/**
 * What anyone may see, and the shapes it comes in.
 *
 * High-school swim results are public: heat sheets are printed and handed out,
 * results are read over a PA, and a season's times end up on a school website.
 * So browsing meets, teams, rosters and results needs no account at all, and
 * the app stops pretending otherwise.
 *
 * Two things are *not* public, and both are guarded here rather than at the
 * edge of a component where a later refactor could quietly drop the check:
 *
 *   - **Birth dates.** Needed for age-group entries and SDIF export, and
 *     nobody else's business. A minor's date of birth is the one field on an
 *     athlete record worth real care.
 *   - **Contact details.** An email or mobile identifies an account, and
 *     never leaves the auth tables.
 *
 * Everything here is pure so the redaction can be tested without a database:
 * the question "can a birth date get out?" should have an answer that doesn't
 * depend on which route is asking.
 */

import { eventClosed, swimTime, type SwimTime } from "./timing";
import { athleteName, eventName, isDiving } from "~/types/meet";
import type { Athlete, Gender } from "~/types/athlete";
import type {
  Seed,
  Meet,
  MeetCourse,
  MeetDetail,
  MeetType,
  Result,
} from "~/types/meet";
import type { Team } from "~/types/team";

/* ------------------------------------------------------------------ people */

/**
 * A person as the world may see them: a name and a gender, because both are
 * on every heat sheet ever printed. Deliberately built by naming the fields
 * that may travel rather than by deleting the ones that may not — a field
 * added to `Athlete` later is then private until someone decides otherwise.
 */
export interface PublicAthlete {
  id: string;
  firstName: string;
  lastName: string;
  gender: Gender;
}

export function publicAthlete(athlete: Athlete): PublicAthlete {
  return {
    id: athlete.id,
    firstName: athlete.firstName,
    lastName: athlete.lastName,
    gender: athlete.gender,
  };
}

export function publicAthletes(athletes: Athlete[]): PublicAthlete[] {
  return athletes.map(publicAthlete);
}

/* ------------------------------------------------------------------- teams */

export interface PublicTeam {
  id: string;
  name: string;
  code: string;
  /** Nobody has signed in as a coach of this team yet. */
  claimed: boolean;
  athletes: number;
  meets: number;
  /**
   * Recorded times across those meets. The surest sign of which season is the
   * real one when a device is deciding what to adopt — an empty roster pushed
   * by accident has none.
   */
  times: number;
}

/** A team named on a meet, for a heat sheet header. */
export interface TeamRef {
  id: string;
  name: string;
  code: string;
}

export function teamRef(team: Team): TeamRef {
  return { id: team.id, name: team.name, code: team.code };
}

/* ------------------------------------------------------------------- meets */

export interface PublicMeetSummary {
  id: string;
  name: string;
  date: string;
  type: MeetType;
  course: MeetCourse;
  location?: string;
  teams: TeamRef[];
  hostTeamId?: string;
  /** Counts, so a list row can say how far along a meet is without loading it. */
  events: number;
  entries: number;
  times: number;
}

/**
 * A meet as a list row.
 *
 * The counts arrive already aggregated — `listMeets` asks the database for
 * them rather than loading six meets in full to render three numbers each.
 */
export function meetSummary(
  meet: Meet,
  teams: Team[],
  counts: { events: number; entries: number; times: number },
): PublicMeetSummary {
  return {
    id: meet.id,
    name: meet.name,
    date: meet.date,
    type: meet.type,
    course: meet.course,
    location: meet.location,
    teams: teams.map(teamRef),
    hostTeamId: meet.hostTeamId,
    events: counts.events,
    entries: counts.entries,
    times: counts.times,
  };
}

/** One swim, as it would be read out: a place, a name, a time. */
export interface PublicPlacing {
  place: number | null;
  athlete: PublicAthlete | null;
  /** The team they were racing for, worked out from their enrollment. */
  team: TeamRef | null;
  lane: number;
  heat: number;
  timeMs: number;
  status: Result["status"];
  /** How the time was arrived at — "median of three", and so on. */
  watchCount: number;
  /**
   * Signed off by whoever is running the meet. Until then these numbers are
   * what the watches worked out, and the meet isn't official.
   */
  final: boolean;
  /** Swum outside the competition: a real time, but no place and no points. */
  exhibition: boolean;
}

export interface PublicEventResults {
  id: string;
  name: string;
  distance: number;
  stroke: string;
  gender: string;
  /** Absent for diving, which holds its place in the order but isn't timed. */
  placings: PublicPlacing[];
  /**
   * Every lane that swam has been signed off, so these results are official.
   * Derived from the acceptances rather than stored, so it can't disagree with
   * them.
   */
  official: boolean;
}

export interface PublicMeetDetail extends PublicMeetSummary {
  results: PublicEventResults[];
}

/**
 * Four groups, in the order a results sheet reads them: swims that count,
 * fastest first; exhibition swims — real times, but never a place — also
 * fastest first, below every swim that counts; then DQs and no-shows, which
 * have no time to rank by, so sorted by name instead. Not for lack of an
 * order to put them in — it's so the page doesn't reshuffle two of them on
 * every reload.
 */
function resultGroup(row: {
  status: Result["status"];
  seed: Pick<Seed, "exhibition">;
}): 0 | 1 | 2 | 3 {
  if (row.status === "DQ") return 2;
  if (row.status !== "OK") return 3;
  return row.seed.exhibition ? 1 : 0;
}

/**
 * A meet's results, event by event, ranked across all of its heats.
 *
 * Ranking ignores heat: a slower heat can hold the fastest swim, and the
 * printed sheet has always been ordered by time rather than by when it was
 * swum. DQs and no-shows keep their line and lose their place, because
 * "who was disqualified" is part of the record.
 */
