import { eventStarted, swimsForEvent, type TimingRows } from "./timing";
import type { Entry, LaneAssignments, LaneCount, Swim } from "~/types/meet";

/**
 * Lane assignment order, fastest lane first. Standard practice puts the top
 * seed in the middle of the pool and works outward, alternating sides: six
 * lanes seed 3-4-2-5-1-6, five lanes 3-2-4-1-5. An even pool has no true
 * centre, so its first pair leans to the high side.
 */
function laneOrder(laneCount: LaneCount): number[] {
  const middle = Math.floor((laneCount + 1) / 2);
  const even = laneCount % 2 === 0;
  const order = [middle];

  for (let step = 1; order.length < laneCount; step++) {
    for (const lane of even
      ? [middle + step, middle - step]
      : [middle - step, middle + step]) {
      if (lane >= 1 && lane <= laneCount) order.push(lane);
    }
  }

  return order;
}

/**
 * Seed a whole event, in one deterministic pass.
 *
 * `entrants` is given in priority order — fastest first, once the app knows a
 * time; first entered first until it does — and that order is also the order
 * lanes fill: the centre of a team's *own* lanes before its outside ones,
 * and a team's own lanes before anybody else's. A team short on entrants
 * simply leaves its spare lanes for whoever needs them, in whichever heat
 * that spare lane falls in, rather than forcing a heat that would otherwise
 * sit mostly empty.
 *
 * Run over the *whole* entrant list every time it changes, rather than only
 * placing whoever's new — a team that enters late still reaches for its own
 * lanes, bumping out whatever overflow was borrowing them, rather than being
 * pushed into an extra heat by swimmers who got there first.
 *
 * Where a swimmer lands back in the seat they already had, the swim keeps its
 * id and every other field untouched — the same rule this always followed,
 * so a watch already taken on an untouched swim (there can't be one, but a
 * caller composing this with other changes might still care) would still
 * point at the right row, and a lane-level exhibition override a reseed of
 * the rest of the event shouldn't clobber survives. `displayOf`/
 * `exhibitionOf` are only consulted for a swim that's freshly created here —
 * moved or brand new — never for one that's kept as-is.
 */
function seedEvent(
  rows: Pick<TimingRows, "swims">,
  eventId: string,
  entries: Entry[],
  laneAssignments: LaneAssignments,
  laneCount: LaneCount,
): Swim[] {
  if (entries.length === 0) return [];

  const heatCount = Math.ceil(entries.length / laneCount);
  const globalOrder = laneOrder(laneCount);

  // Each team's own lanes, centre-out, and how many of that team's own
  // entrants fit across every heat this event ends up needing.
  const ownOrder = new Map<string, number[]>();
  const capacity = new Map<string, number>();
  for (const [teamId, lanes] of Object.entries(laneAssignments)) {
    const order = globalOrder.filter((lane) => lanes.includes(lane));
    ownOrder.set(teamId, order);
    capacity.set(teamId, order.length * heatCount);
  }

  const seatOf = new Map<string, { heat: number; lane: number }>();
  const claimed = new Set<string>(); // "heat/lane", own-lane placements only
  const placedByTeam = new Map<string, number>();
  const overflow: string[] = [];

  for (const entry of entries) {
    const teamId = entry.teamId;
    const order = teamId ? ownOrder.get(teamId) : undefined;
    const already = teamId ? (placedByTeam.get(teamId) ?? 0) : 0;

    if (order && order.length > 0 && already < (capacity.get(teamId!) ?? 0)) {
      const heat = Math.floor(already / order.length) + 1;
      const lane = order[already % order.length];
      seatOf.set(entry.athleteId, { heat, lane });
      claimed.add(`${heat}/${lane}`);
      placedByTeam.set(teamId!, already + 1);
    } else {
      overflow.push(entry.athleteId);
    }
  }

  // Whatever's left over takes whatever's left over: any lane, in any heat,
  // that no team's own swimmers claimed — earliest heat first, centre-out
  // within it.
  const open: Array<{ heat: number; lane: number }> = [];
  for (
    let heat = 1;
    heat <= heatCount && open.length < overflow.length;
    heat++
  ) {
    for (const lane of globalOrder) {
      if (!claimed.has(`${heat}/${lane}`)) open.push({ heat, lane });
    }
  }
  overflow.forEach((athleteId, i) => seatOf.set(athleteId, open[i]));

  const existing = new Map(
    swimsForEvent(rows, eventId).map(
      (s) => [`${s.heat}/${s.lane}`, s] as const,
    ),
  );

  return entries.map((entry) => {
    const seat = seatOf.get(entry.athleteId)!;
    const before = existing.get(`${seat.heat}/${seat.lane}`);
    if (before && before.athleteId === entry.athleteId) return { ...before };
    return {
      eventId,
      heat: seat.heat,
      lane: seat.lane,
      athleteId: entry.athleteId,
      exhibition: entry.exhibition,
    };
  });
}

/**
 * `seedEvent`, or a refusal.
 *
 * Refuses once anything has been recorded against the event — a scratch or a
 * late entry must not rearrange a swim that's already been timed. Reseeding
 * used to clear an event's watches and rulings to make room; on a deck with
 * three timers on it that's somebody's whole afternoon, deleted from one
 * device and synced to the rest. Returns null when it refuses, so the caller
 * can say so rather than appearing to work.
 */
export function reseedEvent(
  rows: TimingRows,
  eventId: string,
  entries: Entry[],
  laneAssignments: LaneAssignments,
  laneCount: LaneCount,
): Swim[] | null {
  if (eventStarted(rows, eventId)) return null;
  return seedEvent(rows, eventId, entries, laneAssignments, laneCount);
}
