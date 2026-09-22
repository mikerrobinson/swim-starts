import {
  parseSwimKey,
  toSwimKey,
  type MeetManifest,
  type Swim,
  type SwimKey,
  type Watch,
} from "~/types/meet";

export type LiveSocketMessage =
  | {
      type: "WATCH_RECORDED";
      eventId: string;
      heat: number;
      lane: number;
      watch: Watch;
    }
  | {
      type: "SWIM_STATUS_UPDATED";
      eventId: string;
      heat: number;
      lane: number;
      status: "pending" | "official" | "dq" | "dns";
      officialTimeMs?: number;
      decidedAt?: number;
      decidedBy?: string;
    }
  | {
      type: "LANE_ASSIGNMENT_CHANGED";
      eventId: string;
      heat: number;
      lane: number;
      athleteId?: string;
      athleteName?: string;
      athleteTeam?: string;
      exhibition?: boolean;
    }
  | {
      type: "ACTIVE_DECK_POSITION";
      eventId: string;
      heatNumber: number;
    }
  | {
      type: "EVENT_RESEEDED";
      eventId: string;
      totalHeats: number;
      swims: Swim[];
    };

class MeetCacheManager {
  // In-memory heap cache of deserialized manifests
  private manifests = new Map<string, MeetManifest>();

  // Coalescing queue for high-frequency bursts
  private isRevalidationPending = false;
  private diskSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Retrieves the manifest synchronously from memory if warm,
   * falling back to localStorage during initial bootstrap.
   */
  getManifest(meetId: string): MeetManifest | null {
    if (this.manifests.has(meetId)) {
      return this.manifests.get(meetId)!;
    }

    if (typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem(`meet:${meetId}`);
        if (raw) {
          const parsed = JSON.parse(raw) as MeetManifest;
          this.manifests.set(meetId, parsed);
          return parsed;
        }
      } catch (err) {
        console.warn("Failed to load meet manifest from storage", err);
      }
    }

    return null;
  }

  /**
   * Stores fresh manifest from initial SSR/loader hydration in RAM and disk.
   */
  saveManifest(meetId: string, manifest: MeetManifest): void {
    this.manifests.set(meetId, manifest);

    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(`meet:${meetId}`, JSON.stringify(manifest));
      } catch (err) {
        console.warn("Failed to persist meet manifest to storage", err);
      }
    }
  }

  /**
   * Applies incoming socket patches directly to the in-memory object graph in O(1) time.
   * Batches downstream Remix revalidation to next animation frame and debounces disk writes.
   */
  applyPatch(
    meetId: string,
    msg: LiveSocketMessage,
    onRevalidate: () => void,
  ): boolean {
    const meet = this.manifests.get(meetId);
    if (!meet) return false;

    let didMutate = false;

    switch (msg.type) {
      case "WATCH_RECORDED": {
        const key = toSwimKey({
          eventId: msg.eventId,
          heat: msg.heat,
          lane: msg.lane,
        });
        const swim = meet.swims[key];
        if (swim) {
          if (!swim.watches) swim.watches = [];
          const existingIdx = swim.watches.findIndex(
            (w) => w.id === msg.watch.id,
          );
          if (existingIdx >= 0) {
            swim.watches[existingIdx] = msg.watch;
          } else {
            swim.watches.push(msg.watch);
          }
          didMutate = true;
        }
        break;
      }

      case "SWIM_STATUS_UPDATED": {
        const key = toSwimKey({
          eventId: msg.eventId,
          heat: msg.heat,
          lane: msg.lane,
        });
        const swim = meet.swims[key];
        if (swim) {
          swim.status = msg.status;
          if (msg.officialTimeMs !== undefined)
            swim.officialTimeMs = msg.officialTimeMs;
          if (msg.decidedAt !== undefined) swim.decidedAt = msg.decidedAt;
          if (msg.decidedBy !== undefined) swim.decidedBy = msg.decidedBy;
          didMutate = true;
        }
        break;
      }

      case "LANE_ASSIGNMENT_CHANGED": {
        const key = toSwimKey({
          eventId: msg.eventId,
          heat: msg.heat,
          lane: msg.lane,
        });
        const swim = meet.swims[key];
        if (swim) {
          swim.athleteId = msg.athleteId;
          if (msg.athleteName !== undefined) swim.athleteName = msg.athleteName;
          if (msg.athleteTeam !== undefined) swim.athleteTeam = msg.athleteTeam;
          if (msg.exhibition !== undefined) swim.exhibition = msg.exhibition;
          didMutate = true;
        }
        break;
      }

      case "ACTIVE_DECK_POSITION": {
        meet.currentEventId = msg.eventId;
        meet.currentHeatNumber = msg.heatNumber;
        didMutate = true;
        break;
      }

      case "EVENT_RESEEDED": {
        if (meet.events[msg.eventId]) {
          meet.events[msg.eventId].totalHeats = msg.totalHeats;
        }
        // Remove prior swims for this event
        for (const key of Object.keys(meet.swims) as SwimKey[]) {
          if (parseSwimKey(key).eventId === msg.eventId) {
            delete meet.swims[key];
          }
        }
        // Populate newly seeded swims
        for (const swim of msg.swims) {
          const key = toSwimKey({
            eventId: swim.eventId,
            heat: swim.heat,
            lane: swim.lane,
          });
          meet.swims[key] = swim;
        }
        didMutate = true;
        break;
      }
    }

    if (!didMutate) return false;

    // 1. Coalesce UI revalidations so rapid multi-timer bursts only repaint once per frame
    if (!this.isRevalidationPending) {
      this.isRevalidationPending = true;
      if (typeof window !== "undefined" && "requestAnimationFrame" in window) {
        requestAnimationFrame(() => {
          this.isRevalidationPending = false;
          onRevalidate();
        });
      } else {
        queueMicrotask(() => {
          this.isRevalidationPending = false;
          onRevalidate();
        });
      }
    }

    // 2. Debounce serialization & disk write until pool action settles
    this.scheduleDiskPersist(meetId, meet);

    return true;
  }

  private scheduleDiskPersist(meetId: string, meet: MeetManifest): void {
    if (typeof window === "undefined") return;

    const existingTimer = this.diskSaveTimers.get(meetId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      try {
        localStorage.setItem(`meet:${meetId}`, JSON.stringify(meet));
      } catch (err) {
        console.warn("Failed debounced write to localStorage", err);
      } finally {
        this.diskSaveTimers.delete(meetId);
      }
    }, 1200); // 1.2s debounce buffer

    this.diskSaveTimers.set(meetId, timer);
  }

  clear(meetId?: string): void {
    if (meetId) {
      this.manifests.delete(meetId);
      const timer = this.diskSaveTimers.get(meetId);
      if (timer) clearTimeout(timer);
      this.diskSaveTimers.delete(meetId);
      if (typeof window !== "undefined") {
        localStorage.removeItem(`meet:${meetId}`);
      }
    } else {
      this.manifests.clear();
      for (const timer of this.diskSaveTimers.values()) {
        clearTimeout(timer);
      }
      this.diskSaveTimers.clear();
    }
  }
}

export const meetCache = new MeetCacheManager();
