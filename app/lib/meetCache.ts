import {
  type Event,
  type MeetAthlete,
  type MeetDetails,
  type MeetManifest,
} from "~/types/meet";
import { toEntryKey } from "~/types/entry";
import { type Entry } from "~/types/entry";
import { toSwimKey } from "~/types/swim";
import { type Swim } from "~/types/swim";
import { toWatchKey } from "~/types/watch";
import { type Watch } from "~/types/watch";
import type { EntityMutation } from "~/types/mutations";
import { toAthleteKey } from "~/types/athlete";

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
      athlete: MeetAthlete;
      isDelete: boolean;
    }
  | {
      type: "MEET_DETAILS";
      details: MeetDetails;
    }
  | {
      type: "EVENTS";
      events: Event[];
    };

interface CacheEntry {
  manifest: MeetManifest;
  lastSyncedAt: number;
  isExplicitlyStale: boolean;
}

interface PatchOptions {
  onRevalidate?: () => void;
  immediate?: boolean; // Defaults to false (batched). Set to true for local client updates
}

class MeetCacheManager {
  // In-memory heap cache of deserialized manifests
  private meets = new Map<string, CacheEntry>();

  // Coalescing queue for high-frequency bursts
  private isRevalidationPending = false;
  private diskSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private revalidateTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCallback: (() => void) | null = null;

  private readonly STALE_TTL_MS = 60 * 1000;

  /**
   * Retrieves the manifest synchronously from memory if warm,
   * falling back to localStorage during initial bootstrap.
   */
  getMeet(meetId: string): MeetManifest | null {
    if (this.meets.has(meetId)) {
      return this.meets.get(meetId)?.manifest!;
    }

    // if (typeof window !== "undefined") {
    //   try {
    //     const raw = localStorage.getItem(`meet:${meetId}`);
    //     if (raw) {
    //       const parsed = JSON.parse(raw) as MeetManifest;
    //       this.meets.set(meetId, {
    //         manifest: parsed,
    //         lastSyncedAt: Date.now(),
    //         isExplicitlyStale: false,
    //       });
    //       return parsed;
    //     }
    //   } catch (err) {
    //     console.warn("Failed to load meet from storage", err);
    //   }
    // }

    return null;
  }

  /**
   * Stores fresh manifest from initial SSR/loader hydration in RAM and disk.
   */
  saveMeet(meetId: string, manifest: MeetManifest): void {
    this.meets.set(meetId, {
      manifest,
      lastSyncedAt: Date.now(),
      isExplicitlyStale: false,
    });

    // if (typeof window !== "undefined") {
    //   try {
    //     localStorage.setItem(`meet:${meetId}`, JSON.stringify(manifest));
    //   } catch (err) {
    //     console.warn("Failed to persist meet manifest to storage", err);
    //   }
    // }
  }

  /**
   * Applies incoming socket patches directly to the in-memory object graph in O(1) time.
   * Batches downstream Remix revalidation to next animation frame and debounces disk writes.
   */
  applyPatch(
    meetId: string,
    mutation: EntityMutation,
    options?: PatchOptions,
  ): boolean {
    const meet = this.meets.get(meetId)?.manifest;
    if (!meet) return false;

    let didMutate = false;

    switch (mutation.entity) {
      case "watch": {
        const k = toWatchKey(mutation.key);
        if (mutation.op === "delete") {
          delete meet.watches[k];
        } else {
          const existing = meet.watches[k] || { ...mutation.key };
          meet.watches[k] = { ...existing, ...mutation.patch };
        }
        didMutate = true;
        break;
      }

      case "entry": {
        const k = toEntryKey(mutation.key);
        if (mutation.op === "delete") {
          delete meet.entries[k];
        } else {
          const existing = meet.entries[k] || { ...mutation.key };
          meet.entries[k] = { ...existing, ...mutation.patch };
        }
        didMutate = true;
        break;
      }

      case "swim": {
        const k = toSwimKey(mutation.key);
        if (mutation.op === "delete") {
          delete meet.swims[k];
        } else {
          const existing = meet.swims[k] || { ...mutation.key };
          meet.swims[k] = { ...existing, ...mutation.patch };
        }
        didMutate = true;
        break;
      }

      case "athlete": {
        const k = toAthleteKey(mutation.key);
        if (mutation.op === "delete") {
          delete meet.athletes[k];
        } else {
          const existing = meet.athletes[k] || { ...mutation.key };
          meet.athletes[k] = { ...existing, ...mutation.patch };
        }
        didMutate = true;
        break;
      }

      case "MEET_DETAILS": {
        meet.details = mutation.details;
        meet.name = mutation.details.name;
        didMutate = true;
        break;
      }

      case "EVENTS": {
        meet.events = Object.fromEntries(mutation.events.map((e) => [e.id, e]));
        didMutate = true;
        break;
      }
    }

    if (!didMutate) return false;

    this.touch(meetId);

    // If a revalidation callback is supplied (client-side only):
    if (typeof window !== "undefined" && options?.onRevalidate) {
      if (options.immediate) {
        // Local touch: bypass debounce timer and paint immediately
        this.pendingCallback = options.onRevalidate;
        this.flushRevalidation();
      } else {
        // WebSocket packet: batch into 50ms window
        this.scheduleRevalidation(options.onRevalidate);
      }
    }

    // 2. Debounce serialization & disk write until pool action settles
    this.scheduleDiskPersist(meetId, meet);

    return true;
  }

  isStale(meetId: string): boolean {
    const entry = this.meets.get(meetId);
    if (!entry) return true;
    if (entry.isExplicitlyStale) return true;
    return Date.now() - entry.lastSyncedAt > this.STALE_TTL_MS;
  }

  markStale(meetId: string): void {
    const entry = this.meets.get(meetId);
    if (entry) {
      entry.isExplicitlyStale = true;
    }
  }

  touch(meetId: string): void {
    const entry = this.meets.get(meetId);
    if (entry) {
      entry.lastSyncedAt = Date.now();
    }
  }

  hasPendingRevalidation(): boolean {
    return this.isRevalidationPending;
  }

  flushRevalidation(): void {
    if (this.revalidateTimer) {
      clearTimeout(this.revalidateTimer);
      this.revalidateTimer = null;
    }
    this.isRevalidationPending = false;

    if (this.pendingCallback) {
      const cb = this.pendingCallback;
      this.pendingCallback = null;
      cb();
    }
  }

  scheduleRevalidation(callback: () => void): void {
    this.pendingCallback = callback;

    if (this.isRevalidationPending) return;
    this.isRevalidationPending = true;

    this.revalidateTimer = setTimeout(() => {
      this.flushRevalidation();
    }, 50);
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
