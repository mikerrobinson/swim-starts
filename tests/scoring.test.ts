import { done, eq } from "./harness.ts";
import {
  eventPoints,
  pointsTable,
  scoreGroup,
  scoreGroupLabel,
  teamTotals,
  type RankedSwim,
} from "../app/lib/scoring.ts";
import { DUAL_MEET_SCORING } from "../app/types/meet.ts";
import type { Event, Seed } from "../app/types/meet.ts";
import type { SwimTime } from "../app/lib/timing.ts";

const MEET = "m1";

function ev(id: string, extra: Partial<Event> = {}): Event {
  return {
    id,
    position: 1,
    distance: 50,
    stroke: "Free",
    gender: "F",
    ...extra,
  };
}

function seed(id: string, athleteId: string, exhibition = false): Seed {
  return {
    id,
    eventId: "e1",
    heat: 1,
    lane: 1,
    athleteId,
    exhibition: exhibition || undefined,
  };
}

function swim(
  id: string,
  athleteId: string,
  status: SwimTime["status"] = "OK",
  exhibition = false,
): RankedSwim {
  return {
    seed: seed(id, athleteId, exhibition),
    time: {
      timeMs: 0,
      status,
      watchCount: 0,
      from: "admin",
      discrepancyMs: null,
      official: true,
    },
  };
}

/* --------------------------------------------------------------- points */

eq(
  eventPoints(
    [swim("s1", "a1"), swim("s2", "a2"), swim("s3", "a3")],
    [6, 4, 3, 2, 1],
  ),
  [6, 4, 3],
  "places score off the table in order",
);

eq(
  eventPoints(
    [swim("s1", "a1"), swim("s2", "a2", "DQ"), swim("s3", "a3")],
    [6, 4, 3],
  ),
  [6, 0, 4],
  "a DQ scores nothing and doesn't take a place from the table",
);

eq(
  eventPoints([swim("s1", "a1"), swim("s2", "a2"), swim("s3", "a3")], [6, 4]),
  [6, 4, 0],
  "a place past the end of the table scores nothing",
);

eq(
  eventPoints(
    [swim("s1", "a1"), swim("s2", "a2", "OK", true), swim("s3", "a3")],
    [6, 4, 3],
  ),
  [6, 0, 4],
  "an exhibition swim scores nothing and doesn't take a place from the table",
);

eq(
  pointsTable(ev("e1", { stroke: "Free" }), DUAL_MEET_SCORING),
  [6, 4, 3, 2, 1],
  "an individual event scores off the individual table",
);
eq(
  pointsTable(ev("e1", { stroke: "Free Relay" }), DUAL_MEET_SCORING),
  [8, 4, 2],
  "a relay scores off the relay table",
);

/* ------------------------------------------------------------- grouping */

eq(
  scoreGroup(ev("e1", { gender: "F" }), { separateByGender: true }),
  "F",
  "grouped by the event's own gender when scored apart",
);
eq(
  scoreGroup(ev("e1", { gender: "M" }), { separateByGender: false }),
  "all",
  "one contest when the meet isn't scored apart",
);
eq(scoreGroupLabel("F"), "Girls", "F reads as Girls");
eq(scoreGroupLabel("M"), "Boys", "M reads as Boys");
eq(scoreGroupLabel("all"), "Team totals", "one contest has no gender label");

/* --------------------------------------------------------------- totals */

const events: Event[] = [ev("e1", { gender: "F" }), ev("e2", { gender: "M" })];

const byEvent = new Map<string, RankedSwim[]>([
  ["e1", [swim("s1", "a1"), swim("s2", "a2")]],
  ["e2", [swim("s3", "a3"), swim("s4", "a1")]],
]);

const teamOf = (athleteId: string): string | undefined =>
  ({ a1: "home", a2: "away", a3: "home" })[athleteId];

const separate = teamTotals(events, byEvent, DUAL_MEET_SCORING, teamOf);
eq(
  [...separate.get("F")!.entries()].sort(),
  [
    ["away", 4],
    ["home", 6],
  ],
  "girls' points are kept apart from boys'",
);
eq(
  [...separate.get("M")!.entries()].sort(),
  [["home", 10]],
  "boys' points don't include the girls' race",
);

const combined = teamTotals(
  events,
  byEvent,
  { ...DUAL_MEET_SCORING, separateByGender: false },
  teamOf,
);
eq(
  [...combined.get("all")!.entries()].sort(),
  [
    ["away", 4],
    ["home", 16],
  ],
  "one contest sums both races onto the same team",
);

const noEnrollment = teamTotals(
  events,
  byEvent,
  DUAL_MEET_SCORING,
  () => undefined,
);
eq(
  noEnrollment.get("F")?.size ?? 0,
  0,
  "a swim nobody can place on a roster scores for nobody",
);

done();
