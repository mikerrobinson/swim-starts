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
