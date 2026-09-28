/**
 * Accounts, sessions, and the invitations that hand out a job.
 *
 * The rules live in `identity.ts`; this is where they meet a database. Four
 * tables, all small: who exists, the code they were last sent, the sessions
 * they hold, and outstanding invites. Which teams somebody coaches used to be
 * a fifth — `memberships`, with a role and a standing — and is now a row in
 * `team_coaches`, beside the meet's own list in `admins.server`.
 *
 * Two things are stored hashed rather than plainly — session tokens and login
 * codes. Neither is a password, but both are live credentials for as long as
 * they last, and a hash means a copy of the database isn't a set of working
 * logins.
 */

import {
  CODE_TTL_MS,
  RESEND_INTERVAL_MS,
  checkChallenge,
  NEVER_SEEN,
  newCode,
  normalizeCode,
  teamToOpen,
  timingSafeEqual,
  type ChallengeCheck,
  type Contact,
} from "./identity";
import { addMeetAdmin } from "./admins.server";
import { addTeamCoach, coachedTeams, teamsCoachedBy } from "./coaches.server";
import { ensureSchema } from "./schema.server";
import { createSeason, createTeam } from "./teams.server";
import type { Team } from "~/types/team";
import type { User } from "~/types/user";

/**
 * An account is an id and the contacts that open it — nothing more.
 *
 * `users` deliberately carries no contact of its own. It used to, as the
 * identity and as a display field, with `identities` bolted on beside it; that
 * left one fact in two places and a hand-written UPDATE keeping them level
 * every time a contact was removed. Uniqueness comes from `identities.contact`
 * being the primary key, and the address a screen shows is derived — see
 * `primaryContact`.
 *
 * `login_codes` is keyed by contact rather than by user, because a code is
 * sent before we know — or care — whether the person behind it exists yet.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     name TEXT,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     last_team_id TEXT,
     last_season_id TEXT
   )`,
  /**
   * The contacts an account can be reached at and sign in with.
   *
   * A person is not one email address. A coach has a school address and a
   * mobile; a parent signs up with one and later wants the other. Keeping
   * contacts in their own table is what lets either one open the same account
   * rather than minting a second.
   *
   * `contact` is the primary key, so one address can only ever belong to one
   * account — which is the property the whole login flow rests on.
   */
  `CREATE TABLE IF NOT EXISTS identities (
     contact TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     user_id TEXT NOT NULL,
     added_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS identities_by_user ON identities (user_id)`,
  `CREATE TABLE IF NOT EXISTS login_codes (
     contact TEXT PRIMARY KEY,
     code_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (user_id)`,
  /**
   * An invitation, whatever it lets you into.
   *
   * One table, because an invite is an invite: a token somebody minted, that
   * expires, that is spent once, and that grants exactly one thing when it is.
   * What it grants is which of `team_id` and `meet_id` is set — exactly one
   * always is — rather than a kind column, so a row can't claim to be a team
   * invitation while carrying a meet.
   *
   * There is one job to hand out on each side — coaching the team, running
   * the meet — so there is nothing for a role column to say. `contact` is set
   * when the link was sent to somebody in particular, and null when it's one a
   * coach copies and passes around.
   */
  `CREATE TABLE IF NOT EXISTS invites (
     token_hash TEXT PRIMARY KEY,
     team_id TEXT,
     meet_id TEXT,
     contact TEXT,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at INTEGER,
     used_by TEXT
   )`,
];

let ready = false;

async function ensureAuthStore(db: D1Database): Promise<void> {
  if (ready) return;
  for (const statement of SCHEMA) await db.prepare(statement).run();
  ready = true;
}

/* ------------------------------------------------------------- primitives */

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Codes are hashed with the contact mixed in.
 *
 * Six digits is a small enough space that a bare hash is a lookup table; the
 * contact makes each one its own space, which is all that's needed given the
 * ten-minute life and five-guess limit.
 */
