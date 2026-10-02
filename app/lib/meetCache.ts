import { type MeetManifest } from "~/types/meet";
import { toEntryKey } from "~/types/entry";
import { toSwimKey } from "~/types/swim";
import { toWatchKey } from "~/types/watch";
import type { EntityMutation } from "~/types/mutations";
import { toAthleteKey } from "~/types/athlete";

interface CacheEntry {
  manifest: MeetManifest;
  lastSyncedAt: number;
  isExplicitlyStale: boolean;
}

interface PatchOptions {
  immediate?: boolean; // Defaults to false (batched). Set to true for local pointer updates
}

type Listener = () => void;

class MeetCacheManager {
  private meets = new Map<string, CacheEntry>();
  private listeners = new Set<Listener>();

  // Coalescing queue for high-frequency bursts (WebSockets)
  private isNotificationPending = false;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private diskSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly STALE_TTL_MS = 60 * 1000;

  /**
   * React useSyncExternalStore subscription contract.
   */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Synchronously invokes all active store subscribers.
   */
  notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  getMeet(meetId: string): MeetManifest | null {
    if (this.meets.has(meetId)) {
      return this.meets.get(meetId)?.manifest!;
    }

    if (typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem(`meet:${meetId}`);
        if (raw) {
          const parsed = JSON.parse(raw) as MeetManifest;
          this.meets.set(meetId, {
            manifest: parsed,
            lastSyncedAt: Date.now(),
            isExplicitlyStale: false,
          });
          return parsed;
        }
      } catch (err) {
        console.warn("Failed to load meet from storage", err);
      }
    }

    return null;
  }

  saveMeet(meetId: string, manifest: MeetManifest): void {
    this.meets.set(meetId, {
      manifest,
      lastSyncedAt: Date.now(),
      isExplicitlyStale: false,
    });

    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(`meet:${meetId}`, JSON.stringify(manifest));
      } catch (err) {
        console.warn("Failed to persist meet manifest to storage", err);
      }
    }
  }

  /**
   * Applies mutations in-place in O(1) time.
   * If immediate = true (local touches), notifies React subscribers synchronously.
   * Otherwise (remote socket frames), batches notifications into a 50ms window.
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
          console.log("deleting watch: ", k);
          delete meet.watches[k];
          console.log("done");
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
    }

    if (!didMutate) return false;

    meet.version = (meet.version || 0) + 1;
    this.meets.get(meetId)!.manifest = { ...meet };
    this.touch(meetId);

    // Notify React UI subscribers
    if (options?.immediate) {
      this.flushNotification();
    } else {
      this.scheduleNotification();
    }

    // Debounce serialization & disk persistence
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

  flushNotification(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.isNotificationPending = false;
    this.notify();
  }

  scheduleNotification(): void {
    if (this.isNotificationPending) return;
    this.isNotificationPending = true;

    this.notifyTimer = setTimeout(() => {
      this.flushNotification();
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
    }, 500);

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
      this.listeners.clear();
      for (const timer of this.diskSaveTimers.values()) {
        clearTimeout(timer);
      }
      this.diskSaveTimers.clear();
      if (this.notifyTimer) {
        clearTimeout(this.notifyTimer);
        this.notifyTimer = null;
      }
      this.isNotificationPending = false;
    }
  }
}

export const meetCache = new MeetCacheManager();
