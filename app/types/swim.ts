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
