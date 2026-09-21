/* ------------------------------------------------------------ people, teams */
/**
 * A team: a name, a code, and the seasons it runs.
 *
 * Deliberately does *not* hold its athletes. The roster is the set of
 * enrollments pointing at global athlete records, so two teams racing the same
 * swimmer point at one person rather than keeping a copy each.
 *
 * A team can exist without anyone owning it. Setting up a meet against a school
 * that has never used the app mints an unclaimed team; a coach from that school
 * claims it later, and the meets it already appears in are unaffected.
 */

export interface Team {
  id: string;
  name: string;
  /** Short code as it appears on a heat sheet or an SD3 file — "CHAP". */
  code: string;
  /** Which season the app works in when nothing says otherwise. */
  currentSeasonId?: string;
  /** Who set it up. Absent for the teams typed in as opponents before this
   *  was recorded, and for the ones that predate accounts entirely. */
  createdBy?: string;
} /**
 * A team's competitive year. Scoped to the team on purpose: a high-school
 * season and a club season don't line up, so there's no useful global one.
 *
 * Both dates are optional — a season with neither runs from the beginning of
 * time to the end of it.
 */

export interface Season {
  id: string;
  teamId: string;
  /** Free text as the coach writes it — "2026-27", "Summer 2027". */
  name: string;
  /** ISO date (yyyy-mm-dd), inclusive. */
  startDate?: string;
  /** ISO date (yyyy-mm-dd), inclusive. */
  endDate?: string;
} /**
 * On the roster, but only for a while.
 *
 * Everything seasonal about an athlete lives here rather than on the athlete,
 * so last year's sophomore is this year's junior without anyone editing
 * anything, and an athlete who moves between a club and a school team is one
 * person with two enrollments.
 */

export interface Enrollment {
  id: string;
  teamId: string;
  seasonId: string;
  athleteId: string;
  /** School year as entered — "9", "Fr", "Senior", whatever the CSV had. */
  year: string;
  /** Optional squad/side for an inter-squad meet (e.g. "Blue" / "Gold"). */
  squad?: string;
  /**
   * "inactive" is someone who left mid-season: off the roster for new races,
   * but they were on it, and any times they swam still stand. Someone who
   * simply isn't on the team this year has no enrollment at all.
   */
  status: EnrollmentStatus;
}
export type EnrollmentStatus =
  | "active"
  | "inactive"; /** Team codes are short and upper-case wherever they're exchanged. */

export function normalizeTeamCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}
