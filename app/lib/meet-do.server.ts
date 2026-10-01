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
 * The write methods mirror `meets.server.ts`'s old D1-backed versions in
 * spirit, one table row at a time, just against local (synchronous) SQLite.
 */

import { DurableObject } from "cloudflare:workers";
import { generateId } from "./id";
import { putAthlete } from "./athletes.server";
import { enrolVisitor } from "./teams.server";
import type {
  Event,
  MeetDetails,
  Stroke,
  MeetManifest,
  MeetAthlete,
  LaneCount,
  LaneAssignments,
} from "~/types/meet";
import type {
  Entry,
  EntryDeleteMutation,
  EntryUpsertMutation,
} from "~/types/entry";
import type { EntryKey } from "~/types/entry";
import type { Swim } from "~/types/swim";
import type { SwimIdentity } from "~/types/swim";
import type { SwimKey } from "~/types/swim";
import type { ResultStatus } from "~/types/swim";
import type { Watch } from "~/types/watch";
import type { WatchIdentity } from "~/types/watch";
import { athleteName, DEFAULT_MEET_DETAILS } from "~/types/meet";
import { canDeleteEntry, canUpsertEntry, toEntryKey } from "~/types/entry";
import { toSwimKey } from "~/types/swim";
import { toWatchKey } from "~/types/watch";
import type { Team } from "~/types/team";
import type { Athlete, Gender } from "~/types/athlete";
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
     athlete_id TEXT NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
     team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
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

  /**
   * This meet's own mirror of whichever teams are racing — copied in by
   * `addTeam` the moment a team joins `meet.teamIds`, so a heat sheet never
   * needs D1 for a name or a code. Meet-scoped on purpose, unlike D1's own
   * `teams`: two meets racing the same school each get their own copy, so
   * neither can go stale because of what the other did to it.
   */
  `CREATE TABLE IF NOT EXISTS teams (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     code TEXT NOT NULL
   )`,
  /**
   * This meet's own roster — copied in by `addTeam` alongside the team it
   * belongs to, one flat row per swimmer rather than D1's enrollment/season
   * pair: a meet is one day, not a competitive year, so there's nothing
   * seasonal left to say. `team_id` is what `addTeam`/`removeTeam` scope a
   * team's roster by and what a heat sheet stamps onto a `Swim`'s
   * `athleteTeam` — never part of the public `Athlete` shape itself, which
   * carries no team of its own (see `types/athlete.ts`).
   *
   * `is_walkup` marks a swimmer added here first, mid-meet, rather than
   * copied from an existing team roster — `addWalkupAthlete` sets it, and
   * `completeMeet` is what writes such a row back to D1 (a fresh account
   * and an enrollment), once, rather than on every walk-up while the meet
   * is still moving.
   */
  `CREATE TABLE IF NOT EXISTS athletes (
     id TEXT PRIMARY KEY,
     first_name TEXT NOT NULL,
     last_name TEXT NOT NULL,
     gender TEXT NOT NULL,
     team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
     birth_date TEXT,
     user_id TEXT,
     is_walkup INTEGER NOT NULL DEFAULT 0
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

/** This meet's own copy of a swimmer — `addTeam`'s roster rows and
 *  `addWalkupAthlete`'s. */
interface MeetAthleteRow {
  [key: string]: SqlStorageValue;
  id: string;
  first_name: string;
  last_name: string;
  gender: string;
  team_id: string;
  birth_date: string | null;
  user_id: string | null;
  is_walkup: number;
}

function meetAthleteFromRow(row: MeetAthleteRow): MeetAthlete {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    gender: row.gender === "M" ? "M" : "F",
    birthDate: row.birth_date ?? undefined,
    userId: row.user_id ?? undefined,
    teamId: row.team_id,
  };
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
      case "athlete":
        break;
      case "swim":
        break;
      case "watch":
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
   * The full client-side `MeetManifest` — everything `meet-layout.tsx`'s loader
   * needs for a meet that isn't `status: "complete"`. Plain `SELECT`s
   * against this DO's own tables plus the `meta` scalars — every one of
   * them, including `athletes`, is this DO's own durable storage now, so
   * there's no cache to warm and no D1 trip to make first.
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
    const details = this.getDetailsObject();

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

    const athletes = this.ctx.storage.sql
      .exec<MeetAthleteRow>("SELECT * FROM athletes")
      .toArray()
      .map(meetAthleteFromRow)
      .reduce<Record<string, MeetAthlete>>((record, athlete) => {
        record[athlete.id] = athlete;
        return record;
      }, {});

    const teams = this.ctx.storage.sql
      .exec<{ id: string; name: string; code: string }>("SELECT * FROM teams")
      .toArray()
      .reduce<Record<string, Team>>((record, row) => {
        record[row.id] = { id: row.id, name: row.name, code: row.code };
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
      athletes,
      teams,
      adminIds,
    };
  }

  /** `details` alone, without the rest of the manifest — what a settings
   *  form's action reads to merge its own changed fields onto before
   *  calling `setDetails`, cheaper than a full `getMeetManifest`. */
  async getDetails(meetId: string): Promise<MeetDetails> {
    return this.getDetailsObject();
  }

  private getDetailsObject(): MeetDetails {
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
   * Copy a racing team's roster in — the moment a team joins
   * `meet.teamIds`, so a timer, an admin or a coach can seat and time its
   * swimmers with no D1 dependency for the rest of the meet. Upsert, not
   * insert: calling this again (a coach adds a swimmer to the team's D1
   * roster mid-setup, say) just refreshes the copy. Broadcasts every
   * athlete as an `ATHLETE` upsert so a screen already open on this meet's
   * entries picks up the new names without a reload.
   */
  async addTeam(team: Team, roster: Athlete[]): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO teams (id, name, code) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, code = excluded.code`,
      team.id,
      team.name,
      team.code,
    );
    for (const athlete of roster) {
      this.ctx.storage.sql.exec(
        `INSERT INTO athletes (id, first_name, last_name, gender, team_id, birth_date, user_id, is_walkup)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           first_name = excluded.first_name,
           last_name = excluded.last_name,
           gender = excluded.gender,
           team_id = excluded.team_id,
           birth_date = excluded.birth_date,
           user_id = excluded.user_id,
           is_walkup = 0`,
        athlete.id,
        athlete.firstName,
        athlete.lastName,
        athlete.gender,
        team.id,
        athlete.birthDate ?? null,
        athlete.userId ?? null,
      );
      this.broadcast({
        type: "ATHLETE",
        athlete: { ...athlete, teamId: team.id },
        isDelete: false,
      });
    }
  }

  /**
   * Drop a team's whole roster copy — the moment it leaves `meet.teamIds`.
   * Refuses once any of its swimmers has an actual time or a decided
   * result against them: a scratch before racing starts is an ordinary
   * setup change, but pulling a team out from under a result that's
   * already stood would make swims that once had a swimmer's name on them
   * un-explainable. Entries and any un-timed swims for this team's
   * athletes go with it — they're not racing this meet any more, so
   * there's nothing for those rows to mean.
   */
  async removeTeam(
    teamId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const athletes = this.ctx.storage.sql
      .exec<MeetAthleteRow>("SELECT * FROM athletes WHERE team_id = ?", teamId)
      .toArray();
    const athleteIds = athletes.map((a) => a.id);
    if (athleteIds.length === 0) {
      this.ctx.storage.sql.exec("DELETE FROM teams WHERE id = ?", teamId);
      return { ok: true };
    }

    const placeholders = athleteIds.map(() => "?").join(",");
    const timed = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM swims
         WHERE athlete_id IN (${placeholders})
           AND (status IS NOT NULL OR official_time_ms IS NOT NULL)`,
        ...athleteIds,
      )
      .toArray()[0]?.n;
    const watched = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM watches w
         JOIN swims s ON (s.event_id, s.heat, s.lane) = (w.event_id, w.heat, w.lane)
         WHERE s.athlete_id IN (${placeholders}) AND w.time_ms IS NOT NULL`,
        ...athleteIds,
      )
      .toArray()[0]?.n;
    if ((timed ?? 0) > 0 || (watched ?? 0) > 0) {
      return {
        ok: false,
        reason:
          "This team has times or results recorded — it can't be removed.",
      };
    }

    this.ctx.storage.sql.exec(
      `DELETE FROM watches WHERE (event_id, heat, lane) IN
        (SELECT event_id, heat, lane FROM swims WHERE athlete_id IN (${placeholders}))`,
      ...athleteIds,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM swims WHERE athlete_id IN (${placeholders})`,
      ...athleteIds,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM entries WHERE athlete_id IN (${placeholders})`,
      ...athleteIds,
    );
    this.ctx.storage.sql.exec(`DELETE FROM athletes WHERE team_id = ?`, teamId);
    this.ctx.storage.sql.exec("DELETE FROM teams WHERE id = ?", teamId);

    for (const athlete of athletes) {
      this.broadcast({
        type: "ATHLETE",
        athlete: meetAthleteFromRow(athlete),
        isDelete: true,
      });
    }
    return { ok: true };
  }

  /** The advisory deck pointer — `MeetManifest.currentEventId`/
   *  `currentHeatNumber`. Advisory only, per the design doc: nothing here
   *  forces a connected timer's own screen to follow it. */
  async setCurrentHeat(
    meetId: string,
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
   * Also the one time a walk-up (`athletes.is_walkup = 1`) ever reaches
   * D1: a real account (`putAthlete`) and an enrollment on the team they
   * raced for (`enrolVisitor`), so the roster they were added to mid-meet
   * still has them on it afterwards. One at a time, ahead of the batch —
   * both calls are their own D1 round trip already, not a prepared
   * statement `db.batch` could fold in.
   *
   * Scoring (`place`/`points`) isn't computed here — nothing in this pass
   * wires up `ScoringRules`/`timing.ts` — so those columns are written null.
   */
  async completeMeet(meetId: string): Promise<void> {
    const walkups = this.ctx.storage.sql
      .exec<MeetAthleteRow>("SELECT * FROM athletes WHERE is_walkup = 1")
      .toArray();
    for (const row of walkups) {
      const athlete = await putAthlete(this.env.DB, {
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        gender: row.gender === "M" ? "M" : "F",
      });
      await enrolVisitor(this.env.DB, meetId, row.team_id, athlete.id);
    }

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

  /** Every declared entry, by event — the DO's own, not D1's, now that
   *  `declareEntry` is the only place an entry is written. */
  private readEntries(): Record<string, Entry[]> {
    const rows = this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM entries ORDER BY entered_at")
      .toArray();
    const entries: Record<string, Entry[]> = {};
    for (const row of rows)
      (entries[row.event_id] ??= []).push(entryFromRow(row));
    return entries;
  }

  /* --------------------------------------------------------- write methods */
  //
  // Every UI action against a swim, a watch or an athlete is one of two
  // shapes now: upsert the whole thing, or delete it by its key — the same
  // "send the object" convention `setDetails`/`setEvents` already use,
  // extended down to a single lane's swim and a single slot's watch. That
  // collapses what used to be eight methods (`seat`/`unseat`/`ensureLane`/
  // `setExhibition`/`recordWatch`/`dropWatch`/`decideResult`/
  // `undecideResult`) into four: seating an athlete, marking exhibition,
  // deciding a result and un-deciding one were never four different edits —
  // they're four different callers sending the same `Swim` object with a
  // different field changed, which a full replace already handles without
  // needing a method of its own for each slice. A synthetic id never
  // existed in the schema (`PRIMARY KEY (meet_id, event_id, heat, lane)`) —
  // it only ever existed in these methods' own stale SQL, left over from
  // before that redesign, which is what made them four methods instead of
  // one: each was reaching for an `id` no row has, and disagreeing quietly
  // with the others about what to do instead.
  //
  // Each still ends by broadcasting the very `LiveSocketMessage` it just
  // applied — the same shape `meetCache.applyPatch` (client-side) already
  // knows how to fold onto a cached manifest, so a connected screen updates
  // itself with no extra translation step on either end.

  /**
   * One lane's swim, replaced whole. Every UI action that touches a swim —
   * seating it, marking it exhibition, deciding or un-deciding its result —
   * is the same call: compute the complete next `Swim` and send it.
   * Whatever field the caller leaves off, the row doesn't have either, so
   * there's no way for a partial edit to disturb a field it wasn't about.
   *
   * `decidedAt`/`decidedBy` travel on the object like everything else, but
   * only a server action that has already resolved who's asking (or the
   * desk's own auto-status effect, which writes `"auto"`) may set them —
   * never a raw client write taken at face value.
   *
   * Still enforces the one cross-row rule a single lane's replace can't
   * express by itself: nobody swims an event twice, so seating an athlete
   * here vacates whatever other lane of the same event they held, and
   * broadcasts that lane's own emptying so a connected screen doesn't have
   * to infer it.
   */
  async upsertSwim(meetId: string, swim: Swim): Promise<Swim> {
    if (swim.athleteId) {
      const vacated = this.ctx.storage.sql
        .exec<SwimRow>(
          `SELECT * FROM swims WHERE event_id = ? AND athlete_id = ? AND NOT (heat = ? AND lane = ?)`,
          swim.eventId,
          swim.athleteId,
          swim.heat,
          swim.lane,
        )
        .toArray();
      for (const row of vacated) {
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
          type: "SWIM",
          swim: swimFromRow(row),
          isDelete: true,
        });
      }
    }

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
      swim.eventId,
      swim.heat,
      swim.lane,
      swim.athleteId ?? "",
      swim.athleteName ?? "",
      swim.athleteTeam ?? "",
      swim.exhibition ? 1 : 0,
      swim.status ?? null,
      swim.officialTimeMs ?? null,
      swim.decidedAt ?? null,
      swim.decidedBy ?? null,
    );

    // Deliberately no entries write here — seating never backports to an
    // entry, from any caller. See `migration-plan.md`.
    this.broadcast({ type: "SWIM", swim, isDelete: false });
    return swim;
  }

  /** Empties a lane — the swim, and whatever's been recorded against it.
   *  What used to be `unseat`. */
  async deleteSwim(meetId: string, slot: SwimIdentity): Promise<void> {
    const existing = this.ctx.storage.sql
      .exec<SwimRow>(
        "SELECT * FROM swims WHERE event_id = ? AND heat = ? AND lane = ?",
        slot.eventId,
        slot.heat,
        slot.lane,
      )
      .toArray()[0];
    if (!existing) return;

    this.ctx.storage.sql.exec(
      "DELETE FROM watches WHERE event_id = ? AND heat = ? AND lane = ?",
      slot.eventId,
      slot.heat,
      slot.lane,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM swims WHERE event_id = ? AND heat = ? AND lane = ?",
      slot.eventId,
      slot.heat,
      slot.lane,
    );
    this.broadcast({
      type: "SWIM",
      swim: swimFromRow(existing),
      isDelete: true,
    });
  }

  /**
   * A blank swim, if this lane doesn't have one yet — what `ensureLane`
   * used to do as a `Write` kind of its own. Not one any more: a slot's
   * watch always implies the lane it's evidence for, so `upsertWatch`
   * reaches for this itself rather than making every caller (the timer's
   * cookie path, the WS fast path) call two RPCs for one action. Silent on
   * purpose — nothing user-visible changed if the lane was already there,
   * and an empty one appearing is exactly the state `LaneRow`'s "no name
   * yet" rendering already expects.
   */
  private ensureSwimRow(meetId: string, slot: SwimIdentity): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO swims (event_id, heat, lane, athlete_id, athlete_name, athlete_team, exhibition)
       VALUES (?, ?, ?, '', '', '', 0)
       ON CONFLICT(event_id, heat, lane) DO NOTHING`,
      slot.eventId,
      slot.heat,
      slot.lane,
    );
  }

  /**
   * Name and team to stamp onto a swim (`Swim.athleteName`/`athleteTeam`) —
   * a public RPC now rather than a private step inside `seat`, because
   * `upsertSwim` takes the whole object and doesn't resolve anything of its
   * own any more. A caller building one (the timer, the desk) reaches for
   * this first: `MeetManifest` carries athletes but not which team each is
   * racing for at this meet — that's `team_id`, local to this DO's own
   * `athletes` row (`addTeam`/`addWalkupAthlete` are what set it) — so this
   * is a plain local join, no D1 trip, no cache to warm first.
   */
  async resolveAthleteDisplay(
    athleteId: string,
  ): Promise<{ name: string; team: string }> {
    if (!athleteId) return { name: "", team: "" };

    const row = this.ctx.storage.sql
      .exec<MeetAthleteRow & { code: string | null }>(
        `SELECT a.*, t.code
         FROM athletes a LEFT JOIN teams t ON t.id = a.team_id
         WHERE a.id = ?`,
        athleteId,
      )
      .toArray()[0];
    if (!row) return { name: "", team: "" };
    return {
      name: athleteName(meetAthleteFromRow(row)),
      team: row.code ?? "",
    };
  }

  /**
   * One slot's watch, replaced whole. What used to split across
   * `recordWatch` (a fresh append-only row) plus the caller's own
   * `ensureLane` call first: a slot's key — event/heat/lane/device/slot —
   * already is its whole identity, so a stopwatch running, then stopped,
   * then submitted is the same slot's row progressing through states, not
   * three different rows racing to be inserted. `ensureSwimRow` creates the
   * lane this is evidence for if nothing has touched it yet.
   */
  async upsertWatch(meetId: string, watch: Watch): Promise<Watch> {
    this.ensureSwimRow(meetId, watch);

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
      watch.eventId,
      watch.heat,
      watch.lane,
      watch.deviceId,
      watch.slot,
      watch.role,
      watch.userId ?? undefined,
      watch.timeMs,
      watch.startedAt,
      watch.stoppedAt,
      watch.recordedAt,
    );

    this.broadcast({ type: "WATCH", watch, isDelete: false });
    return watch;
  }

  /** Clears a slot's whole history — "this clock claim shouldn't exist," not
   *  a correction (that's a fresh `upsertWatch`). What used to be
   *  `dropWatch`. */
  async deleteWatch(meetId: string, key: WatchIdentity): Promise<void> {
    const existing = this.ctx.storage.sql
      .exec<WatchRow>(
        "SELECT * FROM watches WHERE event_id = ? AND heat = ? AND lane = ? AND device_id = ? AND slot = ?",
        key.eventId,
        key.heat,
        key.lane,
        key.deviceId,
        key.slot,
      )
      .toArray()[0];
    if (!existing) return;

    this.ctx.storage.sql.exec(
      "DELETE FROM watches WHERE event_id = ? AND heat = ? AND lane = ? AND device_id = ? AND slot = ?",
      key.eventId,
      key.heat,
      key.lane,
      key.deviceId,
      key.slot,
    );
    this.broadcast({
      type: "WATCH",
      watch: watchFromRow(existing),
      isDelete: true,
    });
  }

  async deleteEntry(mutation: EntryDeleteMutation): Promise<void> {
    const cursor = this.ctx.storage.sql.exec(
      "DELETE FROM entries WHERE event_id = ? AND athlete_id = ? RETURNING athlete_id",
      mutation.key.eventId,
      mutation.key.athleteId,
    );
    if (cursor.toArray().length > 0) {
      this.broadcast(mutation);
      this.reseed(mutation.key.eventId);
    }
  }

  async upsertEntry(mutation: EntryUpsertMutation): Promise<void> {
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
    this.broadcast(mutation);
    this.reseed(mutation.key.eventId);
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
    const details = this.getDetailsObject();

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

  /**
   * A name added behind the blocks. Lands only here, immediately — this
   * DO's own `athletes` row, `is_walkup = 1` — so every connected timer,
   * admin and coach sees the name the instant it's typed, with no D1 round
   * trip on the way. D1 doesn't hear about this swimmer at all until
   * `completeMeet` reconciles every `is_walkup` row into a real account and
   * enrollment, once, the same moment everything else about the meet
   * settles — not on every walk-up while the meet is still moving.
   */
  async addWalkupAthlete(input: {
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
  }): Promise<MeetAthlete> {
    const id = input.id ?? generateId();
    const gender: Gender = input.gender ?? "F";
    this.ctx.storage.sql.exec(
      `INSERT INTO athletes (id, first_name, last_name, gender, team_id, is_walkup)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         gender = excluded.gender,
         team_id = excluded.team_id`,
      id,
      input.firstName.trim().slice(0, 60),
      input.lastName.trim().slice(0, 60),
      gender,
      input.teamId,
    );

    const athlete: MeetAthlete = {
      id,
      firstName: input.firstName.trim().slice(0, 60),
      lastName: input.lastName.trim().slice(0, 60),
      gender,
      teamId: input.teamId,
    };
    this.broadcast({ type: "ATHLETE", athlete, isDelete: false });
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
      } catch {
        // A socket hibernation hasn't reaped yet. It will.
      }
    }
  }
}
