import type { MeetManifest } from "./meet";
import type { User } from "./user";

export type EntryKey = `${string}:${string}`; // `${eventId}:${athleteId}`

export interface EntryIdentity {
  eventId: string;
  athleteId: string;
}

export interface Entry extends EntryIdentity {
  teamId: string;
  seedTimeMs?: number; // null = NT
  exhibition: boolean;
  enteredAt: number;
  enteredBy: string;
}

export function toEntryKey(entry: EntryIdentity): EntryKey {
  return `${entry.eventId}:${entry.athleteId}`;
}

export type EntryUpsertMutation = {
  entity: "entry";
  op: "upsert";
  key: EntryIdentity;
  patch: Partial<Omit<Entry, keyof EntryIdentity>>;
};

export type EntryDeleteMutation = {
  entity: "entry";
  op: "delete";
  key: EntryIdentity;
};

export function canDeleteEntry(
  entryKey: EntryIdentity,
  user: User,
  meet: MeetManifest,
): boolean {
  // TBD - make this work
  // user needs to be admin of this meet, coach of the athlete, or swim/parent of athlete (only if meet/team allows self-entry)
  // can't delete an entry if any watches have been recorded for this event (ie the event has started)
  return true;
}

export function canUpsertEntry(
  entryKey: EntryIdentity,
  user: User,
  meet: MeetManifest,
): boolean {
  // TBD - make this work
  // user needs to be admin of this meet, coach of the athlete, or swim/parent of athlete (only if meet/team allows self-entry)
  // can't enter/modify an entry if any watches have been recorded for this event (ie the event has started)
  return true;
}
