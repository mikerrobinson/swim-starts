/**
 * A seed cookie encodes the payload of one lane's swim, replacing the five
 * per-lane cookies in `timer-messages.ts`. One sharp edge: cookie names are
 * RFC 6265 tokens, so the key is dash-joined into the name itself
 * (`seed-7-1-3`) rather than the value.
 *
 * Just the wire format here — `encodeSeedRecord`/`decodeSeedRecord` and the
 * shape they agree on. The timer screen owns one `SeedRecord` per lane as
 * plain form state and encodes the whole thing fresh on every change; there
 * is deliberately no read-modify-write helper here that patches one field of
 * a record decoded back off the cookie. That used to be `withStart`/
 * `withStop`/etc., and it had a sharp edge of its own: the cookie is cleared
 * the moment the server has synced it, so a lane whose start had already
 * reached the server (cookie now empty) but whose stop hadn't yet would
 * "stop" an empty record — which read, on the way back in, as this device
 * now claiming zero watches, and dropped the one still running. Keeping the
 * record in memory instead of re-deriving it from a cookie that may have
 * already been cleared out from under it removes the whole class of bug.
 *
 * Pure module — no `document.cookie`, no size limits, no network. That's
 * `seed-queue.ts`'s job.
 */

import type { LaneRef } from "~/types/meet";
import type { Gender } from "~/types/athlete";

const COOKIE_PREFIX = "seed-";

export function seedCookieName(at: LaneRef): string {
  return `${COOKIE_PREFIX}${at.event}-${at.heat}-${at.lane}`;
}

/** Which lane a cookie belongs to, from its name alone — the whole index. */
export function parseSeedCookieName(name: string): LaneRef | null {
  if (!name.startsWith(COOKIE_PREFIX)) return null;
  const [event, heat, lane] = name
    .slice(COOKIE_PREFIX.length)
    .split("-")
    .map(Number);
  if (![event, heat, lane].every((n) => Number.isInteger(n) && n > 0)) {
    return null;
  }
  return { event, heat, lane };
}

/* ------------------------------------------------------------------ shape */

export interface WatchSlot {
  startedAt: number | null;
  stoppedAt: number | null;
  timeMs: number | null;
}

export interface SeedRecord {
  /** This device's clock, not a wall clock — for ordering its own actions. */
  updatedAt: number;
  /**
   * Empty until someone is seated. For a walk-up, this is minted by the
   * client itself (not the server) precisely so re-applying the same
   * not-yet-cleared cookie twice upserts the same person rather than
   * minting a duplicate.
   */
  athleteId: string;
  /** Team short code + typed name + chosen gender for a walk-up not yet on
   *  the roster; all empty once `athleteId` names someone already on it. */
  team: string | null;
  name: string;
  gender: Gender | null;
  exhibition: boolean;
  watches: WatchSlot[];
}

export function emptySeedRecord(now = Date.now()): SeedRecord {
  return {
    updatedAt: now,
    athleteId: "",
    team: null,
    name: "",
    gender: null,
    exhibition: false,
    watches: [],
  };
}

/* -------------------------------------------------------------- formatting */

/** Fields separate on `|`, so anything that might contain one is encoded. */
const esc = (value: string) => encodeURIComponent(value);
const unesc = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
};

const numOrBlank = (n: number | null) => (n === null ? "" : String(n));
const blankToNull = (raw: string | undefined): number | null => {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

function formatWatch(slot: WatchSlot): string {
  return [
    numOrBlank(slot.startedAt),
    numOrBlank(slot.stoppedAt),
    numOrBlank(slot.timeMs),
  ].join(",");
}

function parseWatch(raw: string): WatchSlot {
  const [startedAt, stoppedAt, timeMs] = raw.split(",");
  return {
    startedAt: blankToNull(startedAt),
    stoppedAt: blankToNull(stoppedAt),
    timeMs: blankToNull(timeMs),
  };
}

export function encodeSeedRecord(record: SeedRecord): string {
  return [
    record.updatedAt,
    record.athleteId,
    record.team === null ? "" : record.team,
    esc(record.name),
    record.gender ?? "",
    record.exhibition ? 1 : 0,
    record.watches.map(formatWatch).join(";"),
  ].join("|");
}

const asGender = (raw: string | undefined): Gender | null =>
  raw === "M" || raw === "F" ? raw : null;

/** Forgiving about missing/extra fields — a stale cookie should degrade, not wedge the lane. */
export function decodeSeedRecord(raw: string): SeedRecord | null {
  const [updatedAt, athleteId, team, name, gender, exhibition, watches] =
    raw.split("|");
  const at = Number(updatedAt);
  if (!Number.isFinite(at)) return null;
  return {
    updatedAt: at,
    athleteId: unesc(athleteId ?? ""),
    team: team || null,
    name: unesc(name ?? "")
      .trim()
      .slice(0, 80),
    gender: asGender(gender),
    exhibition: exhibition === "1",
    watches: watches ? watches.split(";").map(parseWatch) : [],
  };
}
