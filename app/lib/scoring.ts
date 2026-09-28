/**
 * Places into points, and points into a team score.
 *
 * Ranking is somebody else's job — every function here takes the same ranked,
 * per-event list `results.tsx` already builds: every swim with a time,
 * ordered across all heats, DQs and no-shows keeping their line and losing
 * their place. Nothing here re-derives that order, so a screen showing places
 * and a screen showing points can never disagree about what place somebody
 * finished.
 */

import type { SwimTime } from "./timing";
import {
  isRelay,
  type EventGender,
  type Event,
  type ScoringRules,
  type Swim,
} from "~/types/meet";

export interface RankedSwim {
  swim: Swim;
  time: SwimTime;
}

/** Which points table an event scores off — the relay list or the individual one. */
export function pointsTable(
  event: Pick<Event, "stroke">,
  scoring: Pick<ScoringRules, "individual" | "relay">,
): number[] {
  return isRelay(event) ? scoring.relay : scoring.individual;
}

/**
 * Points earned by each ranked swim in one event, aligned index-for-index
 * with the list it was scored from.
 *
 * A DQ or a no-show scores nothing — it has no place to look a point value up
 * by, the same reason it prints an em dash instead of a place. Neither does an
 * exhibition swim, and it doesn't consume a place in the table either: the
 * swim behind it moves up to the place it would have held anyway, the same as
 * if the exhibition swim had not been entered. A place past the end of the
 * table scores nothing either: a fourth-place finish at a three-deep dual meet
 * is a real place with no points behind it.
 */
export function eventPoints(ranked: RankedSwim[], table: number[]): number[] {
  let place = 0;
  return ranked.map((row) => {
    if (row.time.status !== "OK" || row.swim.exhibition) return 0;
    return table[place++] ?? 0;
  });
}

/** Which contest an event's points belong to: one, or girls and boys apart. */
export type ScoreGroup = EventGender | "all";

function scoreGroup(
  event: Pick<Event, "gender">,
  scoring: Pick<ScoringRules, "separateByGender">,
): ScoreGroup {
  return scoring.separateByGender ? event.gender : "all";
}

/** Girls / Boys / Open, or nothing when the meet scores one contest. */
export function scoreGroupLabel(group: ScoreGroup): string {
  if (group === "F") return "Girls";
  if (group === "M") return "Boys";
  if (group === "Open") return "Open";
  return "Team totals";
}

/**
 * Every team's running total, grouped the way the scoring rules say.
 *
 * A swim nobody can place on a roster — no enrollment on record for this
 * meet's season — doesn't score for anybody rather than guessing which team
 * it should count for.
 */
export function teamTotals(
  events: Event[],
  byEvent: Map<string, RankedSwim[]>,
  scoring: ScoringRules,
  teamOf: (athleteId: string) => string | undefined,
): Map<ScoreGroup, Map<string, number>> {
  const totals = new Map<ScoreGroup, Map<string, number>>();

  for (const event of events) {
    const ranked = byEvent.get(event.id);
    if (!ranked || ranked.length === 0) continue;

    const points = eventPoints(ranked, pointsTable(event, scoring));
    const group = scoreGroup(event, scoring);
    const groupTotals = totals.get(group) ?? new Map<string, number>();
    totals.set(group, groupTotals);

    ranked.forEach((row, i) => {
      if (points[i] === 0) return;
      const teamId = teamOf(row.swim.athleteId || "");
      if (!teamId) return;
      groupTotals.set(teamId, (groupTotals.get(teamId) ?? 0) + points[i]);
    });
  }

  return totals;
}
