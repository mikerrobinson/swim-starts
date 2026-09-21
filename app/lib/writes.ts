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

import type { Athlete } from "~/types/athlete";
import type { ResultStatus, WatchRole } from "~/types/meet";

/** One thing somebody did. */
export type Write =
  | {
      kind: "entry";
      meetId: string;
      eventId: string;
      athleteId: string;
      entering: boolean;
    }
  /**
   * Put somebody in a lane, by where the lane is rather than by a row id.
   *
   * Addressed as event/heat/lane because that is what the person doing it can
   * see — and because the seed may not exist yet, which is the whole point: a
   * timer naming somebody behind the blocks is creating the swim.
   */
  | {
      kind: "seed";
      meetId: string;
      eventId: string;
      heat: number;
      lane: number;
      athleteId: string;
      /** What the server will call it, so the overlay agrees about the id. */
      seedId: string;
    }
  | { kind: "unseed"; meetId: string; seedId: string }
  /**
   * Whether a swim counts towards scoring and placing.
   *
   * Open to whoever may record a time, not just the desk — it's known before
   * there's a result to sign off, and often by whoever's standing at the lane.
   */
  | { kind: "exhibition"; meetId: string; seedId: string; exhibition: boolean }
  | {
      kind: "watch";
      meetId: string;
      seedId: string;
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
      /** Absent for a stopwatch that has started and not been submitted. */
      timeMs?: number;
      recordedAt: number;
      startedAt?: number;
      stoppedAt?: number;
    }
  | { kind: "drop-watch"; meetId: string; seedId: string; timerId: string }
  /**
   * Sign a swim off, or take the sign-off back.
   *
   * There is no half-way: a result exists or it doesn't, and the status is
   * chosen as part of accepting it rather than recorded separately beforehand.
   */
  | {
      kind: "result";
      meetId: string;
      seedId: string;
      status: ResultStatus;
      timeMs: number;
      /**
       * Written by the app's own discrepancy check rather than a person —
       * lets it be taken back automatically when the watches change their
       * story, without ever touching a call somebody actually made.
       */
      auto?: boolean;
    }
  | { kind: "unresult"; meetId: string; seedId: string };

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
