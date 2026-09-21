import { done, eq } from "./harness.ts";
import {
  dayBefore,
  enrollmentIndex,
  findSeason,
  isGraduating,
  makeEnrollment,
  makeSeason,
  nextSeasonName,
  nextYear,
  seasonForDate,
} from "../app/lib/roster.ts";
import type { Season } from "~/types/team.ts";

/**
 * What's left here is the pure part. Which people are on a roster is a query
 * now — see `roster()` in `teams.server.ts` — so the assertions that used to
 * walk a `TeamDoc` looking for its enrollments have gone with the document.
 */

/* ------------------------------------------------------------------ seasons */

const s26 = makeSeason("t1", "2026-27", "2026-08-01", "2027-07-31");
const s27 = makeSeason("t1", "2027-28", "2027-08-01", "2028-07-31");
const both = [s26, s27];

eq(
  seasonForDate(both, s27.id, "2026-11-14")?.name,
  "2026-27",
  "November 2026 is last season",
);
eq(
  seasonForDate(both, s27.id, "2027-11-14")?.name,
  "2027-28",
  "November 2027 is this one",
);
eq(
  seasonForDate(both, s27.id, "2030-01-01")?.name,
  "2027-28",
  "a date outside every season falls back to the current one",
);

// A season with neither date covers everything, which is exactly what a roster
// carried over from before seasons existed means.
const open: Season[] = [{ id: "s0", teamId: "t1", name: "All time" }];
eq(
  seasonForDate(open, "s0", "1999-01-01")?.id,
  "s0",
  "an undated season covers any date",
);
eq(
  seasonForDate([], undefined, "2027-01-01"),
  undefined,
  "no seasons, no answer",
);
eq(findSeason(both, s26.id)?.name, "2026-27", "a season can be found by id");
eq(
  findSeason(both, "nope"),
  undefined,
  "and isn't invented when it isn't there",
);

/* ------------------------------------------------------------------ rolling */

eq(dayBefore("2027-08-01"), "2027-07-31", "the day before a month boundary");
eq(dayBefore("2027-01-01"), "2026-12-31", "and a year boundary");
eq(dayBefore("2028-03-01"), "2028-02-29", "leap year");

eq(nextSeasonName("2026-27"), "2027-28", "next season's name");
eq(nextSeasonName("2026-2027"), "2027-2028", "long form too");
eq(nextSeasonName("2026"), "2027", "a bare year just increments");
eq(nextSeasonName("Summer"), "", "and no guess when it isn't a school year");

/* ------------------------------------------------------------------- grades */

eq(nextYear("10"), "11", "grades advance");
eq(nextYear("Fr"), "Fr", "shorthand is left alone rather than guessed at");
eq(nextYear(""), "", "so is nothing");
eq(isGraduating("12"), true, "seniors are graduating");
eq(isGraduating("11"), false, "juniors aren't");
eq(isGraduating("Sr"), false, "shorthand never counts as graduating");

/* -------------------------------------------------------------- enrollments */

// Derived rather than generated: enrolling the same person twice — a
// re-import, a timer adding a visitor who was already there — updates one row
// instead of making a second. This is what the unique index enforces.
const first = makeEnrollment("t1", s26.id, "a1", { year: "10", squad: "Blue" });
const again = makeEnrollment("t1", s26.id, "a1", { year: "11" });
eq(first.id, again.id, "the same person in the same season is the same row");
eq(first.status, "active", "and active unless said otherwise");

const index = enrollmentIndex([first, makeEnrollment("t1", s26.id, "a2")]);
eq(
  index.get("a1")?.squad,
  "Blue",
  "the index finds somebody's facts by athlete",
);
eq(index.get("a9"), undefined, "and has nothing to say about strangers");

done();
