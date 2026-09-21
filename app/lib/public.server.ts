/**
 * The reading side, over the real tables.
 *
 * These are the queries behind both the browse screens and the public JSON
 * API — one query and one projection, called twice, rather than a second read
 * path built because the sync engine could only ever serve your own team.
 *
 * Everything that leaves here goes through the projections in `public.ts`,
 * which name the fields that may travel rather than deleting the ones that
 * mustn't. Birth dates and contact details never appear.
 */

import { ensureSchema } from "./schema.server";
import { coachedTeams, teamsCoachedBy } from "./coaches.server";
import { athleteRow, type AthleteRow } from "./athletes.server";
import { teamRow, type TeamRow } from "./teams.server";
import { listMeets, meetDetail } from "./meets.server";
import { recordedCount } from "./timing";
import {
  athleteSwims,
  meetResults,
  meetSummary,
  publicAthlete,
  teamRef,
  type PublicAthlete,
  type PublicAthleteDetail,
  type PublicMeetDetail,
  type PublicMeetSummary,
  type PublicTeam,
  type TeamRef,
} from "./public";
import type { Athlete } from "~/types/athlete";

/* ------------------------------------------------------------------- teams */

/** Counts per team, in one pass rather than one query each. */
async function teamCounts(
  db: D1Database,
  teamIds: string[],
): Promise<Map<string, { athletes: number; meets: number; times: number }>> {
  const counts = new Map<
    string,
    { athletes: number; meets: number; times: number }
  >();
  if (teamIds.length === 0) return counts;
  const holes = teamIds.map(() => "?").join(", ");

  const [people, meets, claimed] = await Promise.all([
    db
      .prepare(
        `SELECT team_id, COUNT(DISTINCT athlete_id) AS n FROM enrollments
       WHERE team_id IN (${holes}) GROUP BY team_id`,
      )
      .bind(...teamIds)
      .all<{ team_id: string; n: number }>(),
    db
      .prepare(
        `SELECT team_id, COUNT(*) AS n FROM meet_teams
       WHERE team_id IN (${holes}) GROUP BY team_id`,
      )
      .bind(...teamIds)
      .all<{ team_id: string; n: number }>(),
    db
      .prepare(
        `SELECT mt.team_id AS team_id, COUNT(DISTINCT w.seed_id) AS n
       FROM meet_teams mt JOIN watches w ON w.meet_id = mt.meet_id
       WHERE mt.team_id IN (${holes}) AND w.time_ms IS NOT NULL
       GROUP BY mt.team_id`,
      )
      .bind(...teamIds)
      .all<{ team_id: string; n: number }>(),
  ]);

  for (const id of teamIds) counts.set(id, { athletes: 0, meets: 0, times: 0 });
  for (const row of people.results) counts.get(row.team_id)!.athletes = row.n;
  for (const row of meets.results) counts.get(row.team_id)!.meets = row.n;
  for (const row of claimed.results) counts.get(row.team_id)!.times = row.n;
  return counts;
}

export async function listPublicTeams(db: D1Database): Promise<PublicTeam[]> {
  await ensureSchema(db);
  const { results } = await db
    .prepare("SELECT * FROM teams ORDER BY name")
    .all<TeamRow>();
  const ids = results.map((r) => r.id);
  const [counts, claimed] = await Promise.all([
    teamCounts(db, ids),
    coachedTeams(db),
  ]);

  return results.map((row) => {
    const team = teamRow(row);
    const count = counts.get(row.id) ?? { athletes: 0, meets: 0, times: 0 };
    return {
      id: team.id,
      name: team.name,
      code: team.code,
      claimed: claimed.has(team.id),
      athletes: count.athletes,
      meets: count.meets,
      times: count.times,
    };
  });
}

/**
 * `meets` is a list here and a count on `PublicTeam`, so the count is dropped
 * rather than shadowed — two fields of the same name meaning different things
 * is how a template ends up printing "[object Object] meets".
 */
export interface PublicTeamDetail extends Omit<PublicTeam, "meets"> {
  seasons: Array<{
    id: string;
    name: string;
    startDate?: string;
    endDate?: string;
    roster: Array<
      PublicAthlete & { year: string; squad?: string; active: boolean }
    >;
  }>;
  meets: PublicMeetSummary[];
}

