/**
 * Working an official time out of the watches on a swim, and what an
 * administrator decided about it.
 *
 * Two concepts. **Watches** are evidence: several per swim, one per submitter,
 * nobody overwriting anybody. A **result** is the decision: one per swim,
 * written only when an administrator signs it off, carrying the number they
 * accepted. Everything in between — the proposed time, which swims are still
 * outstanding, whether a heat or an event is done — is derived, so it can
 * never disagree with the rows underneath it.
 *
 * Everything here is pure and takes plain arrays. No document, no store.
 */

import type { Event, Result, Seed, Watch, WatchRole } from "~/types/meet";

/** The rows these functions read. Anything holding all three will do. */
export interface TimingRows {
  seeds: Seed[];
  watches: Watch[];
  results: Result[];
}

/**
 * Swim times are truncated to hundredths, never rounded up: two watches
 * averaging 27.145 give 27.14. A time you didn't swim is not a time.
 */
export function truncateToHundredths(ms: number): number {
  return Math.floor(ms / 10) * 10;
}

/** The mean of some times, truncated for the same reason. */
function meanOf(times: number[]): number {
  return truncateToHundredths(
    times.reduce((sum, ms) => sum + ms, 0) / times.length,
  );
}

/* ----------------------------------------------------------------- watches */

/**
 * The watches on a swim that actually carry a time.
 *
 * The one gate between "a stopwatch is running" and "somebody swam this".
 * A watch with no `timeMs` is a thumb that has gone down and not yet come up,
 * and letting one reach `proposedTime` would put a phantom zero into a median.
 * Every reader that works out a time goes through here.
 */
export function timedWatches(
  rows: Pick<TimingRows, "watches">,
  seedId: string,
): Watch[] {
  return rows.watches
    .filter((w) => w.seedId === seedId && w.timeMs !== undefined)
    .sort((a, b) => a.timeMs! - b.timeMs!);
}

/** Every watch on a swim, running ones included — for a screen showing them. */
export function watchesOn(
  rows: Pick<TimingRows, "watches">,
  seedId: string,
): Watch[] {
  return rows.watches.filter((w) => w.seedId === seedId);
}

/**
 * Whether a stopwatch in this app timed the race, rather than somebody typing
 * a number in afterwards. Read off the two timestamps it leaves behind.
 */
export function fromStopwatch(watch: Watch): boolean {
  return watch.startedAt !== undefined && watch.stoppedAt !== undefined;
}

/* ------------------------------------------- one device, several watches */

/**
 * The separator between a device and which of its watches this is.
 *
 * A device id is `[A-Za-z0-9_-]` and nothing else (`grants.server.ts`), so a
 * `#` in a `timerId` can only ever be this, and a plain id can never be
 * mistaken for a slotted one.
 */
const SLOT = "#";

/**
 * The id one of a clipboard's watches is filed under.
 *
 * A lane timed by three people used to mean three phones, one watch each,
 * keyed by three device ids. It usually means one phone and three handheld
 * watches, and those three still have to be three rows — `watches` is keyed
 * `(seed_id, timer_id)`, one row per submitter, so a device filing three
 * times needs three ids or it would overwrite itself twice.
 *
 * Which is all the suffix is: the same device, saying which of the watches
 * in its hand this reading came off. Re-submitting a corrected sheet lands on
 * exactly the same rows.
 *
 * The first watch keeps the bare device id, so a phone that is itself the
 * stopwatch and a clipboard's watch 1 are the same row rather than two. That
 * is what makes swapping between the two mid-meet harmless: the device holds
 * one place on the lane and adds rows beside it, instead of leaving an
 * orphaned watch behind every time the person changes how they are working.
 */
export function slotTimerId(deviceId: string, slot: number): string {
  return slot > 1 ? `${deviceId}${SLOT}${slot}` : deviceId;
}

/**
 * Which watch on the clipboard this was — 1, 2 or 3.
 *
 * A timer that never held a clipboard has no suffix and is watch 1, which is
 * the honest answer rather than a special case: a phone that is itself the
 * stopwatch is the first and only watch on its lane.
 */
export function watchSlot(timerId: string): number {
  const at = timerId.lastIndexOf(SLOT);
  if (at < 0) return 1;
  const slot = Number(timerId.slice(at + 1));
  return Number.isInteger(slot) && slot > 0 ? slot : 1;
}

/** Whether a watch came off this device, whichever of its watches it is. */
export function fromDevice(timerId: string, deviceId: string): boolean {
  return timerId === deviceId || timerId.startsWith(`${deviceId}${SLOT}`);
}

export interface ProposedTime {
  timeMs: number;
}

/**
 * What a set of watches works out to, by the hand-timing rules.
 *
 * One stands alone. Two are averaged. Three or more take the middle one —
 * which is the point of a third watch: it outvotes a slow thumb rather than
 * dragging the average toward it. An even number above two is averaged across
 * the middle pair, for want of a single middle.
 */
