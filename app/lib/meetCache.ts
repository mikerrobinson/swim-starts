import {
  toEntryKey,
  toSwimKey,
  toWatchKey,
  type Entry,
  type Event,
  type MeetAthlete,
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

class MeetCacheManager {
  // In-memory heap cache of deserialized manifests
  private meets = new Map<string, MeetManifest>();

  // Components subscribed to a meet's live data — see `subscribe`/`notify`.
  // This is the actual re-render trigger for `useMeet()`: the cache mutates
  // a meet's manifest in place (see `applyPatch`), so nothing about React's
  // own data flow (loaderData identity, router state) changes on its own.
  // Notifying these listeners is what makes a mutation visible.
  private listeners = new Map<string, Set<() => void>>();

  // Coalescing queue for high-frequency bursts, one per meet.
  private diskSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private notifyTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Which of a meet's record collections were mutated in place since the
  // last flush — what `notify` snapshots (shallow-copies) right before
  // waking listeners. A whole heat's worth of watches landing in the same
  // 50ms window all mutate `meet.watches` in place, O(1) each; this pays
  // for exactly one shallow copy of `watches` per flush, not one per
  // message, while still giving `useMemo(() => ..., [meet.watches])`
  // consumers a reference that actually changes.
  private dirty = new Map<
    string,
    {
      watches?: boolean;
      swims?: boolean;
      athletes?: boolean;
      entries?: boolean;
    }
  >();

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
   * Subscribe to a meet's live data — called once per mounted `useMeet()`.
   * `applyPatch` writes straight into the cached manifest's collections in
   * place — O(1) per message, no copying, so a burst of watches landing
   * together doesn't cost O(n²) — so this notify callback, not a changed
   * object reference, is what tells a component it's time to re-render.
   * `notify` (below) is where a touched collection actually gets a fresh
   * reference, once per flush no matter how many messages landed in it, so
   * `useMemo(() => ..., [meet.watches])`-style consumers still see a real
   * change without paying for it on every single write. Deliberately
   * outside React Router's own loader/revalidation cycle:
   * `meet-layout.tsx`'s route opts out of revalidation entirely (see its
   * `shouldRevalidate`) so a live patch never races a full loader refetch
   * and flashes stale-then-fresh — this is the only path that updates the
   * screen for a mutation.
   */
  subscribe(meetId: string, listener: () => void): () => void {
    let set = this.listeners.get(meetId);
    if (!set) {
      set = new Set();
      this.listeners.set(meetId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(meetId);
    };
  }

  private notify(meetId: string): void {
    const meet = this.meets.get(meetId);
    const dirty = this.dirty.get(meetId);
    if (meet && dirty) {
      // One shallow copy per collection actually touched since the last
      // flush, however many in-place writes landed against it in between.
      if (dirty.watches) meet.watches = { ...meet.watches };
      if (dirty.swims) meet.swims = { ...meet.swims };
      if (dirty.athletes) meet.athletes = { ...meet.athletes };
      if (dirty.entries) meet.entries = { ...meet.entries };
      this.dirty.delete(meetId);
    }

    for (const listener of this.listeners.get(meetId) ?? []) listener();
  }

  private markDirty(
    meetId: string,
    collection: "watches" | "swims" | "athletes" | "entries",
  ): void {
    let flags = this.dirty.get(meetId);
    if (!flags) {
      flags = {};
      this.dirty.set(meetId, flags);
    }
    flags[collection] = true;
  }

  /**
   * Applies incoming socket patches directly to the in-memory object graph in O(1) time.
   * Batches downstream re-renders to the next tick and debounces disk writes.
   */
  applyPatch(
    meetId: string,
    msg: LiveSocketMessage,
    isLocal: boolean = false,
  ): boolean {
    const meet = this.meets.get(meetId);
    if (!meet) return false;

    let didMutate = false;

    switch (msg.type) {
      case "WATCH": {
        const key = toWatchKey(msg.watch);
        if (msg.isDelete) delete meet.watches[key];
        else meet.watches[key] = msg.watch;
        this.markDirty(meetId, "watches");
        didMutate = true;
        break;
      }

      case "SWIM": {
        const key = toSwimKey(msg.swim);
        if (msg.isDelete) delete meet.swims[key];
        else meet.swims[key] = msg.swim;
        this.markDirty(meetId, "swims");
        didMutate = true;
        break;
      }

      case "ATHLETE": {
        if (msg.isDelete) delete meet.athletes[msg.athlete.id];
        else meet.athletes[msg.athlete.id] = msg.athlete;
        this.markDirty(meetId, "athletes");
        didMutate = true;
        break;
      }

      case "ENTRY": {
        const key = toEntryKey(msg.entry);
        if (msg.isDelete) delete meet.entries[key];
        else meet.entries[key] = msg.entry;
        this.markDirty(meetId, "entries");
        didMutate = true;
        break;
      }

      case "MEET_DETAILS": {
        meet.details = msg.details;
        meet.name = msg.details.name;
        didMutate = true;
        break;
      }

      case "EVENTS": {
        meet.events = Object.fromEntries(msg.events.map((e) => [e.id, e]));
        didMutate = true;
        break;
      }
    }

    if (!didMutate) return false;

    if (isLocal) this.flushNotify(meetId);
    else this.scheduleNotify(meetId);

    // 2. Debounce serialization & disk write until pool action settles
    this.scheduleDiskPersist(meetId, meet);

    return true;
  }

  hasPendingNotify(meetId: string): boolean {
    return this.notifyTimers.has(meetId);
  }

  flushNotify(meetId: string): void {
    const timer = this.notifyTimers.get(meetId);
    if (timer) {
      clearTimeout(timer);
      this.notifyTimers.delete(meetId);
    }
    this.notify(meetId);
  }

  /** Coalesces a burst of patches (a whole heat's worth of watches landing
   *  within the same tick, say) into a single re-render rather than one per
   *  message. */
  private scheduleNotify(meetId: string): void {
    if (this.notifyTimers.has(meetId)) return;

    const timer = setTimeout(() => {
      this.notifyTimers.delete(meetId);
      this.notify(meetId);
    }, 50);
    this.notifyTimers.set(meetId, timer);
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
      const notifyTimer = this.notifyTimers.get(meetId);
      if (notifyTimer) clearTimeout(notifyTimer);
      this.notifyTimers.delete(meetId);
      this.dirty.delete(meetId);
      if (typeof window !== "undefined") {
        localStorage.removeItem(`meet:${meetId}`);
      }
    } else {
      this.meets.clear();
      for (const timer of this.diskSaveTimers.values()) {
        clearTimeout(timer);
      }
      this.diskSaveTimers.clear();
      for (const timer of this.notifyTimers.values()) {
        clearTimeout(timer);
      }
      this.notifyTimers.clear();
      this.dirty.clear();
    }
  }
}

export const meetCache = new MeetCacheManager();
