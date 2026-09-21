/**
 * Reading and writing a meet.
 *
 * Every function here takes a `D1Database` and returns POCOs. Loaders call
 * them; so do the JSON routes, so there is one query and one shape behind both
 * rather than a second read path built for the API.
 *
 * The writes are deliberately small. Seating a lane writes one row, entering a
 * swimmer writes one row, taking a time writes one row — because the people
 * doing those things are doing them at the same moment on different devices,
 * and the only reliable way for two writes not to fight is for them not to
 * touch the same row.
 */

import { ensureSchema } from "./schema.server";
import { generateId } from "./id";
import { DUAL_MEET_SCORING, isLaneCount, isTimersPerLane } from "~/types/meet";
import type {
  EntryLimits,
  LaneAssignments,
  LaneCount,
  Meet,
  MeetCourse,
  MeetDetail,
  Event,
  ScoringRules,
  Swim,
  MeetType,
  ResultStatus,
  Stroke,
  TimersPerLane,
  Watch,
} from "~/types/meet";
import type { Team } from "~/types/team";
import type { Athlete, Gender } from "~/types/athlete";
import { athleteRow, type AthleteRow } from "./athletes.server";
import {
  enrollmentFrom,
  teamRow,
  type EnrollmentRow,
  type TeamRow,
} from "./teams.server";

/* ------------------------------------------------------------------- rows */

interface MeetRow {
  id: string;
  name: string;
  date: string;
  type: string;
  course: string;
  location: string | null;
  host_team_id: string | null;
  created_by: string | null;
  lane_count: number;
  timers_per_lane: number;
  lead_gender: string;
  include_diving: number;
  entry_visibility: string;
  athletes_may_enter: number;
  max_individual: number | null;
  max_relays: number | null;
  max_total: number | null;
  max_per_team_per_event: number | null;
  lane_assignments: string | null;
  scoring: string | null;
}

/** Parse a JSON column, falling back rather than throwing on a bad or absent value. */
function parseJsonColumn<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function meetFrom(row: MeetRow, teamIds: string[]): Meet {
  const limits: EntryLimits = {};
  if (row.max_individual != null) limits.maxIndividual = row.max_individual;
  if (row.max_relays != null) limits.maxRelays = row.max_relays;
  if (row.max_total != null) limits.maxTotal = row.max_total;
  if (row.max_per_team_per_event != null) {
    limits.maxPerTeamPerEvent = row.max_per_team_per_event;
  }

  return {
    id: row.id,
    name: row.name,
    date: row.date,
    type: row.type as MeetType,
    course: row.course as MeetCourse,
    location: row.location ?? undefined,
    teamIds,
    hostTeamId: row.host_team_id ?? undefined,
    createdBy: row.created_by ?? undefined,
    laneCount: isLaneCount(row.lane_count) ? row.lane_count : 6,
    // Absent on every meet made before the setting existed, which is a meet
    // whose timers each carried their own phone.
    timersPerLane: isTimersPerLane(row.timers_per_lane)
      ? row.timers_per_lane
      : 2,
    leadGender: row.lead_gender === "M" ? "M" : "F",
    includeDiving: row.include_diving === 1,
    entryVisibility:
      row.entry_visibility === "own-team" ? "own-team" : "everyone",
    athletesMayEnter: row.athletes_may_enter === 1,
    limits,
    laneAssignments: parseJsonColumn<LaneAssignments>(row.lane_assignments, {}),
    scoring: parseJsonColumn<ScoringRules>(row.scoring, DUAL_MEET_SCORING),
  };
}

interface EventRow {
  id: string;
  meet_id: string;
  position: number;
  distance: number;
  stroke: string;
  gender: string;
  name: string | null;
}

function eventFrom(row: EventRow): Event {
  return {
    id: row.id,
    position: row.position,
    distance: row.distance,
    stroke: row.stroke as Stroke,
    gender: row.gender as Event["gender"],
    name: row.name ?? undefined,
  };
}