export function proposedTime(watches: Watch[]): ProposedTime | null {
  const times = watches
    .filter((w) => w.timeMs !== undefined)
    .map((w) => w.timeMs!)
    .sort((a, b) => a - b);
  if (times.length === 0) return null;

  if (times.length === 1) {
    return { timeMs: times[0] };
  }
  if (times.length === 2) {
    return { timeMs: meanOf(times) };
  }

  const middle = times.length / 2;
  return times.length % 2 === 1
    ? {
        timeMs: times[Math.floor(middle)],
      }
    : {
        timeMs: meanOf([times[middle - 1], times[middle]]),
      };
}

export interface LaneTime {
  timeMs: number;
  /** Which tier answered, so a screen can say why. */
  from: WatchRole;
  /**
   * The spread between the fastest and slowest watch that fed this time.
   * `null` when only one watch did — an administrator's own reading, or a
   * lane with a single stopwatch on it — so there is nothing to disagree.
   */
  discrepancyMs: number | null;
}

/**
 * How much daylight between watches still counts as one lane, one time.
 * Past this, the watches disagree about what actually happened rather than
 * just rounding differently, and a person needs to look rather than the app
 * quietly picking a number.
 */
export const OK_DISCREPANCY_MS = 300;

function spreadOf(watches: Watch[]): number | null {
  if (watches.length < 2) return null;
  const times = watches.map((w) => w.timeMs!);
  return Math.max(...times) - Math.min(...times);
}

/**
 * The time a swim would be given, and the single place that decides it.
 *
 * Three tiers, asked in order, because the watches on a swim are not all the
 * same kind of evidence:
 *
 * 1. **The administrator's own reading.** Whoever runs the meet has looked at
 *    the lane, the watches and whatever the timers are telling them, and said
 *    what it was. That is a ruling and it stands.
 * 2. **The timers, by the hand-timing rules.** The official procedure, and
 *    what the third timer is for.
 * 3. **The coaches, averaged.** A fallback for a swim the timing table missed.
 *    Coaches time their own swimmers from the side, which is a worse position
 *    and an interested one, so they answer only when nothing better did.
 *
 * Tiers are never mixed. Averaging a coach's watch in with the timers' would
 * let the side of the pool quietly move an official time, and a median across
 * all of them would do the same less visibly.
 */
export function laneTime(watches: Watch[]): LaneTime | null {
  const timed = watches.filter((w) => w.timeMs !== undefined);
  const byRole = (role: WatchRole) => timed.filter((w) => w.role === role);

  // The most recent, if an administrator has somehow left two — a later
  // reading replaces an earlier one rather than being averaged with it.
  const official = byRole("admin").sort(
    (a, b) => b.recordedAt - a.recordedAt,
  )[0];
  if (official) {
    return {
      timeMs: official.timeMs!,
      from: "admin",
      // A ruling, not a reading among several — nothing else to disagree.
      discrepancyMs: null,
    };
  }

  const timers = byRole("timer");
  const proposed = proposedTime(timers);
  if (proposed)
    return { ...proposed, from: "timer", discrepancyMs: spreadOf(timers) };

  const coaches = byRole("coach");
  if (coaches.length > 0) {
    return {
      timeMs: meanOf(coaches.map((w) => w.timeMs!)),
      from: "coach",
      discrepancyMs: spreadOf(coaches),
    };
  }

  return null;
}

export type LaneProgress = "none" | "waiting" | "complete";

/**
 * How far along a swim's timing is, for a desk watching a heat go off.
 *
 * Three answers, and the middle one is the reason this exists. A lane with
 * nothing on it and a lane whose timers are all still holding their clocks
 * show the same empty box, and they want opposite responses: send somebody to
 * cover it, or leave it alone.
 *
 * Only timers count. A coach's watch and the desk's own reading are not what
 * the lane is waiting for — the timing table is.
 */
export function laneProgress(
  rows: Pick<TimingRows, "watches">,
  seedId: string,
): LaneProgress {
  const timers = watchesOn(rows, seedId).filter((w) => w.role === "timer");
  if (timers.length === 0) return "none";
  return timers.every((w) => w.timeMs !== undefined) ? "complete" : "waiting";
}

/** Stopwatches still running on a swim: started, not stopped, no time sent yet. */
export function runningWatches(
  rows: Pick<TimingRows, "watches">,
  seedId: string,
): Watch[] {
  return watchesOn(rows, seedId).filter(
    (w) =>
      w.timeMs === undefined &&
      w.startedAt !== undefined &&
      w.stoppedAt === undefined,
  );
}

