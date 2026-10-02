import { useMemo } from "react";
import { useMeet } from "~/hooks/useMeet";
import type { MeetAthlete, Event } from "~/types/meet";
import { toSwimKey, type Swim } from "~/types/swim";
import type { Watch } from "~/types/watch";

type LaneManifest = {
  swim: Swim;
  athlete?: MeetAthlete;
  watches: Watch[];
  isComplete: boolean;
};

type HeatManifest = {
  event: Event;
  heatNumber: number;
  totalHeats: number;
  lanes: Record<number, LaneManifest>;
  isComplete: boolean;
  prev: {
    eventId: string;
    heat: number;
  } | null;
  next: {
    eventId: string;
    heat: number;
  } | null;
};

export function useHeat(eventId: string, heat: number): HeatManifest | null {
  const { events, details, athletes, swims, watches, version } = useMeet();

  return useMemo(() => {
    const event = events[eventId];
    if (!event) return null;
    // 1. Resolve Heats & Navigation Pointers
    const sortedEvents = Object.values(events).sort(
      (a, b) => a.position - b.position,
    );
    const eventIdx = sortedEvents.findIndex((e) => e.id === eventId);
    const totalHeats = event.totalHeats || 1;

    let prev: { eventId: string; heat: number } | null = null;
    let next: { eventId: string; heat: number } | null = null;

    if (heat > 1) {
      prev = { eventId, heat: heat - 1 };
    } else if (eventIdx > 0) {
      const prevEvent = sortedEvents[eventIdx - 1];
      prev = { eventId: prevEvent.id, heat: prevEvent.totalHeats || 1 };
    }

    if (heat < totalHeats) {
      next = { eventId, heat: heat + 1 };
    } else if (eventIdx !== -1 && eventIdx + 1 < sortedEvents.length) {
      next = { eventId: sortedEvents[eventIdx + 1].id, heat: 1 };
    }

    // 2. Hydrate the Lane Grid (assuming standard 6 or 8 lane configuration)
    let filledLanes = 0;
    let completedLanes = 0;
    const lanes: Record<number, LaneManifest> = {};

    // Standard pool lanes (e.g., 1 to 6)
    for (let lane = 1; lane <= (details.laneCount || 6); lane++) {
      const swimKey = toSwimKey({ eventId, heat, lane });
      const swim = swims[swimKey];
      const athlete = swim?.athleteId ? athletes[swim.athleteId] : undefined;

      // Extract watches for this slot (filtered by O(1) or prefix check)
      const laneWatches = Object.values(watches).filter(
        (w) => w.eventId === eventId && w.heat === heat && w.lane === lane,
      );

      const hasRecordedTime =
        !!swim?.officialTimeMs || laneWatches.some((w) => !!w.timeMs);

      if (swim && swim.status !== "NS") {
        filledLanes++;
        if (hasRecordedTime || swim.status === "OK" || swim.status === "DQ") {
          completedLanes++;
        }
      }

      lanes[lane] = {
        swim,
        athlete,
        watches: laneWatches,
        isComplete: hasRecordedTime,
      };
    }

    // 3. Derived Operational Heat Status
    const isComplete = filledLanes > 0 && completedLanes >= filledLanes;

    return {
      event,
      heatNumber: heat,
      totalHeats,
      lanes,
      isComplete,
      prev,
      next,
    };
  }, [eventId, heat, events, details, swims, athletes, watches, version]);
}