interface SwimRow {
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

function asResultStatus(value: string | null): ResultStatus | undefined {
  if (value === "DQ" || value === "NS") return value;
  return value === "OK" ? "OK" : undefined;
}

function swimFrom(row: SwimRow): Swim {
  return {
    id: row.id,
    eventId: row.event_id,
    heat: row.heat,
    lane: row.lane,
    athleteId: row.athlete_id,
    athleteName: row.athlete_name,
    athleteTeam: row.athlete_team,
    exhibition: row.exhibition === 1 ? true : undefined,
    status: asResultStatus(row.status),
    officialTimeMs: row.official_time_ms ?? undefined,
    decidedAt: row.decided_at ?? undefined,
    decidedBy: row.decided_by ?? undefined,
  };
}

interface WatchRow {
  id: string;
  swim_id: string;
  submitted_by: string;
  user_id: string | null;
  role: string | null;
  slot: number;
  time_ms: number | null;
  started_at: number | null;
  stopped_at: number | null;
  submitted_at: number;
}

function watchFrom(row: WatchRow): Watch {
  return {
    id: row.id,
    swimId: row.swim_id,
    submittedBy: row.submitted_by,
    userId: row.user_id ?? undefined,
    role: row.role === "admin" || row.role === "coach" ? row.role : "timer",
    slot: row.slot,
    timeMs: row.time_ms ?? undefined,
    startedAt: row.started_at ?? undefined,
    stoppedAt: row.stopped_at ?? undefined,
    submittedAt: row.submitted_at,
  };
}

/* ------------------------------------------------------------------ reads */

export async function getMeet(
  db: D1Database,
  id: string,
): Promise<Meet | null> {
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT * FROM meets WHERE id = ?")
    .bind(id)
    .first<MeetRow>();
  if (!row) return null;
  const { results } = await db
    .prepare("SELECT team_id FROM meet_teams WHERE meet_id = ?")
    .bind(id)
    .all<{ team_id: string }>();
  return meetFrom(
    row,
    results.map((r) => r.team_id),
  );
}

export interface MeetSummary {
  meet: Meet;
  teams: Team[];
  eventCount: number;
  entryCount: number;
  timedLanes: number;
}

/**
 * The meets list.
 *
 * Counts come back as aggregates rather than by loading each meet whole — the
 * list shows "1 event · 6 entries · 2 times" and nothing else, and fetching
 * six meets in full to render three numbers each is how a list screen gets
 * slow.
 */
export async function listMeets(
  db: D1Database,
  options: { teamId?: string } = {},
): Promise<MeetSummary[]> {
  await ensureSchema(db);

  const where = options.teamId
    ? "WHERE m.id IN (SELECT meet_id FROM meet_teams WHERE team_id = ?)"
    : "";
  const binds = options.teamId ? [options.teamId] : [];

  const { results: meetRows } = await db
    .prepare(`SELECT m.* FROM meets m ${where} ORDER BY m.date DESC`)
    .bind(...binds)
    .all<MeetRow>();
  if (meetRows.length === 0) return [];

  const ids = meetRows.map((m) => m.id);
  const holes = ids.map(() => "?").join(", ");

  const [links, events, entries, watches, teams] = await Promise.all([
    db
      .prepare(
        `SELECT meet_id, team_id FROM meet_teams WHERE meet_id IN (${holes})`,
      )
      .bind(...ids)
      .all<{ meet_id: string; team_id: string }>(),
    db
      .prepare(
        `SELECT meet_id, COUNT(*) AS n FROM events WHERE meet_id IN (${holes}) GROUP BY meet_id`,
      )
      .bind(...ids)
      .all<{ meet_id: string; n: number }>(),
    db
      .prepare(
        `SELECT meet_id, COUNT(*) AS n FROM entries WHERE meet_id IN (${holes}) GROUP BY meet_id`,
      )
      .bind(...ids)
      .all<{ meet_id: string; n: number }>(),
    db
      .prepare(
        `SELECT meet_id, COUNT(DISTINCT swim_id) AS n
       FROM watches WHERE meet_id IN (${holes}) AND time_ms IS NOT NULL
       GROUP BY meet_id`,
      )
      .bind(...ids)
      .all<{ meet_id: string; n: number }>(),
    db
      .prepare(
        `SELECT * FROM teams WHERE id IN (
         SELECT team_id FROM meet_teams WHERE meet_id IN (${holes}))`,
      )
      .bind(...ids)
      .all<TeamRow>(),
  ]);

  const teamById = new Map(
    teams.results.map((t) => [t.id, teamRow(t)] as const),
  );
  const teamsOf = new Map<string, string[]>();
  for (const link of links.results) {
    (
      teamsOf.get(link.meet_id) ??
      teamsOf.set(link.meet_id, []).get(link.meet_id)!
    ).push(link.team_id);
  }
  const count = (rows: { meet_id: string; n: number }[]) =>
    new Map(rows.map((r) => [r.meet_id, r.n] as const));
  const eventsBy = count(events.results);
  const entriesBy = count(entries.results);
  const watchesBy = count(watches.results);

  return meetRows.map((row) => {
    const teamIds = teamsOf.get(row.id) ?? [];
    return {
      meet: meetFrom(row, teamIds),
      teams: teamIds
        .map((id) => teamById.get(id))
        .filter((t): t is Team => !!t),
      eventCount: eventsBy.get(row.id) ?? 0,
      entryCount: entriesBy.get(row.id) ?? 0,
      timedLanes: watchesBy.get(row.id) ?? 0,
    };
  });
}

/**
 * Everything a meet's screens need, in one round of queries.
 *
 * Seven single-table reads against indexed `meet_id` columns, plus the people
 * those rows refer to. That denormalised column is why this isn't a pile of
 * joins.
 */
export async function meetDetail(
  db: D1Database,
  meetId: string,
): Promise<MeetDetail | null> {
  await ensureSchema(db);

  const meetRowP = db
    .prepare("SELECT * FROM meets WHERE id = ?")
    .bind(meetId)
    .first<MeetRow>();
  const [meetRow, links, events, entries, swims, watches] = await Promise.all([
    meetRowP,
    db
      .prepare("SELECT team_id FROM meet_teams WHERE meet_id = ?")
      .bind(meetId)
      .all<{ team_id: string }>(),
    db
      .prepare("SELECT * FROM events WHERE meet_id = ? ORDER BY position")
      .bind(meetId)
      .all<EventRow>(),
    // Ordered by when each entry was made: first entered swims the middle
    // lane until the app has a real seed time to rank by.
    db
      .prepare(
        "SELECT event_id, athlete_id FROM entries WHERE meet_id = ? ORDER BY entered_at",
      )
      .bind(meetId)
      .all<{ event_id: string; athlete_id: string }>(),
    db
      .prepare("SELECT * FROM swims WHERE meet_id = ?")
      .bind(meetId)
      .all<SwimRow>(),
    db
      .prepare("SELECT * FROM watches WHERE meet_id = ?")
      .bind(meetId)
      .all<WatchRow>(),
  ]);
  if (!meetRow) return null;

  const teamIds = links.results.map((r) => r.team_id);
  const meet = meetFrom(meetRow, teamIds);

  const entryMap: Record<string, string[]> = {};
  for (const row of entries.results) {
    (entryMap[row.event_id] ??= []).push(row.athlete_id);
  }

  // Everyone these rows actually name, plus everyone on a racing team's
  // roster — a swimmer nobody has entered yet still has to be pickable.
  const wanted = new Set<string>();
  for (const list of Object.values(entryMap))
    for (const id of list) wanted.add(id);
  // Skipping the lanes nobody has named yet, whose `athlete_id` is empty —
  // there is no such person to fetch.
  for (const swim of swims.results) {
    if (swim.athlete_id) wanted.add(swim.athlete_id);
  }

  const holes = teamIds.map(() => "?").join(", ");
  const [teams, rosters] = await Promise.all([
    teamIds.length
      ? db
          .prepare(`SELECT * FROM teams WHERE id IN (${holes})`)
          .bind(...teamIds)
          .all<TeamRow>()
      : Promise.resolve({ results: [] as TeamRow[] }),
    // The rosters of the teams actually racing, for the season this meet falls
    // in. A swimmer nobody has entered yet still needs a row on the grid.
    teamIds.length
      ? db
          .prepare(
            `SELECT e.* FROM enrollments e
           WHERE e.team_id IN (${holes})
             AND e.season_id IN (
               SELECT s.id FROM seasons s
               WHERE s.team_id = e.team_id
                 AND (s.start_date IS NULL OR s.start_date <= ?)
                 AND (s.end_date IS NULL OR s.end_date >= ?))`,
          )
          .bind(...teamIds, meet.date, meet.date)
          .all<EnrollmentRow>()
      : Promise.resolve({ results: [] as EnrollmentRow[] }),
  ]);
  for (const row of rosters.results) wanted.add(row.athlete_id);

  return {
    meet,
    teams: teams.results.map(teamRow),
    events: events.results.map(eventFrom),
    entries: entryMap,
    swims: swims.results.map(swimFrom),
    watches: watches.results.map(watchFrom),
    athletes: await athletesByIds(db, [...wanted]),
    enrollments: rosters.results.map(enrollmentFrom),
  };
}

/** People by id, in batches D1 will accept. */
async function athletesByIds(
  db: D1Database,
  ids: string[],
): Promise<Athlete[]> {
  if (ids.length === 0) return [];
  const out: Athlete[] = [];
  for (let start = 0; start < ids.length; start += 80) {
    const slice = ids.slice(start, start + 80);
    const { results } = await db
      .prepare(
        `SELECT * FROM athletes WHERE id IN (${slice.map(() => "?").join(", ")})`,
      )
      .bind(...slice)
      .all<AthleteRow>();
    out.push(...results.map(athleteRow));
  }
  return out;
}

/* ----------------------------------------------------------------- writing */

export interface MeetInput {
  name: string;
  date: string;
  type: MeetType;
  course: MeetCourse;
  location?: string;
  teamIds: string[];
  hostTeamId?: string;
  createdBy?: string;
  laneCount?: LaneCount;
  timersPerLane?: TimersPerLane;
  leadGender?: Gender;
  includeDiving?: boolean;
  limits?: EntryLimits;
  entryVisibility?: Meet["entryVisibility"];
  athletesMayEnter?: boolean;
  laneAssignments?: LaneAssignments;
  scoring?: ScoringRules;
}

export async function createMeet(
  db: D1Database,
  input: MeetInput,
  now = Date.now(),
): Promise<Meet> {
  await ensureSchema(db);
  const id = generateId();
  const teamIds = [...new Set(input.teamIds.filter(Boolean))];

  await db.batch([
    db
      .prepare(
        `INSERT INTO meets (id, name, date, type, course, location, host_team_id,
                          created_by, lane_count, timers_per_lane,
                          lead_gender, include_diving,
                          entry_visibility, athletes_may_enter,
                          max_individual, max_relays, max_total, max_per_team_per_event,
                          lane_assignments, scoring,
                          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.name,
        input.date,
        input.type,
        input.course,
        input.location ?? null,
        teamIds.includes(input.hostTeamId ?? "") ? input.hostTeamId! : null,
        input.createdBy ?? null,
        input.laneCount ?? 6,
        input.timersPerLane ?? 1,
        input.leadGender ?? "F",
        input.includeDiving ? 1 : 0,
        input.entryVisibility ?? "everyone",
        input.athletesMayEnter ? 1 : 0,
        input.limits?.maxIndividual ?? null,
        input.limits?.maxRelays ?? null,
        input.limits?.maxTotal ?? null,
        input.limits?.maxPerTeamPerEvent ?? null,
        JSON.stringify(input.laneAssignments ?? {}),
        JSON.stringify(input.scoring ?? DUAL_MEET_SCORING),
        now,
      ),
    ...teamIds.map((teamId) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO meet_teams (meet_id, team_id) VALUES (?, ?)",
        )
        .bind(id, teamId),
    ),
  ]);

  return (await getMeet(db, id))!;
}

/** Patch a meet's own fields. Columns absent from the patch are untouched. */
export async function updateMeet(
  db: D1Database,
  meetId: string,
  patch: Partial<MeetInput>,
): Promise<void> {
  await ensureSchema(db);

  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    binds.push(value);
  };

  if (patch.name !== undefined) set("name", patch.name);
  if (patch.date !== undefined) set("date", patch.date);
  if (patch.type !== undefined) set("type", patch.type);
  if (patch.course !== undefined) set("course", patch.course);
  if (patch.location !== undefined) set("location", patch.location || null);
  if (patch.hostTeamId !== undefined)
    set("host_team_id", patch.hostTeamId || null);
  if (patch.laneCount !== undefined) set("lane_count", patch.laneCount);
  if (patch.timersPerLane !== undefined) {
    set("timers_per_lane", patch.timersPerLane);
  }
  if (patch.leadGender !== undefined) set("lead_gender", patch.leadGender);
  if (patch.includeDiving !== undefined)
    set("include_diving", patch.includeDiving ? 1 : 0);
  if (patch.entryVisibility !== undefined)
    set("entry_visibility", patch.entryVisibility);
  if (patch.athletesMayEnter !== undefined) {
    set("athletes_may_enter", patch.athletesMayEnter ? 1 : 0);
  }
  if (patch.limits !== undefined) {
    set("max_individual", patch.limits.maxIndividual ?? null);
    set("max_relays", patch.limits.maxRelays ?? null);
    set("max_total", patch.limits.maxTotal ?? null);
    set("max_per_team_per_event", patch.limits.maxPerTeamPerEvent ?? null);
  }
  if (patch.laneAssignments !== undefined) {
    set("lane_assignments", JSON.stringify(patch.laneAssignments));
  }
  if (patch.scoring !== undefined)
    set("scoring", JSON.stringify(patch.scoring));

  if (sets.length > 0) {
    await db
      .prepare(`UPDATE meets SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...binds, meetId)
      .run();
  }

  if (patch.teamIds) {
    const teamIds = [...new Set(patch.teamIds.filter(Boolean))];
    await db.batch([
      db.prepare("DELETE FROM meet_teams WHERE meet_id = ?").bind(meetId),
      ...teamIds.map((teamId) =>
        db
          .prepare(
            "INSERT OR IGNORE INTO meet_teams (meet_id, team_id) VALUES (?, ?)",
          )
          .bind(meetId, teamId),
      ),
    ]);
  }
}

/**
 * Delete a meet and everything under it.
 *
 * A real delete, in one batch. There is no tombstone to keep: nothing else
 * holds a copy that could put the row back.
 */
export async function deleteMeet(
  db: D1Database,
  meetId: string,
): Promise<void> {
  await ensureSchema(db);
  await db.batch(
    ["watches", "swims", "entries", "events", "meet_teams"]
      .map((table) =>
        db.prepare(`DELETE FROM ${table} WHERE meet_id = ?`).bind(meetId),
      )
      .concat(db.prepare("DELETE FROM meets WHERE id = ?").bind(meetId)),
  );
}

/* ----------------------------------------------------------------- events */

export async function addEvent(
  db: D1Database,
  meetId: string,
  event: {
    distance: number;
    stroke: Stroke;
    gender: Event["gender"];
    name?: string;
  },
): Promise<Event> {
  await ensureSchema(db);
  const last = await db
    .prepare(
      "SELECT COALESCE(MAX(position), -1) AS p FROM events WHERE meet_id = ?",
    )
    .bind(meetId)
    .first<{ p: number }>();
  const id = generateId();
  await db
    .prepare(
      `INSERT INTO events (id, meet_id, position, distance, stroke, gender, name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      meetId,
      (last?.p ?? -1) + 1,
      event.distance,
      event.stroke,
      event.gender,
      event.name ?? null,
    )
    .run();
  return { id, position: (last?.p ?? -1) + 1, ...event };
}

/** Write a whole lineup at once — what "start from the standard order" does. */
export async function addEventsToMeet(
  db: D1Database,
  meetId: string,
  events: Event[],
): Promise<void> {
  await ensureSchema(db);
  if (events.length === 0) return;
  await db.batch(
    events.map((event, position) =>
      db
        .prepare(
          `INSERT INTO events (id, meet_id, position, distance, stroke, gender, name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          event.id,
          meetId,
          position,
          event.distance,
          event.stroke,
          event.gender,
          event.name ?? null,
        ),
    ),
  );
}

/**
 * Remove an event and everything under it.
 *
 * Watches hang off swims rather than the event, so nothing here deletes them
 * directly — `reseedEvent` refuses once the event has a watch or a decision
 * against it, so by the time this runs there is nothing hanging off a swim
 * that this would orphan.
 */
export async function removeEvent(
  db: D1Database,
  eventId: string,
): Promise<void> {
  await ensureSchema(db);
  await db.batch([
    db.prepare("DELETE FROM swims WHERE event_id = ?").bind(eventId),
    db.prepare("DELETE FROM entries WHERE event_id = ?").bind(eventId),
    db.prepare("DELETE FROM events WHERE id = ?").bind(eventId),
  ]);
}

/** Write the running order. `position` is the order, so this is one column. */
export async function setEventOrder(
  db: D1Database,
  order: string[],
): Promise<void> {
  await ensureSchema(db);
  if (order.length === 0) return;
  await db.batch(
    order.map((eventId, index) =>
      db
        .prepare("UPDATE events SET position = ? WHERE id = ?")
        .bind(index, eventId),
    ),
  );
}

/* ------------------------------------------------------------------ heats */

/** Find the swim in a lane, if there is one. */
export async function swimAt(
  db: D1Database,
  eventId: string,
  heat: number,
  lane: number,
): Promise<Swim | null> {
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT * FROM swims WHERE event_id = ? AND heat = ? AND lane = ?")
    .bind(eventId, heat, lane)
    .first<SwimRow>();
  return row ? swimFrom(row) : null;
}

/**
 * The swim in a lane, made to exist because something was timed against it.
 *
 * A watch belongs to a swim, and a swim is a lane in a heat before it is
 * anybody in particular. Behind the blocks the name is often the last thing
 * settled: the volunteer is watching the water, the heat goes off, and who
 * was in lane 4 gets sorted out afterwards. So a time for a lane nobody has
 * named creates the lane rather than being refused, with no athlete on it.
 *
 * Nothing else about the row is touched if it is already there — this never
 * moves anybody or un-names a lane — and a name arriving later keeps this
 * id (the meet's Durable Object does the equivalent for the live meet; see
 * `MeetDurableObject.seat`), so the watch is already hanging off the right
 * swim.
 */
export async function ensureLane(
  db: D1Database,
  meetId: string,
  place: { eventId: string; heat: number; lane: number },
): Promise<Swim> {
  await ensureSchema(db);

  const existing = await swimAt(db, place.eventId, place.heat, place.lane);
  if (existing) return existing;

  const id = generateId();
  await db
    .prepare(
      `INSERT INTO swims (id, meet_id, event_id, heat, lane, athlete_id)
       VALUES (?, ?, ?, ?, ?, '')
       ON CONFLICT(event_id, heat, lane) DO NOTHING`,
    )
    .bind(id, meetId, place.eventId, place.heat, place.lane)
    .run();

  // Re-read rather than trusting the insert: two timers on the same lane can
  // both arrive here, and the one that lost has to come away with the id that
  // won — otherwise their watches would hang off two different swims.
  return (
    (await swimAt(db, place.eventId, place.heat, place.lane)) ?? {
      id,
      eventId: place.eventId,
      heat: place.heat,
      lane: place.lane,
      athleteId: "",
      athleteName: "",
      athleteTeam: "",
    }
  );
}

/**
 * One more heat, empty until somebody's named.
 *
 * Numbered after whatever the event already has, and made to exist the same
 * way any unnamed lane does — a placeholder row nobody has named, in lane one.
 * The rest of the pool doesn't need a row of its own: the run screens already
 * draw every lane of a heat whether or not it's seeded.
 */
export async function addHeat(
  db: D1Database,
  meetId: string,
  eventId: string,
): Promise<number> {
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT COALESCE(MAX(heat), 0) AS h FROM swims WHERE event_id = ?")
    .bind(eventId)
    .first<{ h: number }>();
  const heat = (row?.h ?? 0) + 1;
  await ensureLane(db, meetId, { eventId, heat, lane: 1 });
  return heat;
}
