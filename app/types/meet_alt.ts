export type SwimKey = `${string}:h${number}:l${number}`;
export type EventId = string;

export function makeSwimKey(
  eventId: string,
  heat: number,
  lane: number,
): SwimKey {
  return `${eventId}:h${heat}:l${lane}`;
}

export function parseSwimKey(key: SwimKey): {
  eventId: string;
  heat: number;
  lane: number;
} {
  const [eventId, h, l] = key.split(":");
  return {
    eventId,
    heat: Number(h.replace("h", "")),
    lane: Number(l.replace("l", "")),
  };
}

export interface Watch {
  id: string;
  swimId: string;
  userId?: string;
  role: "timer" | "chief_timer" | "admin";
  slot: number; // Watch 1, 2, or 3
  timeMs?: number;
  startedAt?: number;
  stoppedAt?: number;
  submittedAt: number;
  submittedBy: string;
}

export interface Swim {
  id: string;
  eventId: EventId;
  heat: number; // 1-based (Heat 1, 2, 3)
  lane: number; // 1-based (Lane 1, 2, 3, 4, 5, 6)
  athleteId?: string; // Optional for open lanes
  athleteName?: string;
  athleteTeam?: string;
  exhibition: boolean;
  status: "pending" | "official" | "dq" | "dns";
  officialTimeMs?: number;
  decidedAt?: number;
  decidedBy?: string;
  watches?: Watch[]; // Hydrated watches for easy UI display
}

export interface Event {
  id: string;
  position: number; // Chronological order: 1, 2, 3 (or 10, 20, 30)
  eventNumber: number; // e.g. 101
  distance: number; // 50, 100, 200
  stroke: "free" | "back" | "breast" | "fly" | "im" | "medley";
  gender: "boys" | "girls" | "mixed";
  name?: string;
  totalHeats?: number; // Optional, can be calculated from swims
}

export interface MeetManifest {
  id: string;
  name: string;
  isLive: boolean;
  events: Record<EventId, Event>;
  swims: Record<SwimKey, Swim>;
  // Current deck pointer:
  currentEventId?: EventId;
  currentHeatNumber?: number;
}

/*
 *  Helpers for working with the running order of a meet, which is the order heats are swum in.
 */
// 1. Get ordered list of events for the meet
export function getSortedEvents(meet: MeetManifest): Event[] {
  return Object.values(meet.events).sort((a, b) => a.position - b.position);
}

// 2. Get all swims for a specific heat (ordered by lane)
export function getHeatSwims(
  meet: MeetManifest,
  eventId: string,
  heatNumber: number,
): Swim[] {
  return Object.values(meet.swims)
    .filter((s) => s.eventId === eventId && s.heat === heatNumber)
    .sort((a, b) => a.lane - b.lane);
}

// 3. Find the total number of heats in an event
export function getTotalHeatsForEvent(
  meet: MeetManifest,
  eventId: string,
): number {
  const heats = new Set(
    Object.values(meet.swims)
      .filter((s) => s.eventId === eventId)
      .map((s) => s.heat),
  );
  return heats.size;
}

// 4. Stepper: Calculate the next sequential heat/event
export function getNextHeat(
  meet: MeetManifest,
  currentEventId: string,
  currentHeat: number,
): { eventId: string; heat: number } | null {
  const totalHeats = getTotalHeatsForEvent(meet, currentEventId);

  // Still more heats in the current event?
  if (currentHeat < totalHeats) {
    return { eventId: currentEventId, heat: currentHeat + 1 };
  }

  // Move to the next event in the schedule
  const sortedEvents = getSortedEvents(meet);
  const currentEventIdx = sortedEvents.findIndex(
    (e) => e.id === currentEventId,
  );

  if (currentEventIdx !== -1 && currentEventIdx + 1 < sortedEvents.length) {
    const nextEvent = sortedEvents[currentEventIdx + 1];
    return { eventId: nextEvent.id, heat: 1 };
  }

  // Reached end of meet
  return null;
}