function codeHash(contact: string, code: string): Promise<string> {
  return sha256(`code:${contact}:${code}`);
}

function tokenHash(token: string): Promise<string> {
  return sha256(`token:${token}`);
}

/** 256 bits, URL-safe — it travels in a header and sometimes in a link. */
function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function newId(): string {
  return crypto.randomUUID();
}

/* ------------------------------------------------------------- challenges */

export type ChallengeStart =
  | { ok: true; code: string }
  | { ok: false; retryInMs: number };

/**
 * Mint a code for a contact, replacing whatever was outstanding.
 *
 * One live challenge per contact: asking again should get you a working code,
 * not a choice of two. The quiet period in between is what stops the endpoint
 * being used to text a stranger over and over.
 */
export async function startChallenge(
  db: D1Database,
  contact: Contact,
  now = Date.now(),
): Promise<ChallengeStart> {
  await ensureAuthStore(db);

  const existing = await db
    .prepare("SELECT created_at FROM login_codes WHERE contact = ?")
    .bind(contact.value)
    .first<{ created_at: number }>();

  if (existing && now - existing.created_at < RESEND_INTERVAL_MS) {
    return {
      ok: false,
      retryInMs: RESEND_INTERVAL_MS - (now - existing.created_at),
    };
  }

  const code = newCode();
  await db
    .prepare(
      `INSERT INTO login_codes (contact, code_hash, created_at, attempts)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(contact) DO UPDATE SET
         code_hash = excluded.code_hash,
         created_at = excluded.created_at,
         attempts = 0`,
    )
    .bind(contact.value, await codeHash(contact.value, code), now)
    .run();

  return { ok: true, code };
}

export type VerifyResult =
  | { ok: true; user: User; isNew: boolean }
  | { ok: false; check: ChallengeCheck };

/**
 * Check a code and, if it holds, produce the person behind the contact.
 *
 * A contact nobody has used before becomes an account here — proving you can
 * read what was sent to it is the entire signup. A wrong guess costs an
 * attempt; a right one burns the challenge outright so a code can't be
 * replayed.
 */
/**
 * Check a code and spend it, without touching accounts.
 *
 * Signing in and adding a contact to an existing account ask the same question
 * — can you read what was sent here? — but only one of them should create an
 * account. Fusing the two meant proving a new contact minted a stray account
 * that then owned it, and the attach that followed was refused for a clash
 * with a user who existed only because of the attach.
 */
export async function consumeLoginCode(
  db: D1Database,
  contact: Contact,
  submitted: string,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; check: ChallengeCheck }> {
  await ensureAuthStore(db);

  const row = await db
    .prepare(
      "SELECT code_hash, created_at, attempts FROM login_codes WHERE contact = ?",
    )
    .bind(contact.value)
    .first<{ code_hash: string; created_at: number; attempts: number }>();

  // Nothing outstanding reads as expired: it's indistinguishable from the
  // person's side, and saying "never asked" would confirm the contact exists.
  if (!row) return { ok: false, check: { ok: false, reason: "expired" } };

  const submittedHash = await codeHash(contact.value, normalizeCode(submitted));
  const check = checkChallenge(
    { createdAt: row.created_at, attempts: row.attempts },
    timingSafeEqual(row.code_hash, submittedHash),
    now,
  );

  if (!check.ok) {
    if (check.reason === "wrong") {
      await db
        .prepare(
          "UPDATE login_codes SET attempts = attempts + 1 WHERE contact = ?",
        )
        .bind(contact.value)
        .run();
    }
    return { ok: false, check };
  }

  await db
    .prepare("DELETE FROM login_codes WHERE contact = ?")
    .bind(contact.value)
    .run();
  return { ok: true };
}

