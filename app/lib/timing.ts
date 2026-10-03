/**
 * Working an official time out of the watches on a swim, and what an
 * administrator decided about it.
 *
 * Two concepts. **Watches** are evidence: one row per device per slot, keyed
 * by the lane it's evidence for (`event/heat/lane/device/slot` — there is no
 * separate swim id, a swim's whole identity already is its lane) — a
 * correction upserts that same row rather than appending a new one, so
 * there's no history left to collapse to "current": the row already is.
 * A **decision** is the administrator's own call, written directly onto the
 * swim it's about once, and taken back by clearing those same fields rather
 * than deleting a row elsewhere. Everything in between — the proposed time,
 * which swims are still outstanding, whether a heat or an event is done — is
 * derived, so it can never disagree with the rows underneath it.
 *
 * Everything here is pure and takes plain arrays. No document, no store.
 */

import type { Event } from "~/types/meet";
import type { Swim } from "~/types/swim";
import type { SwimIdentity } from "~/types/swim";
import type { Watch } from "~/types/watch";
import type { WatchRole } from "~/types/watch";
import { toSwimKey } from "~/types/swim";
import { type SwimKey } from "~/types/swim";

/** The rows these functions read. Anything holding both will do. */
export interface TimingRows {
  swims: Swim[];
  watches: Watch[];
}

/**
 * Swim times are truncated to hundredths, never rounded up: two watches
 * averaging 27.145 give 27.14. A time you didn't swim is not a time.
 */
