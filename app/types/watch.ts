export type WatchRole = "timer" | "coach" | "admin";

export type WatchKey = `e${string}:h${number}:l${number}:d${string}:s${number}`;

export interface WatchIdentity {
  eventId: string;
  heat: number;
  lane: number;
  deviceId: string;
  slot: number; // 0 for direct timing, 1/2/3 for multi-watch clipboard transcription
}

export interface Watch extends WatchIdentity {
  role: WatchRole;
  userId?: string;
  startedAt: number;
  stoppedAt: number;
  timeMs: number;
  recordedAt: number;
}

export function toWatchKey(watch: WatchIdentity): WatchKey {
  return `e${watch.eventId}:h${watch.heat}:l${watch.lane}:d${watch.deviceId}:s${watch.slot}`;
}

export type WatchUpsertMutation = {
  entity: "watch";
  op: "upsert";
  key: WatchIdentity;
  patch: Partial<Omit<Watch, keyof WatchIdentity>>;
};

export type WatchDeleteMutation = {
  entity: "watch";
  op: "delete";
  key: WatchIdentity;
};
