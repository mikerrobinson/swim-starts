import type { Athlete } from "~/types/athlete";
import {
  toEntryKey,
  toSwimKey,
  toWatchKey,
  type Entry,
  type MeetDetails,
  type MeetManifest,
  type Swim,
  type Watch,
} from "~/types/meet";

export type LiveSocketMessage =
  | {
      type: "WATCH";
      watch: Watch;
      isDelete: boolean;
    }
  | {
      type: "SWIM";
      swim: Swim;
      isDelete: boolean;
    }
  | {
      type: "ENTRY";
      entry: Entry;
      isDelete: boolean;
    }
  | {
      type: "ATHLETE";
      athlete: Athlete;
      isDelete: boolean;
    }
  | {
      type: "MEET_DETAILS";
      details: MeetDetails;
    };

class MeetCacheManager {
  // In-memory heap cache of deserialized manifests
  private meets = new Map<string, MeetManifest>();

  // Coalescing queue for high-frequency bursts
  private isRevalidationPending = false;
  private diskSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Retrieves the manifest synchronously from memory if warm,
   * falling back to localStorage during initial bootstrap.
   */
  getMeet(meetId: string): MeetManifest | null {
    if (this.meets.has(meetId)) {
      return this.meets.get(meetId)!;
    }

    if (typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem(`meet:${meetId}`);
        if (raw) {
          const parsed = JSON.parse(raw) as MeetManifest;
          this.meets.set(meetId, parsed);
          return parsed;
        }
      } catch (err) {
        console.warn("Failed to load meet from storage", err);
      }
    }

    return null;
  }

  /**
   * Stores fresh manifest from initial SSR/loader hydration in RAM and disk.
   */
  saveMeet(meetId: string, manifest: MeetManifest): void {
    this.meets.set(meetId, manifest);

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
    const meet = this.meets.get(meetId);
    if (!meet) return false;

    let didMutate = false;

    switch (msg.type) {
      case "WATCH": {
        const key = toWatchKey(msg.watch);
        if (msg.isDelete) delete meet.watches[key];
        else meet.watches[key] = msg.watch;
        didMutate = true;
        break;
      }

      case "SWIM": {
        const key = toSwimKey(msg.swim);
        if (msg.isDelete) delete meet.swims[key];
        else meet.swims[key] = msg.swim;
        didMutate = true;
        break;
      }

      case "ATHLETE": {
        if (msg.isDelete) delete meet.athletes[msg.athlete.id];
        else meet.athletes[msg.athlete.id] = msg.athlete;
        didMutate = true;
        break;
      }

      case "ENTRY": {
        const key = toEntryKey(msg.entry);
        if (msg.isDelete) delete meet.entries[key];
        else meet.entries[key] = msg.entry;
        didMutate = true;
        break;
      }

      case "MEET_DETAILS": {
        meet.details = msg.details;
        meet.name = msg.details.name;
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
    }, 500); // 500ms debounce buffer

    this.diskSaveTimers.set(meetId, timer);
  }

  clear(meetId?: string): void {
    if (meetId) {
      this.meets.delete(meetId);
      const timer = this.diskSaveTimers.get(meetId);
      if (timer) clearTimeout(timer);
      this.diskSaveTimers.delete(meetId);
      if (typeof window !== "undefined") {
        localStorage.removeItem(`meet:${meetId}`);
      }
    } else {
      this.meets.clear();
      for (const timer of this.diskSaveTimers.values()) {
        clearTimeout(timer);
      }
      this.diskSaveTimers.clear();
    }
  }
}

export const meetCache = new MeetCacheManager();
