import type { Entry } from "./entry";

export type HeatKey = string;

export interface HeatIdentity {
  id: string;
}

export interface Heat extends HeatIdentity {
  eventId: string;
  eventHeatNumber: number;
  lanes: Record<number, Entry>;
  displayName?: string;
  status: "not-started" | "in-progress" | "complete";
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