export async function verifyChallenge(
  db: D1Database,
  contact: Contact,
  submitted: string,
  now = Date.now(),
): Promise<VerifyResult> {
  const spent = await consumeLoginCode(db, contact, submitted, now);
  if (!spent.ok) return { ok: false, check: spent.check };

  const existing = await findUser(db, contact.value);
  if (existing) {
    await db
      .prepare("UPDATE users SET last_seen_at = ? WHERE id = ?")
      .bind(now, existing.id)
      .run();
    return { ok: true, user: { ...existing, lastSeenAt: now }, isNew: false };
  }

  const user: User = {
    id: newId(),
    name: null,
    createdAt: now,
    lastSeenAt: now,
    lastTeamId: null,
    lastSeasonId: null,
  };
  await db
    .prepare(
      `INSERT INTO users (id, name, created_at, last_seen_at)
       VALUES (?, NULL, ?, ?)`,
    )
    .bind(user.id, now, now)
    .run();
  // The contact they just proved is their first way in — and, being the first,
  // the one they'll be shown by.
  await db
    .prepare(
      "INSERT INTO identities (contact, kind, user_id, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(contact) DO NOTHING",
    )
    .bind(contact.value, contact.kind, user.id, now)
    .run();

  return { ok: true, user, isNew: true };
}

/* ---------------------------------------------------------------- sessions */

/**
 * How long a session lasts without being used.
 *
 * Long, on purpose: a coach signs in once on the iPad that lives in the swim
 * bag and shouldn't be asked again mid-meet on pool wifi. Every use pushes it
 * out again, so in practice only a device that's been idle for over a year
 * has to sign in twice.
 */
const SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000;

/** Don't rewrite the row on every request — a day's resolution is plenty. */
const SESSION_TOUCH_MS = 24 * 60 * 60 * 1000;

interface UserRow {
  id: string;
  name: string | null;
  created_at: number;
  last_seen_at: number;
  last_team_id: string | null;
  last_season_id: string | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastTeamId: row.last_team_id,
    lastSeasonId: row.last_season_id,
  };
}

/**
 * The contact an account is shown by.
 *
 * Derived, not stored: it's the first contact added, and when that one is
 * removed the next becomes it on its own. `users` used to keep a copy, which
 * meant every path that touched `identities` had to remember to rewrite it —
 * a denormalisation whose only job was to answer a question the rows that
 * actually define it can answer directly.
 *
 * `added_at` decides, with the contact itself as a tiebreak so two added in
 * the same millisecond still order the same way on every read.
 */
function primaryContact(column: "contact" | "kind"): string {
  return `(SELECT i2.${column} FROM identities i2
            WHERE i2.user_id = u.id
            ORDER BY i2.added_at, i2.contact LIMIT 1)`;
}

const USER_SELECT = `u.id, u.name, u.created_at, u.last_seen_at,
     u.last_team_id, u.last_season_id`;

/**
 * The account a contact signs in to.
 *
 * Through `identities`, which is now the only place a contact lives — so a
 * second address added later opens the same account rather than a new one,
 * and there is no second lookup that could disagree.
 */
async function findUser(db: D1Database, contact: string): Promise<User | null> {
  const row = await db
    .prepare(
      `SELECT ${USER_SELECT}
       FROM identities i JOIN users u ON u.id = i.user_id
       WHERE i.contact = ?`,
    )
    .bind(contact)
    .first<UserRow>();
  return row ? toUser(row) : null;
}

export interface Identity {
  contact: string;
  kind: string;
  addedAt: number;
}

export async function identitiesFor(
  db: D1Database,
  userId: string,
): Promise<Identity[]> {
  await ensureAuthStore(db);
  const { results } = await db
    .prepare(
      "SELECT contact, kind, added_at FROM identities WHERE user_id = ? ORDER BY added_at",
    )
    .bind(userId)
    .all<{ contact: string; kind: string; added_at: number }>();
  return results.map((row) => ({
    contact: row.contact,
    kind: row.kind,
    addedAt: row.added_at,
  }));
}

