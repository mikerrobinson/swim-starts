/**
 * Folds a DO broadcast over a cached snapshot — the old timer workspace's
 * live sync (`meet-live.ts`). `applyWrite` is "apply one accepted change to
 * data that hasn't heard about it yet."
 *
 * Loader data (or a cached `MeetSnapshot`) is what the server has last said.
 * Folding a change over it is what makes a tap feel instant on good wifi and
 * keep working on none — and it's a pure function of both, so there is no
 * third copy of the meet to fall out of step.
 *
 * Every write's effect here has to match what the server (or the DO) does
 * with it, and that pairing is the only thing to be careful about in this
 * file: if a write grows a rule on either side, it grows the same rule here.
 *
 * One deliberate simplification: the server's `watches` table is append-only
 * (a correction is a new row), but this overlay only needs the *current*
 * view, not history, so a pending or incoming `watch` write is folded
 * upsert-style by `(swimId, submittedBy, slot)` — good enough for "what does
 * the screen show right now," which is all an overlay is for.
 */

import type { MeetDetail, MeetSnapshot, Watch } from "~/types/meet";
import type { MeetBroadcast } from "./writes";

/**
 * Fold one change — this device's own pending write, or an incoming
 * broadcast — over a snapshot. Generic over anything `MeetSnapshot`-shaped so
 * a full `MeetDetail` (today's loader data) and a bare live snapshot (the
 * DO's `getSnapshot`) share the same reducer without either losing whatever
 * extra fields it came in with.
 */
export function applyWrite<T extends MeetSnapshot>(
  detail: T,
  message: MeetBroadcast,
): T {
  let entries = detail.entries;
  let swims = detail.swims;
  let watches = detail.watches;
  let athletes = detail.athletes;

  switch (message.kind) {
    case "entry": {
      const current = entries[message.eventId] ?? [];
      const next = message.entering
        ? current.includes(message.athleteId)
          ? current
          : [...current, message.athleteId]
        : current.filter((id) => id !== message.athleteId);
      entries = { ...entries, [message.eventId]: next };
      break;
    }

    case "swim": {
      // Nobody swims an event twice, so vacate whatever other lane they
      // held — the same rule `setSeed`/`seat` applies on the server.
      swims = swims.filter(
        (s) =>
          !(
            s.eventId === message.eventId &&
            s.athleteId === message.athleteId &&
            !(s.heat === message.heat && s.lane === message.lane)
          ),
      );
      const at = swims.findIndex(
        (s) =>
          s.eventId === message.eventId &&
          s.heat === message.heat &&
          s.lane === message.lane,
      );
      const before = at >= 0 ? swims[at] : undefined;
      const next = {
        id: before?.id ?? message.swimId,
        meetId: message.meetId,
        eventId: message.eventId,
        heat: message.heat,
        lane: message.lane,
        athleteId: message.athleteId,
        athleteName:
          before?.athleteId === message.athleteId ? before.athleteName : "",
        athleteTeam:
          before?.athleteId === message.athleteId ? before.athleteTeam : "",
      };
      swims =
        at >= 0 ? swims.map((s, i) => (i === at ? next : s)) : [...swims, next];

      // Note: unlike `entry`, seating never backports here either — swims
      // never update entries, on the client's own copy any more than on the
      // server's.
      break;
    }

    case "unswim":
      swims = swims.filter((s) => s.id !== message.swimId);
      watches = watches.filter((w) => w.swimId !== message.swimId);
      break;

    case "exhibition":
      swims = swims.map((s) =>
        s.id === message.swimId
          ? { ...s, exhibition: message.exhibition || undefined }
          : s,
      );
      break;

    case "watch": {
      const slot = message.slot ?? 1;
      const next: Watch = {
        id: message.swimId + "|" + message.timerId + "|" + slot,
        swimId: message.swimId,
        submittedBy: message.timerId,
        userId: message.userId,
        role: message.role,
        slot,
        timeMs: message.timeMs,
        startedAt: message.startedAt,
        stoppedAt: message.stoppedAt,
        submittedAt: message.submittedAt,
      };
      watches = [
        ...watches.filter(
          (w) =>
            !(
              w.swimId === next.swimId &&
              w.submittedBy === next.submittedBy &&
              w.slot === next.slot
            ),
        ),
        next,
      ];
      break;
    }

    case "drop-watch": {
      const slot = message.slot ?? 1;
      watches = watches.filter(
        (w) =>
          !(
            w.swimId === message.swimId &&
            w.submittedBy === message.timerId &&
            w.slot === slot
          ),
      );
      break;
    }

    case "result": {
      const swim = swims.find((s) => s.id === message.swimId);
      if (!swim) break;
      swims = swims.map((s) =>
        s.id === message.swimId
          ? {
              ...s,
              status: message.status,
              officialTimeMs: message.timeMs,
              decidedBy: message.auto ? "auto" : undefined,
              decidedAt: Date.now(),
            }
          : s,
      );
      break;
    }

    case "unresult":
      swims = swims.map((s) =>
        s.id === message.swimId
          ? {
              ...s,
              status: undefined,
              officialTimeMs: undefined,
              decidedAt: undefined,
              decidedBy: undefined,
            }
          : s,
      );
      break;

    case "walkup":
      if (!athletes.some((a) => a.id === message.athlete.id)) {
        athletes = [...athletes, message.athlete];
      }
      break;
  }

  return { ...detail, entries, swims, watches, athletes };
}
