import { generateId } from "./id";
import { eventTouched, seedsForEvent, type TimingRows } from "./timing";
import type { LaneAssignments, LaneCount, Seed } from "~/types/meet";

/**
 * Lane assignment order, fastest lane first. Standard practice puts the top
 * seed in the middle of the pool and works outward, alternating sides: six
 * lanes seed 3-4-2-5-1-6, five lanes 3-2-4-1-5. An even pool has no true
 * centre, so its first pair leans to the high side.
 */
export function laneOrder(laneCount: LaneCount): number[] {
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
 * Split swimmers into heats and assign lanes.
 *
 * Heats are numbered in swum order, 1-based, and any short heat comes first —
 * that's how meets actually run it, so the last heat is full. Within a heat,
 * swimmers fill lanes from the middle outward.
 *
 * One seed per swimmer, and none for the lanes nobody is in: a lane with
 * nobody in it isn't a planned swim, and a heat is the distinct heats across
 * the seeds rather than a row of its own.
 */
export function buildSeeds(
  meetId: string,
  eventId: string,
  athleteIds: string[],
  laneCount: LaneCount,
): Seed[] {
  if (athleteIds.length === 0) return [];

  const order = laneOrder(laneCount);
  const heatCount = Math.ceil(athleteIds.length / laneCount);
  const remainder = athleteIds.length % laneCount;
  const firstHeatSize = remainder === 0 ? laneCount : remainder;

  const seeds: Seed[] = [];
  let cursor = 0;

  for (let index = 0; index < heatCount; index++) {
    const size = index === 0 ? firstHeatSize : laneCount;
    const group = athleteIds.slice(cursor, cursor + size);
    cursor += size;

    group.forEach((athleteId, i) => {
      seeds.push({
        id: generateId(),
        eventId,
        heat: index + 1,
        lane: order[i],
        athleteId,
      });
    });
  }

  return seeds;
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
 * Where a swimmer lands back in the seat they already had, the seed keeps its
 * id — the same rule this always followed, so a watch already taken on an
 * untouched swim (there can't be one, but a caller composing this with other
 * changes might still care) would still point at the right row.
 */
export function seedEvent(
  rows: Pick<TimingRows, "seeds">,
  meetId: string,
  eventId: string,
  entrants: string[],
  teamOf: (athleteId: string) => string | undefined,
  laneAssignments: LaneAssignments,
  laneCount: LaneCount,
): Seed[] {
  if (entrants.length === 0) return [];

  const heatCount = Math.ceil(entrants.length / laneCount);
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

  for (const athleteId of entrants) {
    const teamId = teamOf(athleteId);
    const order = teamId ? ownOrder.get(teamId) : undefined;
    const already = teamId ? (placedByTeam.get(teamId) ?? 0) : 0;

    if (order && order.length > 0 && already < (capacity.get(teamId!) ?? 0)) {
      const heat = Math.floor(already / order.length) + 1;
      const lane = order[already % order.length];
      seatOf.set(athleteId, { heat, lane });
      claimed.add(`${heat}/${lane}`);
      placedByTeam.set(teamId!, already + 1);
    } else {
      overflow.push(athleteId);
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
    seedsForEvent(rows, eventId).map(
      (s) => [`${s.heat}/${s.lane}`, s] as const,
    ),
  );

  return entrants.map((athleteId) => {
    const seat = seatOf.get(athleteId)!;
    const before = existing.get(`${seat.heat}/${seat.lane}`);
    return before && before.athleteId === athleteId
      ? { ...before }
      : {
          id: generateId(),
          eventId,
          heat: seat.heat,
          lane: seat.lane,
          athleteId,
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
  meetId: string,
  eventId: string,
  entrants: string[],
  teamOf: (athleteId: string) => string | undefined,
  laneAssignments: LaneAssignments,
  laneCount: LaneCount,
): Seed[] | null {
  if (eventTouched(rows, eventId)) return null;
  return seedEvent(
    rows,
    meetId,
    eventId,
    entrants,
    teamOf,
    laneAssignments,
    laneCount,
  );
}
