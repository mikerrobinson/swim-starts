export type HeatKey = string;

export interface HeatIdentity {
  id: string;
}

export interface Heat extends HeatIdentity {
  primaryEventId: string;
  heatNumber: number;
  title?: string;
  status: "seeded" | "in_progress" | "completed";
}

export function toAthleteKey(heatIdentity: HeatIdentity): HeatKey {
  return heatIdentity.id;
}

export type HeatUpsertMutation = {
  entity: "heat";
  op: "upsert";
  key: HeatIdentity;
  patch: Omit<Heat, keyof HeatIdentity>;
};

export type HeatDeleteMutation = {
  entity: "heat";
  op: "delete";
  key: HeatIdentity;
};
