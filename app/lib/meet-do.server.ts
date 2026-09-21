/**
 * One Meet Durable Object per meet — `env.MEET_DO.getByName(meetId)`.
 *
 * Owns the live, multi-writer, race-day state (`seeds`, `watches`, `results`,
 * `entries`) for exactly the duration of the meet: hydrated from D1 the first
 * time anything touches the meet, dumped back to D1 on a periodic checkpoint
 * and at meet end.
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
import type { MeetBroadcast, Write } from "./writes";
import type { Athlete } from "~/types/athlete";
import type {
  Meet,
  Event,
  MeetSnapshot,
  Result,
  Seed,
  Stroke,
  Watch,
} from "~/types/meet";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS seeds (
     id TEXT PRIMARY KEY,
     meet_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     heat INTEGER NOT NULL,
     lane INTEGER NOT NULL,
     athlete_id TEXT NOT NULL,
     seed_time_ms INTEGER,
     exhibition INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS seeds_by_lane ON seeds (event_id, heat, lane)`,

  `CREATE TABLE IF NOT EXISTS watches (
     seed_id TEXT NOT NULL,
     meet_id TEXT NOT NULL,
     timer_id TEXT NOT NULL,
     user_id TEXT,
     role TEXT NOT NULL DEFAULT 'timer',
     time_ms INTEGER,
     recorded_at INTEGER NOT NULL,
     started_at INTEGER,
     stopped_at INTEGER,
     PRIMARY KEY (seed_id, timer_id)
   )`,

  `CREATE TABLE IF NOT EXISTS results (
     seed_id TEXT PRIMARY KEY,
     meet_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     athlete_id TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'OK',
     time_ms INTEGER NOT NULL,
     decided_by TEXT,
     decided_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS entries (
     meet_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     athlete_id TEXT NOT NULL,
     created_at INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (event_id, athlete_id)
   )`,

  // Bookkeeping the four tables above don't need for themselves: which meet
  // this instance is (a DO doesn't know its own name — see `ensureHydrated`)
  // and whether the D1 copy has already been pulled in once.
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

/** How D1 rows for the four live tables come back, before mapping to POCOs. */
interface SeedRow {
  [key: string]: SqlStorageValue;
  id: string;
  meet_id: string;
  event_id: string;
  heat: number;
  lane: number;
  athlete_id: string;
  seed_time_ms: number | null;
  exhibition: number | null;
}
interface WatchRow {
  [key: string]: SqlStorageValue;
  seed_id: string;
  meet_id: string;
  timer_id: string;
  user_id: string | null;
  role: string | null;
  time_ms: number | null;
  recorded_at: number;
  started_at: number | null;
  stopped_at: number | null;
}
interface ResultRow {
  [key: string]: SqlStorageValue;
  seed_id: string;
  meet_id: string;
  event_id: string;
  athlete_id: string;
  status: string;
  time_ms: number;
  decided_by: string | null;
  decided_at: number;
}
interface EntryRow {
  [key: string]: SqlStorageValue;
  meet_id: string;
  event_id: string;
  athlete_id: string;
  created_at: number;
}

/** D1's `events` row — read fresh for `declareEntry`'s checks, since the
 *  programme is setup data the DO doesn't own. */
interface EventRow {
  id: string;
  meet_id: string;
  position: number;
  distance: number;
  stroke: string;
  gender: string;
  name: string | null;
}
function eventFromRow(row: EventRow): Event {
  return {
    id: row.id,
    position: row.position,
    distance: row.distance,
    stroke: row.stroke as Stroke,
    gender: row.gender as Event["gender"],
    name: row.name ?? undefined,
  };
}

