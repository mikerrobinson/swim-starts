import { done, eq } from "./harness.ts";
import {
  eventClosed,
  eventTouched,
  fromStopwatch,
  heatClosed,
  heatsOf,
  laneProgress,
  laneTime,
  proposedTime,
  recordedCount,
  swimsForHeat,
  swimTime,
  truncateToHundredths,
  currentWatches,
  type TimingRows,
} from "../app/lib/timing.ts";
import type { ResultStatus, Swim, Watch } from "../app/types/meet.ts";

const MEET = "m1";
const EVENT = "e1";

function swim(
  id: string,
  heat: number,
  lane: number,
  athleteId: string,
  extra: Partial<Swim> = {},
): Swim {
  return {
    id,
    meetId: MEET,
    eventId: EVENT,
    heat,
    lane,
    athleteId,
    athleteName: "",
    athleteTeam: "",
    ...extra,
  };
}

/** A swim with a decision already on it — what `decideResult` writes. */
function decided(
  base: Swim,
  timeMs: number,
  status: ResultStatus = "OK",
): Swim {
  return { ...base, status, officialTimeMs: timeMs, decidedAt: 2_000 };
}

let watchSeq = 0;
function watch(
  swimId: string,
  submittedBy: string,
  timeMs: number | undefined,
  extra: Partial<Watch> = {},
): Watch {
  return {
    id: `w${++watchSeq}`,
    swimId,
    submittedBy,
    role: "timer",
    slot: 1,
    timeMs,
    submittedAt: 1_000,
    ...extra,
  };
}

/* ---------------------------------------------------- the hand-timing rules */

eq(truncateToHundredths(27_145), 27_140, "times truncate, never round up");
eq(proposedTime([]), null, "no watches, no time");
eq(
  proposedTime([watch("s1", "a", 27_140)]),
  { timeMs: 27_140, method: "single", watchCount: 1 },
  "one watch stands on its own",
);
eq(
  proposedTime([watch("s1", "a", 27_140), watch("s1", "b", 27_150)]),
  { timeMs: 27_140, method: "average", watchCount: 2 },
  "two are averaged, and the average truncates",
);
eq(
  proposedTime([
    watch("s1", "a", 27_140),
    watch("s1", "b", 27_160),
    watch("s1", "c", 31_000),
  ]),
  { timeMs: 27_160, method: "median", watchCount: 3 },
  "three take the middle one, so a slow thumb can't drag it",
);

// A stopwatch that has started and not been submitted is not a zero.
eq(
  proposedTime([watch("s1", "a", 27_140), watch("s1", "b", undefined)]),
  { timeMs: 27_140, method: "single", watchCount: 1 },
  "a watch still running is not counted as a time of zero",
);

/* ------------------------------------------------ which time is the time */

{
  const s = swim("s1", 1, 4, "a1");
  const timers = [
    watch("s1", "d-1", 27_140),
    watch("s1", "d-2", 27_160),
    watch("s1", "d-3", 31_000),
  ];
  const coaches = [
    watch("s1", "u-a", 27_500, { role: "coach", userId: "u-a" }),
    watch("s1", "u-b", 27_700, { role: "coach", userId: "u-b" }),
  ];
  const official = watch("s1", "u-ref", 26_990, {
    role: "admin",
    userId: "u-ref",
  });

  eq(laneTime([]), null, "a swim nobody timed has no time");
  eq(
    laneTime(timers),
    {
      timeMs: 27_160,
      method: "median",
      watchCount: 3,
      from: "timer",
      discrepancyMs: 3_860,
    },
    "three timers take the middle one — the slow thumb is outvoted, not averaged",
  );
  eq(
    laneTime(coaches),
    {
      timeMs: 27_600,
      method: "average",
      watchCount: 2,
      from: "coach",
      discrepancyMs: 200,
    },
    "coaches are averaged when there are no timers",
  );
  eq(
    laneTime([...timers, ...coaches])?.timeMs,
    27_160,
    "and are ignored entirely when there are — the side of the pool cannot move an official time",
  );
  eq(
    laneTime([...timers, ...coaches, official]),
    {
      timeMs: 26_990,
      method: "official",
      watchCount: 1,
      from: "admin",
      discrepancyMs: null,
    },
    "whoever runs the meet decides, whatever the rest say",
  );

  /* --- how a time arrived is the timestamps, not a field about them --- */
  eq(
    [
      fromStopwatch(watch("s1", "a", 27_140, { startedAt: 1, stoppedAt: 2 })),
      fromStopwatch(watch("s1", "a", 27_140)),
    ],
    [true, false],
    "a watch came off a stopwatch exactly when it carries both timestamps",
  );

  /* --- a decision outranks everything, and doesn't move --- */
  const rows: TimingRows = { swims: [s], watches: timers };
  eq(
    swimTime(rows, "s1")?.timeMs,
    27_160,
    "with no decision, the watches propose",
  );
  eq(swimTime(rows, "s1")?.official, false, "and a proposal is not official");

  const signed: TimingRows = { ...rows, swims: [decided(s, 27_160)] };
  eq(swimTime(signed, "s1")?.official, true, "a signed-off swim is official");
  eq(
    swimTime(
      { ...signed, watches: [...timers, watch("s1", "late", 20_000)] },
      "s1",
    )?.timeMs,
    27_160,
    "and a late watch cannot move it — the number was written down when it was accepted",
  );
  eq(
    swimTime({ ...signed, watches: [] }, "s1")?.timeMs,
    27_160,
    "nor can discarding every watch under it",
  );
}