export async function publicTeamDetail(
  db: D1Database,
  teamId: string,
): Promise<PublicTeamDetail | null> {
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT * FROM teams WHERE id = ?")
    .bind(teamId)
    .first<TeamRow>();
  if (!row) return null;
  const team = teamRow(row);

  const [seasons, roster, counts, claimed, meets] = await Promise.all([
    db
      .prepare(
        "SELECT * FROM seasons WHERE team_id = ? ORDER BY COALESCE(start_date, ''), name",
      )
      .bind(teamId)
      .all<{
        id: string;
        name: string;
        start_date: string | null;
        end_date: string | null;
      }>(),
    db
      .prepare(
        `SELECT e.season_id, e.year, e.squad, e.status,
              a.id, a.first_name, a.last_name, a.gender, a.birth_date, a.user_id
       FROM enrollments e JOIN athletes a ON a.id = e.athlete_id
       WHERE e.team_id = ? ORDER BY a.last_name, a.first_name`,
      )
      .bind(teamId)
      .all<
        AthleteRow & {
          season_id: string;
          year: string;
          squad: string | null;
          status: string;
        }
      >(),
    teamCounts(db, [teamId]),
    coachedTeams(db),
    listMeets(db, { teamId }),
  ]);

  const count = counts.get(teamId) ?? { athletes: 0, meets: 0, times: 0 };

  return {
    id: team.id,
    name: team.name,
    code: team.code,
    claimed: claimed.has(team.id),
    athletes: count.athletes,
    times: count.times,
    seasons: seasons.results.map((season) => ({
      id: season.id,
      name: season.name,
      startDate: season.start_date ?? undefined,
      endDate: season.end_date ?? undefined,
      roster: roster.results
        .filter((r) => r.season_id === season.id)
        .map((r) => ({
          ...publicAthlete(athleteRow(r)),
          year: r.year,
          squad: r.squad ?? undefined,
          active: r.status !== "inactive",
        })),
    })),
    meets: meets.map((row) =>
      meetSummary(row.meet, row.teams, {
        events: row.eventCount,
        entries: row.entryCount,
        times: row.timedLanes,
      }),
    ),
  };
}

/* ------------------------------------------------------------------- meets */

export async function listPublicMeets(
  db: D1Database,
  options: { teamId?: string } = {},
): Promise<PublicMeetSummary[]> {
  const rows = await listMeets(db, options);
  return rows.map((row) =>
    meetSummary(row.meet, row.teams, {
      events: row.eventCount,
      entries: row.entryCount,
      times: row.timedLanes,
    }),
  );
}

export async function publicMeetDetail(
  db: D1Database,
  meetId: string,
): Promise<PublicMeetDetail | null> {
  const detail = await meetDetail(db, meetId);
  if (!detail) return null;

  // Which team each swimmer was racing for, from the enrollments this meet
  // already loaded. A visiting swimmer is on their own school's roster, not
  // on the host's, which is the whole reason athletes are global.
  const teams = new Map(detail.teams.map((t) => [t.id, teamRef(t)] as const));
  const teamOf = (athleteId: string): TeamRef | null => {
    const enrolled = detail.enrollments.find((e) => e.athleteId === athleteId);
    return enrolled ? (teams.get(enrolled.teamId) ?? null) : null;
  };

  const entries = Object.values(detail.entries).reduce(
    (n, ids) => n + ids.length,
    0,
  );
  return {
    ...meetSummary(detail.meet, detail.teams, {
      events: detail.events.length,
      entries,
      times: recordedCount(detail),
    }),
    results: meetResults(detail, teamOf),
  };
}

/* ---------------------------------------------------------------- athletes */

