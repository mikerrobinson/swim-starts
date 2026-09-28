/**
 * Teams, their seasons, and who swam for them.
 *
 * A team does not hold its athletes. The roster is the set of enrollments
 * pointing at global athlete records, which is what lets two teams racing the
 * same swimmer point at one person instead of keeping a copy each.
 */

import { ensureSchema } from "./schema.server";
import { generateId } from "./id";
import { todayIso } from "~/types/athlete";
import { normalizeTeamCode } from "~/types/team";
import type { Athlete } from "~/types/athlete";
import type { EnrollmentStatus } from "~/types/team";
import type { Enrollment } from "~/types/team";
import type { Season } from "~/types/team";
import type { Team } from "~/types/team";
import { athleteRow, type AthleteRow } from "./athletes.server";

export interface TeamRow {
  id: string;
  name: string;
  code: string;
  current_season_id: string | null;
  created_by: string | null;
  created_at: number;
}

export function teamRow(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    currentSeasonId: row.current_season_id ?? undefined,
    createdBy: row.created_by ?? undefined,
  };
}

interface SeasonRow {
  id: string;
  team_id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
}

function seasonRow(row: SeasonRow): Season {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    startDate: row.start_date ?? undefined,
    endDate: row.end_date ?? undefined,
  };
}

export interface EnrollmentRow {
  id: string;
  team_id: string;
  season_id: string;
  athlete_id: string;
  year: string;
  squad: string | null;
  status: string;
}

function enrollmentFrom(row: EnrollmentRow): Enrollment {
  return {
    id: row.id,
    teamId: row.team_id,
    seasonId: row.season_id,
    athleteId: row.athlete_id,
    year: row.year,
    squad: row.squad ?? undefined,
    status: row.status === "inactive" ? "inactive" : "active",
  };
}

/* ------------------------------------------------------------------ reads */

export async function getTeam(
  db: D1Database,
  id: string,
): Promise<Team | null> {
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT * FROM teams WHERE id = ?")
    .bind(id)
    .first<TeamRow>();
  return row ? teamRow(row) : null;
}

export async function listSeasons(
  db: D1Database,
  teamId: string,
): Promise<Season[]> {
  await ensureSchema(db);
  const { results } = await db
    .prepare(
      "SELECT * FROM seasons WHERE team_id = ? ORDER BY COALESCE(start_date, ''), name",
    )
    .bind(teamId)
    .all<SeasonRow>();
  return results.map(seasonRow);
}

export interface RosterEntry {
  athlete: Athlete;
  enrollment: Enrollment;
}

/**
 * A team's roster for a season, as people plus what's true of them this year.
 *
 * One join, because that is what the roster *is* — the alternative is two
 * round trips and a stitch on the client.
 */
export async function roster(
  db: D1Database,
  teamId: string,
  seasonId?: string,
): Promise<RosterEntry[]> {
  await ensureSchema(db);
  const { results } = seasonId
    ? await db
        .prepare(
          `SELECT e.*, a.id AS a_id, a.first_name, a.last_name, a.gender, a.birth_date, a.user_id
           FROM enrollments e JOIN athletes a ON a.id = e.athlete_id
           WHERE e.team_id = ? AND e.season_id = ?
           ORDER BY a.last_name, a.first_name`,
        )
        .bind(teamId, seasonId)
        .all<EnrollmentRow & AthleteRow & { a_id: string }>()
    : await db
        .prepare(
          `SELECT e.*, a.id AS a_id, a.first_name, a.last_name, a.gender, a.birth_date, a.user_id
           FROM enrollments e JOIN athletes a ON a.id = e.athlete_id
           WHERE e.team_id = ?
           ORDER BY a.last_name, a.first_name`,
        )
        .bind(teamId)
        .all<EnrollmentRow & AthleteRow & { a_id: string }>();

  return results.map((row) => ({
    athlete: athleteRow({ ...row, id: row.a_id }),
    enrollment: enrollmentFrom(row),
  }));
}

/**
 * The season a date falls in, or the team's current one.
 *
 * A season with no dates covers everything, which is what a roster carried
 * over from before seasons existed means.
 */
export function seasonForDate(
  seasons: Season[],
  currentSeasonId: string | undefined,
  isoDate: string,
): Season | undefined {
  const covering = seasons.find(
    (s) =>
      (!s.startDate || s.startDate <= isoDate) &&
      (!s.endDate || s.endDate >= isoDate),
  );
  return (
    covering ?? seasons.find((s) => s.id === currentSeasonId) ?? seasons.at(-1)
  );
}

/* ----------------------------------------------------------------- writing */