/* ------------------------------------ how far along a swim's timing is */

{
  const s = swim("s1", 1, 1, "a1");
  const base: TimingRows = { swims: [s], watches: [] };

  eq(
    laneProgress({ ...base, watches: [] }, "s1"),
    "none",
    "a lane nobody has touched is waiting for somebody to cover it",
  );
  // The distinction the colour exists for: this looks identical to the line
  // above if you only read the number, and wants the opposite response.
  eq(
    laneProgress(
      { ...base, watches: [watch("s1", "d-1", undefined, { startedAt: 1 })] },
      "s1",
    ),
    "waiting",
    "a watch running on it is not nothing — it is in hand",
  );
  eq(
    laneProgress(
      {
        ...base,
        watches: [
          watch("s1", "d-1", 27_140),
          watch("s1", "d-2", undefined, { startedAt: 1 }),
        ],
      },
      "s1",
    ),
    "waiting",
    "two armed and one in is still waiting on the second",
  );
  eq(
    laneProgress(
      {
        ...base,
        watches: [watch("s1", "d-1", 27_140), watch("s1", "d-2", 27_160)],
      },
      "s1",
    ),
    "complete",
    "every watch that started has been sent",
  );
  // The timing table is what the lane waits for. A coach timing from the side
  // is not, and neither is the desk's own reading.
  eq(
    laneProgress(
      { ...base, watches: [watch("s1", "u-c", 27_500, { role: "coach" })] },
      "s1",
    ),
    "none",
    "a coach's watch doesn't put a lane in hand — the timing table does",
  );
}

/* ---------------------------------------------------------------- closing */

{
  const swims = [
    swim("s1", 1, 3, "a1"),
    swim("s2", 1, 4, "a2"),
    swim("s3", 2, 3, "a3"),
  ];
  const rows: TimingRows = { swims, watches: [] };

  eq(
    heatsOf(rows, EVENT),
    [1, 2],
    "an event's heats are the distinct heats of its swims",
  );
  eq(
    swimsForHeat(rows, EVENT, 1).map((s) => s.lane),
    [3, 4],
    "in lane order",
  );
  eq(heatClosed(rows, EVENT, 1), false, "nothing signed off, nothing closed");
  eq(eventClosed(rows, EVENT), false, "nor the event");

  const one: TimingRows = {
    ...rows,
    swims: swims.map((s) => (s.id === "s1" ? decided(s, 27_140) : s)),
  };
  eq(
    heatClosed(one, EVENT, 1),
    false,
    "one of two swims signed off is not a closed heat",
  );

  const heat1: TimingRows = {
    ...rows,
    swims: swims.map((s) =>
      s.id === "s1"
        ? decided(s, 27_140)
        : s.id === "s2"
          ? decided(s, 27_500)
          : s,
    ),
  };
  eq(heatClosed(heat1, EVENT, 1), true, "both signed off closes the heat");
  eq(eventClosed(heat1, EVENT), false, "but heat 2 is still out");

  const all: TimingRows = {
    ...rows,
    swims: swims.map((s, i) => decided(s, i + 1)),
  };
  eq(
    eventClosed(all, EVENT),
    true,
    "every heat closed makes the event official",
  );

  // An event with nothing seeded hasn't started, so it isn't finished either.
  eq(
    eventClosed({ swims: [], watches: [] }, EVENT),
    false,
    "an unseeded event is not closed",
  );
}

/* ------------------------------------------------- reseeding's guard rail */

