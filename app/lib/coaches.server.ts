/**
 * Who coaches a team.
 *
 * The same question as `admins.server`'s, asked of a team instead of a meet,
 * and answered the same way: a row is the whole relationship. You coach this
 * team because you are in this list — there is no role to interpret, no
 * standing to be in, and nothing to reconcile between what you are and what
 * you may do.
 *
 * This replaces `memberships`, which carried a `role` of five values and a
 * `status` of two so that it could describe a coach, an athlete, a parent, a
 * viewer and somebody waiting to be let in. Only the first of those ever
 * changed what the code did — every check in the app was `isCoach()` — and the
 * rest described relationships that already live somewhere truer: a swimmer is
 * on a team because they are *enrolled* in one of its seasons, and their
 * account is tied to them by `athletes.user_id`.
 *
 * The bootstrap differs from a meet's, and deliberately. A meet is created
 * with its creator already running it, because a meet with no administrator
 * could not have been created. A team may exist with no coach at all — every
 * opponent typed in during meet setup is one — so an empty list is a real
 * state, and it means "unclaimed": the first coach to ask takes it, and from
 * then on the list is the gate.
 */

import { NEVER_SEEN } from "./identity";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS team_coaches (
     team_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     added_at INTEGER NOT NULL,
     added_by TEXT,
     PRIMARY KEY (team_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS coaches_by_user ON team_coaches (user_id)`,
];

let ready = false;

async function ensureCoachStore(db: D1Database): Promise<void> {
  if (ready) return;
  for (const statement of SCHEMA) await db.prepare(statement).run();
  await adoptMemberships(db);
  ready = true;
}

/**
 * Carry the coaches out of `memberships` and take the old table away.
 *
 * A one-shot conversion rather than a compatibility layer: the rows that meant
 * "coach" become coaches, the rows that meant anything else meant nothing the
 * app read, and the table goes. Dropping it is what makes this run once —
 * there is no flag to keep, because the absence of the table is the flag.
 */
async function adoptMemberships(db: D1Database): Promise<void> {
  const old = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memberships'",
    )
    .first<{ name: string }>();
  if (!old) return;

  await db
    .prepare(
      `INSERT INTO team_coaches (team_id, user_id, added_at, added_by)
       SELECT team_id, user_id, created_at, decided_by FROM memberships
        WHERE status = 'active' AND role IN ('head_coach', 'coach')
       ON CONFLICT(team_id, user_id) DO NOTHING`,
    )
    .run();
  await db.prepare("DROP TABLE memberships").run();
}

export async function isTeamCoach(
  db: D1Database,
  userId: string | null | undefined,
  teamId: string,
): Promise<boolean> {
  if (!userId) return false;
  await ensureCoachStore(db);
  const row = await db
    .prepare(
      "SELECT 1 AS ok FROM team_coaches WHERE team_id = ? AND user_id = ?",
    )
    .bind(teamId, userId)
    .first<{ ok: number }>();
  return row !== null;
}

/** Every team this person coaches, for deciding a screenful at once. */
export async function teamsCoachedBy(
  db: D1Database,
  userId: string | null | undefined,
): Promise<string[]> {
  if (!userId) return [];
  await ensureCoachStore(db);
  const { results } = await db
    .prepare(
      "SELECT team_id FROM team_coaches WHERE user_id = ? ORDER BY added_at",
    )
    .bind(userId)
    .all<{ team_id: string }>();
  return results.map((row) => row.team_id);
}

/**
 * Which teams have somebody coaching them.
 *
 * The complement is what "unclaimed" means on the teams list, and what lets a
 * coach take over the placeholder an opponent created for them.
 */
export async function coachedTeams(db: D1Database): Promise<Set<string>> {
  await ensureCoachStore(db);
  const { results } = await db
    .prepare("SELECT DISTINCT team_id FROM team_coaches")
    .all<{ team_id: string }>();
  return new Set(results.map((row) => row.team_id));
}

export interface TeamCoach {
  userId: string;
  contact: string;
  name: string | null;
  addedAt: number;
  /** Invited, but has never signed in — so the contact is still unproven. */
  pending: boolean;
}

/**
 * The people coaching a team, with the contact each is shown by.
 *
 * That subquery is `auth.server`'s `primaryContact` rule written out rather
 * than imported: accounts must not depend on teams, and importing it here
 * would close that loop — the same trade `admins.server` makes.
 */
export async function teamCoaches(
  db: D1Database,
  teamId: string,
): Promise<TeamCoach[]> {
  await ensureCoachStore(db);
  const { results } = await db
    .prepare(
      `SELECT c.user_id, c.added_at, u.name, u.last_seen_at,
              (SELECT i.contact FROM identities i WHERE i.user_id = u.id
                ORDER BY i.added_at, i.contact LIMIT 1) AS contact
       FROM team_coaches c JOIN users u ON u.id = c.user_id
       WHERE c.team_id = ? ORDER BY c.added_at`,
    )
    .bind(teamId)
    .all<{
      user_id: string;
      added_at: number;
      contact: string;
      name: string | null;
      last_seen_at: number;
    }>();

  return results.map((row) => ({
    userId: row.user_id,
    contact: row.contact,
    name: row.name,
    addedAt: row.added_at,
    pending: row.last_seen_at === NEVER_SEEN,
  }));
}

export async function addTeamCoach(
  db: D1Database,
  teamId: string,
  userId: string,
  addedBy: string | null,
  now = Date.now(),
): Promise<void> {
  await ensureCoachStore(db);
  await db
    .prepare(
      `INSERT INTO team_coaches (team_id, user_id, added_at, added_by)
       VALUES (?, ?, ?, ?) ON CONFLICT(team_id, user_id) DO NOTHING`,
    )
    .bind(teamId, userId, now, addedBy)
    .run();
}

/**
 * Step down, or remove someone else.
 *
 * Refuses the last one, exactly as a meet refuses its last administrator: a
 * team with no coach can't edit its roster, hand the job on, or let anybody
 * in. Note the asymmetry with creation — a team may *start* with no coach, and
 * that state means "unclaimed". Falling back into it from one coach would mean
 * a team anybody could take over, which is not the same thing at all.
 */
export async function removeTeamCoach(
  db: D1Database,
  teamId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  await ensureCoachStore(db);
  const current = await teamCoaches(db, teamId);
  if (!current.some((coach) => coach.userId === userId)) {
    return { ok: false, reason: "They don't coach this team." };
  }
  if (current.length <= 1) {
    return {
      ok: false,
      reason: "A team needs a coach. Add another one first.",
    };
  }
  await db
    .prepare("DELETE FROM team_coaches WHERE team_id = ? AND user_id = ?")
    .bind(teamId, userId)
    .run();
  return { ok: true };
}

/**
 * Take on a team nobody is coaching.
 *
 * The only way into a team from outside it. Teams that predate accounts have
 * no coaches, and so does every school an opponent typed in during meet setup;
 * somebody has to be able to say "that's mine". It's a land grab of exactly
 * one unclaimed team, and it closes behind them: from the moment this returns
 * true, the list is the gate and everyone else is invited or not at all.
 */
export async function claimTeam(
  db: D1Database,
  teamId: string,
  userId: string,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  await ensureCoachStore(db);
  const held = await db
    .prepare("SELECT 1 AS ok FROM team_coaches WHERE team_id = ? LIMIT 1")
    .bind(teamId)
    .first<{ ok: number }>();
  if (held) {
    return {
      ok: false,
      reason: "Somebody already coaches that team. Ask them to add you.",
    };
  }
  await addTeamCoach(db, teamId, userId, null, now);
  return { ok: true };
}
