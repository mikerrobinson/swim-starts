import type { AthleteDeleteMutation, AthleteUpsertMutation } from "./athlete";
import type { EntryDeleteMutation, EntryUpsertMutation } from "./entry";
import type { SwimDeleteMutation, SwimUpsertMutation } from "./swim";
import type { WatchDeleteMutation, WatchUpsertMutation } from "./watch";

export type EntityMutation =
  | WatchUpsertMutation
  | WatchDeleteMutation
  | EntryUpsertMutation
  | EntryDeleteMutation
  | AthleteUpsertMutation
  | AthleteDeleteMutation
  | SwimUpsertMutation
  | SwimDeleteMutation;
