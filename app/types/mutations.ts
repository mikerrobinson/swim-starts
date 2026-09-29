// app/types/mutations.ts

import type { Athlete } from "./athlete";
import type { Swim } from "./swim";
import type { Watch } from "./watch";

export type EntityMutation =
  // 1. WATCH
  | {
      entity: "watch";
      op: "upsert";
      key: {
        eventId: string;
        heat: number;
        lane: number;
        userId: string;
        slot: number;
      };
      patch: Partial<
        Omit<Watch, "eventId" | "heat" | "lane" | "userId" | "slot">
      >;
    }
  | {
      entity: "watch";
      op: "delete";
      key: {
        eventId: string;
        heat: number;
        lane: number;
        userId: string;
        slot: number;
      };
    }

  // 2. SWIM
  | {
      entity: "swim";
      op: "upsert";
      key: { eventId: string; heat: number; lane: number };
      patch: Partial<Omit<Swim, "eventId" | "heat" | "lane">>;
    }
  | {
      entity: "swim";
      op: "delete";
      key: { eventId: string; heat: number; lane: number };
    }

  // 3. ATHLETE
  | {
      entity: "athlete";
      op: "upsert";
      key: { id: string };
      patch: Partial<Omit<Athlete, "id">>;
    }
  | {
      entity: "athlete";
      op: "delete";
      key: { id: string };
    };