/**
 * Stopwatches a thumb has already stopped but not yet submitted.
 *
 * A distinct state from "running": the desk should stop counting these up
 * and stop letting anyone sign the lane off OK, but it isn't a time yet
 * either — that only exists once the submit lands and gives it a `timeMs`.
 */
export function stoppedWatches(
  rows: Pick<TimingRows, "watches">,
  seedId: string,
): Watch[] {
  return watchesOn(rows, seedId).filter(
    (w) => w.timeMs === undefined && w.stoppedAt !== undefined,
  );
}

/* ----------------------------------------------------------------- results */

export function resultFor(
  rows: Pick<TimingRows, "results">,
  seedId: string,
): Result | undefined {
  return rows.results.find((r) => r.seedId === seedId);
}

/**
 * What a swim reads as right now: the signed-off result, or what the watches
 * propose if nobody has signed it off yet.
 *
 * The distinction matters on every screen. A proposal moves when a watch
 * arrives or is discarded; a result does not, because the number was written
 * down when somebody accepted it.
 */
export interface SwimTime {
  timeMs: number;
  status: Result["status"];
  watchCount: number;
  from: WatchRole;
  discrepancyMs: number | null;
  /** True once an administrator has signed it off. */
  official: boolean;
}

export function swimTime(rows: TimingRows, seedId: string): SwimTime | null {
  const result = resultFor(rows, seedId);
  if (result) {
    return {
      timeMs: result.timeMs,
      status: result.status,
      watchCount: 0,
      from: "admin",
      discrepancyMs: null,
      official: true,
    };
  }

  const proposed = laneTime(watchesOn(rows, seedId));
  if (!proposed) return null;
  return { ...proposed, status: "OK", official: false };
}

/* ----------------------------------------------------------------- closing */

/** The seeds of one event, in heat then lane order. */
export function seedsForEvent(
  rows: Pick<TimingRows, "seeds">,
  eventId: string,
): Seed[] {
  return rows.seeds
    .filter((s) => s.eventId === eventId)
    .sort((a, b) => a.heat - b.heat || a.lane - b.lane);
}

/** The seeds of one heat of one event. */
export function seedsForHeat(
  rows: Pick<TimingRows, "seeds">,
  eventId: string,
  heat: number,
): Seed[] {
  return seedsForEvent(rows, eventId).filter((s) => s.heat === heat);
}

/** Which heats an event has, in order. A heat with nothing in it isn't one. */
export function heatsOf(
  rows: Pick<TimingRows, "seeds">,
  eventId: string,
): number[] {
  return [...new Set(seedsForEvent(rows, eventId).map((s) => s.heat))].sort(
    (a, b) => a - b,
  );
}

/**
 * Whether anything has been recorded against an event.
 *
 * The test for "this event is history now". Reseeding may rearrange an event
 * nobody has swum; once there is a watch or a result against one of its seeds,
 * rearranging it would leave those pointing at swims that no longer mean what
 * they meant.
 */
export function eventTouched(rows: TimingRows, eventId: string): boolean {
  const ids = new Set(seedsForEvent(rows, eventId).map((s) => s.id));
  return (
    rows.watches.some((w) => ids.has(w.seedId)) ||
    rows.results.some((r) => ids.has(r.seedId))
  );
}

/**
 * A heat is done once every swim in it has been signed off. Derived rather
 * than stored, so "done" can never disagree with the results underneath it.
 */
export function heatClosed(
  rows: TimingRows,
  eventId: string,
  heat: number,
): boolean {
  const seeds = seedsForHeat(rows, eventId, heat);
  if (seeds.length === 0) return false;
  return seeds.every((seed) => resultFor(rows, seed.id) !== undefined);
}

/** An event is done once all of its heats are. Its results are then official. */
export function eventClosed(rows: TimingRows, eventId: string): boolean {
  const heats = heatsOf(rows, eventId);
  if (heats.length === 0) return false;
  return heats.every((heat) => heatClosed(rows, eventId, heat));
}

/** How far along a heat is, for a screen that has to show progress. */
export function heatProgress(
  rows: TimingRows,
  eventId: string,
  heat: number,
): { signedOff: number; swims: number } {
  const seeds = seedsForHeat(rows, eventId, heat);
  return {
    signedOff: seeds.filter((s) => resultFor(rows, s.id) !== undefined).length,
    swims: seeds.length,
  };
}

/** How many swims have anything recorded — the meet's "times" count. */
export function recordedCount(
  rows: Pick<TimingRows, "watches" | "results">,
): number {
  const swims = new Set<string>();
  for (const w of rows.watches) if (w.timeMs !== undefined) swims.add(w.seedId);
  for (const r of rows.results) swims.add(r.seedId);
  return swims.size;
}

/** Events in the order they're swum. */
export function orderedEvents(events: Event[]): Event[] {
  return [...events].sort((a, b) => a.position - b.position);
}
