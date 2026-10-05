/**
 * One Meet Durable Object per meet — `env.MEET_DO.getByName(meetId)`.
 *
 * Owns everything meet-specific for as long as the meet is `status !==
 * "complete"`: its settings (`details`), the programme (`events`), and the
 * live, multi-writer race-day state (`entries`, `swims`, `watches`). All of
 * it lives only here for reading — there is no D1 mirror to hydrate from or
 * checkpoint back to; this DO's own SQLite storage is already durable.
 * `details` is the one exception on the write side: `setDetails` pushes
 * every edit straight through to D1's `meets` row too (name, date, lane
 * count, ...), synchronously, so the D1-only meets list never shows a
 * stale copy — D1 never gets to disagree with the DO, it just isn't asked
 * for the current answer while the meet's still running. Once an admin
 * completes the meet, `completeMeet` also flushes a denormalized `results`
 * archive and flips `status`; from that point on D1 answers every read and
 * this DO is never spun back up.
 *
 * This DO holds no copy of an athlete or a team — D1 owns that identity,
 * full stop. `entries.athlete_id`/`team_id` and `swims.athlete_id` are
 * plain ids, never a local foreign key; `swims.athlete_name`/`athlete_team`
 * are a denormalized snapshot the client stamps on at seat/entry time from
 * its own already-current `meetCache` copy of the D1 roster, not something
 * this DO resolves itself. `meet-layout.tsx`'s loader is what splices D1's
 * current roster onto this DO's live state into one `MeetManifest` for the
 * client — see its doc comment.
 *
 * The write methods mirror `meets.server.ts`'s old D1-backed versions in
 * spirit, one table row at a time, just against local (synchronous) SQLite.
 */

