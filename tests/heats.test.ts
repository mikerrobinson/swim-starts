import { done, eq } from "./harness.ts";
import { buildSwims, laneOrder, reseedEvent, seedEvent } from "../app/lib/heats.ts";
import type { LaneAssignments, Swim, Watch } from "../app/types/meet.ts";

/* ------------------------------------------------ lanes */

// The three that were hard-coded before must come out unchanged.
eq(laneOrder(4), [2, 3, 1, 4], "4 lanes");
eq(laneOrder(6), [3, 4, 2, 5, 1, 6], "6 lanes");
eq(laneOrder(8), [4, 5, 3, 6, 2, 7, 1, 8], "8 lanes");
eq(laneOrder(5), [3, 2, 4, 1, 5], "5 lanes");
eq(laneOrder(10), [5, 6, 4, 7, 3, 8, 2, 9, 1, 10], "10 lanes");

for (const n of [4, 5, 6, 8, 10] as const) {
  const order = laneOrder(n);
  eq(
    [...order].sort((a, b) => a - b),
    Array.from({ length: n }, (_, i) => i + 1),
    `${n} lanes: every lane once`,
  );
}

/* ------------------------------------------------ seeding */

// 13 swimmers in a 10-lane pool: short heat first, seeded from the middle.
{
  const swims = buildSwims("m1", "e1", Array.from({ length: 13 }, (_, i) => `s${i + 1}`), 10);
  const heats = [...new Set(swims.map((s) => s.heat))];

  eq(heats, [1, 2], "13 in a 10-lane pool makes 2 heats, numbered from 1");
  eq(swims.filter((s) => s.heat === 1).length, 3, "short heat first");
  eq(
    swims.filter((s) => s.heat === 1).map((s) => `${s.lane}:${s.athleteId}`),
    ["5:s1", "6:s2", "4:s3"],
    "top seeds centred (5, 6, 4)",
  );
  eq(swims.filter((s) => s.heat === 2).length, 10, "full heat second");
  // A lane nobody is in is not a row: a heat is what is actually in it.
  eq(swims.length, 13, "one swim per swimmer, and none for the empty lanes");
}

{
  const five = buildSwims("m1", "e2", Array.from({ length: 7 }, (_, i) => `s${i + 1}`), 5);
  eq([...new Set(five.map((s) => s.heat))], [1, 2], "7 in a 5-lane pool makes 2 heats");
  eq(
    five.filter((s) => s.heat === 1).map((s) => `${s.lane}:${s.athleteId}`),
    ["3:s1", "2:s2"],
    "5-lane short heat seeds 3 then 2",
  );
}

eq(buildSwims("m1", "e3", [], 6), [], "nobody entered, nothing to seed");

/* ------------------------------------------------ automatic seeding */

// Home swims the odds, away the evens — a typical dual meet's lanes.
const LANES: LaneAssignments = { home: [1, 3, 5], away: [2, 4, 6] };
const teamOf = (athleteId: string) =>
  athleteId.startsWith("h") ? "home" : athleteId.startsWith("a") ? "away" : undefined;
const seatsOf = (swims: Swim[]) => swims.map((s) => `${s.heat}/${s.lane}:${s.athleteId}`);

// Entered in order, home's own entrants take the centre of home's own lanes
// first — nobody's timed yet, so entry order stands in for speed.
{
  const swims = seedEvent({ swims: [] }, "m1", "e1", ["h1", "h2", "h3"], teamOf, LANES, 6);
  eq(
    seatsOf(swims),
    ["1/3:h1", "1/5:h2", "1/1:h3"],
    "home's first three entrants fill home's own lanes, centre-out, in entry order",
  );
}

// A fourth home entrant, with away still empty, doesn't open a second heat —
// it reaches for whichever lane is nearest the centre and unclaimed.
{
  const swims = seedEvent({ swims: [] }, "m1", "e1", ["h1", "h2", "h3", "h4"], teamOf, LANES, 6);
  eq(
    seatsOf(swims),
    ["1/3:h1", "1/5:h2", "1/1:h3", "1/4:h4"],
    "home's overflow swimmer borrows the nearest open lane rather than a new heat",
  );
}

// Away's coach enters two swimmers afterwards. Reseeding the whole event —
// not just placing the newcomers — lets away reclaim its own lanes, and
// home's overflow swimmer moves to whatever's left, not away's spot.
{
  const round1 = seedEvent({ swims: [] }, "m1", "e1", ["h1", "h2", "h3", "h4"], teamOf, LANES, 6);
  const round2 = seedEvent(
    { swims: round1 },
    "m1",
    "e1",
    ["h1", "h2", "h3", "h4", "a1", "a2"],
    teamOf,
    LANES,
    6,
  );

  eq(
    seatsOf(round2),
    ["1/3:h1", "1/5:h2", "1/1:h3", "1/6:h4", "1/4:a1", "1/2:a2"],
    "away reclaims its own lanes; home's overflow swimmer is bumped to what's left",
  );

  const idOf = (swims: Swim[], athleteId: string) =>
    swims.find((s) => s.athleteId === athleteId)?.id;
  eq(idOf(round2, "h1"), idOf(round1, "h1"), "h1 kept its seat, so it keeps its row's id");
  eq(idOf(round2, "h2"), idOf(round1, "h2"), "so does h2");
  eq(idOf(round2, "h3"), idOf(round1, "h3"), "so does h3");
  eq(
    idOf(round2, "h4") === idOf(round1, "h4"),
    false,
    "h4 moved lanes, so it's a fresh row",
  );
}

// With no lane assignments at all, everybody's overflow: lanes fill from the
// centre out, in entry order, one heat at a time.
{
  const swims = seedEvent(
    { swims: [] },
    "m1",
    "e1",
    Array.from({ length: 7 }, (_, i) => `s${i + 1}`),
    () => undefined,
    {},
    5,
  );
  eq(
    seatsOf(swims),
    ["1/3:s1", "1/2:s2", "1/4:s3", "1/1:s4", "1/5:s5", "2/3:s6", "2/2:s7"],
    "no team preference: centre-out, heat 1 fills before heat 2 opens",
  );
}

// Reseeding refuses once anything has been recorded against the event.
{
  const seeded = seedEvent({ swims: [] }, "m1", "e1", ["h1", "h2"], teamOf, LANES, 6);
  const base = { swims: seeded, watches: [] as Watch[] };

  const untouched = reseedEvent(base, "m1", "e1", ["h1", "h2", "a1"], teamOf, LANES, 6);
  eq(untouched !== null, true, "an untouched event reseeds");
  eq(untouched!.length, 3, "the new entrant is included");

  const timed = {
    ...base,
    watches: [
      {
        id: "w1",
        swimId: seeded[0].id,
        submittedBy: "t1",
        role: "timer" as const,
        slot: 1,
        timeMs: 27_140,
        submittedAt: 1,
      },
    ],
  };
  eq(
    reseedEvent(timed, "m1", "e1", ["h1", "h2", "a1"], teamOf, LANES, 6),
    null,
    "a watch anywhere in the event stops it",
  );

  const dq = {
    ...base,
    swims: base.swims.map((s) =>
      s.id === seeded[0].id
        ? { ...s, status: "DQ" as const, officialTimeMs: 0, decidedAt: 2 }
        : s,
    ),
  };
  eq(
    reseedEvent(dq, "m1", "e1", ["h1", "h2", "a1"], teamOf, LANES, 6),
    null,
    "so does a decision with no watch behind it",
  );
}

done();
