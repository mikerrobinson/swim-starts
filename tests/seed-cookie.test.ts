import { done, eq } from "./harness.ts";
import {
  decodeSeedRecord,
  emptySeedRecord,
  encodeSeedRecord,
  parseSeedCookieName,
  seedCookieName,
  type SeedRecord,
} from "../app/lib/seed-cookie.ts";

/* ------------------------------------------------------- the addressing */

eq(seedCookieName({ event: 7, heat: 1, lane: 3 }), "seed-7-1-3", "dash-joined, in the name");
eq(parseSeedCookieName("seed-7-1-3"), { event: 7, heat: 1, lane: 3 }, "and reads back");
eq(parseSeedCookieName("seed-0-1-3"), null, "these are 1-based, as the screen says them");
eq(parseSeedCookieName("seed-x-1-3"), null, "and they are numbers");
eq(parseSeedCookieName("mr_timer"), null, "an unrelated cookie name isn't one of ours");

/* -------------------------------------------------------------- round trip */
//
// No `withX` mutators here on purpose — the timer screen owns a whole
// `SeedRecord` per lane as plain form state and encodes it fresh on every
// change, so the only thing this module still needs to get right is the wire
// format: whatever a record says going in is what it says coming back out.

eq(decodeSeedRecord(encodeSeedRecord(emptySeedRecord(1))), emptySeedRecord(1), "an empty record round-trips");

{
  const seated: SeedRecord = { ...emptySeedRecord(2), athleteId: "a-1" };
  eq(decodeSeedRecord(encodeSeedRecord(seated)), seated, "a plain seat round-trips");
}

{
  // The delimiter safety a comma-containing name needs — this app writes
  // names "Castellanos, Sofia", and `|` is the field separator here.
  const walkup: SeedRecord = {
    ...emptySeedRecord(2),
    athleteId: "a-2",
    team: "CHAP",
    name: "Castellanos, Sofia | Extra",
    gender: "F",
  };
  const decoded = decodeSeedRecord(encodeSeedRecord(walkup));
  eq(decoded?.name, "Castellanos, Sofia | Extra", "a name with the field separator in it survives");
  eq(decoded?.team, "CHAP", "and the team code beside it");
  eq(decoded?.gender, "F", "and the chosen gender");
}

{
  const withWatches: SeedRecord = {
    ...emptySeedRecord(3),
    watches: [
      { startedAt: 100, stoppedAt: 200, timeMs: null },
      { startedAt: null, stoppedAt: null, timeMs: 30110 },
    ],
  };
  eq(decodeSeedRecord(encodeSeedRecord(withWatches)), withWatches, "watch slots round-trip, including a blank one");
}

/* -------------------------------------------------------- forgiving parse */

eq(decodeSeedRecord("not-a-number|a-1"), null, "no updatedAt at all is not a record");
eq(
  decodeSeedRecord("5"),
  { updatedAt: 5, athleteId: "", team: null, name: "", gender: null, exhibition: false, watches: [] },
  "missing trailing fields degrade to empty rather than refusing the cookie",
);
eq(
  decodeSeedRecord("5|a-1||||1|1,2,3;abc,,5")?.watches,
  [{ startedAt: 1, stoppedAt: 2, timeMs: 3 }, { startedAt: null, stoppedAt: null, timeMs: 5 }],
  "an unreadable field in one slot empties just that field, not the slot beside it",
);

/* ------------------------------------------------------------------ size */

// One lane's whole record — seat, exhibition, three watches — still fits
// comfortably inside a cookie.
{
  const full: SeedRecord = {
    ...emptySeedRecord(4),
    athleteId: "a-1",
    exhibition: true,
    watches: [
      { startedAt: 100, stoppedAt: 200, timeMs: 30000 },
      { startedAt: null, stoppedAt: null, timeMs: 30110 },
      { startedAt: null, stoppedAt: null, timeMs: 29990 },
    ],
  };
  const size = encodeURIComponent(encodeSeedRecord(full)).length;
  eq(size < 200, true, `one lane's record stays small (${size} bytes)`);
}

done();
