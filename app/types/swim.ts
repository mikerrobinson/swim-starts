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
  patch: Partial<Omit<Swim, keyof SwimIdentity>>;
};

export type SwimDeleteMutation = {
  entity: "swim";
  op: "delete";
  key: SwimIdentity;
};
