import type { Watch, WatchIdentity, WatchKey } from "./watch";

export type ResultStatus = "OK" | "DQ" | "NS";

export type SwimKey = `e${string}:h${number}:l${number}`;

export interface SwimIdentity {
  eventId: string;
  heat: number;
  lane: number;
}

export interface Swim extends SwimIdentity {
  athleteId?: string; // Optional for open lanes
  athleteName?: string;
  athleteTeam?: string;
  exhibition: boolean;

  watches: Record<WatchKey, Watch>;
  status?: ResultStatus;
  officialTimeMs?: number;
  decidedAt?: number;
  decidedBy?: string;
}

export function toSwimKey(swim: SwimIdentity): SwimKey {
  return `e${swim.eventId}:h${swim.heat}:l${swim.lane}`;
}

export type SwimUpsertMutation = {
  entity: "swim";
  op: "upsert";
  key: SwimIdentity;
  patch: Omit<Swim, keyof SwimIdentity>;
};

export type SwimDeleteMutation = {
  entity: "swim";
  op: "delete";
  key: SwimIdentity;
};
