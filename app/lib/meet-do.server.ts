/**
 * One Meet Durable Object per meet — `env.MEET_DO.getByName(meetId)`.
 *
 * Owns the live, multi-writer, race-day state (`entries`, `swims`, `watches`)
 * for exactly the duration of the meet: hydrated from D1 the first time
 * anything touches the meet, dumped back to D1 on a periodic checkpoint and
 * at meet end.
 *
 * Table shapes mirror `schema.server.ts` exactly, `meet_id` column included,
 * so hydration and the dump back are plain row copies rather than a reshape.
 * The write methods mirror `meets.server.ts`'s D1 versions the same way, one
 * table row at a time, just against local (synchronous) SQLite instead of D1.
 */

import { DurableObject } from "cloudflare:workers";
import { generateId } from "./id";
import { athleteRow, putAthlete, type AthleteRow } from "./athletes.server";
import { enrolVisitor } from "./teams.server";
import { getMeet } from "./meets.server";
import { mayEnter, type MeetAccess } from "./access";
import { whyNotEnter } from "./events";
import { reseedEvent } from "./heats";
import type { isLiveSignal, MeetBroadcast, Write } from "./writes";
import type {
  Meet,
  Event,
  MeetSnapshot,
  ResultStatus,
  Swim,
  Stroke,
  Watch,
  SwimKey,
  MeetManifest,
  Entry,
  EntryKey,
} from "~/types/meet";
import { athleteName, toEntryKey, toSwimKey } from "~/types/meet";
import type { Athlete, Gender } from "~/types/athlete";

