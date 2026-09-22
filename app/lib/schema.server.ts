/**
 * The database, as tables.
 *
 * One table per thing, columns for its fields, foreign keys by id. There is
 * no object store, no scope column, no per-row `updated_at` deciding who
 * wins a merge, and no tombstones — a row is written by whoever owns it, and
 * a delete is a DELETE.
 *
 * These shapes are mirrored exactly by the meet's Durable Object
 * (`meet-do.server.ts`), which is where `entries`, `swims` and `watches`
 * actually live for the duration of a meet — D1 holds the checkpointed copy.
 * Everything else here (teams, seasons, athletes, enrollments, meets, events)
 * is D1-only.
 *
 * Two shapes are worth knowing before reading the rest.
 *
 * **`meet_id` is denormalised onto events, entries, swims and watches.** It
 * is derivable by joining, and it's here anyway because every screen under a
 * meet asks "everything for this meet" and that answers fastest as a handful
 * of indexed single-table reads.
 *
 * **Rows several people write at once are keyed so they can't collide.** A
 * swim is `(event_id, heat, lane)`. Six timers seating their own lane write
 * six different rows; three timers on one lane write three different rows.
 * `watches` has no such key at all — it's append-only, so two timers, or one
 * timer correcting themselves, can only ever add rows, never contend for one.
 * Concurrency is a property of the keys (or their absence) rather than
 * something the app has to reconcile afterwards.
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
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS meets_by_date ON meets (date)`,

  /** Which teams are racing. A meet belongs to none of them. */
  `CREATE TABLE IF NOT EXISTS meet_teams (
     meet_id TEXT NOT NULL,
     team_id TEXT NOT NULL,
     PRIMARY KEY (meet_id, team_id)
   )`,
  `CREATE INDEX IF NOT EXISTS meet_teams_by_team ON meet_teams (team_id)`,

  /**
   * The programme. `position` is the order events are swum in, so reordering
   * is an update to a column rather than a rewrite of a list.
   */
  `CREATE TABLE IF NOT EXISTS events (
     meet_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     distance INTEGER NOT NULL,
     stroke TEXT NOT NULL,
     gender TEXT NOT NULL,
     name TEXT,
     PRIMARY KEY (meet_id, event_id)
   )`,
  `CREATE INDEX IF NOT EXISTS events_by_meet ON events (meet_id, position)`,

  /**
   * One swimmer in one race. Two coaches entering their own never collide.
   *
   * `entered_at` is what auto-seeding ranks by in place of a real seed time:
   * first entered swims the middle lane until the app has a time to seed by.
   * Seating someone never writes here — see `swims` — so this table can
   * disagree with who's actually in a lane, on purpose.
   */
  `CREATE TABLE IF NOT EXISTS entries (
     meet_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     athlete_id TEXT NOT NULL,
     seed_time_ms INTEGER,
     exhibition INTEGER NOT NULL DEFAULT 0,
     entered_at INTEGER NOT NULL DEFAULT 0,
     entered_by TEXT,
     PRIMARY KEY (event_id, athlete_id),
     FOREIGN KEY (meet_id, event_id) 
       REFERENCES events(meet_id, event_id) 
       ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS entries_by_meet ON entries (meet_id)`,
  `CREATE INDEX IF NOT EXISTS entries_by_athlete ON entries (athlete_id)`,

  /**
   * One planned swim. The unit everything about running a meet hangs off.
   *
   * There is no heats table: a heat is which heat, a small integer, so the
   * heats of an event are the distinct heats across its swims and a heat
   * cannot exist with nothing in it. Keyed by event, heat and lane, so the
   * coach seeding, the administrator correcting the desk and the timer fixing
   * a name behind the blocks all write the same row and the last wins.
   *
   * The `id` is what lets a time survive somebody being moved: watches point
   * at it, not at a lane number. `status`/`official_time_ms`/`decided_*` are
   * absent until an administrator signs the swim off — there is no separate
   * results table; the decision lives on the swim it's about.
   */
  `CREATE TABLE IF NOT EXISTS swims (
     meet_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     heat INTEGER NOT NULL,
     lane INTEGER NOT NULL,
     athlete_id TEXT NOT NULL,
     athlete_name TEXT NOT NULL DEFAULT '',
     athlete_team TEXT NOT NULL DEFAULT '',
     exhibition INTEGER NOT NULL DEFAULT 0,
     status TEXT,
     official_time_ms INTEGER,
     decided_at INTEGER,
     decided_by TEXT,

     PRIMARY KEY (meet_id, event_id, heat, lane),
     FOREIGN KEY (meet_id, event_id) 
       REFERENCES events(meet_id, event_id) 
       ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS swims_by_meet ON swims (meet_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS swims_by_lane ON swims (event_id, heat, lane)`,

  /**
   * Evidence. Append-only: a correction is a new row, never an edit to an old
   * one, so nothing here is ever overwritten and a re-send after a dropped
   * connection just adds a row a diff will find identical to the last.
   *
   * `time_ms` is null while a stopwatch is running and nothing has been
   * submitted — which is how the desk tells a lane nobody is covering from one
   * whose timers are still holding their clocks. `slot` is which of one
   * submitter's concurrent stopwatches this is (clipboard mode); the current
   * state of a slot is its latest row by `submitted_at`, which is what
   * `currentWatches` (`timing.ts`) computes — history below that stays, on
   * purpose, as the audit trail.
   */
  `CREATE TABLE IF NOT EXISTS watches (
     meet_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     heat INTEGER NOT NULL,
     lane INTEGER NOT NULL,
     device_id TEXT NOT NULL,
     slot INTEGER NOT NULL DEFAULT 1,
     role TEXT NOT NULL DEFAULT 'timer',
     user_id TEXT,
     time_ms INTEGER,
     started_at INTEGER,
     stopped_at INTEGER,
     recorded_at INTEGER NOT NULL,

     PRIMARY KEY (meet_id, event_id, heat, lane, device_id, slot),
     FOREIGN KEY (meet_id, event_id) 
       REFERENCES events(meet_id, event_id) 
       ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS watches_by_meet ON watches (meet_id)`,
  `CREATE INDEX IF NOT EXISTS watches_by_swim ON watches (swim_id, timer_id, slot)`,
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

/** For tests and scripts that want the statements without the memoisation. */
export const SCHEMA_STATEMENTS = SCHEMA;