export function meetResults(
  detail: MeetDetail,
  teamOf: (athleteId: string) => TeamRef | null,
): PublicEventResults[] {
  const byId = new Map(detail.athletes.map((a) => [a.id, a] as const));

  /**
   * Every swim that has a time, signed off or not.
   *
   * A seed with nothing against it is somebody who was in a lane and whose
   * time never arrived — a hole rather than a result, and not something to
   * publish a blank line for.
   */
  const swims = detail.seeds
    .map((seed) => ({ seed, time: swimTime(detail, seed.id) }))
    .filter((row): row is { seed: Seed; time: SwimTime } => row.time !== null);

  return detail.events.map((event) => {
    const forEvent = swims
      .filter(({ seed }) => seed.eventId === event.id)
      .map(({ seed, time }) => ({ ...time, seed, athleteId: seed.athleteId }))
      .sort((a, b) => {
        const ga = resultGroup(a);
        const gb = resultGroup(b);
        if (ga !== gb) return ga - gb;
        if (ga <= 1) return a.timeMs - b.timeMs;

        const nameOf = (row: typeof a) => {
          const athlete = byId.get(row.athleteId);
          return athlete ? athleteName(athlete) : "";
        };
        return nameOf(a).localeCompare(nameOf(b));
      });

    let place = 0;
    const placings: PublicPlacing[] = forEvent.map((row) => {
      const athlete = byId.get(row.athleteId);
      // An exhibition swim keeps its line, ranked by time same as any other,
      // but takes no place — the swim behind it moves up to the one it would
      // have held had the exhibition swim not been entered.
      const ranked = row.status === "OK" && !row.seed.exhibition;
      return {
        place: ranked ? ++place : null,
        athlete: athlete ? publicAthlete(athlete) : null,
        team: teamOf(row.athleteId),
        lane: row.seed.lane,
        heat: row.seed.heat,
        timeMs: row.timeMs,
        status: row.status,
        watchCount: row.watchCount,
        final: row.official,
        exhibition: row.seed.exhibition === true,
      };
    });

    return {
      id: event.id,
      name: eventName(event),
      distance: event.distance,
      stroke: event.stroke,
      gender: event.gender,
      placings: isDiving(event) ? [] : placings,
      official: isDiving(event) ? false : eventClosed(detail, event.id),
    };
  });
}

/* ---------------------------------------------------------------- athletes */

/** One swim on an athlete's own page. */
export interface AthleteSwim {
  meetId: string;
  meetName: string;
  date: string;
  course: MeetCourse;
  eventName: string;
  /** Groups a swimmer's times for the same race across a season. */
  raceKey: string;
  timeMs: number;
  status: Result["status"];
  /** Place within that event, across all of its heats. */
  place: number | null;
  /** True for the fastest clean swim of this race in this course. */
  best: boolean;
  /** Swum outside the competition: a real time, but no place and no points. */
  exhibition: boolean;
}

export interface PublicAthleteDetail extends PublicAthlete {
  teams: Array<TeamRef & { seasons: string[] }>;
  swims: AthleteSwim[];
}

/**
 * Everything one person has swum, newest first, with their best marked.
 *
 * "Best" is per race *and* course: a 100 Free in a 25-yard pool and one in a
 * 50-metre pool are not the same swim, and calling either a personal best over
 * the other would be wrong in a way a swimmer would notice immediately.
 */
export function athleteSwims(
  athleteId: string,
  meets: MeetDetail[],
): AthleteSwim[] {
  const swims: AthleteSwim[] = [];

  for (const detail of meets) {
    const meet = detail.meet;
    const events = new Map(detail.events.map((e) => [e.id, e] as const));
    const all = detail.seeds
      .map((seed) => ({ seed, time: swimTime(detail, seed.id) }))
      .filter(
        (row): row is { seed: Seed; time: SwimTime } => row.time !== null,
      );

    for (const { seed, time } of all) {
      if (seed.athleteId !== athleteId) continue;
      const event = events.get(seed.eventId);
      if (!event || isDiving(event)) continue;

      // Place is scored across the whole event, not within a heat — and an
      // exhibition swim, this one included, never has one.
      const ranked = all
        .filter(
          (r) =>
            r.seed.eventId === event.id &&
            r.time.status === "OK" &&
            !r.seed.exhibition,
        )
        .sort((a, b) => a.time.timeMs - b.time.timeMs);
      const at = ranked.findIndex((r) => r.seed.id === seed.id);
      const result = { ...time, lane: seed.lane };

      swims.push({
        place: at >= 0 ? at + 1 : null,
        meetId: meet.id,
        meetName: meet.name,
        date: meet.date,
        course: meet.course,
        eventName: eventName(event),
        raceKey: `${event.distance}|${event.stroke}|${meet.course}`,
        timeMs: result.timeMs,
        status: result.status,
        best: false,
        exhibition: seed.exhibition === true,
      });
    }
  }

  const fastest = new Map<string, number>();
  for (const swim of swims) {
    if (swim.status !== "OK") continue;
    const current = fastest.get(swim.raceKey);
    if (current === undefined || swim.timeMs < current) {
      fastest.set(swim.raceKey, swim.timeMs);
    }
  }
  for (const swim of swims) {
    swim.best =
      swim.status === "OK" && fastest.get(swim.raceKey) === swim.timeMs;
  }

  return swims.sort(
    (a, b) =>
      b.date.localeCompare(a.date) || a.eventName.localeCompare(b.eventName),
  );
}