/**
 * Attach a contact to an account.
 *
 * The caller has to have proved the code sent to it first — an address you
 * can't read is not yours, and without that check anyone could claim any
 * address and lock its owner out of their own account.
 */
export async function addIdentity(
  db: D1Database,
  userId: string,
  contact: Contact,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  await ensureAuthStore(db);
  const taken = await db
    .prepare("SELECT user_id FROM identities WHERE contact = ?")
    .bind(contact.value)
    .first<{ user_id: string }>();
  if (taken) {
    return {
      ok: false,
      reason:
        taken.user_id === userId
          ? "That's already on your account."
          : "That contact belongs to another account.",
    };
  }

  await db
    .prepare(
      "INSERT INTO identities (contact, kind, user_id, added_at) VALUES (?, ?, ?, ?)",
    )
    .bind(contact.value, contact.kind, userId, now)
    .run();
  return { ok: true };
}

/**
 * Take a contact off an account.
 *
 * Never the last one. An account with no contact can't be signed into again,
 * and there'd be no way back in to fix it.
 */
export async function removeIdentity(
  db: D1Database,
  userId: string,
  contact: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  await ensureAuthStore(db);
  const mine = await identitiesFor(db, userId);
  if (!mine.some((i) => i.contact === contact)) {
    return { ok: false, reason: "That isn't on your account." };
  }
  if (mine.length <= 1) {
    return {
      ok: false,
      reason: "Add another way to sign in before removing this one.",
    };
  }

  await db
    .prepare("DELETE FROM identities WHERE contact = ? AND user_id = ?")
    .bind(contact, userId)
    .run();

  // Nothing else to put right. What the app displays is whichever contact is
  // now the earliest, which is true the moment the row is gone.
  return { ok: true };
}

/** Hand out a session. The plaintext token is returned once and never stored. */
export async function createSession(
  db: D1Database,
  userId: string,
  now = Date.now(),
): Promise<string> {
  await ensureAuthStore(db);
  const token = newToken();
  await db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(await tokenHash(token), userId, now, now, now + SESSION_TTL_MS)
    .run();
  return token;
}

/**
 * The person behind a token, or null.
 *
 * Looked up by hash, so an expired or forged token is simply a miss — there's
 * no branch here that behaves differently for a token that once existed.
 */
