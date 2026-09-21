// app/lib/meetCache.ts

export interface LaneSubmission {
  timeMs: number;
  status: "valid" | "dq" | "dns";
  deviceId: string;
}

export interface MeetManifest {
  id: string;
  name: string;
  isLive: boolean;
  version: number;
  events: Array<{
    id: string;
    number: number;
    name: string;
    heats: Array<{
      id: string;
      number: number;
      lanes: Array<{
        lane: number;
        swimmerName?: string;
        seedTimeMs?: number;
      }>;
    }>;
  }>;
}

class MeetCacheManager {
  private memory = new Map<string, any>();
  private pendingSyncKeys = new Set<string>();

  getManifest(meetId: string): MeetManifest | null {
    if (this.memory.has(`manifest:${meetId}`)) {
      return this.memory.get(`manifest:${meetId}`);
    }
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(`manifest:${meetId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        this.memory.set(`manifest:${meetId}`, parsed);
        return parsed;
      }
    }
    return null;
  }

  saveManifest(meetId: string, manifest: MeetManifest) {
    this.memory.set(`manifest:${meetId}`, manifest);
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(`manifest:${meetId}`, JSON.stringify(manifest));
      } catch (_) {}
    }
  }

  setServerState(key: string, data: any) {
    // Monotonic guard: do not let server packets clobber pending offline writes
    if (this.pendingSyncKeys.has(key)) return;
    this.memory.set(key, data);
  }

  setOptimisticLocal(key: string, data: any) {
    this.pendingSyncKeys.add(key);
    this.memory.set(key, data);
  }

  ackSync(key: string) {
    this.pendingSyncKeys.delete(key);
  }

  getLaneState(key: string) {
    return this.memory.get(key);
  }
}

export const meetCache = new MeetCacheManager();
