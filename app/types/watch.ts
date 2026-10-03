import type { MeetManifest } from "./meet";
import type { User } from "./user";

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
  patch: Omit<Watch, keyof WatchIdentity>;
};

export type WatchDeleteMutation = {
  entity: "watch";
  op: "delete";
  key: WatchIdentity;
};

export function canDeleteWatch(
  entryKey: WatchIdentity,
  user: User,
  meet: MeetManifest,
): boolean {
  // TBD - make this work
  // user needs to be admin of this meet, coach of the athlete, or swim/parent of athlete (only if meet/team allows self-entry)
  // can't delete an entry if any watches have been recorded for this event (ie the event has started)
  return true;
}

export function canUpsertWatch(
  entryKey: WatchIdentity,
  user: User,
  meet: MeetManifest,
): boolean {
  // TBD - make this work
  // user needs to be admin of this meet, coach of the athlete, or swim/parent of athlete (only if meet/team allows self-entry)
  // can't enter/modify an entry if any watches have been recorded for this event (ie the event has started)
  return true;
}