export async function userForToken(
  db: D1Database,
  token: string | null | undefined,
  now = Date.now(),
): Promise<User | null> {
  if (!token) return null;
  await ensureAuthStore(db);

  const hash = await tokenHash(token);
  const row = await db
    .prepare(
      `SELECT ${USER_SELECT}, s.last_used_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(hash, now)
    .first<UserRow & { last_used_at: number }>();
  if (!row) return null;

  // Sliding expiry, written at most once a day so a busy meet doesn't turn
  // every request into a write.
  if (now - row.last_used_at > SESSION_TOUCH_MS) {
    await db
      .prepare(
        "UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?",
      )
      .bind(now, now + SESSION_TTL_MS, hash)
      .run();
  }

  return toUser(row);
}

/** The bearer token on a request, from the header the client sends. */
/** The cookie a browser sends on its own, including on a plain navigation. */
const SESSION_COOKIE = "mr_session";

/**
 * The session token on a request, from either place it can be.
 *
 * Two carriers, for two kinds of caller. A `fetch` from our own code sends an
 * `Authorization` header — that's what the outbox and the timer's phone use,
 * and it's what a script or the QR-code grant can use too. A *navigation*
 * sends nothing of the sort, and loaders run on navigations: the browser has
 * to be the one carrying the credential, which means a cookie.
 *
 * The header used to be the only carrier, on the grounds that nothing but our
 * own code could send one — CSRF gone rather than defended against. That was
 * right while every screen rendered from a client store. It stopped being
 * available the moment the reading moved into loaders, where an anonymous
 * request is indistinguishable from being signed out. The cookie is
 * `SameSite=Lax`, so it rides top-level navigations and not cross-site form
 * posts, which is the defence the header used to make unnecessary.
 */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header) {
    const [scheme, value] = header.split(" ");
    if (scheme?.toLowerCase() === "bearer" && value) return value;
  }
  return cookieToken(request);
}

function cookieToken(request: Request): string | null {
  const jar = request.headers.get("cookie");
  if (!jar) return null;
  for (const part of jar.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE && rest.length) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

/**
 * How the session cookie is written and cleared.
 *
 * The whole credential, now that nothing keeps a second copy. `HttpOnly`
 * because no script needs to read it — and because a token no script can read
 * is one no script on the page can leak, which is what a copy in localStorage
 * could never be. `Secure` everywhere but localhost, which has no https to be
 * secure on.
 */
export function sessionCookie(
  token: string | null,
  request: Request,
  maxAgeSeconds = 60 * 60 * 24 * 90,
): string {
  const https = new URL(request.url).protocol === "https:";
  const bits = [
    `${SESSION_COOKIE}=${token ? encodeURIComponent(token) : ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(https ? ["Secure"] : []),
    `Max-Age=${token ? maxAgeSeconds : 0}`,
  ];
  return bits.join("; ");
}

export async function endSession(db: D1Database, token: string): Promise<void> {
  await ensureAuthStore(db);
  await db
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(await tokenHash(token))
    .run();
}

/** Sign out everywhere — the answer to a lost phone. */
export async function endAllSessions(
  db: D1Database,
  userId: string,
): Promise<void> {
  await ensureAuthStore(db);
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

export async function setName(
  db: D1Database,
  userId: string,
  name: string,
): Promise<void> {
  await ensureAuthStore(db);
  const trimmed = name.trim().slice(0, 80);
  await db
    .prepare("UPDATE users SET name = ? WHERE id = ?")
    .bind(trimmed || null, userId)
    .run();
}

/* ------------------------------------------------------------------ teams */

/**
 * What a team is called and how big it is, for the screens that list teams
 * alongside your standing with them.
 *
 * Straight off the tables. Auth keeps no copy of a team, so there is nothing
 * here that can disagree with the roster.
 */
export interface TeamFacts {
  name: string;
  code: string;
  athletes: number;
  meets: number;
}

async function teamFacts(db: D1Database): Promise<Map<string, TeamFacts>> {
  await ensureSchema(db);
  const { results } = await db
    .prepare(
      `SELECT t.id, t.name, t.code,
              (SELECT COUNT(DISTINCT athlete_id) FROM enrollments e WHERE e.team_id = t.id) AS athletes,
              (SELECT COUNT(*) FROM meet_teams mt WHERE mt.team_id = t.id) AS meets
       FROM teams t`,
    )
    .all<{
      id: string;
      name: string;
      code: string;
      athletes: number;
      meets: number;
    }>();

  return new Map(
    results.map((row) => [
      row.id,
      {
        name: row.name,
        code: row.code,
        athletes: row.athletes,
        meets: row.meets,
      },
    ]),
  );
}

export interface CoachedTeam extends TeamFacts {
  teamId: string;
}

/** Every team this person coaches, named. */
export async function coachedTeamsFor(
  db: D1Database,
  userId: string,
): Promise<CoachedTeam[]> {
  const mine = await teamsCoachedBy(db, userId);
  if (mine.length === 0) return [];

  const facts = await teamFacts(db);
  return mine.map((teamId) => ({
    teamId,
    ...(facts.get(teamId) ?? {
      name: "Untitled team",
      code: "",
      athletes: 0,
      meets: 0,
    }),
  }));
}

export interface JoinableTeam extends TeamFacts {
  teamId: string;
  /** False when nobody coaches it yet — which is what makes it claimable. */
  claimed: boolean;
}

/**
 * Start a team, with yourself coaching it.
 *
 * The team, its first season and the coach are written together. A season is
 * here because a team with none can hold no roster and every path that adds
 * one asks which season it's for; the coach is here because a team created
 * with nobody on it would be indistinguishable from an unclaimed one, and the
 * next person along could take it.
 */
export async function startTeam(
  db: D1Database,
  userId: string,
  input: { name: string; code?: string },
  now = Date.now(),
): Promise<Team> {
  await ensureAuthStore(db);
  const team = await createTeam(
    db,
    { name: input.name, code: input.code, createdBy: userId },
    now,
  );
  await createSeason(db, { teamId: team.id, name: "Current season" });
  await addTeamCoach(db, team.id, userId, null, now);
  return team;
}

/* --------------------------------------------------------------- invites */

/** An invite is good for a fortnight — long enough to sit in an inbox over a
 *  school holiday, short enough that a forwarded link goes stale. */
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * What an invitation lets you into. Exactly one of the two.
 *
 * Neither carries a role, because each side has exactly one job to hand out:
 * coaching the team, or running the meet. `contact` is set when the link was
 * sent to somebody in particular — it lets the sign-in screen fill the box in
 * — and left off for a link that's simply copied.
 */
export type InviteGrant =
  | { teamId: string; contact?: string }
  | { meetId: string; contact?: string };

/**
 * Mint a one-time invitation.
 *
 * Returned in plaintext once, exactly like a session token, because it *is*
 * one — a bearer credential that turns into coaching a team, or into running
 * a meet, for whoever redeems it. That's the trade for letting somebody be
 * added by sending them a link.
 */
export async function createInvite(
  db: D1Database,
  grant: InviteGrant,
  createdBy: string,
  now = Date.now(),
): Promise<string> {
  await ensureAuthStore(db);
  const token = newToken();
  const teamId = "teamId" in grant ? grant.teamId : null;
  const meetId = "meetId" in grant ? grant.meetId : null;

  await db
    .prepare(
      `INSERT INTO invites
         (token_hash, team_id, meet_id, contact, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await tokenHash(token),
      teamId,
      meetId,
      grant.contact ?? null,
      createdBy,
      now,
      now + INVITE_TTL_MS,
    )
    .run();
  return token;
}

/**
 * Replace whatever was outstanding for one person on one thing.
 *
 * Resending shouldn't leave two live tokens for the same job — the older one
 * would still work, and "I sent it twice" would mean two ways in rather than
 * one that arrived.
 */
export async function supersedeInvites(
  db: D1Database,
  grant: { meetId?: string; teamId?: string; contact: string },
): Promise<void> {
  await ensureAuthStore(db);
  await db
    .prepare(
      `DELETE FROM invites
       WHERE contact = ? AND used_at IS NULL
         AND meet_id IS ? AND team_id IS ?`,
    )
    .bind(grant.contact, grant.meetId ?? null, grant.teamId ?? null)
    .run();
}

export type InviteInfo =
  | { kind: "team"; teamId: string; name: string; code: string }
  | {
      kind: "meet";
      meetId: string;
      name: string;
      date: string;
      contact: string | null;
    };

/**
 * What an invitation is for, before anyone signs in — so the sign-in screen
 * can say which team is being joined, or which meet is being run, instead of
 * asking for a contact blind.
 */
export async function inspectInvite(
  db: D1Database,
  token: string,
  now = Date.now(),
): Promise<InviteInfo | null> {
  await ensureAuthStore(db);
  const row = await db
    .prepare(
      `SELECT team_id, meet_id, contact FROM invites
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .bind(await tokenHash(token), now)
    .first<{
      team_id: string | null;
      meet_id: string | null;
      contact: string | null;
    }>();
  if (!row) return null;

  if (row.meet_id) {
    const meet = await db
      .prepare("SELECT name, date FROM meets WHERE id = ?")
      .bind(row.meet_id)
      .first<{ name: string; date: string }>();
    if (!meet) return null;
    return {
      kind: "meet",
      meetId: row.meet_id,
      name: meet.name,
      date: meet.date,
      contact: row.contact,
    };
  }

  const facts = (await teamFacts(db)).get(row.team_id!);
  return {
    kind: "team",
    teamId: row.team_id!,
    name: facts?.name ?? "Untitled team",
    code: facts?.code ?? "",
  };
}

export type InviteRedemption =
  | { ok: true; kind: "team"; teamId: string }
  | { ok: true; kind: "meet"; meetId: string }
  | { ok: false; error: string };

/**
 * Spend the link and grant what it names.
 *
 * The update that marks it used carries `used_at IS NULL` in its WHERE, so two
 * people racing on a forwarded link can't both come out with it — whoever's
 * write lands second sees no rows changed and is told the invite is spent.
 *
 * What's granted goes to whoever proved a contact just now, not to whoever the
 * invitation was addressed to: a link forwarded to a colleague is redeemed by
 * the colleague, which is the behaviour a forwarded link should have.
 */
export async function redeemInvite(
  db: D1Database,
  token: string,
  userId: string,
  now = Date.now(),
): Promise<InviteRedemption> {
  await ensureAuthStore(db);

  const claimed = await db
    .prepare(
      `UPDATE invites SET used_at = ?, used_by = ?
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
       RETURNING team_id, meet_id`,
    )
    .bind(now, userId, await tokenHash(token), now)
    .first<{ team_id: string | null; meet_id: string | null }>();

  if (!claimed)
    return { ok: false, error: "That invitation has expired or been used." };

  if (claimed.meet_id) {
    await addMeetAdmin(db, claimed.meet_id, userId, null, now);
    return { ok: true, kind: "meet", meetId: claimed.meet_id };
  }

  // Already coaching there is not an error — a second link, or one forwarded
  // back to somebody who is already in, simply lands them where it says.
  const teamId = claimed.team_id!;
  await addTeamCoach(db, teamId, userId, null, now);
  return { ok: true, kind: "team", teamId };
}

/* ------------------------------------------------------------- the answer */

export interface SessionPayload {
  user: {
    id: string;
    contact: string;
    contactKind: string;
    name: string | null;
    lastSeasonId: string | null;
  };
  /** The teams this person coaches. There is no other standing to have. */
  teams: CoachedTeam[];
  /** Which team to open. Null means there's nothing this person can open yet. */
  openTeamId: string | null;
}

/**
 * Everything the app needs to draw itself for a signed-in person.
 *
 * One shape, returned by both signing in and asking "who am I", so the client
 * has a single thing to handle rather than two that could drift.
 *
 * `joinable` is filled in only when there's nothing to open. Somebody already
 * on a team has no business being handed a list of the others.
 */
export async function sessionPayload(
  db: D1Database,
  user: User,
  invitedTeamId?: string | null,
): Promise<SessionPayload> {
  const [teams, identities] = await Promise.all([
    coachedTeamsFor(db, user.id),
    identitiesFor(db, user.id),
  ]);
  const openTeamId = teamToOpen(
    teams.map((team) => team.teamId),
    { invitedTeamId, lastTeamId: user.lastTeamId },
  );
  // The earliest-added identity is the one shown by — same rule
  // `primaryContact()` answers in SQL, asked here in JS since this is the
  // one place a `User` needs its contact for display rather than for a
  // lookup.
  const primary = identities[0];

  return {
    user: {
      id: user.id,
      contact: primary?.contact ?? "",
      contactKind: primary?.kind ?? "email",
      name: user.name,
      lastSeasonId: user.lastSeasonId,
    },
    teams,
    openTeamId,
  };
}

/* ------------------------------------------------------------- directory */

/**
 * The account for a contact, creating an unproven one if there isn't one.
 *
 * This is the only place an account appears without somebody having read a
 * code — which is a real departure from "proving you can read what was sent
 * to it is the entire signup", and is deliberate: a meet administrator has to
 * be nameable before they arrive, or the person setting the meet up can't
 * hand the job over in advance.
 *
 * The contact is what makes it safe. `identities.contact` is unique, so
 * inviting somebody who already has an account returns *that* account rather
 * than minting a rival for the same address — and the moment they sign in,
 * the ordinary flow finds them by the same contact and stamps `last_seen_at`.
 */
export async function inviteUser(
  db: D1Database,
  contact: Contact,
  name: string | null,
  now = Date.now(),
): Promise<{ user: User; created: boolean }> {
  await ensureAuthStore(db);

  const existing = await findUser(db, contact.value);
  if (existing) return { user: existing, created: false };

  const user: User = {
    id: newId(),
    name: name?.trim() || null,
    createdAt: now,
    lastSeenAt: NEVER_SEEN,
    lastTeamId: null,
    lastSeasonId: null,
  };
  await db
    .prepare(
      `INSERT INTO users (id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)`,
    )
    .bind(user.id, user.name, now, NEVER_SEEN)
    .run();
  await db
    .prepare(
      "INSERT INTO identities (contact, kind, user_id, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(contact) DO NOTHING",
    )
    .bind(contact.value, contact.kind, user.id, now)
    .run();

  return { user, created: true };
}

export interface DirectoryUser {
  userId: string;
  name: string | null;
  contact: string;
  pending: boolean;
}

/**
 * Everyone with an account, for picking a person by name.
 *
 * Deliberately not scoped to a team. Running a meet is the one job in this app
 * that belongs to no team — often it's a referee who coaches nobody — so a
 * picker that could only offer your own club's coaches could not express the
 * case the role exists for.
 *
 * The cost is that it hands one meet's administrator a list of contacts, and
 * that cost is real. It's bounded by requiring a search: an empty query
 * returns nothing, so the endpoint answers "is this person here?" rather than
 * printing the directory.
 */
/**
 * One account, named — for a screen showing who something is attached to.
 *
 * Deliberately narrow: an id in, a name and a contact out, and no way to list.
 * The caller has to already hold the id, which it only does because somebody
 * with the standing to link them put it there.
 */
export async function describeUser(
  db: D1Database,
  userId: string,
): Promise<DirectoryUser | null> {
  await ensureAuthStore(db);
  const row = await db
    .prepare(
      `SELECT u.id, u.name, u.last_seen_at,
              ${primaryContact("contact")} AS contact
       FROM users u WHERE u.id = ?`,
    )
    .bind(userId)
    .first<{
      id: string;
      name: string | null;
      contact: string;
      last_seen_at: number;
    }>();
  if (!row) return null;
  return {
    userId: row.id,
    name: row.name,
    contact: row.contact,
    pending: row.last_seen_at === NEVER_SEEN,
  };
}

export async function searchUsers(
  db: D1Database,
  query: string,
  limit = 20,
): Promise<DirectoryUser[]> {
  await ensureAuthStore(db);
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  // The wildcards are ours, so anything that looks like one in what was typed
  // has to stop being one before it reaches LIKE.
  const escaped = trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`).toLowerCase();

  const { results } = await db
    .prepare(
      `SELECT u.id, u.name, u.last_seen_at,
              ${primaryContact("contact")} AS contact
       FROM users u
       WHERE LOWER(u.name) LIKE '%' || ?1 || '%' ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM identities i WHERE i.user_id = u.id
                       AND LOWER(i.contact) LIKE '%' || ?1 || '%' ESCAPE '\\')
       ORDER BY u.name IS NULL, u.name, contact
       LIMIT ?2`,
    )
    .bind(escaped, limit)
    .all<{
      id: string;
      name: string | null;
      contact: string;
      last_seen_at: number;
    }>();

  return results.map((row) => ({
    userId: row.id,
    name: row.name,
    contact: row.contact,
    pending: row.last_seen_at === NEVER_SEEN,
  }));
}
