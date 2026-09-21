/**
 * The vocabulary of a change, shared by everything that has to agree on it.
 *
 * One closed union rather than a free-form request, because three separate
 * pieces of the app have to mean the same thing by it: the outbox replays it
 * from storage a reload later, `applyPending` folds it over loader data to
 * show a tap before the server has heard of it, and the endpoint it is posted
 * to writes the row. A write that grows a rule has to grow it in all three,
 * and naming the shape once is what makes that a visible obligation rather
 * than a coincidence.
 *
 * Written down here rather than inside the queue because it is a wire
 * contract, not a detail of how the queue happens to work.
 */

import type { ResultStatus, WatchRole } from "~/types/meet";
import type { Athlete } from "~/types/athlete";

/** One thing somebody did. */
export type Write =
  | {
      kind: "entry";
      meetId: string;
      eventId: string;
      athleteId: string;
      entering: boolean;
      /** Decided at entry time, copied onto the swim the next seeding
       *  creates for this entry. See `Entry.seedTimeMs`/`Entry.exhibition`. */
      seedTimeMs?: number;
      exhibition?: boolean;
    }
  /**
   * Put somebody in a lane, by where the lane is rather than by a row id.
   *
   * Addressed as event/heat/lane because that is what the person doing it can
   * see — and because the swim may not exist yet, which is the whole point: a
   * timer naming somebody behind the blocks is creating it. Never backports
   * to an entry — an un-entered swim is allowed to exist and stay that way.
   */
  | {
      kind: "swim";
      meetId: string;
      eventId: string;
      heat: number;
      lane: number;
      athleteId: string;
      /** What the server will call it, so the overlay agrees about the id. */
      swimId: string;
    }
  | { kind: "unswim"; meetId: string; swimId: string }
  /**
   * Whether a swim counts towards scoring and placing.
   *
   * Open to whoever may record a time, not just the desk — it's known before
   * there's anything to sign off, and often by whoever's standing at the lane.
   */
  | { kind: "exhibition"; meetId: string; swimId: string; exhibition: boolean }
  /**
   * One reading of one stopwatch. Append-only on the server: this always
   * creates a new row, never edits an old one, so a retry after the wifi
   * drops at the wall is just another identical row rather than a collision.
   */
  | {
      kind: "watch";
      meetId: string;
      swimId: string;
      /** Whose watch: a device id, or the user id of whoever is signed in. */
      timerId: string;
      /**
       * The account behind it, and what they are to this meet. Both are sent
       * so the optimistic overlay ranks the watch the way the server will;
       * the server records its own answer either way, so neither is taken on
       * trust.
       */
      userId?: string;
      role: WatchRole;
      /** Which of this submitter's concurrent stopwatches this is. Absent
       *  means 1 — plain own-stopwatch mode, not a clipboard slot. */
      slot?: number;
      /** Absent for a stopwatch that has started and not been submitted. */
      timeMs?: number;
      submittedAt: number;
      startedAt?: number;
      stoppedAt?: number;
    }
  /** Clears a slot's whole history — "this clock claim shouldn't exist,"
   *  not "this clock's last reading was wrong" (that's a new `watch`). */
  | {
      kind: "drop-watch";
      meetId: string;
      swimId: string;
      timerId: string;
      slot?: number;
    }
  /**
   * Sign a swim off, or take the sign-off back.
   *
   * There is no half-way: a swim is decided or it isn't, and the status is
   * chosen as part of accepting it rather than recorded separately beforehand.
   * Writes straight onto the swim row — there is no separate results table.
   */
  | {
      kind: "result";
      meetId: string;
      swimId: string;
      status: ResultStatus;
      timeMs: number;
      /**
       * Written by the app's own discrepancy check rather than a person —
       * lets it be taken back automatically when the watches change their
       * story, without ever touching a call somebody actually made.
       */
      auto?: boolean;
    }
  | { kind: "unresult"; meetId: string; swimId: string };

/**
 * The subset of `Write` a live connection may send over its own socket,
 * rather than through the resilient cookie/action path — the WS "fast path"
 * (see `migration-plan.md`). Armed/stopped visibility and exhibition are
 * worth the latency win and cost nothing if lost, since the cookie already
 * carries the full, durable restatement. A final timed watch, an entry (which
 * reseeds) and a decision (irreversible) are deliberately excluded — those
 * stay on the resilient path or an explicit action, never "fire and hope".
 */
export type LiveSignal =
  | Extract<Write, { kind: "swim" }>
  | Extract<Write, { kind: "exhibition" }>
  | (Extract<Write, { kind: "watch" }> & { timeMs?: undefined });

export function isLiveSignal(write: Write): write is LiveSignal {
  return (
    write.kind === "swim" ||
    write.kind === "exhibition" ||
    (write.kind === "watch" && write.timeMs === undefined)
  );
}

/**
 * A name added behind the blocks (`MeetDurableObject.addWalkupAthlete`) —
 * not a `Write`, since declaring one is a D1 write on global tables
 * (athletes, enrollments), not a change to anything the meet's DO owns. It
 * still needs to reach every connected client the moment it happens, the
 * same way a `Write` does, so it travels the same broadcast channel.
 */
export interface WalkupBroadcast {
  kind: "walkup";
  meetId: string;
  athlete: Athlete;
}

/** Everything that can arrive over a meet's live connection. */
export type MeetBroadcast = Write | WalkupBroadcast;