import { DurableObject } from "cloudflare:workers";
import {
  type Event,
  type MeetDetails,
  type Stroke,
  type MeetManifest,
  type LaneCount,
  type LaneAssignments,
  DEFAULT_MEET_DETAILS,
} from "~/types/meet";
import {
  type Entry,
  type EntryKey,
  type EntryDeleteMutation,
  type EntryUpsertMutation,
  canDeleteEntry,
  canUpsertEntry,
  toEntryKey,
} from "~/types/entry";
import {
  type ResultStatus,
  type Swim,
  type SwimKey,
  type SwimDeleteMutation,
  type SwimUpsertMutation,
  toSwimKey,
} from "~/types/swim";
import {
  canDeleteWatch,
  canUpsertWatch,
  toWatchKey,
  type Watch,
  type WatchDeleteMutation,
  type WatchUpsertMutation,
} from "~/types/watch";
import type { EntityMutation } from "~/types/mutations";
import type { User } from "~/types/user";
import { swimsForEvent, type TimingRows } from "./timing";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS swims (
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

     PRIMARY KEY (event_id, heat, lane)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS swims_by_lane ON swims (event_id, heat, lane)`,

  `CREATE TABLE IF NOT EXISTS watches (
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

     PRIMARY KEY (event_id, heat, lane, device_id, slot),
     FOREIGN KEY (event_id, heat, lane) 
       REFERENCES swims(event_id, heat, lane) 
       ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS watches_by_swim ON watches (event_id, heat, lane)`,

  `CREATE TABLE IF NOT EXISTS entries (
     event_id TEXT NOT NULL,
     athlete_id TEXT NOT NULL,
     team_id TEXT NOT NULL,
     seed_time_ms INTEGER,
     exhibition INTEGER NOT NULL DEFAULT 0,
     entered_at INTEGER NOT NULL DEFAULT 0,
     entered_by TEXT,
     PRIMARY KEY (event_id, athlete_id)
   )`,

  /**
   * The programme. Meet-specific, so — unlike the old D1 `events` table this
   * replaces — it lives only here, no `meet_id` needed: one DO is already
   * exactly one meet's worth of rows. `setEvents` (below) is the only write;
   * nothing seeds this yet — see `getMeetManifest`'s doc comment.
   */
  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY,
     position INTEGER NOT NULL,
     distance INTEGER NOT NULL,
     stroke TEXT NOT NULL,
     gender TEXT NOT NULL,
     name TEXT,
     total_heats INTEGER
   )`,

  `CREATE TABLE IF NOT EXISTS heats (
    id TEXT PRIMARY KEY,
    "order" INTEGER NOT NULL UNIQUE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'seeded'
  )`,

  // Scalar bookkeeping the tables above don't carry a column for:
  // `currentEventId`, `currentHeatNumber` (see `getMeetManifest`/
  // `setCurrentHeat`). `name` isn't here — D1's `meets.name` is that fact's
  // one home, so callers pass it into `getMeetManifest` rather than this DO
  // keeping its own copy to drift out of sync.
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

/** How this DO's own live tables come back, before mapping to POCOs. */
interface SwimRow {
  [key: string]: SqlStorageValue;
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
  event_id: string;
  athlete_id: string;
  team_id: string;
  seed_time_ms: number | null;
  exhibition: number | null;
  entered_at: number;
  entered_by: string;
}

/** This DO's own `events` table — its programme, once something writes one
 *  via `setEvents`. `declareEntry`'s entry-limit check reads this now too —
 *  it used to read a D1 `events` table that no longer exists. */
interface EventRow {
  [key: string]: SqlStorageValue;
  id: string;
  position: number;
  distance: number;
  stroke: string;
  gender: string;
  name: string | null;
  total_heats: number | null;
}

function eventFromRow(row: EventRow): Event {
  return {
    id: row.id,
    position: row.position,
    distance: row.distance,
    stroke: row.stroke as Stroke,
    gender: row.gender as Event["gender"],
    name: row.name ?? undefined,
    totalHeats: row.total_heats ?? undefined,
  };
}

function asResultStatus(value: string | null): ResultStatus | undefined {
  if (value === "DQ" || value === "NS" || value === "OK") return value;
  return undefined;
}

function swimFromRow(row: SwimRow): Swim {
  return {
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
    timeMs: row.time_ms ?? 0,
    startedAt: row.started_at ?? 0,
    stoppedAt: row.stopped_at ?? 0,
    recordedAt: row.recorded_at,
  };
}
function entryFromRow(row: EntryRow): Entry {
  return {
    athleteId: row.athlete_id,
    teamId: row.team_id,
    eventId: row.event_id,
    seedTimeMs: row.seed_time_ms ?? undefined,
    exhibition: row.exhibition === 1 ? true : false,
    enteredAt: row.entered_at,
    enteredBy: row.entered_by,
  };
}

export type DBResult = "applied" | "noop" | "failed";

/** Who a live connection is, resolved by the Worker before the upgrade ever
 *  reaches the DO — see `api.meet.live.ts`. */
export type MeetRole = "admin" | "coach" | "timer" | "spectator";

export class MeetDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.deleteAll();
      for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
    });
  }

  /* ------------------------------------------------------------- lifecycle */

  private getMeta(key: string): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
        .toArray()[0]?.value ?? null
    );
  }

  private setMeta(key: string, value: string | null): void {
    if (value === null) {
      this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = ?", key);
    } else {
      this.ctx.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        key,
        value,
      );
    }
  }

  async processMutation(
    meetId: string,
    user: User,
    mutation: EntityMutation,
  ): Promise<void> {
    const meet = await this.getMeetManifest(meetId);
    switch (mutation.entity) {
      case "entry":
        if (
          mutation.op === "delete" &&
          canDeleteEntry(mutation.key, user, meet)
        ) {
          await this.deleteEntry(mutation);
        } else if (
          mutation.op === "upsert" &&
          canUpsertEntry(mutation.key, user, meet)
        ) {
          await this.upsertEntry(mutation);
        }
        break;
      case "swim":
        if (mutation.op === "delete") {
          await this.deleteSwim(mutation);
        } else {
          await this.upsertSwim(mutation);
        }
        break;
      case "watch":
        if (
          mutation.op === "delete" &&
          canDeleteWatch(mutation.key, user, meet)
        ) {
          await this.deleteWatch(mutation);
        } else if (
          mutation.op === "upsert" &&
          canUpsertWatch(mutation.key, user, meet)
        ) {
          await this.upsertWatch(mutation);
        }
        break;
    }
  }

  // TBD: maybe parallelize here?
  async processMutations(
    meetId: string,
    user: User,
    mutations: EntityMutation[],
  ): Promise<void> {
    if (mutations === null || mutations.length < 1) return;

    for (const mutation of mutations) {
      this.processMutation(meetId, user, mutation);
    }
  }

  /* --------------------------------------------------------------- reading */

  /**
   * This DO's own half of the client-side `MeetManifest` — events, entries,
   * swims, watches — plain `SELECT`s against this DO's own tables plus the
   * `meta` scalars, so there's no cache to warm and no D1 trip to make
   * first. `athletes`/`teams` come back empty: `meet-layout.tsx`'s loader is
   * what splices in a current D1 roster read before a client ever sees this,
   * since identity isn't this DO's to answer for any more.
   *
   * `name` isn't its own `meta` row — it's just `details.name`, read back
   * out. There's only one stored copy, so it can't drift out of sync with
   * itself the way a separate denormalized copy could.
   *
   * Nothing seeds `events` yet — there's no meet-setup-into-the-DO flow to
   * call `setEvents` — so a freshly created meet's manifest legitimately
   * comes back with an empty programme until that's built.
   */
  async getMeetManifest(meetId: string): Promise<MeetManifest> {
    const details = await this.getDetails();

    const events = this.ctx.storage.sql
      .exec<EventRow>("SELECT * FROM events")
      .toArray()
      .map(eventFromRow)
      .reduce<Record<string, Event>>((record, event) => {
        record[event.id] = event;
        return record;
      }, {});

    const swims = this.ctx.storage.sql
      .exec<SwimRow>("SELECT * FROM swims")
      .toArray()
      .map(swimFromRow)
      .reduce<Record<SwimKey, Swim>>((record, swim) => {
        record[toSwimKey(swim)] = swim;
        return record;
      }, {});

    const entries = this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM entries")
      .toArray()
      .map(entryFromRow)
      .reduce<Record<EntryKey, Entry>>((record, entry) => {
        record[toEntryKey(entry)] = entry;
        return record;
      }, {});

    const watches = this.ctx.storage.sql
      .exec<WatchRow>("SELECT * FROM watches")
      .toArray()
      .map(watchFromRow)
      .reduce<Record<string, Watch>>((record, watch) => {
        record[toWatchKey(watch)] = watch;
        return record;
      }, {});

    const adminIds = this.getMeta("adminIds")?.split(",") || [];

    const rawHeat = this.getMeta("currentHeatNumber");
    return {
      id: meetId,
      name: details.name,
      details,
      status: "scheduled",
      currentEventId: this.getMeta("currentEventId") ?? undefined,
      currentHeatNumber: rawHeat === null ? undefined : Number(rawHeat),
      events,
      entries,
      swims,
      watches,
      // Identity lives in D1 now, not here — `meet-layout.tsx`'s loader is
      // what fills these back in from a current roster read before handing
      // the manifest to a client, so an empty object here is a mid-flight
      // state no screen is ever meant to actually render.
      athletes: {},
      teams: {},
      adminIds,
    };
  }

  /** `details` alone, without the rest of the manifest — what a settings
   *  form's action reads to merge its own changed fields onto before
   *  calling `setDetails`, cheaper than a full `getMeetManifest`. */
  async getDetails(): Promise<MeetDetails> {
    const raw = this.getMeta("details");
    if (!raw) return DEFAULT_MEET_DETAILS;
    try {
      return JSON.parse(raw) as MeetDetails;
    } catch {
      return DEFAULT_MEET_DETAILS;
    }
  }

  /**
   * Replace the meet's whole settings object at once — the same "send the
   * object" convention `setEvents` uses, and for the same reason: a settings
   * form submits everything it's bound to, not a diff, so there's nothing
   * to merge incorrectly here. Broadcasts `MEET_DETAILS` so every connected
   * screen's `meetCache` picks it up the same way it already does watches/
   * swims/entries/athletes.
   *
   * Also writes straight through to D1's `meets` row, synchronously, so the
   * meets list (`meets.tsx`, D1-only on purpose) never shows a stale name/
   * date/lane count — the DO stays the authoritative copy (this is the only
   * writer either place ever sees), D1 is just never allowed to drift from
   * it. A settings save is a deliberate, infrequent action, not a hot path
   * like a watch or a swim, so the extra D1 round trip costs nothing anyone
   * would notice.
   */
  async setDetails(meetId: string, details: MeetDetails): Promise<void> {
    this.setMeta("details", JSON.stringify(details));
    await this.detailsUpdateStatement(meetId, details).run();
    this.broadcast({ type: "MEET_DETAILS", details });
  }

  /** The `UPDATE meets SET <details columns>` statement, bound and ready to
   *  `.run()` or fold into a `.batch()` — shared by `setDetails` (every
   *  edit) and `completeMeet` (which also flips `status` in the same
   *  batch), so the column list lives in exactly one place. */
  private detailsUpdateStatement(
    meetId: string,
    details: MeetDetails,
  ): D1PreparedStatement {
    return this.env.DB.prepare(
      `UPDATE meets SET
         name = ?, date = ?, type = ?, course = ?, location = ?,
         lane_count = ?, timers_per_lane = ?, lead_gender = ?,
         include_diving = ?, entry_visibility = ?, athletes_may_enter = ?,
         max_individual = ?, max_relays = ?, max_total = ?,
         max_per_team_per_event = ?, lane_assignments = ?, scoring = ?
       WHERE id = ?`,
    ).bind(
      details.name,
      details.date,
      details.type,
      details.course,
      details.location ?? null,
      details.laneCount,
      details.timersPerLane,
      details.leadGender,
      details.includeDiving ? 1 : 0,
      details.entryVisibility,
      details.athletesMayEnter ? 1 : 0,
      details.limits.maxIndividual ?? null,
      details.limits.maxRelays ?? null,
      details.limits.maxTotal ?? null,
      details.limits.maxPerTeamPerEvent ?? null,
      JSON.stringify(details.laneAssignments),
      JSON.stringify(details.scoring),
      meetId,
    );
  }

  /** Replace the whole programme at once — what a meet-setup screen calling
   *  this does when a coach or admin picks the lineup. */
  async setEvents(meetId: string, events: Event[]): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM events");
    for (const event of events) {
      this.ctx.storage.sql.exec(
        `INSERT INTO events (id, position, distance, stroke, gender, name, total_heats)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        event.id,
        event.position,
        event.distance,
        event.stroke,
        event.gender,
        event.name ?? null,
        event.totalHeats ?? null,
      );
    }
    this.broadcast({ type: "EVENTS", events });
  }

  /**
   * Drop a team's racing presence from this meet, deleting any entries and
   * swims that haven't happened (deleting a team during a meet is an unlikely
   * edge case, anyway)
   */
  async removeTeam(
    teamId: string,
    team: { name: string; code: string },
  ): Promise<{ ok: true }> {
    const entryRows = this.ctx.storage.sql
      .exec<{
        event_id: string;
        athlete_id: string;
      }>("SELECT event_id, athlete_id FROM entries WHERE team_id = ?", teamId)
      .toArray();
    this.ctx.storage.sql.exec("DELETE FROM entries WHERE team_id = ?", teamId);
    for (const row of entryRows) {
      this.broadcast({
        entity: "entry",
        op: "delete",
        key: { eventId: row.event_id, athleteId: row.athlete_id },
      });
    }

    // Never a swim that's already been timed or decided — that one stays,
    // an unexplainable name on it forever rather than silently vanishing
    // because the team later left the meet.
    const swimRows = this.ctx.storage.sql
      .exec<SwimRow>(
        `SELECT * FROM swims
         WHERE athlete_team IN (?, ?)
           AND status IS NULL AND official_time_ms IS NULL`,
        team.code,
        team.name,
      )
      .toArray();
    for (const row of swimRows) {
      this.ctx.storage.sql.exec(
        "DELETE FROM watches WHERE event_id = ? AND heat = ? AND lane = ?",
        row.event_id,
        row.heat,
        row.lane,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM swims WHERE event_id = ? AND heat = ? AND lane = ?",
        row.event_id,
        row.heat,
        row.lane,
      );
      this.broadcast({
        entity: "swim",
        op: "delete",
        key: { eventId: row.event_id, heat: row.heat, lane: row.lane },
      });
    }

    return { ok: true };
  }

  /** The advisory deck pointer — `MeetManifest.currentEventId`/
   *  `currentHeatNumber`. Advisory only, per the design doc: nothing here
   *  forces a connected timer's own screen to follow it. */
  async setCurrentHeat(
    currentEventId?: string,
    currentHeatNumber?: number,
  ): Promise<void> {
    this.setMeta("currentEventId", currentEventId ?? null);
    this.setMeta(
      "currentHeatNumber",
      currentHeatNumber === undefined ? null : String(currentHeatNumber),
    );
  }

  /**
   * The one-time archive flush: denormalizes this DO's own `swims` (plus its
   * `events` for the display fields a completed meet's D1 row has to carry
   * on its own — see `results`' doc comment in `schema.server.ts`) into
   * D1's `results`, and flips `meets.status` to `"complete"` — all in one
   * batch. `details` doesn't need rewriting here: `setDetails` already keeps
   * D1's `meets` row current on every edit, not just at completion. From
   * this point on, D1 answers every read for this meet and this DO is never
   * spun back up to do it again.
   *
   * A swim with no `athlete_id` at all — a walk-up never given one, named
   * only by its `athlete_name`/`athlete_team` — reaches D1 exactly the way
   * every other swim does: as a `results` row. There's no account or
   * enrollment created for them; that denormalized row is the only trace
   * of them this app ever keeps, on purpose (see the file's own doc
   * comment) unless a future pass decides reconciling one back onto the
   * team's roster is worth doing.
   *
   * Scoring (`place`/`points`) isn't computed here — nothing in this pass
   * wires up `ScoringRules`/`timing.ts` — so those columns are written null.
   */
  async completeMeet(meetId: string): Promise<void> {
    const swims = this.ctx.storage.sql
      .exec<SwimRow>("SELECT * FROM swims")
      .toArray();
    const events = this.ctx.storage.sql
      .exec<EventRow>("SELECT * FROM events")
      .toArray();
    const eventById = new Map(events.map((e) => [e.id, e] as const));

    const db = this.env.DB;
    await db.batch([
      ...swims.map((s) => {
        const event = eventById.get(s.event_id);
        return db
          .prepare(
            `INSERT INTO results (meet_id, event_id, event_number, distance, stroke, gender, heat, lane, athlete_id, athlete_name, athlete_team, time_ms, status, exhibition, place, points)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            meetId,
            s.event_id,
            event?.event_number ?? 0,
            event?.distance ?? 0,
            event?.stroke ?? "",
            event?.gender ?? "Open",
            s.heat,
            s.lane,
            s.athlete_id || null,
            s.athlete_name,
            s.athlete_team,
            s.official_time_ms,
            s.status ?? "OK",
            s.exhibition,
            null,
            null,
          );
      }),
      db
        .prepare("UPDATE meets SET status = 'complete' WHERE id = ?")
        .bind(meetId),
    ]);
  }

  /* --------------------------------------------------------- write methods */
  async upsertSwim(mutation: SwimUpsertMutation): Promise<void> {
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO swims (event_id, heat, lane, athlete_id, athlete_name, athlete_team, exhibition, status, official_time_ms, decided_at, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, heat, lane) DO UPDATE SET
         athlete_id = excluded.athlete_id,
         athlete_name = excluded.athlete_name,
         athlete_team = excluded.athlete_team,
         exhibition = excluded.exhibition,
         status = excluded.status,
         official_time_ms = excluded.official_time_ms,
         decided_at = excluded.decided_at,
         decided_by = excluded.decided_by`,
        mutation.key.eventId,
        mutation.key.heat,
        mutation.key.lane,
        mutation.patch.athleteId ?? "",
        mutation.patch.athleteName ?? "",
        mutation.patch.athleteTeam ?? "",
        mutation.patch.exhibition ? 1 : 0,
        mutation.patch.status ?? null,
        mutation.patch.officialTimeMs ?? null,
        mutation.patch.decidedAt ?? null,
        mutation.patch.decidedBy ?? null,
      );
    } catch (e) {
      console.error("deleteSwim failure: ", e);
    }
    this.broadcast(mutation);
  }

  async deleteSwim(mutation: SwimDeleteMutation): Promise<void> {
    try {
      const hasWatches = this.ctx.storage.sql
        .exec<SwimRow>(
          "SELECT * FROM watches WHERE event_id = ? AND heat = ? AND lane = ?",
          mutation.key.eventId,
          mutation.key.heat,
          mutation.key.lane,
        )
        .toArray()[0];
      if (hasWatches)
        throw new Error("Cannot delete a swim with existing watches");

      const cursor = this.ctx.storage.sql.exec(
        "DELETE FROM swims WHERE event_id = ? AND heat = ? AND lane = ? RETURNING lane",
        mutation.key.eventId,
        mutation.key.heat,
        mutation.key.lane,
      );
      if (cursor.toArray().length < 1) return;
    } catch (e) {
      console.error("deleteSwim failure: ", e);
    }
    this.broadcast(mutation);
  }

  async deleteEntry(mutation: EntryDeleteMutation): Promise<void> {
    try {
      const cursor = this.ctx.storage.sql.exec(
        "DELETE FROM entries WHERE event_id = ? AND athlete_id = ? RETURNING athlete_id",
        mutation.key.eventId,
        mutation.key.athleteId,
      );
      if (cursor.toArray().length < 1) return;
    } catch (e) {
      console.error("deleteEntry failure: ", e);
    }
    this.broadcast(mutation);
    this.reseed(mutation.key.eventId);
  }

  async upsertEntry(mutation: EntryUpsertMutation): Promise<void> {
    try {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO entries (event_id, athlete_id, team_id, seed_time_ms, exhibition, entered_at, entered_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        mutation.key.eventId,
        mutation.key.athleteId,
        mutation.patch.teamId,
        mutation.patch.seedTimeMs ?? null,
        mutation.patch.exhibition ? 1 : 0,
        mutation.patch.enteredAt,
        mutation.patch.enteredBy,
      );
    } catch (e) {
      console.error("upsertEntry failure: ", e);
    }
    this.broadcast(mutation);
    this.reseed(mutation.key.eventId);
  }

  async deleteWatch(mutation: WatchDeleteMutation): Promise<void> {
    try {
      const cursor = this.ctx.storage.sql.exec(
        "DELETE FROM watches WHERE event_id = ? AND heat = ? AND lane = ? AND device_id = ? AND slot = ? RETURNING slot",
        mutation.key.eventId,
        mutation.key.heat,
        mutation.key.lane,
        mutation.key.deviceId,
        mutation.key.slot,
      );
      if (cursor.toArray().length < 1) return;
    } catch (e) {
      console.error("deleteWatch failure: ", e);
    }
    this.broadcast(mutation);
  }

  async upsertWatch(mutation: WatchUpsertMutation): Promise<void> {
    try {
      // ensure a swim exists - handles the case of a walk up
      this.ctx.storage.sql.exec(
        `INSERT INTO swims (event_id, heat, lane, athlete_id, athlete_name, athlete_team, exhibition)
       VALUES (?, ?, ?, '', '', '', 0)
       ON CONFLICT(event_id, heat, lane) DO NOTHING`,
        mutation.key.eventId,
        mutation.key.heat,
        mutation.key.lane,
      );

      this.ctx.storage.sql.exec(
        `INSERT INTO watches (event_id, heat, lane, device_id, slot, role, user_id, time_ms, started_at, stopped_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, heat, lane, device_id, slot) DO UPDATE SET
         role = excluded.role,
         user_id = excluded.user_id,
         time_ms = excluded.time_ms,
         started_at = excluded.started_at,
         stopped_at = excluded.stopped_at,
         recorded_at = excluded.recorded_at`,
        mutation.key.eventId,
        mutation.key.heat,
        mutation.key.lane,
        mutation.key.deviceId,
        mutation.key.slot,
        mutation.patch.role,
        mutation.patch.userId,
        mutation.patch.timeMs,
        mutation.patch.startedAt,
        mutation.patch.stoppedAt,
        mutation.patch.recordedAt,
      );
    } catch (e) {
      console.error("upsertWatch failure: ", e);
    }
    console.log("done upserting");
    this.broadcast(mutation);
  }

  /**
   * Lane assignment order, fastest lane first. Standard practice puts the top
   * seed in the middle of the pool and works outward, alternating sides: six
   * lanes seed 3-4-2-5-1-6, five lanes 3-2-4-1-5. An even pool has no true
   * centre, so its first pair leans to the high side.
   */
  private laneOrder(laneCount: LaneCount): number[] {
    const middle = Math.floor((laneCount + 1) / 2);
    const even = laneCount % 2 === 0;
    const order = [middle];

    for (let step = 1; order.length < laneCount; step++) {
      for (const lane of even
        ? [middle + step, middle - step]
        : [middle - step, middle + step]) {
        if (lane >= 1 && lane <= laneCount) order.push(lane);
      }
    }

    return order;
  }

  /**
   * Seed a whole event, in one deterministic pass.
   *
   * `entrants` is given in priority order — fastest first, once the app knows a
   * time; first entered first until it does — and that order is also the order
   * lanes fill: the centre of a team's *own* lanes before its outside ones,
   * and a team's own lanes before anybody else's. A team short on entrants
   * simply leaves its spare lanes for whoever needs them, in whichever heat
   * that spare lane falls in, rather than forcing a heat that would otherwise
   * sit mostly empty.
   *
   * Run over the *whole* entrant list every time it changes, rather than only
   * placing whoever's new — a team that enters late still reaches for its own
   * lanes, bumping out whatever overflow was borrowing them, rather than being
   * pushed into an extra heat by swimmers who got there first.
   *
   * Where a swimmer lands back in the seat they already had, the swim keeps its
   * id and every other field untouched — the same rule this always followed,
   * so a watch already taken on an untouched swim (there can't be one, but a
   * caller composing this with other changes might still care) would still
   * point at the right row, and a lane-level exhibition override a reseed of
   * the rest of the event shouldn't clobber survives. `displayOf`/
   * `exhibitionOf` are only consulted for a swim that's freshly created here —
   * moved or brand new — never for one that's kept as-is.
   */
  private seedEvent(
    rows: Pick<TimingRows, "swims">,
    eventId: string,
    entries: Entry[],
    laneAssignments: LaneAssignments,
    laneCount: LaneCount,
  ): Swim[] {
    if (entries.length === 0) return [];

    const heatCount = Math.ceil(entries.length / laneCount);
    const globalOrder = this.laneOrder(laneCount);

    // Each team's own lanes, centre-out, and how many of that team's own
    // entrants fit across every heat this event ends up needing.
    const ownOrder = new Map<string, number[]>();
    const capacity = new Map<string, number>();
    for (const [teamId, lanes] of Object.entries(laneAssignments)) {
      const order = globalOrder.filter((lane) => lanes.includes(lane));
      ownOrder.set(teamId, order);
      capacity.set(teamId, order.length * heatCount);
    }

    const seatOf = new Map<string, { heat: number; lane: number }>();
    const claimed = new Set<string>(); // "heat/lane", own-lane placements only
    const placedByTeam = new Map<string, number>();
    const overflow: string[] = [];

    for (const entry of entries) {
      const teamId = entry.teamId;
      const order = teamId ? ownOrder.get(teamId) : undefined;
      const already = teamId ? (placedByTeam.get(teamId) ?? 0) : 0;

      if (order && order.length > 0 && already < (capacity.get(teamId!) ?? 0)) {
        const heat = Math.floor(already / order.length) + 1;
        const lane = order[already % order.length];
        seatOf.set(entry.athleteId, { heat, lane });
        claimed.add(`${heat}/${lane}`);
        placedByTeam.set(teamId!, already + 1);
      } else {
        overflow.push(entry.athleteId);
      }
    }

    // Whatever's left over takes whatever's left over: any lane, in any heat,
    // that no team's own swimmers claimed — earliest heat first, centre-out
    // within it.
    const open: Array<{ heat: number; lane: number }> = [];
    for (
      let heat = 1;
      heat <= heatCount && open.length < overflow.length;
      heat++
    ) {
      for (const lane of globalOrder) {
        if (!claimed.has(`${heat}/${lane}`)) open.push({ heat, lane });
      }
    }
    overflow.forEach((athleteId, i) => seatOf.set(athleteId, open[i]));

    const existing = new Map(
      swimsForEvent(rows, eventId).map(
        (s) => [`${s.heat}/${s.lane}`, s] as const,
      ),
    );

    return entries.map((entry) => {
      const seat = seatOf.get(entry.athleteId)!;
      const before = existing.get(`${seat.heat}/${seat.lane}`);
      if (before && before.athleteId === entry.athleteId) return { ...before };
      return {
        eventId,
        heat: seat.heat,
        lane: seat.lane,
        athleteId: entry.athleteId,
        exhibition: entry.exhibition,
      };
    });
  }

  private async reseed(eventId: string) {
    const swims = this.ctx.storage.sql
      .exec<SwimRow>("SELECT * FROM swims WHERE event_id = ?", eventId)
      .toArray()
      .map(swimFromRow);
    const watches = this.ctx.storage.sql
      .exec<WatchRow>("SELECT * FROM watches WHERE event_id = ?", eventId)
      .toArray()
      .map(watchFromRow);
    const entries = this.ctx.storage.sql
      .exec<EntryRow>(
        "SELECT * FROM entries WHERE event_id = ? ORDER BY entered_at",
        eventId,
      )
      .toArray()
      .map(entryFromRow);
    const details = await this.getDetails();

    const nextSwims = this.seedEvent(
      { swims },
      eventId,
      entries,
      details.laneAssignments,
      details.laneCount,
    );

    // Only null when the event turned out to be touched.
    if (!nextSwims) return;

    const before = new Map(swims.map((s) => [toSwimKey(s), s] as const));
    const after = new Map(nextSwims.map((s) => [toSwimKey(s), s] as const));

    this.ctx.storage.sql.exec("DELETE FROM swims WHERE event_id = ?", eventId);
    for (const swim of nextSwims) {
      this.ctx.storage.sql.exec(
        `INSERT INTO swims (event_id, heat, lane, athlete_id, athlete_name, athlete_team, exhibition)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        eventId,
        swim.heat,
        swim.lane,
        swim.athleteId ?? "",
        swim.athleteName ?? "",
        swim.athleteTeam ?? "",
        swim.exhibition ? 1 : 0,
      );
    }

    for (const [key, prior] of before) {
      if (!after.has(key))
        this.broadcast({
          entity: "swim",
          op: "upsert",
          key: prior,
          patch: prior,
        });
    }
    for (const [key, swim] of after) {
      const prior = before.get(key);
      if (prior && prior.athleteId === swim.athleteId) {
        continue; // Unmoved — nothing for a connected screen to redraw.
      }
      this.broadcast({
        entity: "swim",
        op: "upsert",
        key: swim,
        patch: swim,
      });
    }
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
   * The WS fast path is disabled for now, not ported. It used to send a
   * `LiveSignal` — a `Write` addressed by a synthetic `swimId`/`timerId` —
   * straight over the already-open socket for latency, ahead of the
   * resilient cookie/action round trip. Neither address exists any more
   * (a swim's whole identity is its `event_id, heat, lane`; nothing in this
   * schema was ever keyed by an id), so there is nothing left to look up.
   * Redesigning this to send a natural-key-addressed signal instead is part
   * of the same pass that moves the admin desk and the timer workspace onto
   * `upsertSwim`/`upsertWatch` directly — until then every write still
   * lands, just over the resilient path alone, without this one's latency
   * shortcut for arming or stopping a stopwatch.
   */
  async webSocketMessage(
    _ws: WebSocket,
    _raw: string | ArrayBuffer,
  ): Promise<void> {
    // Intentionally a no-op — see the doc comment above.
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
   *
   * `LiveSocketMessage` only now — every write method broadcasts the same
   * shape `meetCache.applyPatch` (`meet-layout.tsx`'s client) already knows how
   * to fold onto a cached manifest. The old `MeetBroadcast` (`Write`-shaped)
   * vocabulary this used to also send is gone with the granular RPCs that
   * used to construct it.
   */
  private broadcast(message: EntityMutation): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch (e) {
        console.error("broadcase failure: ", e);
      }
    }
  }
}
