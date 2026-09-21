/**
 * Season arithmetic, and small helpers over a roster once it's loaded.
 *
 * Everything that used to walk a `TeamDoc` looking for its seasons and
 * enrollments is a query now — see `teams.server.ts`. What's left here is the
 * pure part: which season a date falls in, what next year's season is called,
 * and who is graduating.
 */

import { generateId } from "./id";
import type { Enrollment } from "~/types/team";
import type { Season } from "~/types/team";

/**
 * The season a date falls in.
 *
 * A season with neither date covers everything, which is exactly what a roster
 * carried over from before seasons existed means. Falls back to the team's
 * current season, then to the most recent one, rather than returning nothing
 * and leaving the caller to guess.
 */
export function seasonForDate<
  T extends Pick<Season, "id" | "startDate" | "endDate">,
>(
  // Generic over the row rather than taking a bare `Season`, so a caller
  // holding seasons with a roster hanging off them gets one of those back
  // instead of a narrowed copy with the roster lost.
  seasons: T[],
  currentSeasonId: string | undefined,
  isoDate: string,
): T | undefined {
  const covering = seasons.find(
    (s) =>
      (!s.startDate || s.startDate <= isoDate) &&
      (!s.endDate || s.endDate >= isoDate),
  );
  return (
    covering ?? seasons.find((s) => s.id === currentSeasonId) ?? seasons.at(-1)
  );
}

export function findSeason(
  seasons: Season[],
  seasonId: string | undefined,
): Season | undefined {
  return seasons.find((s) => s.id === seasonId);
}

/** Enrollments by athlete id, for a screen that has the roster in hand. */
export function enrollmentIndex(
  enrollments: Enrollment[],
): Map<string, Enrollment> {
  return new Map(enrollments.map((e) => [e.athleteId, e] as const));
}

/** The day before an ISO date, for closing one season as the next opens. */
export function dayBefore(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function makeSeason(
  teamId: string,
  name: string,
  startDate?: string,
  endDate?: string,
): Season {
  return { id: generateId(), teamId, name, startDate, endDate };
}

/**
 * Next year's grade.
 *
 * Numeric grades advance; anything else is left exactly as written. The
 * temptation is to map "Fr" to "So", and the reason not to is that a roster
 * CSV contains whatever a school types — "Fr", "9th", "Freshman", "FR" — and a
 * ladder that half-works silently mislabels every row it doesn't recognise. A
 * grade left alone is visibly unchanged, which a coach can fix in a second.
 */
export function nextYear(year: string): string {
  const value = Number(year.trim());
  return Number.isInteger(value) && value > 0 ? String(value + 1) : year;
}

/** "2026-27" becomes "2027-28"; a bare year increments; anything else is "". */
export function nextSeasonName(name: string): string {
  const trimmed = name.trim();

  // A bare year is a season name too — "2026" simply becomes "2027".
  if (/^\d{4}$/.test(trimmed)) return String(Number(trimmed) + 1);

  const match = /^(\d{4})\s*[-/]\s*(\d{2}|\d{4})$/.exec(trimmed);
  if (!match) return "";
  const start = Number(match[1]) + 1;
  const end =
    match[2].length === 2
      ? String((start + 1) % 100).padStart(2, "0")
      : String(start + 1);
  return `${start}-${end}`;
}

/**
 * Whether somebody in this year leaves at the end of the season.
 *
 * Numeric grades only, for the same reason `nextYear` advances only those: a
 * guess about "Sr" that is wrong quietly archives somebody still on the team.
 */
export function isGraduating(year: string, finalYear = 12): boolean {
  const value = Number(year.trim());
  return Number.isInteger(value) && value >= finalYear;
}

/** A roster row, with an id derived so re-enrolling the same person updates. */
export function makeEnrollment(
  teamId: string,
  seasonId: string,
  athleteId: string,
  facts: { year?: string; squad?: string; status?: Enrollment["status"] } = {},
): Enrollment {
  return {
    id: `${seasonId}:${athleteId}`,
    teamId,
    seasonId,
    athleteId,
    year: facts.year ?? "",
    squad: facts.squad,
    status: facts.status ?? "active",
  };
}