function seedFromRow(row: SeedRow): Seed {
  return {
    id: row.id,
    eventId: row.event_id,
    heat: row.heat,
    lane: row.lane,
    athleteId: row.athlete_id,
    seedTimeMs: row.seed_time_ms ?? undefined,
    exhibition: row.exhibition === 1 ? true : undefined,
  };
}
function watchFromRow(row: WatchRow): Watch {
  return {
    seedId: row.seed_id,
    timerId: row.timer_id,
    userId: row.user_id ?? undefined,
    role: row.role === "admin" || row.role === "coach" ? row.role : "timer",
    timeMs: row.time_ms ?? undefined,
    recordedAt: row.recorded_at,
    startedAt: row.started_at ?? undefined,
    stoppedAt: row.stopped_at ?? undefined,
  };
}
function resultFromRow(row: ResultRow): Result {
  return {
    seedId: row.seed_id,
    eventId: row.event_id,
    athleteId: row.athlete_id,
    status: row.status === "DQ" || row.status === "NS" ? row.status : "OK",
    timeMs: row.time_ms,
    decidedBy: row.decided_by ?? undefined,
    decidedAt: row.decided_at,
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
    const [seeds, watches, results, entries] = await Promise.all([
      db
        .prepare("SELECT * FROM seeds WHERE meet_id = ?")
        .bind(meetId)
        .all<SeedRow>(),
      db
        .prepare("SELECT * FROM watches WHERE meet_id = ?")
        .bind(meetId)
        .all<WatchRow>(),
      db
        .prepare("SELECT * FROM results WHERE meet_id = ?")
        .bind(meetId)
        .all<ResultRow>(),
      db
        .prepare("SELECT * FROM entries WHERE meet_id = ?")
        .bind(meetId)
        .all<EntryRow>(),
    ]);

    for (const s of seeds.results) {
      this.ctx.storage.sql.exec(
        `INSERT INTO seeds (id, meet_id, event_id, heat, lane, athlete_id, seed_time_ms, exhibition)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        s.id,
        s.meet_id,
        s.event_id,
        s.heat,
        s.lane,
        s.athlete_id,
        s.seed_time_ms,
        s.exhibition,
      );
    }
    for (const w of watches.results) {
      this.ctx.storage.sql.exec(
        `INSERT INTO watches (seed_id, meet_id, timer_id, user_id, role, time_ms, recorded_at, started_at, stopped_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        w.seed_id,
        w.meet_id,
        w.timer_id,
        w.user_id,
        w.role,
        w.time_ms,
        w.recorded_at,
        w.started_at,
        w.stopped_at,
      );
    }
    for (const r of results.results) {
      this.ctx.storage.sql.exec(
        `INSERT INTO results (seed_id, meet_id, event_id, athlete_id, status, time_ms, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        r.seed_id,
        r.meet_id,
        r.event_id,
        r.athlete_id,
        r.status,
        r.time_ms,
        r.decided_by,
        r.decided_at,
      );
    }
    for (const e of entries.results) {
      this.ctx.storage.sql.exec(
        `INSERT INTO entries (meet_id, event_id, athlete_id, created_at) VALUES (?, ?, ?, ?)`,
        e.meet_id,
        e.event_id,
        e.athlete_id,
        e.created_at,
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
          OR a.id IN (SELECT athlete_id FROM seeds WHERE meet_id = ? AND athlete_id != '')`,
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
    const seeds = this.ctx.storage.sql
      .exec<SeedRow>("SELECT * FROM seeds WHERE meet_id = ?", meetId)
      .toArray();
    const watches = this.ctx.storage.sql
      .exec<WatchRow>("SELECT * FROM watches WHERE meet_id = ?", meetId)
      .toArray();
    const results = this.ctx.storage.sql
      .exec<ResultRow>("SELECT * FROM results WHERE meet_id = ?", meetId)
      .toArray();
    const entries = this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM entries WHERE meet_id = ?", meetId)
      .toArray();

    await db.batch([
      db.prepare("DELETE FROM seeds WHERE meet_id = ?").bind(meetId),
      db.prepare("DELETE FROM watches WHERE meet_id = ?").bind(meetId),
      db.prepare("DELETE FROM results WHERE meet_id = ?").bind(meetId),
      db.prepare("DELETE FROM entries WHERE meet_id = ?").bind(meetId),
      ...seeds.map((s) =>
        db
          .prepare(
            `INSERT INTO seeds (id, meet_id, event_id, heat, lane, athlete_id, seed_time_ms, exhibition)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            s.id,
            s.meet_id,
            s.event_id,
            s.heat,
            s.lane,
            s.athlete_id,
            s.seed_time_ms,
            s.exhibition,
          ),
      ),
      ...watches.map((w) =>
        db
          .prepare(
            `INSERT INTO watches (seed_id, meet_id, timer_id, user_id, role, time_ms, recorded_at, started_at, stopped_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            w.seed_id,
            w.meet_id,
            w.timer_id,
            w.user_id,
            w.role,
            w.time_ms,
            w.recorded_at,
            w.started_at,
            w.stopped_at,
          ),
      ),
      ...results.map((r) =>
        db
          .prepare(
            `INSERT INTO results (seed_id, meet_id, event_id, athlete_id, status, time_ms, decided_by, decided_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            r.seed_id,
            r.meet_id,
            r.event_id,
            r.athlete_id,
            r.status,
            r.time_ms,
            r.decided_by,
            r.decided_at,
          ),
      ),
      ...entries.map((e) =>
        db
          .prepare(
            `INSERT INTO entries (meet_id, event_id, athlete_id, created_at) VALUES (?, ?, ?, ?)`,
          )
          .bind(e.meet_id, e.event_id, e.athlete_id, e.created_at),
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

    const seeds = this.ctx.storage.sql
      .exec<SeedRow>("SELECT * FROM seeds WHERE meet_id = ?", meetId)
      .toArray()
      .map(seedFromRow);
    const watches = this.ctx.storage.sql
      .exec<WatchRow>("SELECT * FROM watches WHERE meet_id = ?", meetId)
      .toArray()
      .map(watchFromRow);
    const results = this.ctx.storage.sql
      .exec<ResultRow>("SELECT * FROM results WHERE meet_id = ?", meetId)
      .toArray()
      .map(resultFromRow);
    const entries = this.readEntries(meetId);

    const wanted = new Set<string>();
    for (const list of Object.values(entries))
      for (const id of list) wanted.add(id);
    for (const seed of seeds) if (seed.athleteId) wanted.add(seed.athleteId);
    const athletes = [...wanted]
      .map((id) => this.roster.get(id))
      .filter((a): a is Athlete => !!a);

    return { entries, seeds, watches, results, athletes };
  }

  /** Every declared entry, by event — the DO's own, not D1's, now that
   *  `declareEntry` is the only place an entry is written. */
  private readEntries(meetId: string): Record<string, string[]> {
    const rows = this.ctx.storage.sql
      .exec<EntryRow>(
        "SELECT * FROM entries WHERE meet_id = ? ORDER BY created_at",
        meetId,
      )
      .toArray();
    const entries: Record<string, string[]> = {};
    for (const row of rows) (entries[row.event_id] ??= []).push(row.athlete_id);
    return entries;
  }

  /* --------------------------------------------------------- write methods */
  //
  // One per `Write` kind, named for the action rather than the union's own
  // kind names (`seat` not `seed`, and so on) — the RPC surface a caller
  // reads, not the wire format it happens to share. Each ends by
  // broadcasting the very `Write` it just applied, so `applyPending` can
  // fold a broadcast over a cached snapshot exactly the way it folds a
  // pending write over loader data.

  async seat(input: WriteOf<"seed">): Promise<Seed> {
    await this.ensureHydrated(input.meetId);

    const existing = this.ctx.storage.sql
      .exec<SeedRow>(
        "SELECT * FROM seeds WHERE event_id = ? AND heat = ? AND lane = ?",
        input.eventId,
        input.heat,
        input.lane,
      )
      .toArray()[0];

    // Nobody swims an event twice — vacate whatever other lane they held.
    this.ctx.storage.sql.exec(
      `DELETE FROM seeds WHERE event_id = ? AND athlete_id = ? AND NOT (heat = ? AND lane = ?)`,
      input.eventId,
      input.athleteId,
      input.heat,
      input.lane,
    );

    const id = existing?.id ?? input.seedId;
    this.ctx.storage.sql.exec(
      `INSERT INTO seeds (id, meet_id, event_id, heat, lane, athlete_id, seed_time_ms, exhibition)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
       ON CONFLICT(event_id, heat, lane) DO UPDATE SET athlete_id = excluded.athlete_id`,
      id,
      input.meetId,
      input.eventId,
      input.heat,
      input.lane,
      input.athleteId,
    );

    // Swimming a race is being in it.
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO entries (meet_id, event_id, athlete_id, created_at) VALUES (?, ?, ?, ?)`,
      input.meetId,
      input.eventId,
      input.athleteId,
      Date.now(),
    );

    this.broadcast({ kind: "seed", ...input });
    return {
      id,
      eventId: input.eventId,
      heat: input.heat,
      lane: input.lane,
      athleteId: input.athleteId,
      seedTimeMs: existing?.seed_time_ms ?? undefined,
      exhibition: existing?.exhibition === 1 ? true : undefined,
    };
  }

  async unseat(input: WriteOf<"unseed">): Promise<void> {
    await this.ensureHydrated(input.meetId);
    this.ctx.storage.sql.exec(
      "DELETE FROM watches WHERE seed_id = ?",
      input.seedId,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM results WHERE seed_id = ?",
      input.seedId,
    );
    this.ctx.storage.sql.exec("DELETE FROM seeds WHERE id = ?", input.seedId);
    this.broadcast({ kind: "unseed", ...input });
  }

  /**
   * The swim in a lane, made to exist because something was timed against it
   * before anybody said who was there — mirrors `meets.server.ts`'s D1
   * version of the same idea. Not a `Write` kind of its own: nobody decides
   * to "ensure a lane", it's what `recordWatch`/`setExhibition`'s caller
   * reaches for when it doesn't yet know whether a seed exists (the timer's
   * raw-cookie path in `api.timer.lane.ts`, which addresses by event/heat/
   * lane rather than by a seed id it would have to already know).
   */
  async ensureLane(input: {
    meetId: string;
    eventId: string;
    heat: number;
    lane: number;
  }): Promise<Seed> {
    await this.ensureHydrated(input.meetId);

    const existing = this.ctx.storage.sql
      .exec<SeedRow>(
        "SELECT * FROM seeds WHERE event_id = ? AND heat = ? AND lane = ?",
        input.eventId,
        input.heat,
        input.lane,
      )
      .toArray()[0];
    if (existing) return seedFromRow(existing);

    const id = generateId();
    this.ctx.storage.sql.exec(
      `INSERT INTO seeds (id, meet_id, event_id, heat, lane, athlete_id, seed_time_ms, exhibition)
       VALUES (?, ?, ?, ?, ?, '', NULL, 0)
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
    const seed = this.ctx.storage.sql
      .exec<SeedRow>(
        "SELECT * FROM seeds WHERE event_id = ? AND heat = ? AND lane = ?",
        input.eventId,
        input.heat,
        input.lane,
      )
      .toArray()[0]!;
    return seedFromRow(seed);
  }

  async setExhibition(input: WriteOf<"exhibition">): Promise<void> {
    await this.ensureHydrated(input.meetId);
    this.ctx.storage.sql.exec(
      "UPDATE seeds SET exhibition = ? WHERE id = ?",
      input.exhibition ? 1 : 0,
      input.seedId,
    );
    this.broadcast({ kind: "exhibition", ...input });
  }

  async recordWatch(input: WriteOf<"watch">): Promise<void> {
    await this.ensureHydrated(input.meetId);
    this.ctx.storage.sql.exec(
      `INSERT INTO watches (seed_id, meet_id, timer_id, user_id, role, time_ms, recorded_at, started_at, stopped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(seed_id, timer_id) DO UPDATE SET
         user_id = excluded.user_id,
         role = excluded.role,
         time_ms = COALESCE(excluded.time_ms, watches.time_ms),
         recorded_at = excluded.recorded_at,
         started_at = COALESCE(excluded.started_at, watches.started_at),
         stopped_at = COALESCE(excluded.stopped_at, watches.stopped_at)`,
      input.seedId,
      input.meetId,
      input.timerId,
      input.userId ?? null,
      input.role,
      input.timeMs ?? null,
      input.recordedAt,
      input.startedAt ?? null,
      input.stoppedAt ?? null,
    );
    this.broadcast({ kind: "watch", ...input });
  }

  async dropWatch(input: WriteOf<"drop-watch">): Promise<void> {
    await this.ensureHydrated(input.meetId);
    this.ctx.storage.sql.exec(
      "DELETE FROM watches WHERE seed_id = ? AND timer_id = ?",
      input.seedId,
      input.timerId,
    );
    this.broadcast({ kind: "drop-watch", ...input });
  }

  /**
   * `decidedBy` isn't part of the `result` `Write` — it's the caller's own
   * identity, resolved by the Worker before this RPC is ever reached, the
   * same way `api.meet.writes.ts` resolves it from the session today rather
   * than trusting it in the request body.
   */
  async decideResult(
    input: WriteOf<"result">,
    decidedBy?: string,
  ): Promise<void> {
    await this.ensureHydrated(input.meetId);
    const seed = this.ctx.storage.sql
      .exec<SeedRow>("SELECT * FROM seeds WHERE id = ?", input.seedId)
      .toArray()[0];
    if (!seed) throw new Error("That swim is no longer in the meet");

    this.ctx.storage.sql.exec(
      `INSERT INTO results (seed_id, meet_id, event_id, athlete_id, status, time_ms, decided_by, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(seed_id) DO UPDATE SET
         status = excluded.status,
         time_ms = excluded.time_ms,
         decided_by = excluded.decided_by,
         decided_at = excluded.decided_at`,
      input.seedId,
      input.meetId,
      seed.event_id,
      seed.athlete_id,
      input.status,
      input.timeMs,
      input.auto ? "auto" : (decidedBy ?? null),
      Date.now(),
    );
    this.broadcast({ kind: "result", ...input });
  }

  async undecideResult(input: WriteOf<"unresult">): Promise<void> {
    await this.ensureHydrated(input.meetId);
    this.ctx.storage.sql.exec(
      "DELETE FROM results WHERE seed_id = ?",
      input.seedId,
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
        `INSERT OR IGNORE INTO entries (meet_id, event_id, athlete_id, created_at) VALUES (?, ?, ?, ?)`,
        input.meetId,
        input.eventId,
        input.athleteId,
        Date.now(),
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
   * Persists as a full replace, matching `replaceSeeds`'s old D1 semantics —
   * `reseedEvent` can change the id set's shape (fewer or more swimmers)
   * even though most ids carry over unchanged — but broadcasts only the
   * seeds that actually moved, so a lane nobody touched doesn't flicker on
   * every connected screen.
   */
  private async reseedIfUntouched(
    meetId: string,
    eventId: string,
    meet: Pick<Meet, "teamIds" | "laneAssignments" | "laneCount">,
  ): Promise<void> {
    const seeds = this.ctx.storage.sql
      .exec<SeedRow>("SELECT * FROM seeds WHERE event_id = ?", eventId)
      .toArray()
      .map(seedFromRow);
    const watches = this.ctx.storage.sql
      .exec<WatchRow>(
        `SELECT w.* FROM watches w JOIN seeds s ON s.id = w.seed_id WHERE s.event_id = ?`,
        eventId,
      )
      .toArray()
      .map(watchFromRow);
    const results = this.ctx.storage.sql
      .exec<ResultRow>(
        `SELECT r.* FROM results r JOIN seeds s ON s.id = r.seed_id WHERE s.event_id = ?`,
        eventId,
      )
      .toArray()
      .map(resultFromRow);

    const entrants = this.readEntries(meetId)[eventId] ?? [];
    const teamOf = await this.teamOfMap(entrants, meet.teamIds);

    const nextSeeds = reseedEvent(
      { seeds, watches, results },
      meetId,
      eventId,
      entrants,
      (athleteId) => teamOf.get(athleteId),
      meet.laneAssignments,
      meet.laneCount,
    );
    // Only null when the event turned out to be touched.
    if (!nextSeeds) return;

    const before = new Map(seeds.map((s) => [s.id, s] as const));

    this.ctx.storage.sql.exec(
      `DELETE FROM watches WHERE seed_id IN (SELECT id FROM seeds WHERE event_id = ?)`,
      eventId,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM results WHERE seed_id IN (SELECT id FROM seeds WHERE event_id = ?)`,
      eventId,
    );
    this.ctx.storage.sql.exec(`DELETE FROM seeds WHERE event_id = ?`, eventId);
    for (const seed of nextSeeds) {
      this.ctx.storage.sql.exec(
        `INSERT INTO seeds (id, meet_id, event_id, heat, lane, athlete_id, seed_time_ms, exhibition)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        seed.id,
        meetId,
        eventId,
        seed.heat,
        seed.lane,
        seed.athleteId,
        seed.seedTimeMs ?? null,
        seed.exhibition ? 1 : 0,
      );
    }

    const after = new Set(nextSeeds.map((s) => s.id));
    for (const id of before.keys()) {
      if (!after.has(id))
        this.broadcast({ kind: "unseed", meetId, seedId: id });
    }
    for (const seed of nextSeeds) {
      const prior = before.get(seed.id);
      if (
        prior &&
        prior.heat === seed.heat &&
        prior.lane === seed.lane &&
        prior.athleteId === seed.athleteId
      ) {
        continue; // Unmoved — nothing for a connected screen to redraw.
      }
      this.broadcast({
        kind: "seed",
        meetId,
        eventId,
        heat: seed.heat,
        lane: seed.lane,
        athleteId: seed.athleteId,
        seedId: seed.id,
      });
    }
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
  }): Promise<Athlete> {
    await this.ensureHydrated(input.meetId);

    const id = generateId();
    const athlete = await putAthlete(this.env.DB, {
      id,
      firstName: input.firstName,
      lastName: input.lastName,
      // No birth date and no real gender signal from a walk-up — same as
      // the timer's own walk-up path today (api.timer.lane.ts).
      gender: "F",
    });
    await enrolVisitor(this.env.DB, input.meetId, input.teamId, id);

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
      role,
      userId: url.searchParams.get("userId") ?? undefined,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(): Promise<void> {
    // Writes arrive over RPC, not this socket — see `fetch`'s doc comment.
    // Nothing a client sends here is acted on (yet); reaching this from the
    // browser at all would mean something upstream misunderstood the
    // transport.
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
