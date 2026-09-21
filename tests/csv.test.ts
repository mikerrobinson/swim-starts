import { done, eq } from "./harness.ts";
import { parseBirthDate, parseRosterCsv } from "../app/lib/csv.ts";
import { ageOn } from "~/types/athlete.ts";

/* ------------------------------------------------ birthdate */

const TODAY = new Date("2026-09-05T00:00:00Z");
const date = (v: string) => parseBirthDate(v, TODAY);

eq(date("2009-03-14"), { date: "2009-03-14" }, "ISO");
eq(date("3/14/2009"), { date: "2009-03-14" }, "US slashed");
eq(date("03/04/2009"), { date: "2009-03-04" }, "zero padded is month-first");
eq(date("2009-3-4"), { date: "2009-03-04" }, "unpadded ISO");
eq(date("3-14-2009"), { date: "2009-03-14" }, "dashes");
eq(date("3.14.2009"), { date: "2009-03-14" }, "dots");
eq(date("3/14/09"), { date: "2009-03-14" }, "two-digit year in this century");
eq(
  date("3/14/98"),
  { date: "1998-03-14" },
  "two-digit year that would be in the future rolls back",
);
eq(date(""), { error: "" }, "an empty cell is simply absent");
eq(date("   "), { error: "" }, "whitespace too");

const bad = (v: string) =>
  "error" in date(v) && (date(v) as { error: string }).error !== "";
eq(bad("2009-02-31"), true, "the 31st of February is refused");
eq(
  bad("14/3/2009"),
  true,
  "a day in the month slot is refused, not silently swapped",
);
eq(bad("sophomore"), true, "prose is refused");
eq(bad("2035-01-01"), true, "the future is refused");
eq(bad("1850-01-01"), true, "1850 is refused");

// Age on a date, including the birthday edge.
eq(
  ageOn({ birthDate: "2009-03-14" }, "2026-03-13"),
  16,
  "day before the birthday",
);
eq(ageOn({ birthDate: "2009-03-14" }, "2026-03-14"), 17, "on the birthday");
eq(ageOn({ birthDate: "2009-03-14" }, "2026-03-15"), 17, "day after");
eq(ageOn({ birthDate: "2009-12-31" }, "2026-01-01"), 16, "across the new year");
eq(ageOn({}, "2026-09-05"), null, "no birth date, no age");
eq(ageOn({ birthDate: "not a date" }, "2026-09-05"), null, "junk, no age");

// Import: the column and its aliases, and a bad cell warns without losing the row.
const csv = [
  "First Name,Last Name,Gender,Year,DOB,Squad",
  "Avery,Nguyen,F,10,3/14/2009,Blue",
  "Marcus,Hill,M,12,2007-11-02,Gold",
  "Sam,Reyes,M,9,sophomore,",
  "Jo,Park,F,11,,",
].join("\n");
const { entries, warnings } = parseRosterCsv(csv);
eq(
  entries.map((e) => e.athlete.birthDate),
  ["2009-03-14", "2007-11-02", undefined, undefined],
  "birth dates imported, junk left blank",
);
eq(entries.length, 4, "a bad birthday never costs the swimmer");
eq(
  entries.map((e) => e.year),
  ["10", "12", "9", "11"],
  "grade lands on the enrollment side of the import",
);
eq(entries[0].squad, "Blue", "so does squad");
eq(warnings.length, 1, "one warning, for the one bad cell");
eq(warnings[0].includes("Sam Reyes"), true, "the warning names them");

done();