export async function listPublicAthletes(
  db: D1Database,
  options: { q?: string; limit?: number } = {},
): Promise<Array<PublicAthlete & { teams: TeamRef[] }>> {
  await ensureSchema(db);
  const limit = Math.min(options.limit ?? 200, 500);
  const q = options.q?.trim();

  const { results } = q
    ? await db
        .prepare(
          `SELECT * FROM athletes WHERE last_name LIKE ?1 OR first_name LIKE ?1
           ORDER BY last_name, first_name LIMIT ?2`,
        )
        .bind(`%${q}%`, limit)
        .all<AthleteRow>()
    : await db
        .prepare(
          "SELECT * FROM athletes ORDER BY last_name, first_name LIMIT ?",
        )
        .bind(limit)
        .all<AthleteRow>();

  if (results.length === 0) return [];
  const ids = results.map((r) => r.id);
  const holes = ids.map(() => "?").join(", ");

  const { results: links } = await db
    .prepare(
      `SELECT DISTINCT e.athlete_id, t.id, t.name, t.code
       FROM enrollments e JOIN teams t ON t.id = e.team_id
       WHERE e.athlete_id IN (${holes})`,
    )
    .bind(...ids)
    .all<{ athlete_id: string; id: string; name: string; code: string }>();

  const teamsOf = new Map<string, TeamRef[]>();
  for (const link of links) {
    const list = teamsOf.get(link.athlete_id) ?? [];
    list.push({ id: link.id, name: link.name, code: link.code });
    teamsOf.set(link.athlete_id, list);
  }

  return results.map((row) => ({
    ...publicAthlete(athleteRow(row)),
    teams: teamsOf.get(row.id) ?? [],
  }));
}

export async function publicAthleteDetail(
  db: D1Database,
  athleteId: string,
): Promise<PublicAthleteDetail | null> {
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT * FROM athletes WHERE id = ?")
    .bind(athleteId)
    .first<AthleteRow>();
  if (!row) return null;
  const athlete: Athlete = athleteRow(row);

  const { results: enrolled } = await db
    .prepare(
      `SELECT t.id, t.name, t.code, s.name AS season
       FROM enrollments e
       JOIN teams t ON t.id = e.team_id
       JOIN seasons s ON s.id = e.season_id
       WHERE e.athlete_id = ?`,
    )
    .bind(athleteId)
    .all<{ id: string; name: string; code: string; season: string }>();

  const teams = new Map<string, TeamRef & { seasons: string[] }>();
  for (const row of enrolled) {
    const existing = teams.get(row.id) ?? {
      id: row.id,
      name: row.name,
      code: row.code,
      seasons: [],
    };
    if (!existing.seasons.includes(row.season))
      existing.seasons.push(row.season);
    teams.set(row.id, existing);
  }

  // The meets they actually swam in, rather than every meet in the database.
  const { results: meetIds } = await db
    .prepare(
      `SELECT DISTINCT meet_id FROM (
         SELECT meet_id FROM entries WHERE athlete_id = ?1
         UNION SELECT meet_id FROM seeds WHERE athlete_id = ?1)`,
    )
    .bind(athleteId)
    .all<{ meet_id: string }>();

  const details = await Promise.all(
    meetIds.map((row) => meetDetail(db, row.meet_id)),
  );

  return {
    ...publicAthlete(athlete),
    teams: [...teams.values()],
    swims: athleteSwims(
      athleteId,
      details.filter((d): d is NonNullable<typeof d> => d !== null),
    ),
  };
}

/* ------------------------------------------------------------------- users */

export interface UserDashboard {
  userId: string;
  name: string | null;
  /** The teams this person coaches. */
  teams: TeamRef[];
  meets: PublicMeetSummary[];
  /** The athlete record this account is, when one has been linked. */
  athlete: PublicAthlete | null;
}

export async function userDashboard(
  db: D1Database,
  userId: string,
): Promise<UserDashboard | null> {
  await ensureSchema(db);

  const user = await db
    .prepare("SELECT id, name FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; name: string | null }>();
  if (!user) return null;

  const teamIds = await teamsCoachedBy(db, userId);
  const teams: TeamRef[] = [];
  if (teamIds.length > 0) {
    const { results } = await db
      .prepare(
        `SELECT * FROM teams WHERE id IN (${teamIds.map(() => "?").join(", ")})`,
      )
      .bind(...teamIds)
      .all<TeamRow>();
    for (const row of results) teams.push(teamRef(teamRow(row)));
  }

  const linked = await db
    .prepare("SELECT * FROM athletes WHERE user_id = ?")
    .bind(userId)
    .first<AthleteRow>();

  // Every meet their teams are racing, newest first.
  const meets: PublicMeetSummary[] = [];
  const seen = new Set<string>();
  for (const teamId of teamIds) {
    for (const row of await listPublicMeets(db, { teamId })) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      meets.push(row);
    }
  }
  meets.sort((a, b) => b.date.localeCompare(a.date));

  return {
    userId: user.id,
    name: user.name,
    teams,
    meets,
    athlete: linked ? publicAthlete(athleteRow(linked)) : null,
  };
}
