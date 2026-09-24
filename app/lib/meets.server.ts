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
  MeetStatus,
  MeetType,
  ScoringRules,
  TimersPerLane,
} from "~/types/meet";
import type { Team } from "~/types/team";
import type { Gender } from "~/types/athlete";
import { teamRow, type TeamRow } from "./teams.server";
import { ensureAdminStore, meetAdminIds } from "./admins.server";

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
  status: string;
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

function meetFrom(row: MeetRow, teamIds: string[], adminIds: string[]): Meet {
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
    adminIds,
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
    status: row.status === "complete" ? "complete" : "scheduled",
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
  const [teams, adminIds] = await Promise.all([
    db
      .prepare("SELECT team_id FROM meet_teams WHERE meet_id = ?")
      .bind(id)
      .all<{ team_id: string }>(),
    meetAdminIds(db, id),
  ]);
  return meetFrom(
    row,
    teams.results.map((r) => r.team_id),
    adminIds,
  );
}

/**
 * The one cheap read a route needs before it can decide where the rest of a
 * meet's data comes from: `status !== "complete"` means "ask the meet's
 * Durable Object", `"complete"` means "read D1's `results` table instead,
 * and don't wake the DO to do it." See `meets2.tsx`.
 */
export async function getMeetGate(
  db: D1Database,
  id: string,
): Promise<{ id: string; name: string; status: MeetStatus } | null> {
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT id, name, status FROM meets WHERE id = ?")
    .bind(id)
    .first<{ id: string; name: string; status: string }>();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status === "complete" ? "complete" : "scheduled",
  };
}

export interface MeetSummary {
  meet: Meet;
  teams: Team[];
}

/**
 * The meets list. D1-only, on purpose: a meet's event/entry/timing counts now
 * live in its Durable Object, and waking every meet's DO just to render a
 * list is exactly what this split is meant to avoid — so this list no longer
 * shows them.
 */
export async function listMeets(
  db: D1Database,
  options: { teamId?: string } = {},
): Promise<MeetSummary[]> {
  await Promise.all([ensureSchema(db), ensureAdminStore(db)]);

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

  const [links, teams, admins] = await Promise.all([
    db
      .prepare(
        `SELECT meet_id, team_id FROM meet_teams WHERE meet_id IN (${holes})`,
      )
      .bind(...ids)
      .all<{ meet_id: string; team_id: string }>(),
    db
      .prepare(
        `SELECT * FROM teams WHERE id IN (
         SELECT team_id FROM meet_teams WHERE meet_id IN (${holes}))`,
      )
      .bind(...ids)
      .all<TeamRow>(),
    db
      .prepare(
        `SELECT meet_id, user_id FROM meet_admins WHERE meet_id IN (${holes})`,
      )
      .bind(...ids)
      .all<{ meet_id: string; user_id: string }>(),
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
  const adminsOf = new Map<string, string[]>();
  for (const row of admins.results) {
    (
      adminsOf.get(row.meet_id) ??
      adminsOf.set(row.meet_id, []).get(row.meet_id)!
    ).push(row.user_id);
  }

  return meetRows.map((row) => {
    const teamIds = teamsOf.get(row.id) ?? [];
    return {
      meet: meetFrom(row, teamIds, adminsOf.get(row.id) ?? []),
      teams: teamIds
        .map((id) => teamById.get(id))
        .filter((t): t is Team => !!t),
    };
  });
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
    ["results", "meet_teams"]
      .map((table) =>
        db.prepare(`DELETE FROM ${table} WHERE meet_id = ?`).bind(meetId),
      )
      .concat(db.prepare("DELETE FROM meets WHERE id = ?").bind(meetId)),
  );
}
