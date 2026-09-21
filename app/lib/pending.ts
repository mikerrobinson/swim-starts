/**
 * What the screen shows while the outbox is still catching up — and what
 * folds a DO broadcast over a cached snapshot too. Both are "apply one
 * change to data that hasn't heard about it yet" — the only difference is
 * whether the change is this device's own unacknowledged write or somebody
 * else's, already-accepted one arriving over the wire. `applyWrite` is that one
 * operation; `applyPending` is just it, reduced over a queue.
 *
 * Loader data (or a cached `MeetSnapshot`) is what the server has last said.
 * Folding a change over it is what makes a tap feel instant on good wifi and
 * keep working on none — and it's a pure function of both, so there is no
 * third copy of the meet to fall out of step.
 *
 * Every write's effect here has to match what the server (or the DO) does
 * with it, and that pairing is the only thing to be careful about in this
 * file: if a write grows a rule on either side, it grows the same rule here.
 */

import type { MeetDetail, MeetSnapshot, Watch } from "~/types/meet";
import type { MeetBroadcast } from "./writes";
import type { Queued } from "./outbox";

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
  let seeds = detail.seeds;
  let watches = detail.watches;
  let results = detail.results;
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

    case "seed": {
      // Nobody swims an event twice, so vacate whatever other lane they
      // held — the same rule `setSeed`/`seat` applies on the server.
      seeds = seeds.filter(
        (s) =>
          !(
            s.eventId === message.eventId &&
            s.athleteId === message.athleteId &&
            !(s.heat === message.heat && s.lane === message.lane)
          ),
      );
      const at = seeds.findIndex(
        (s) =>
          s.eventId === message.eventId &&
          s.heat === message.heat &&
          s.lane === message.lane,
      );
      const next = {
        id: at >= 0 ? seeds[at].id : message.seedId,
        meetId: message.meetId,
        eventId: message.eventId,
        heat: message.heat,
        lane: message.lane,
        athleteId: message.athleteId,
      };
      seeds =
        at >= 0 ? seeds.map((s, i) => (i === at ? next : s)) : [...seeds, next];

      // Swimming a race is being in it.
      const current = entries[message.eventId] ?? [];
      if (!current.includes(message.athleteId)) {
        entries = {
          ...entries,
          [message.eventId]: [...current, message.athleteId],
        };
      }
      break;
    }

    case "unseed":
      seeds = seeds.filter((s) => s.id !== message.seedId);
      watches = watches.filter((w) => w.seedId !== message.seedId);
      results = results.filter((r) => r.seedId !== message.seedId);
      break;

    case "exhibition":
      seeds = seeds.map((s) =>
        s.id === message.seedId
          ? { ...s, exhibition: message.exhibition || undefined }
          : s,
      );
      break;

    case "watch": {
      const existing = watches.find(
        (w) => w.seedId === message.seedId && w.timerId === message.timerId,
      );
      const next: Watch = {
        seedId: message.seedId,
        timerId: message.timerId,
        userId: message.userId,
        role: message.role,
        // A start that follows a time must not blank it — the same
        // `COALESCE` the server writes.
        timeMs: message.timeMs ?? existing?.timeMs,
        recordedAt: message.recordedAt,
        startedAt: message.startedAt ?? existing?.startedAt,
        stoppedAt: message.stoppedAt ?? existing?.stoppedAt,
      };
      watches = [
        ...watches.filter(
          (w) => !(w.seedId === next.seedId && w.timerId === next.timerId),
        ),
        next,
      ];
      break;
    }

    case "drop-watch":
      watches = watches.filter(
        (w) => !(w.seedId === message.seedId && w.timerId === message.timerId),
      );
      break;

    case "result": {
      const seed = seeds.find((s) => s.id === message.seedId);
      if (!seed) break;
      results = [
        ...results.filter((r) => r.seedId !== message.seedId),
        {
          seedId: message.seedId,
          eventId: seed.eventId,
          athleteId: seed.athleteId,
          status: message.status,
          timeMs: message.timeMs,
          decidedBy: message.auto ? "auto" : undefined,
          decidedAt: Date.now(),
        },
      ];
      break;
    }

    case "unresult":
      results = results.filter((r) => r.seedId !== message.seedId);
      break;

    case "walkup":
      if (!athletes.some((a) => a.id === message.athlete.id)) {
        athletes = [...athletes, message.athlete];
      }
      break;
  }

  return { ...detail, entries, seeds, watches, results, athletes };
}

/** `applyWrite`, reduced over a queue of this device's own pending writes —
 *  the outbox's optimistic overlay. */
export function applyPending(detail: MeetDetail, queue: Queued[]): MeetDetail {
  const mine = queue.filter((q) => q.write.meetId === detail.meet.id);
  return mine.reduce((acc, { write }) => applyWrite(acc, write), detail);
}
