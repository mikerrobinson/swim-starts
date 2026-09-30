/**
 * The database, as tables.
 *
 * One table per thing, columns for its fields, foreign keys by id. There is
 * no object store, no scope column, no per-row `updated_at` deciding who
 * wins a merge, and no tombstones — a row is written by whoever owns it, and
 * a delete is a DELETE.
 *
 * D1 holds only what's global across meets — teams, seasons, athletes,
 * enrollments — plus a minimal index row per meet (`meets`) and a
 * read-optimized archive of finished ones (`results`). A meet's own
 * programme and race-day state — events, entries, swims, watches — live
 * entirely in that meet's Durable Object (`meet-do.server.ts`) for as long as
 * it's `status = 'scheduled'`; there is no D1 mirror of them to keep in sync.
 * `results` is written once, when an admin completes the meet — see
 * `MeetDurableObject.completeMeet` — and is D1's only record of it from then
 * on; the DO for a completed meet is never spun back up to answer a read.
 *
 * The account tables — users, identities, sessions, invites — are defined in
 * `auth.server.ts`; meet grants in `grants.server.ts`, and who runs what in
 * `admins.server.ts` (meets) and `coaches.server.ts` (teams).
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS teams (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     code TEXT NOT NULL,
     current_season_id TEXT,
     created_by TEXT,
     created_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS seasons (
     id TEXT PRIMARY KEY,
     team_id TEXT NOT NULL,
     name TEXT NOT NULL,
     start_date TEXT,
     end_date TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS seasons_by_team ON seasons (team_id)`,

  /**
   * People. Global, and never deleted — results reference them by id forever.
   */
  `CREATE TABLE IF NOT EXISTS athletes (
     id TEXT PRIMARY KEY,
     first_name TEXT NOT NULL,
     last_name TEXT NOT NULL,
     gender TEXT NOT NULL,
     birth_date TEXT,
     user_id TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS athletes_by_user ON athletes (user_id)`,
  `CREATE INDEX IF NOT EXISTS athletes_by_name ON athletes (last_name, first_name)`,

  /**
   * Who swam for a team, and when. The roster is this table, not a column on
   * the team: one person can be enrolled by a school and a club at once.
   */
  `CREATE TABLE IF NOT EXISTS enrollments (
     id TEXT PRIMARY KEY,
     team_id TEXT NOT NULL,
     season_id TEXT NOT NULL,
     athlete_id TEXT NOT NULL,
     year TEXT NOT NULL DEFAULT '',
     squad TEXT,
     status TEXT NOT NULL DEFAULT 'active'
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS enrollments_unique ON enrollments (season_id, athlete_id)`,
  `CREATE INDEX IF NOT EXISTS enrollments_by_team ON enrollments (team_id)`,
  `CREATE INDEX IF NOT EXISTS enrollments_by_athlete ON enrollments (athlete_id)`,

  `CREATE TABLE IF NOT EXISTS meets (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     date TEXT NOT NULL,
     type TEXT NOT NULL,
     course TEXT NOT NULL,
     location TEXT,
     host_team_id TEXT,
     created_by TEXT,
     lane_count INTEGER NOT NULL DEFAULT 6,
     timers_per_lane INTEGER NOT NULL DEFAULT 1,
     lead_gender TEXT NOT NULL DEFAULT 'F',
     include_diving INTEGER NOT NULL DEFAULT 0,
     entry_visibility TEXT NOT NULL DEFAULT 'everyone',
     athletes_may_enter INTEGER NOT NULL DEFAULT 0,
     max_individual INTEGER,
     max_relays INTEGER,
     max_total INTEGER,
     max_per_team_per_event INTEGER,
     lane_assignments TEXT,
     scoring TEXT,
     status TEXT NOT NULL DEFAULT 'scheduled',
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS meets_by_date ON meets (date)`,

  /** Which teams are racing. A meet belongs to none of them. */
  `CREATE TABLE IF NOT EXISTS meet_teams (
     meet_id TEXT NOT NULL REFERENCES meets(id) ON DELETE CASCADE,
     team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
     PRIMARY KEY (meet_id, team_id)
   )`,
  `CREATE INDEX IF NOT EXISTS meet_teams_by_team ON meet_teams (team_id)`,

  /**
   * The read-optimized archive of a finished meet — written once, in one
   * batch, by `MeetDurableObject.completeMeet`, and D1's only record of that
   * meet's racing from then on.
   *
   * Fully denormalized on purpose: a completed meet's Durable Object is never
   * spun back up to answer a read, so this row has to carry everything a
   * results page needs by itself — the event's distance/stroke/gender
   * (`eventName()` in `types/meet.ts` renders them) rather than an event id
   * to look up, and the swimmer's name/team rather than an athlete id to
   * join against a roster that may have since changed.
   */
  `CREATE TABLE IF NOT EXISTS results (
     meet_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     event_number INTEGER NOT NULL,
     distance INTEGER NOT NULL,
     stroke TEXT NOT NULL,
     gender TEXT NOT NULL,
     heat INTEGER NOT NULL,
     lane INTEGER NOT NULL,
     athlete_id TEXT,
     athlete_name TEXT NOT NULL,
     athlete_team TEXT NOT NULL,
     time_ms INTEGER,
     status TEXT NOT NULL,
     exhibition INTEGER NOT NULL DEFAULT 0,
     place INTEGER,
     points REAL,
     PRIMARY KEY (meet_id, event_id, heat, lane)
   )`,
  `CREATE INDEX IF NOT EXISTS results_by_meet ON results (meet_id, event_number, heat)`,
];

let ready = false;

/**
 * Create anything missing, once per worker instance.
 *
 * Cheap enough to call from any loader — after the first call it's a boolean
 * check — and it means a fresh database needs no separate migration step to
 * start working.
 */

export async function ensureSchema(db: D1Database): Promise<void> {
  if (ready) return;
  for (const statement of SCHEMA) await db.prepare(statement).run();
  ready = true;
}