function truncateToHundredths(ms: number): number {
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
 * Every watch on a swim's lane — one row per device per slot already, since
 * the storage layer keys watches by `event/heat/lane/device/slot` and
 * upserts rather than appends, so there is nothing left for this to
 * collapse: the current state of a slot and its whole history are the same
 * row. Every reader that works out a time, a lane's progress, or whether an
 * event is touched goes through here.
 */
export function currentWatches(
  rows: Pick<TimingRows, "watches">,
  slot: SwimIdentity,
): Watch[] {
  return rows.watches.filter(
    (w) =>
      w.eventId === slot.eventId &&
      w.heat === slot.heat &&
      w.lane === slot.lane,
  );
}

/**
 * The current watches on a swim that actually carry a time.
 *
 * The one gate between "a stopwatch is running" and "somebody swam this".
 * A watch with no `timeMs` is a thumb that has gone down and not yet come up,
 * and letting one reach `proposedTime` would put a phantom zero into a median.
 * Every reader that works out a time goes through here.
 */
function timedWatches(
  rows: Pick<TimingRows, "watches">,
  slot: SwimIdentity,
): Watch[] {
  return currentWatches(rows, slot)
    .filter((w) => w.timeMs > 0)
    .sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Whether a stopwatch in this app timed the race, rather than somebody typing
 * a number in afterwards. Read off the two timestamps it leaves behind.
 */
export function fromStopwatch(watch: Watch): boolean {
  return watch.startedAt !== 0 && watch.stoppedAt !== 0;
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
function proposedTime(watches: Watch[]): ProposedTime | null {
  const times = watches
    .filter((w) => w.timeMs > 0)
    .map((w) => w.timeMs)
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
 * just rounding differences, and a person needs to look rather than the app
 * quietly picking a number.
 */
export const OK_DISCREPANCY_MS = 300;

function spreadOf(watches: Watch[]): number | null {
  if (watches.length < 2) return null;
  const times = watches.map((w) => w.timeMs);
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
  const timed = watches.filter((w) => w.timeMs > 0);
  const byRole = (role: WatchRole) => timed.filter((w) => w.role === role);

  // The most recent, if an administrator has somehow left two — a later
  // reading replaces an earlier one rather than being averaged with it.
  const official = byRole("admin").sort(
    (a, b) => (b.recordedAt || 0) - (a.recordedAt || 0),
  )[0];
  if (official) {
    return {
      timeMs: official.timeMs,
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
      timeMs: meanOf(coaches.map((w) => w.timeMs)),
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
  slot: SwimIdentity,
): LaneProgress {
  const timers = currentWatches(rows, slot).filter((w) => w.role === "timer");
  if (timers.length === 0) return "none";
  return timers.every((w) => w.timeMs > 0) ? "complete" : "waiting";
}

/** Stopwatches still running on a swim: started, not stopped, no time sent yet. */
export function runningWatches(
  rows: Pick<TimingRows, "watches">,
  slot: SwimIdentity,
): Watch[] {
  return currentWatches(rows, slot).filter(
    (w) => w.timeMs === 0 && w.startedAt !== 0 && w.stoppedAt === 0,
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
  slot: SwimIdentity,
): Watch[] {
  return currentWatches(rows, slot).filter(
    (w) => w.timeMs === 0 && w.stoppedAt !== 0,
  );
}

/* ----------------------------------------------------------------- results */

/**
 * What a swim reads as right now: the signed-off decision, or what the
 * watches propose if nobody has signed it off yet.
 *
 * The distinction matters on every screen. A proposal moves when a watch
 * arrives; a decision does not, because the number was written down when
 * somebody accepted it.
 */
export interface SwimTime {
  timeMs: number;
  status: NonNullable<Swim["status"]>;
  /** True once an administrator has signed it off. */
  official: boolean;
}

export function swimTime(
  rows: TimingRows,
  slot: SwimIdentity,
): SwimTime | null {
  const swim = rows.swims.find(
    (s) =>
      s.eventId === slot.eventId &&
      s.heat === slot.heat &&
      s.lane === slot.lane,
  );
  if (swim?.status) {
    return {
      timeMs: swim.officialTimeMs ?? 0,
      status: swim.status,
      official: true,
    };
  }

  const watches = timedWatches(rows, slot);
  const proposed = laneTime(watches);
  if (!proposed) return null;
  return {
    ...proposed,
    status: "OK",
    official: false,
  };
}

/* ----------------------------------------------------------------- closing */

/** The swims of one event, in heat then lane order. */
export function swimsForEvent(
  rows: Pick<TimingRows, "swims">,
  eventId: string,
): Swim[] {
  return rows.swims
    .filter((s) => s.eventId === eventId)
    .sort((a, b) => a.heat - b.heat || a.lane - b.lane);
}

/** The swims of one heat of one event. */
export function swimsForHeat(
  rows: Pick<TimingRows, "swims">,
  eventId: string,
  heat: number,
): Swim[] {
  return swimsForEvent(rows, eventId).filter((s) => s.heat === heat);
}

/** Which heats an event has, in order. A heat with nothing in it isn't one. */
export function heatsOf(
  rows: Pick<TimingRows, "swims">,
  eventId: string,
): number[] {
  return [...new Set(swimsForEvent(rows, eventId).map((s) => s.heat))].sort(
    (a, b) => a - b,
  );
}

/**
 * Whether anything has been recorded against an event.
 *
 * The test for "this event is history now". Reseeding may rearrange an event
 * nobody has swum; once there is a watch or a decision against one of its
 * swims, rearranging it would leave those pointing at a swim that no longer
 * means what it meant.
 */
export function eventStarted(rows: TimingRows, eventId: string): boolean {
  return (
    rows.watches.some((w) => w.eventId === eventId) ||
    rows.swims.some((s) => s.eventId === eventId && !!s.status)
  );
}

/**
 * A heat is done once every swim in it has been signed off. Derived rather
 * than stored, so "done" can never disagree with the swims underneath it.
 */
export function swimsComplete(swims: Swim[]): boolean {
  if (swims.length === 0) return false;
  return swims.every((swim) => !!swim.status);
}

/** How many swims have anything recorded — the meet's "times" count. */
export function recordedCount(
  rows: Pick<TimingRows, "swims" | "watches">,
): number {
  const keys = new Set<SwimKey>();
  for (const w of rows.watches)
    if (w.timeMs !== undefined) keys.add(toSwimKey(w));
  for (const s of rows.swims) if (s.status) keys.add(toSwimKey(s));
  return keys.size;
}
