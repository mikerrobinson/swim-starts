import { done, eq } from "./harness.ts";
import {
  eventClosed,
  fromDevice,
  slotTimerId,
  watchSlot,
  eventTouched,
  fromStopwatch,
  heatClosed,
  heatsOf,
  laneProgress,
  laneTime,
  proposedTime,
  recordedCount,
  resultFor,
  seedsForHeat,
  swimTime,
  truncateToHundredths,
  watchesOn,
} from "../app/lib/timing.ts";
import type { Result, Seed, Watch } from "../app/types/meet.ts";

const MEET = "m1";
const EVENT = "e1";

function seed(id: string, heat: number, lane: number, athleteId: string): Seed {
  return { id, eventId: EVENT, heat, lane, athleteId };
}

function watch(
  seedId: string,
  timerId: string,
  timeMs: number | undefined,
  extra: Partial<Watch> = {},
): Watch {
  return {
    seedId,
    timerId,
    role: "timer",
    timeMs,
    recordedAt: 1_000,
    ...extra,
  };
}

function result(
  seedId: string,
  timeMs: number,
  status: Result["status"] = "OK",
): Result {
  return {
    seedId,
    eventId: EVENT,
    athleteId: "a1",
    status,
    timeMs,
    decidedAt: 2_000,
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
  const s = seed("s1", 1, 4, "a1");
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

  /* --- a result outranks everything, and doesn't move --- */
  const rows = { seeds: [s], watches: timers, results: [] as Result[] };
  eq(
    swimTime(rows, "s1")?.timeMs,
    27_160,
    "with no result, the watches propose",
  );
  eq(swimTime(rows, "s1")?.official, false, "and a proposal is not official");

  const signed = { ...rows, results: [result("s1", 27_160)] };
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
  const s = seed("s1", 1, 1, "a1");
  const base = { seeds: [s], results: [] as Result[] };

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
  const seeds = [
    seed("s1", 1, 3, "a1"),
    seed("s2", 1, 4, "a2"),
    seed("s3", 2, 3, "a3"),
  ];
  const rows = { seeds, watches: [] as Watch[], results: [] as Result[] };

  eq(
    heatsOf(rows, EVENT),
    [1, 2],
    "an event's heats are the distinct heats of its seeds",
  );
  eq(
    seedsForHeat(rows, EVENT, 1).map((s) => s.lane),
    [3, 4],
    "in lane order",
  );
  eq(heatClosed(rows, EVENT, 1), false, "nothing signed off, nothing closed");
  eq(eventClosed(rows, EVENT), false, "nor the event");

  const one = { ...rows, results: [result("s1", 27_140)] };
  eq(
    heatClosed(one, EVENT, 1),
    false,
    "one of two swims signed off is not a closed heat",
  );

  const heat1 = {
    ...rows,
    results: [result("s1", 27_140), result("s2", 27_500)],
  };
  eq(heatClosed(heat1, EVENT, 1), true, "both signed off closes the heat");
  eq(eventClosed(heat1, EVENT), false, "but heat 2 is still out");

  const all = {
    ...rows,
    results: [result("s1", 1), result("s2", 2), result("s3", 3)],
  };
  eq(
    eventClosed(all, EVENT),
    true,
    "every heat closed makes the event official",
  );

  // An event with nothing seeded hasn't started, so it isn't finished either.
  eq(
    eventClosed({ seeds: [], watches: [], results: [] }, EVENT),
    false,
    "an unseeded event is not closed",
  );
}

/* ------------------------------------------------- reseeding's guard rail */

{
  const seeds = [seed("s1", 1, 3, "a1")];
  eq(
    eventTouched({ seeds, watches: [], results: [] }, EVENT),
    false,
    "an event nobody has timed can be reseeded",
  );
  eq(
    eventTouched(
      { seeds, watches: [watch("s1", "d-1", 27_140)], results: [] },
      EVENT,
    ),
    true,
    "one watch is enough to make it history",
  );
  eq(
    eventTouched(
      { seeds, watches: [], results: [result("s1", 27_140)] },
      EVENT,
    ),
    true,
    "so is a result with no watch behind it — a DQ is still a record",
  );
  // A watch still running counts too: a reseed mid-heat would move the lane
  // out from under a thumb that is already down.
  eq(
    eventTouched(
      {
        seeds,
        watches: [watch("s1", "d-1", undefined, { startedAt: 1 })],
        results: [],
      },
      EVENT,
    ),
    true,
    "and so does a stopwatch that is merely running",
  );
}

/* ------------------------------------------------------------- counting */

{
  const seeds = [seed("s1", 1, 3, "a1"), seed("s2", 1, 4, "a2")];
  eq(
    recordedCount({
      watches: [
        watch("s1", "d-1", 27_140),
        watch("s2", "d-2", undefined, { startedAt: 1 }),
      ],
      results: [],
    }),
    1,
    "a running stopwatch is not a time recorded",
  );
  eq(
    recordedCount({ watches: [], results: [result("s1", 27_140)] }),
    1,
    "a signed-off swim is, even with no watch left under it",
  );
  eq(
    watchesOn({ watches: [watch("s1", "d-1", 1), watch("s2", "d-1", 2)] }, "s1")
      .length,
    1,
    "watches are read per swim",
  );
  eq(
    resultFor({ results: [result("s1", 1)] }, "s2"),
    undefined,
    "and results likewise",
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
  const unnamed = seed("s9", 1, 5, "");
  eq(
    swimTime(
      { seeds: [unnamed], watches: [watch("s9", "d-1", 27_140)], results: [] },
      "s9",
    ),
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
    recordedCount({ watches: [watch("s9", "d-1", 27_140)], results: [] }),
    1,
    "and it counts as a time the meet has recorded",
  );
  eq(
    laneProgress({ watches: [watch("s9", "d-1", 27_140)] }, "s9"),
    "complete",
    "and the desk sees the lane as covered",
  );
  eq(
    seedsForHeat({ seeds: [unnamed] }, EVENT, 1).length,
    1,
    "the swim is in its heat like any other",
  );
}

/* ------------------------------------------- one device, several watches */

/**
 * A lane timed by three people used to mean three phones. It usually means one
 * phone holding the sheet and three handheld watches read onto it — and those
 * still have to be three rows, because `watches` is keyed one per submitter.
 *
 * The first watch keeps the bare device id, so a phone that is itself the
 * stopwatch and a clipboard's first column are the same row rather than two.
 * That is what makes swapping between the two mid-meet harmless.
 */
eq(slotTimerId("d-abc", 1), "d-abc", "the first watch is just the device");
eq(slotTimerId("d-abc", 3), "d-abc#3", "the rest say which watch they are");
eq(watchSlot("d-abc"), 1, "a plain timer is watch one");
eq(watchSlot("d-abc#3"), 3, "and a slotted one says so");
eq(
  watchSlot("d-abc#nonsense"),
  1,
  "garbage after the marker is still watch one",
);
eq(
  fromDevice("d-abc#2", "d-abc"),
  true,
  "a column belongs to the device holding it",
);
eq(fromDevice("d-abc", "d-abc"), true, "so does the bare one");
eq(
  fromDevice("d-abcdef", "d-abc"),
  false,
  "and a device whose id merely starts the same does not",
);

// The point of the third watch, filed by one phone: it outvotes the slow
// thumb rather than dragging an average toward it.
{
  const s10 = seed("s10", 1, 4, "a1");
  const sheet = [
    watch("s10", slotTimerId("d-1", 1), 27_140),
    watch("s10", slotTimerId("d-1", 2), 27_200),
    watch("s10", slotTimerId("d-1", 3), 28_900),
  ];
  eq(
    swimTime({ seeds: [s10], watches: sheet, results: [] }, "s10"),
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
  // A clipboard that armed three and submitted two: the third row is deleted
  // on the way in (`api.timer.lane.ts`), so the lane is not left waiting on a
  // watch nobody is holding.
  eq(
    laneProgress(
      { watches: [sheet[0], watch("s10", slotTimerId("d-1", 2), undefined)] },
      "s10",
    ),
    "waiting",
    "a column still running is a lane still waiting",
  );
}

done();