const SCHEMA = [
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

     PRIMARY KEY (meet_id, event_id, heat, lane)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS swims_by_lane ON swims (event_id, heat, lane)`,

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
     FOREIGN KEY (meet_id, event_id, heat, lane) 
       REFERENCES swims(meet_id, event_id, heat, lane) 
       ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS watches_by_swim ON watches (event_id, heat, lane)`,

  `CREATE TABLE IF NOT EXISTS entries (
     meet_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     athlete_id TEXT NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
     seed_time_ms INTEGER,
     exhibition INTEGER NOT NULL DEFAULT 0,
     entered_at INTEGER NOT NULL DEFAULT 0,
     entered_by TEXT,
     PRIMARY KEY (event_id, athlete_id)
   )`,
  `CREATE TABLE IF NOT EXISTS teams (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     code TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS athletes (
     id TEXT PRIMARY KEY,
     first_name TEXT NOT NULL,
     last_name TEXT NOT NULL,
     gender TEXT NOT NULL,
     team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
     birth_date TEXT,
     user_id TEXT
   )`,

  // Bookkeeping the three tables above don't need for themselves: which meet
  // this instance is (a DO doesn't know its own name — see `ensureHydrated`)
  // and whether the D1 copy has already been pulled in once.
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

/** How D1 rows for the three live tables come back, before mapping to POCOs. */
interface SwimRow {
  [key: string]: SqlStorageValue;
  id: string;
  meet_id: string;
  event_id: string;
  heat: number;
  lane: number;
  athlete_id: string;
  athlete_name: string;
  athlete_team: string;
  exhibition: number | null;
  status: string | null;
  official_time_ms: number | null;
  decided_at: number | null;
  decided_by: string | null;
}

interface WatchRow {
  [key: string]: SqlStorageValue;
  meet_id: string;
  event_id: string;
  heat: number;
  lane: number;
  device_id: string;
  user_id: string | null;
  role: string;
  slot: number;
  time_ms: number | null;
  started_at: number | null;
  stopped_at: number | null;
  recorded_at: number;
}
interface EntryRow {
  [key: string]: SqlStorageValue;
  id: string;
  meet_id: string;
  event_id: string;
  athlete_id: string;
  seed_time_ms: number | null;
  exhibition: number | null;
  entered_at: number;
  entered_by: string;
}

/** D1's `events` row — read fresh for `declareEntry`'s checks, since the
 *  programme is setup data the DO doesn't own. */
interface EventRow {
  id: string;
  meet_id: string;
  eventNumber: number;
  position: number;
  distance: number;
  stroke: string;
  gender: string;
  name: string | null;
}

function eventFromRow(row: EventRow): Event {
  return {
    id: row.id,
    eventNumber: row.eventNumber,
    position: row.position,
    distance: row.distance,
    stroke: row.stroke as Stroke,
    gender: row.gender as Event["gender"],
    name: row.name ?? undefined,
  };
}
function asResultStatus(value: string | null): ResultStatus | undefined {
  if (value === "DQ" || value === "NS") return value;
  return value === "OK" ? "OK" : undefined;
}
function swimFromRow(row: SwimRow): Swim {
  return {
    id: row.id,
    eventId: row.event_id,
    heat: row.heat,
    lane: row.lane,
    athleteId: row.athlete_id,
    athleteName: row.athlete_name,
    athleteTeam: row.athlete_team,
    exhibition: row.exhibition === 1 ? true : false,
    status: asResultStatus(row.status),
    officialTimeMs: row.official_time_ms ?? undefined,
    decidedAt: row.decided_at ?? undefined,
    decidedBy: row.decided_by ?? undefined,
  };
}
function watchFromRow(row: WatchRow): Watch {
  return {
    eventId: row.event_id,
    heat: row.heat,
    lane: row.lane,
    deviceId: row.device_id,
    slot: row.slot,
    role: row.role === "admin" || row.role === "coach" ? row.role : "timer",
    userId: row.user_id ?? undefined,
    timeMs: row.time_ms ?? undefined,
    startedAt: row.started_at ?? undefined,
    stoppedAt: row.stopped_at ?? undefined,
    recordedAt: row.recorded_at,
  };
}
function entryFromRow(row: EntryRow): Entry {
  return {
    id: row.id,
    athleteId: row.athlete_id,
    eventId: row.event_id,
    seedTimeMs: row.seed_time_ms ?? undefined,
    exhibition: row.exhibition === 1 ? true : false,
    enteredAt: row.entered_at,
    enteredBy: row.entered_by,
  };
}
/** One RPC write method's input: the matching `Write` variant, kind dropped
 *  (the method name already says it). */
type WriteOf<K extends Write["kind"]> = Omit<
  Extract<Write, { kind: K }>,
  "kind"
>;

/** Who a live connection is, resolved by the Worker before the upgrade ever
 *  reaches the DO — see `api.meet.live.ts`. */
export type MeetRole = "admin" | "coach" | "timer" | "spectator";

/** How often the DO mirrors its live tables back to D1 while a meet is
 *  connected — insurance, not the primary durability mechanism (DO SQLite
 *  storage already is one). */
const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;

export class MeetDurableObject extends DurableObject<Env> {
  /** Lost on eviction, rebuilt from D1 by `loadRoster` on the next request —
   *  a small in-memory cache for rendering names against seeds without
   *  hitting D1 on every read. Not the source of truth for anything. */
  private roster = new Map<string, Athlete>();
  private hydrated = false;
  private rosterLoaded = false;
  private hydrating: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
    });
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Pull this meet's live tables in from D1, once ever per DO lifetime.
   *
   * Not run from the constructor's `blockConcurrencyWhile` — that's for
   * schema setup only, never for I/O — so instead every RPC method calls
   * this first and a single in-flight promise is
   * shared by whichever requests arrive while it's still running. Without
   * that, two RPC calls landing before hydration finishes would each see
   * "not hydrated yet" and hydrate twice: D1 reads aren't storage operations,
   * so they don't get an input gate, and requests can interleave across the
   * `await`.
   *
   * A DO doesn't know its own name, so `meetId` is passed in by every caller
   * rather than asked for — same reason every `Write` variant already
   * carries one.
   */
  private async ensureHydrated(meetId: string): Promise<void> {
    if (this.hydrated) {
      if (!this.rosterLoaded) await this.loadRoster(meetId);
      return;
    }
    if (!this.hydrating) this.hydrating = this.hydrate(meetId);
    await this.hydrating;
  }

  private async hydrate(meetId: string): Promise<void> {
    // Storage surviving a prior instance of this same DO (an eviction, not a
    // cold meet) shows up here as a meta row — pulling from D1 again would
    // stomp on writes made since the last dump.
    const already = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'meetId'")
      .toArray();
    if (already.length === 0) await this.hydrateFromD1(meetId);

    await this.loadRoster(meetId);
    this.hydrated = true;
    this.rosterLoaded = true;

    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) {
      await this.ctx.storage.setAlarm(Date.now() + CHECKPOINT_INTERVAL_MS);
    }
  }

  private async hydrateFromD1(meetId: string): Promise<void> {
    const db = this.env.DB;
    const [swims, watches, entries] = await Promise.all([
      db
        .prepare("SELECT * FROM swims WHERE meet_id = ?")
        .bind(meetId)
        .all<SwimRow>(),
      db
        .prepare("SELECT * FROM watches WHERE meet_id = ?")
        .bind(meetId)
        .all<WatchRow>(),
      db
        .prepare("SELECT * FROM entries WHERE meet_id = ?")
        .bind(meetId)
        .all<EntryRow>(),
    ]);

    for (const s of swims.results) {
      this.ctx.storage.sql.exec(
        `INSERT INTO swims (id, meet_id, event_id, heat, lane, athlete_id, athlete_name, athlete_team, exhibition, status, official_time_ms, decided_at, decided_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        s.id,
        s.meet_id,
        s.event_id,
        s.heat,
        s.lane,
        s.athlete_id,
        s.athlete_name,
        s.athlete_team,
        s.exhibition,
        s.status,
        s.official_time_ms,
        s.decided_at,
        s.decided_by,
      );
    }
    for (const w of watches.results) {
      this.ctx.storage.sql.exec(
        `INSERT INTO watches (id, swim_id, meet_id, submitted_by, user_id, role, slot, time_ms, started_at, stopped_at, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        w.id,
        w.swim_id,
        w.meet_id,
        w.timer_id,
        w.user_id,
        w.role,
        w.slot,
        w.time_ms,
        w.started_at,
        w.stopped_at,
        w.recorded_at,
      );
    }
    for (const e of entries.results) {
      this.ctx.storage.sql.exec(
        `INSERT INTO entries (meet_id, event_id, athlete_id, seed_time_ms, exhibition, entered_at, entered_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        e.meet_id,
        e.event_id,
        e.athlete_id,
        e.seed_time_ms,
        e.exhibition,
        e.entered_at,
        e.entered_by,
      );
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('meetId', ?)",
      meetId,
    );
  }

  /** Everyone the live tables currently name, for rendering without a D1 trip. */
  private async loadRoster(meetId: string): Promise<void> {
    const rows = await this.env.DB.prepare(
      `SELECT DISTINCT a.* FROM athletes a
       WHERE a.id IN (SELECT athlete_id FROM entries WHERE meet_id = ?)
          OR a.id IN (SELECT athlete_id FROM swims WHERE meet_id = ? AND athlete_id != '')`,
    )
      .bind(meetId, meetId)
      .all<AthleteRow>();
    this.roster = new Map(rows.results.map((row) => [row.id, athleteRow(row)]));
  }

  /**
   * Mirror the live tables back to D1. Called on the periodic checkpoint
   * alarm and by `finalizeMeet`; a full replace rather than an upsert, since
   * a lane un-seated or a watch dropped in the DO has to disappear from D1
   * too, not just have its later state overwritten.
   */
  private async dumpToD1(meetId: string): Promise<void> {
    const db = this.env.DB;
    const swims = this.ctx.storage.sql
      .exec<SwimRow>("SELECT * FROM swims WHERE meet_id = ?", meetId)
      .toArray();
    const watches = this.ctx.storage.sql
      .exec<WatchRow>("SELECT * FROM watches WHERE meet_id = ?", meetId)
      .toArray();
    const entries = this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM entries WHERE meet_id = ?", meetId)
      .toArray();

    await db.batch([
      db.prepare("DELETE FROM swims WHERE meet_id = ?").bind(meetId),
      db.prepare("DELETE FROM watches WHERE meet_id = ?").bind(meetId),
      db.prepare("DELETE FROM entries WHERE meet_id = ?").bind(meetId),
      ...swims.map((s) =>
        db
          .prepare(
            `INSERT INTO swims (id, meet_id, event_id, heat, lane, athlete_id, athlete_name, athlete_team, exhibition, status, official_time_ms, decided_at, decided_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            s.id,
            s.meet_id,
            s.event_id,
            s.heat,
            s.lane,
            s.athlete_id,
            s.athlete_name,
            s.athlete_team,
            s.exhibition,
            s.status,
            s.official_time_ms,
            s.decided_at,
            s.decided_by,
          ),
      ),
      ...watches.map((w) =>
        db
          .prepare(
            `INSERT INTO watches (id, swim_id, meet_id, submitted_by, user_id, role, slot, time_ms, started_at, stopped_at, submitted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            w.id,
            w.swim_id,
            w.meet_id,
            w.timer_id,
            w.user_id,
            w.role,
            w.slot,
            w.time_ms,
            w.started_at,
            w.stopped_at,
            w.recorded_at,
          ),
      ),
      ...entries.map((e) =>
        db
          .prepare(
            `INSERT INTO entries (meet_id, event_id, athlete_id, seed_time_ms, exhibition, entered_at, entered_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            e.meet_id,
            e.event_id,
            e.athlete_id,
            e.seed_time_ms,
            e.exhibition,
            e.entered_at,
            e.entered_by,
          ),
      ),
    ]);
  }

  /** The periodic checkpoint. Reschedules itself only while somebody's still
   *  connected — a meet nobody is watching has nothing new to mirror. */
  async alarm(): Promise<void> {
    const meetId = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'meetId'")
      .toArray()[0]?.value;
    if (!meetId) return;

    await this.dumpToD1(meetId);
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + CHECKPOINT_INTERVAL_MS);
    }
  }

  /** The explicit end-of-meet dump. Not wired to any UI yet — nothing calls
   *  this to mark a meet finished — but the RPC method exists for when
   *  something does. */
  async finalizeMeet(meetId: string): Promise<void> {
    await this.ensureHydrated(meetId);
    await this.dumpToD1(meetId);
    await this.ctx.storage.deleteAlarm();
  }

  /* --------------------------------------------------------------- reading */

  async getSnapshot(meetId: string): Promise<MeetSnapshot> {
    await this.ensureHydrated(meetId);

    const swims = this.ctx.storage.sql
      .exec<SwimRow>("SELECT * FROM swims WHERE meet_id = ?", meetId)
      .toArray()
      .map(swimFromRow);
    const watches = this.ctx.storage.sql
      .exec<WatchRow>("SELECT * FROM watches WHERE meet_id = ?", meetId)
      .toArray()
      .map(watchFromRow);
    const entries = this.readEntries(meetId);

    const wanted = new Set<string>();
    for (const list of Object.values(entries))
      for (const id of list) wanted.add(id);
    for (const swim of swims) if (swim.athleteId) wanted.add(swim.athleteId);
    const athletes = [...wanted]
      .map((id) => this.roster.get(id))
      .filter((a): a is Athlete => !!a);

    return { entries, swims, watches, athletes };
  }

  async getSnapshotNew(meetId: string): Promise<MeetManifest> {
    await this.ensureHydrated(meetId);

    const swims = this.ctx.storage.sql
      .exec<SwimRow>("SELECT * FROM swims WHERE meet_id = ?", meetId)
      .toArray()
      .map(swimFromRow)
      .reduce<Record<SwimKey, Swim>>((record, swim) => {
        record[toSwimKey(swim)] = swim;
        return record;
      }, {});

    const entries = this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM entries WHERE meet_id = ?", meetId)
      .toArray()
      .map(entryFromRow)
      .reduce<Record<EntryKey, Entry>>((record, entry) => {
        record[toEntryKey(entry)] = entry;
        return record;
      }, {});

    const watches = this.ctx.storage.sql
      .exec<WatchRow>("SELECT * FROM watches WHERE meet_id = ?", meetId)
      .toArray()
      .map(watchFromRow)
      .reduce<Record<string, Watch>>((record, watch) => {
        record[watch.id] = watch;
        return record;
      }, {});

    //const entries = this.readEntries(meetId);

    const wanted = new Set<string>();
    for (const list of Object.values(entries))
      for (const id of list) wanted.add(id);
    for (const swim of Object.values(swims))
      if (swim.athleteId) wanted.add(swim.athleteId);
    const athletes: Record<string, Athlete> = {};

    for (const id of wanted) {
      const athlete = this.roster.get(id);
      if (athlete) {
        athletes[id] = athlete;
      }
    }
    return { entries, swims, watches, athletes };
  }

  /** Every declared entry, by event — the DO's own, not D1's, now that
   *  `declareEntry` is the only place an entry is written. */
  private readEntries(meetId: string): Record<string, string[]> {
    const rows = this.ctx.storage.sql
      .exec<EntryRow>(
        "SELECT * FROM entries WHERE meet_id = ? ORDER BY entered_at",
        meetId,
      )
      .toArray();
    const entries: Record<string, string[]> = {};
    for (const row of rows) (entries[row.event_id] ??= []).push(row.athlete_id);
    return entries;
  }

  /**
   * Full entry rows for one event, keyed by athlete — what `reseedIfUntouched`
   * needs to copy `exhibition` onto a swim it creates. Not part of
   * `getSnapshot`'s public shape: nothing outside seeding needs a whole
   * `Entry`, just the athlete list `readEntries` already gives it.
   */
  private readEntryRows(
    meetId: string,
    eventId: string,
  ): Map<string, EntryRow> {
    const rows = this.ctx.storage.sql
      .exec<EntryRow>(
        "SELECT * FROM entries WHERE meet_id = ? AND event_id = ?",
        meetId,
        eventId,
      )
      .toArray();
    return new Map(rows.map((row) => [row.athlete_id, row]));
  }

  /* --------------------------------------------------------- write methods */
  //
  // One per `Write` kind, named for the action rather than the union's own
  // kind names (`seat` not `swim`, and so on) — the RPC surface a caller
  // reads, not the wire format it happens to share. Each ends by
  // broadcasting the very `Write` it just applied, so `applyPending` can
  // fold a broadcast over a cached snapshot exactly the way it folds a
  // pending write over loader data.

  async seat(input: WriteOf<"swim">): Promise<Swim> {
    await this.ensureHydrated(input.meetId);

    const existing = this.ctx.storage.sql
      .exec<SwimRow>(
        "SELECT * FROM swims WHERE event_id = ? AND heat = ? AND lane = ?",
        input.eventId,
        input.heat,
        input.lane,
      )
      .toArray()[0];

    // Nobody swims an event twice — vacate whatever other lane they held.
    this.ctx.storage.sql.exec(
      `DELETE FROM swims WHERE event_id = ? AND athlete_id = ? AND NOT (heat = ? AND lane = ?)`,
      input.eventId,
      input.athleteId,
      input.heat,
      input.lane,
    );

    const { name, team } = await this.resolveAthleteDisplay(
      input.meetId,
      input.athleteId,
    );

    const id = existing?.id ?? input.swimId;
    this.ctx.storage.sql.exec(
      `INSERT INTO swims (id, meet_id, event_id, heat, lane, athlete_id, athlete_name, athlete_team, exhibition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(event_id, heat, lane) DO UPDATE SET
         athlete_id = excluded.athlete_id,
         athlete_name = excluded.athlete_name,
         athlete_team = excluded.athlete_team`,
      id,
      input.meetId,
      input.eventId,
      input.heat,
      input.lane,
      input.athleteId,
      name,
      team,
    );

    // Deliberately no entries write here — seating never backports to an
    // entry, from any caller. See `migration-plan.md`.
    this.broadcast({ kind: "swim", ...input });
    return {
      id,
      eventId: input.eventId,
      heat: input.heat,
      lane: input.lane,
      athleteId: input.athleteId,
      athleteName: name,
      athleteTeam: team,
      exhibition: existing?.exhibition === 1 ? true : undefined,
    };
  }

  async unseat(input: WriteOf<"unswim">): Promise<void> {
    await this.ensureHydrated(input.meetId);
    this.ctx.storage.sql.exec(
      "DELETE FROM watches WHERE swim_id = ?",
      input.swimId,
    );
    this.ctx.storage.sql.exec("DELETE FROM swims WHERE id = ?", input.swimId);
    this.broadcast({ kind: "unswim", ...input });
  }

  /**
   * Name and team to stamp onto a swim at seat time (`Swim.athleteName`/
   * `athleteTeam`), so the timer workspace can render a lane without
   * carrying a roster. Falls back to D1 when the roster cache hasn't loaded
   * this athlete yet — a walk-up added moments earlier, say.
   */
  private async resolveAthleteDisplay(
    meetId: string,
    athleteId: string,
  ): Promise<{ name: string; team: string }> {
    if (!athleteId) return { name: "", team: "" };

    let athlete = this.roster.get(athleteId);
    if (!athlete) {
      const row = await this.env.DB.prepare(
        "SELECT * FROM athletes WHERE id = ?",
      )
        .bind(athleteId)
        .first<AthleteRow>();
      if (row) {
        athlete = athleteRow(row);
        this.roster.set(athlete.id, athlete);
      }
    }
    const name = athlete ? athleteName(athlete) : "";

    const meet = await getMeet(this.env.DB, meetId);
    if (!meet || meet.teamIds.length === 0) return { name, team: "" };

    const row = await this.env.DB.prepare(
      `SELECT t.code FROM enrollments e JOIN teams t ON t.id = e.team_id
       WHERE e.athlete_id = ? AND e.team_id IN (${meet.teamIds.map(() => "?").join(",")})
       LIMIT 1`,
    )
      .bind(athleteId, ...meet.teamIds)
      .first<{ code: string }>();
    return { name, team: row?.code ?? "" };
  }

  /**
   * The swim in a lane, made to exist because something was timed against it
   * before anybody said who was there — mirrors `meets.server.ts`'s D1
   * version of the same idea. Not a `Write` kind of its own: nobody decides
   * to "ensure a lane", it's what `recordWatch`/`setExhibition`'s caller
   * reaches for when it doesn't yet know whether a swim exists (the timer's
   * cookie path in `seed-cookie.server.ts`, which addresses by event/heat/
   * lane rather than by a swim id it would have to already know).
   */
  async ensureLane(input: {
    meetId: string;
    eventId: string;
    heat: number;
    lane: number;
  }): Promise<Swim> {
    await this.ensureHydrated(input.meetId);

    const existing = this.ctx.storage.sql
      .exec<SwimRow>(
        "SELECT * FROM swims WHERE event_id = ? AND heat = ? AND lane = ?",
        input.eventId,
        input.heat,
        input.lane,
      )
      .toArray()[0];
    if (existing) return swimFromRow(existing);

    const id = generateId();
    this.ctx.storage.sql.exec(
      `INSERT INTO swims (id, meet_id, event_id, heat, lane, athlete_id, athlete_name, athlete_team, exhibition)
       VALUES (?, ?, ?, ?, ?, '', '', '', 0)
       ON CONFLICT(event_id, heat, lane) DO NOTHING`,
      id,
      input.meetId,
      input.eventId,
      input.heat,
      input.lane,
    );
    // Re-read rather than trusting the insert: two timers on the same lane
    // can both arrive here, and the one that lost has to come away with the
    // id that won, or their watches would hang off two different swims.
    const swim = this.ctx.storage.sql
      .exec<SwimRow>(
        "SELECT * FROM swims WHERE event_id = ? AND heat = ? AND lane = ?",
        input.eventId,
        input.heat,
        input.lane,
      )
      .toArray()[0]!;
    return swimFromRow(swim);
  }

  async setExhibition(input: WriteOf<"exhibition">): Promise<void> {
    await this.ensureHydrated(input.meetId);
    this.ctx.storage.sql.exec(
      "UPDATE swims SET exhibition = ? WHERE id = ?",
      input.exhibition ? 1 : 0,
      input.swimId,
    );
    this.broadcast({ kind: "exhibition", ...input });
  }

  /**
   * Append-only: always a new row, never an update to an old one — see
   * `Watch`'s doc comment. Callers (`seed-cookie.server.ts`, the WS fast
   * path) are responsible for not re-submitting a slot's unchanged state, so
   * this doesn't grow a duplicate row for every re-render of the same cookie.
   */
  async recordWatch(input: WriteOf<"watch">): Promise<void> {
    await this.ensureHydrated(input.meetId);
    this.ctx.storage.sql.exec(
      `INSERT INTO watches (id, swim_id, meet_id, submitted_by, user_id, role, slot, time_ms, started_at, stopped_at, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      generateId(),
      input.swimId,
      input.meetId,
      input.timerId,
      input.userId ?? null,
      input.role,
      input.slot ?? 1,
      input.timeMs ?? null,
      input.startedAt ?? null,
      input.stoppedAt ?? null,
      input.submittedAt,
    );
    this.broadcast({ kind: "watch", ...input });
  }

  /** Clears a slot's whole history — "this clock claim shouldn't exist,"
   *  not a correction (that's a new `recordWatch`). */
  async dropWatch(input: WriteOf<"drop-watch">): Promise<void> {
    await this.ensureHydrated(input.meetId);
    this.ctx.storage.sql.exec(
      "DELETE FROM watches WHERE swim_id = ? AND submitted_by = ? AND slot = ?",
      input.swimId,
      input.timerId,
      input.slot ?? 1,
    );
    this.broadcast({ kind: "drop-watch", ...input });
  }

  /**
   * `decidedBy` isn't part of the `result` `Write` — it's the caller's own
   * identity, resolved by the Worker before this RPC is ever reached, the
   * same way `api.meet.writes.ts` resolves it from the session today rather
   * than trusting it in the request body. Writes straight onto the swim's
   * own row — there is no separate results table to upsert into.
   */
  async decideResult(
    input: WriteOf<"result">,
    decidedBy?: string,
  ): Promise<void> {
    await this.ensureHydrated(input.meetId);
    const swim = this.ctx.storage.sql
      .exec<SwimRow>("SELECT * FROM swims WHERE id = ?", input.swimId)
      .toArray()[0];
    if (!swim) throw new Error("That swim is no longer in the meet");

    this.ctx.storage.sql.exec(
      `UPDATE swims SET status = ?, official_time_ms = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
      input.status,
      input.timeMs,
      input.auto ? "auto" : (decidedBy ?? null),
      Date.now(),
      input.swimId,
    );
    this.broadcast({ kind: "result", ...input });
  }

  async undecideResult(input: WriteOf<"unresult">): Promise<void> {
    await this.ensureHydrated(input.meetId);
    this.ctx.storage.sql.exec(
      `UPDATE swims SET status = NULL, official_time_ms = NULL, decided_by = NULL, decided_at = NULL WHERE id = ?`,
      input.swimId,
    );
    this.broadcast({ kind: "unresult", ...input });
  }

  /**
   * Entering or scratching one swimmer — now with the auto-reseed
   * `api.meet.writes.ts` used to do against D1 (the gap flagged since step
   * 2/3): entries are DO-owned like the other three live tables, so
   * whether an event is "touched" and what its lineup looks like are both
   * read from here, never from a D1 snapshot that could be stale between
   * checkpoints.
   *
   * `access` is resolved by the Worker from the session before this is ever
   * called — same separation as the WebSocket handshake in `fetch`. Returns
   * a refusal rather than throwing: a DO RPC error crossing the Worker
   * boundary loses everything but a message, and the caller needs a status
   * code to answer with.
   */
  async declareEntry(
    input: WriteOf<"entry">,
    access: MeetAccess,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    await this.ensureHydrated(input.meetId);

    const meet = await getMeet(this.env.DB, input.meetId);
    if (!meet) return { ok: false, status: 404, error: "No such meet" };

    const teamsOf = await this.teamsOfAthlete(input.athleteId);
    if (
      !mayEnter(access, input.athleteId, {
        athletesMayEnter: meet.athletesMayEnter,
        teamsOf: () => teamsOf,
      })
    ) {
      return {
        ok: false,
        status: 403,
        error: "That swimmer isn't yours to enter.",
      };
    }

    if (input.entering) {
      const eventRows = await this.env.DB.prepare(
        "SELECT * FROM events WHERE meet_id = ? ORDER BY position",
      )
        .bind(input.meetId)
        .all<EventRow>();
      const refusal = whyNotEnter(
        {
          events: eventRows.results.map(eventFromRow),
          entries: this.readEntries(input.meetId),
          limits: meet.limits,
        },
        input.athleteId,
        input.eventId,
      );
      if (refusal) return { ok: false, status: 400, error: refusal };

      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO entries (meet_id, event_id, athlete_id, seed_time_ms, exhibition, entered_at, entered_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.meetId,
        input.eventId,
        input.athleteId,
        input.seedTimeMs ?? null,
        input.exhibition ? 1 : 0,
        Date.now(),
        access.userId,
      );
    } else {
      this.ctx.storage.sql.exec(
        "DELETE FROM entries WHERE event_id = ? AND athlete_id = ?",
        input.eventId,
        input.athleteId,
      );
    }
    this.broadcast({ kind: "entry", ...input });

    await this.reseedIfUntouched(input.meetId, input.eventId, meet);
    return { ok: true };
  }

  /** Every team an athlete is enrolled on, anywhere — enough for `mayEnter`'s
   *  "is this one of the teams you coach" check, which only cares whether
   *  any of them intersects `access.coachOf`. */
  private async teamsOfAthlete(athleteId: string): Promise<string[]> {
    const { results } = await this.env.DB.prepare(
      "SELECT DISTINCT team_id FROM enrollments WHERE athlete_id = ?",
    )
      .bind(athleteId)
      .all<{ team_id: string }>();
    return results.map((r) => r.team_id);
  }

  /**
   * Re-seed an event over its current entrants, exactly the rule
   * `api.meet.writes.ts` always followed: skipped once anything has been
   * recorded against the event, since a scratch or a late entry must not
   * rearrange a swim that's already been timed.
   *
   * Persists as a full replace — `reseedEvent` can change the id set's shape
   * (fewer or more swimmers) even though most ids carry over unchanged — but
   * broadcasts only the swims that actually moved, so a lane nobody touched
   * doesn't flicker on every connected screen. An un-entered swim (a walk-up
   * nobody's backfilled an entry for) isn't in `entrants` at all, so it can
   * be reflowed or dropped by this same pass — accepted, per
   * `migration-plan.md`.
   */
  private async reseedIfUntouched(
    meetId: string,
    eventId: string,
    meet: Pick<Meet, "teamIds" | "laneAssignments" | "laneCount">,
  ): Promise<void> {
    const swims = this.ctx.storage.sql
      .exec<SwimRow>("SELECT * FROM swims WHERE event_id = ?", eventId)
      .toArray()
      .map(swimFromRow);
    const watches = this.ctx.storage.sql
      .exec<WatchRow>(
        `SELECT w.* FROM watches w JOIN swims s ON s.id = w.swim_id WHERE s.event_id = ?`,
        eventId,
      )
      .toArray()
      .map(watchFromRow);

    const entrants = this.readEntries(meetId)[eventId] ?? [];
    const teamOf = await this.teamOfMap(entrants, meet.teamIds);
    const teamCodes = await this.teamCodesOf(meet.teamIds);
    const entryRows = this.readEntryRows(meetId, eventId);

    const displayOf = (athleteId: string) => {
      const athlete = this.roster.get(athleteId);
      const teamId = teamOf.get(athleteId);
      return {
        name: athlete ? athleteName(athlete) : "",
        team: teamId ? (teamCodes.get(teamId) ?? "") : "",
      };
    };
    const exhibitionOf = (athleteId: string) =>
      entryRows.get(athleteId)?.exhibition === 1 ? true : undefined;

    const nextSwims = reseedEvent(
      { swims, watches },
      meetId,
      eventId,
      entrants,
      (athleteId) => teamOf.get(athleteId),
      meet.laneAssignments,
      meet.laneCount,
      displayOf,
      exhibitionOf,
    );
    // Only null when the event turned out to be touched.
    if (!nextSwims) return;

    const before = new Map(swims.map((s) => [s.id, s] as const));

    this.ctx.storage.sql.exec(
      `DELETE FROM watches WHERE swim_id IN (SELECT id FROM swims WHERE event_id = ?)`,
      eventId,
    );
    this.ctx.storage.sql.exec(`DELETE FROM swims WHERE event_id = ?`, eventId);
    for (const swim of nextSwims) {
      this.ctx.storage.sql.exec(
        `INSERT INTO swims (id, meet_id, event_id, heat, lane, athlete_id, athlete_name, athlete_team, exhibition)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        swim.id,
        meetId,
        eventId,
        swim.heat,
        swim.lane,
        swim.athleteId,
        swim.athleteName,
        swim.athleteTeam,
        swim.exhibition ? 1 : 0,
      );
    }

    const after = new Set(nextSwims.map((s) => s.id));
    for (const id of before.keys()) {
      if (!after.has(id))
        this.broadcast({ kind: "unswim", meetId, swimId: id });
    }
    for (const swim of nextSwims) {
      const prior = before.get(swim.id);
      if (
        prior &&
        prior.heat === swim.heat &&
        prior.lane === swim.lane &&
        prior.athleteId === swim.athleteId
      ) {
        continue; // Unmoved — nothing for a connected screen to redraw.
      }
      this.broadcast({
        kind: "swim",
        meetId,
        eventId,
        heat: swim.heat,
        lane: swim.lane,
        athleteId: swim.athleteId,
        swimId: swim.id,
      });
    }
  }

  /** `teamId -> code`, for stamping `Swim.athleteTeam` with what a heat
   *  sheet actually shows rather than an internal id. */
  private async teamCodesOf(teamIds: string[]): Promise<Map<string, string>> {
    if (teamIds.length === 0) return new Map();
    const { results } = await this.env.DB.prepare(
      `SELECT id, code FROM teams WHERE id IN (${teamIds.map(() => "?").join(",")})`,
    )
      .bind(...teamIds)
      .all<{ id: string; code: string }>();
    return new Map(results.map((r) => [r.id, r.code] as const));
  }

  /** `athleteId -> teamId`, scoped to this meet's own racing teams — what
   *  `reseedEvent` needs to know whose own lanes an entrant reaches for. */
  private async teamOfMap(
    athleteIds: string[],
    racingTeamIds: string[],
  ): Promise<Map<string, string>> {
    if (athleteIds.length === 0 || racingTeamIds.length === 0) return new Map();
    const { results } = await this.env.DB.prepare(
      `SELECT athlete_id, team_id FROM enrollments
       WHERE athlete_id IN (${athleteIds.map(() => "?").join(",")})
         AND team_id IN (${racingTeamIds.map(() => "?").join(",")})`,
    )
      .bind(...athleteIds, ...racingTeamIds)
      .all<{ athlete_id: string; team_id: string }>();
    return new Map(results.map((r) => [r.athlete_id, r.team_id] as const));
  }

  /**
   * A name added behind the blocks. Athletes and enrollments are global —
   * the deck-entry exception — so this writes straight to D1, same as any
   * other roster edit, then updates the roster cache and broadcasts so every
   * connected client can render the name immediately rather than waiting
   * for their next full snapshot.
   */
  async addWalkupAthlete(input: {
    meetId: string;
    teamId: string;
    firstName: string;
    lastName: string;
    /** No birth date and, absent a caller that knows better, no real gender
     *  signal from a walk-up either — same default this always used. */
    gender?: Gender;
    /**
     * Client-minted when the caller needs re-applying the same not-yet-
     * acknowledged request to upsert the same person rather than mint a
     * duplicate (see the timer's seed cookie). Server-minted otherwise.
     */
    id?: string;
  }): Promise<Athlete> {
    await this.ensureHydrated(input.meetId);

    const athlete = await putAthlete(this.env.DB, {
      id: input.id,
      firstName: input.firstName,
      lastName: input.lastName,
      gender: input.gender ?? "F",
    });
    await enrolVisitor(this.env.DB, input.meetId, input.teamId, athlete.id);

    this.roster.set(athlete.id, athlete);
    this.broadcast({ kind: "walkup", meetId: input.meetId, athlete });
    return athlete;
  }

  /* -------------------------------------------------------------- sockets */

  /**
   * The live connection. Only reached via `api.meet.live.ts`, which resolves
   * `role`/`userId` from the session/grant *before* forwarding the upgrade —
   * this method trusts them rather than parsing a cookie itself.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const meetId = url.searchParams.get("meetId");
    const role = url.searchParams.get("role") as MeetRole | null;
    if (!meetId || !role) {
      return new Response("Missing meetId or role", { status: 400 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    await this.ensureHydrated(meetId);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Tagged by role so a future spectator-payload filter can target
    // `getWebSockets("spectator")` without redesigning the transport.
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({
      meetId,
      role,
      userId: url.searchParams.get("userId") ?? undefined,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * The WS fast path (`migration-plan.md`): armed/stopped visibility, a seat,
   * or an exhibition toggle, sent straight over the already-open socket for
   * latency instead of waiting on the resilient cookie/action round trip.
   * Restricted to `LiveSignal` — never an entry (reseeds, wants a stable
   * request), a timed watch, or a decision (irreversible) — those stay on
   * the resilient path or an explicit action, never "fire and hope".
   *
   * Trust here is coarse, matching `fetch`'s own: `role` is whatever the
   * Worker tagged the connection with at handshake (not re-checked against
   * `meetAccess` per message), and a spectator is refused outright. A wrong
   * or malicious signal costs at worst a UI hint that self-corrects the next
   * time the cookie or a broadcast catches everyone up — nothing here is the
   * durable record of anything.
   */
  async webSocketMessage(
    ws: WebSocket,
    raw: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof raw !== "string") return;
    const attachment = ws.deserializeAttachment() as {
      meetId: string;
      role: MeetRole;
      userId?: string;
    } | null;
    if (!attachment || attachment.role === "spectator") return;

    let write: Write;
    try {
      write = JSON.parse(raw) as Write;
    } catch {
      return;
    }
    if (!isLiveSignal(write)) return;

    // The connection's own meet, never whatever the message claims — a
    // socket is already scoped to one meet at handshake.
    const meetId = attachment.meetId;
    await this.ensureHydrated(meetId);

    switch (write.kind) {
      case "swim":
        await this.seat({
          meetId,
          eventId: write.eventId,
          heat: write.heat,
          lane: write.lane,
          athleteId: write.athleteId,
          swimId: write.swimId,
        });
        return;
      case "exhibition":
        await this.setExhibition({
          meetId,
          swimId: write.swimId,
          exhibition: write.exhibition,
        });
        return;
      case "watch":
        await this.recordWatch({
          meetId,
          swimId: write.swimId,
          timerId: write.timerId,
          userId: write.userId ?? attachment.userId,
          role: write.role,
          slot: write.slot,
          timeMs: undefined,
          submittedAt: write.submittedAt,
          startedAt: write.startedAt,
          stoppedAt: write.stoppedAt,
        });
        return;
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    if (!wasClean)
      console.warn("meet-do: socket closed uncleanly", { code, reason });
    ws.close(code, reason);
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error("meet-do: socket error", error);
  }

  /**
   * Every connected socket, whatever role it's tagged with. Spectators get
   * the same message as everyone else for now — narrowing that payload is
   * an open product decision, not a blocker for the broadcast mechanism
   * itself.
   */
  private broadcast(message: MeetBroadcast): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // A socket hibernation hasn't reaped yet. It will.
      }
    }
  }
}
