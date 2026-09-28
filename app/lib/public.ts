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

import type { Athlete, Gender } from "~/types/athlete";
import type { Meet, MeetCourse, MeetType, ResultStatus } from "~/types/meet";
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
  status: ResultStatus;
  /** Place within that event, across all of its heats. */
  place: number | null;
  /** True for the fastest clean swim of this race in this course. */
  best: boolean;
  /** Swum outside the competition: a real time, but no place and no points. */
  exhibition: boolean;
}