/**
 * Make a team.
 *
 * `createdBy` is who set it up, recorded the same way a meet records it: not a
 * permission — coaching a team is a row in `team_coaches`, and the creator
 * gets one of those too — but the answer to "where did this come from", which
 * matters most for the placeholder teams typed in as opponents.
 */
export async function createTeam(
  db: D1Database,
  input: { name: string; code?: string; id?: string; createdBy?: string },
  now = Date.now(),
): Promise<Team> {
  await ensureSchema(db);
  const id = input.id ?? generateId();
  const code = normalizeTeamCode(input.code || input.name);
  await db
    .prepare(
      `INSERT INTO teams (id, name, code, current_season_id, created_by, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, code = excluded.code`,
    )
    .bind(
      id,
      input.name.trim().slice(0, 80),
      code,
      input.createdBy ?? null,
      now,
    )
    .run();
  return (await getTeam(db, id))!;
}

export async function updateTeam(
  db: D1Database,
  teamId: string,
  patch: Partial<Pick<Team, "name" | "code" | "currentSeasonId">>,
): Promise<void> {
  await ensureSchema(db);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    binds.push(patch.name.trim().slice(0, 80));
  }
  if (patch.code !== undefined) {
    sets.push("code = ?");
    binds.push(normalizeTeamCode(patch.code));
  }
  if (patch.currentSeasonId !== undefined) {
    sets.push("current_season_id = ?");
    binds.push(patch.currentSeasonId || null);
  }
  if (sets.length === 0) return;
  await db
    .prepare(`UPDATE teams SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds, teamId)
    .run();
}

export async function createSeason(
  db: D1Database,
  input: { teamId: string; name: string; startDate?: string; endDate?: string },
): Promise<Season> {
  await ensureSchema(db);
  const id = generateId();
  await db
    .prepare(
      `INSERT INTO seasons (id, team_id, name, start_date, end_date)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.teamId,
      input.name,
      input.startDate ?? null,
      input.endDate ?? null,
    )
    .run();
  return {
    id,
    teamId: input.teamId,
    name: input.name,
    startDate: input.startDate,
    endDate: input.endDate,
  };
}

export interface EnrolInput {
  teamId: string;
  seasonId: string;
  athleteId: string;
  year?: string;
  squad?: string;
  status?: EnrollmentStatus;
}

/**
 * Put somebody on a roster.
 *
 * The id is derived from the season and the athlete rather than generated, so
 * enrolling the same person twice — a re-import, a timer adding a visiting
 * swimmer who was already there — updates one row instead of making a second.
 */
export async function enrol(
  db: D1Database,
  input: EnrolInput,
): Promise<Enrollment> {
  await ensureSchema(db);
  const id = `${input.seasonId}:${input.athleteId}`;
  await db
    .prepare(
      `INSERT INTO enrollments (id, team_id, season_id, athlete_id, year, squad, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(season_id, athlete_id) DO UPDATE SET
         year = excluded.year, squad = excluded.squad, status = excluded.status`,
    )
    .bind(
      id,
      input.teamId,
      input.seasonId,
      input.athleteId,
      input.year ?? "",
      input.squad ?? null,
      input.status ?? "active",
    )
    .run();
  return {
    id,
    teamId: input.teamId,
    seasonId: input.seasonId,
    athleteId: input.athleteId,
    year: input.year ?? "",
    squad: input.squad,
    status: input.status ?? "active",
  };
}

/**
 * Enrol a visiting swimmer a timer typed in, from the meet's own facts.
 *
 * A timer may say "this is a Horizon swimmer". They may not say which team
 * document to write into or which season, and the difference is what keeps a
 * QR-code grant from reaching a team's roster generally.
 */
export async function enrolVisitor(
  db: D1Database,
  meetId: string,
  teamId: string,
  athleteId: string,
): Promise<Enrollment | null> {
  await ensureSchema(db);
  const racing = await db
    .prepare("SELECT 1 AS ok FROM meet_teams WHERE meet_id = ? AND team_id = ?")
    .bind(meetId, teamId)
    .first<{ ok: number }>();
  if (!racing) return null;

  const meet = await db
    .prepare("SELECT date FROM meets WHERE id = ?")
    .bind(meetId)
    .first<{ date: string }>();
  const team = await getTeam(db, teamId);
  const seasons = await listSeasons(db, teamId);
  const season = seasonForDate(
    seasons,
    team?.currentSeasonId,
    meet?.date ?? todayIso(),
  );
  if (!season) return null;

  return enrol(db, { teamId, seasonId: season.id, athleteId });
}