{
  const s1 = swim("s1", 1, 3, "a1");
  eq(
    eventTouched({ swims: [s1], watches: [] }, EVENT),
    false,
    "an event nobody has timed can be reseeded",
  );
  eq(
    eventTouched({ swims: [s1], watches: [watch("s1", "d-1", 27_140)] }, EVENT),
    true,
    "one watch is enough to make it history",
  );
  eq(
    eventTouched({ swims: [decided(s1, 27_140)], watches: [] }, EVENT),
    true,
    "so is a decision with no watch behind it — a DQ is still a record",
  );
  // A watch still running counts too: a reseed mid-heat would move the lane
  // out from under a thumb that is already down.
  eq(
    eventTouched(
      {
        swims: [s1],
        watches: [watch("s1", "d-1", undefined, { startedAt: 1 })],
      },
      EVENT,
    ),
    true,
    "and so does a stopwatch that is merely running",
  );
}

/* ------------------------------------------------------------- counting */

{
  const s1 = swim("s1", 1, 3, "a1");
  const s2 = swim("s2", 1, 4, "a2");
  eq(
    recordedCount({
      swims: [s1, s2],
      watches: [
        watch("s1", "d-1", 27_140),
        watch("s2", "d-2", undefined, { startedAt: 1 }),
      ],
    }),
    1,
    "a running stopwatch is not a time recorded",
  );
  eq(
    recordedCount({ swims: [decided(s1, 27_140)], watches: [] }),
    1,
    "a signed-off swim is, even with no watch left under it",
  );
  eq(
    currentWatches(
      { watches: [watch("s1", "d-1", 1), watch("s2", "d-1", 2)] },
      "s1",
    ).length,
    1,
    "watches are read per swim",
  );
}

/* ------------------------------------------------ a lane nobody has named */

/**
 * A time may exist before the swimmer does.
 *
 * A timer who never taps a name still times the race, and the watch is filed
 * against a swim with an empty `athleteId` rather than refused — so everything
 * that reads a time has to work on one. The name arrives later, from the desk,
 * onto the same row.
 */
{
  const unnamed = swim("s9", 1, 5, "");
  eq(
    swimTime({ swims: [unnamed], watches: [watch("s9", "d-1", 27_140)] }, "s9"),
    {
      timeMs: 27_140,
      method: "single",
      watchCount: 1,
      status: "OK",
      official: false,
      from: "timer",
      discrepancyMs: null,
    },
    "an unnamed lane's watch still proposes a time",
  );
  eq(
    recordedCount({ swims: [unnamed], watches: [watch("s9", "d-1", 27_140)] }),
    1,
    "and it counts as a time the meet has recorded",
  );
  eq(
    laneProgress({ watches: [watch("s9", "d-1", 27_140)] }, "s9"),
    "complete",
    "and the desk sees the lane as covered",
  );
  eq(
    swimsForHeat({ swims: [unnamed] }, EVENT, 1).length,
    1,
    "the swim is in its heat like any other",
  );
}

/* ------------------------------------------- one device, several watches */

/**
 * A lane timed by three people used to mean three phones. It usually means one
 * phone holding the sheet and three handheld watches read onto it — and those
 * still have to be three rows, since `watches` carries one per submitter *and*
 * slot. `slot` is a plain field now (no id-string encoding to parse), so a
 * clipboard's three columns are just three watches sharing a `submittedBy`
 * and differing only in `slot`.
 */
{
  const s10 = swim("s10", 1, 4, "a1");
  const sheet = [
    watch("s10", "d-1", 27_140, { slot: 1 }),
    watch("s10", "d-1", 27_200, { slot: 2 }),
    watch("s10", "d-1", 28_900, { slot: 3 }),
  ];
  eq(
    swimTime({ swims: [s10], watches: sheet }, "s10"),
    {
      timeMs: 27_200,
      method: "median",
      watchCount: 3,
      status: "OK",
      official: false,
      from: "timer",
      discrepancyMs: 1_760,
    },
    "three watches off one clipboard are three watches, and take the middle one",
  );
  eq(
    laneProgress({ watches: sheet }, "s10"),
    "complete",
    "and the desk reads the lane as covered by all three",
  );
  eq(
    laneProgress(
      { watches: [sheet[0], watch("s10", "d-1", undefined, { slot: 2 })] },
      "s10",
    ),
    "waiting",
    "a column still running is a lane still waiting",
  );

  // Append-only: a correction is a new row for the same slot, and the older
  // one stays behind it as history — `currentWatches` picks the latest.
  const corrected = watch("s10", "d-1", 27_150, {
    slot: 1,
    submittedAt: 2_000,
  });
  eq(
    currentWatches({ watches: [...sheet, corrected] }, "s10").find(
      (w) => w.slot === 1,
    )?.timeMs,
    27_150,
    "the latest row for a slot is its current state",
  );
  eq(
    swimTime({ swims: [s10], watches: [...sheet, corrected] }, "s10")?.timeMs,
    27_200,
    "and the median is worked out from current state, not every historical row",
  );
}

done();
