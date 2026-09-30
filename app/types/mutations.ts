// app/types/mutations.ts

import type { Athlete, AthleteIdentity } from "./athlete";
import type { Entry, EntryIdentity } from "./entry";
import type { Swim, SwimIdentity } from "./swim";
import type { Watch, WatchIdentity } from "./watch";

export type EntityMutation =
  // 1. WATCH
  | {
      entity: "watch";
      op: "upsert";
      key: WatchIdentity;
      patch: Partial<Omit<Watch, keyof WatchIdentity>>;
    }
  | {
      entity: "watch";
      op: "delete";
      key: WatchIdentity;
    }

  // 2. SWIM
  | {
      entity: "swim";
      op: "upsert";
      key: SwimIdentity;
      patch: Partial<Omit<Swim, keyof SwimIdentity>>;
    }
  | {
      entity: "swim";
      op: "delete";
      key: SwimIdentity;
    }

  // 3. ATHLETE
  | {
      entity: "athlete";
      op: "upsert";
      key: AthleteIdentity;
      patch: Partial<Omit<Athlete, keyof AthleteIdentity>>;
    }
  | {
      entity: "athlete";
      op: "delete";
      key: AthleteIdentity;
    }

  // 4. ENTRY
  | {
      entity: "entry";
      op: "upsert";
      key: EntryIdentity;
      patch: Partial<Omit<Entry, keyof EntryIdentity>>;
    }
  | {
      entity: "entry";
      op: "delete";
      key: EntryIdentity;
    };
