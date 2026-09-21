import { generateId } from "./id";
import { formatTime } from "./time";
import {
  fromStopwatch,
  swimTime,
  currentWatches,
  type SwimTime,
} from "./timing";
import {
  eventName,
  athleteName,
  type MeetDetail,
  type Swim,
} from "~/types/meet";
import { type Enrollment } from "~/types/team";
import type { Athlete, Gender } from "~/types/athlete";

/**
 * One row of a roster import: the person, plus what's true of them this
 * season. The two halves land in different tables, so they travel as a pair.
 */
export interface RosterEntry {
  athlete: Athlete;
  year: string;
  squad?: string;
}

/** RFC-4180-ish parser: handles quoted fields, embedded commas, and CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Strip a UTF-8 BOM, which Excel loves to add.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

/** Header aliases, so a coach's export doesn't need renaming first. */
const COLUMN_ALIASES: Record<string, string[]> = {
  firstName: ["firstname", "first", "fname", "givenname"],
  lastName: ["lastname", "last", "lname", "surname", "familyname"],
  fullName: ["name", "fullname", "swimmer", "swimmername", "athlete"],
  gender: ["gender", "sex", "m/f", "mf"],
  year: ["year", "schoolyear", "grade", "gradelevel", "class", "yr"],
  birthDate: ["birthdate", "birthday", "dob", "dateofbirth", "birth", "bday"],
  squad: ["squad", "team", "side", "color", "group"],
};

function parseGender(value: string): Gender | null {
  const v = value.trim().toLowerCase();
  if (["m", "male", "b", "boy", "boys", "men"].includes(v)) return "M";
  if (["f", "female", "g", "girl", "girls", "w", "women"].includes(v))
    return "F";
  return null;
}

/**
 * Read a birth date the way a coach's export actually writes it: ISO from a
 * database, or US m/d/y from a spreadsheet. Returns the ISO day, or the reason
 * it couldn't — a wrong birth date is worse than none, so anything ambiguous
 * or implausible is refused rather than guessed at. An empty cell is simply
 * absent, and reports an empty reason.
 */
export function parseBirthDate(
  value: string,
  today = new Date(),
): { date: string } | { error: string } {
  const text = value.trim();
  if (!text) return { error: "" };

  let year: number;
  let month: number;
  let day: number;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const slashed = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(text);

  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (slashed) {
    month = Number(slashed[1]);
    day = Number(slashed[2]);
    const rawYear = slashed[3];
    year = Number(rawYear);
    if (rawYear.length === 2) {
      // Two digits can't say which century. Nobody on a roster was born in
      // the future, so the recent past wins.
      const century = Math.floor(today.getFullYear() / 100) * 100;
      year = century + year;
      if (year > today.getFullYear()) year -= 100;
    }
  } else {
    return {
      error: `"${text}" isn't a date we recognise (try 2009-03-14 or 3/14/2009)`,
    };
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { error: `"${text}" isn't a real date` };
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${year}-${pad(month)}-${pad(day)}`;

  // Round-tripping catches the 31st of February and friends.
  const check = new Date(`${date}T00:00:00Z`);
  if (
    Number.isNaN(check.getTime()) ||
    check.toISOString().slice(0, 10) !== date
  ) {
    return { error: `"${text}" isn't a real date` };
  }
  if (year < 1900 || date > today.toISOString().slice(0, 10)) {
    return { error: `"${text}" is outside the range of a swimmer's birthday` };
  }

  return { date };
}

export interface RosterImport {
  entries: RosterEntry[];
  /** Human-readable problems, one per skipped or patched row. */
  warnings: string[];
}

/**
 * Turn a roster CSV into swimmers.
 *
 * Expects a header row. Name can arrive as separate first/last columns or as a
 * single "Name" column ("Last, First" or "First Last").
 */
export function parseRosterCsv(text: string): RosterImport {
  const rows = parseCsv(text);
  const warnings: string[] = [];

  if (rows.length === 0) {
    return { entries: [], warnings: ["The file was empty."] };
  }

  const header = rows[0].map(normalizeHeader);
  const column: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    const index = header.findIndex((h) => aliases.includes(h));
    if (index >= 0) column[key] = index;
  }

  const hasName =
    column.fullName !== undefined ||
    column.firstName !== undefined ||
    column.lastName !== undefined;

  if (!hasName) {
    return {
      entries: [],
      warnings: [
        `No name column found. Expected a "First Name"/"Last Name" pair or a "Name" column. Found: ${rows[0].join(", ")}`,
      ],
    };
  }

  const cell = (row: string[], key: string) =>
    column[key] === undefined ? "" : (row[column[key]] ?? "").trim();

  const entries: RosterEntry[] = [];

  rows.slice(1).forEach((row, i) => {
    const lineNumber = i + 2;

    let firstName = cell(row, "firstName");
    let lastName = cell(row, "lastName");

    if (!firstName && !lastName) {
      const full = cell(row, "fullName");
      if (full.includes(",")) {
        const [last, first] = full.split(",");
        lastName = last.trim();
        firstName = (first ?? "").trim();
      } else {
        const parts = full.split(/\s+/).filter(Boolean);
        firstName = parts.slice(0, -1).join(" ");
        lastName =
          parts.length > 1 ? parts[parts.length - 1] : (parts[0] ?? "");
      }
    }

    if (!firstName && !lastName) {
      warnings.push(`Line ${lineNumber}: no name, skipped.`);
      return;
    }

    const rawGender = cell(row, "gender");
    const gender = parseGender(rawGender);
    if (!gender) {
      warnings.push(
        `Line ${lineNumber} (${firstName} ${lastName}): gender "${rawGender}" not recognized, defaulted to F.`,
      );
    }

    const rawBirthDate = cell(row, "birthDate");
    const birthDate = parseBirthDate(rawBirthDate);
    if ("error" in birthDate && birthDate.error) {
      warnings.push(
        `Line ${lineNumber} (${firstName} ${lastName}): ${birthDate.error}, left blank.`,
      );
    }

    entries.push({
      athlete: {
        id: generateId(),
        firstName,
        lastName,
        gender: gender ?? "F",
        birthDate: "date" in birthDate ? birthDate.date : undefined,
      },
      year: cell(row, "year"),
      squad: cell(row, "squad") || undefined,
    });
  });

  return { entries, warnings };
}

function csvEscape(value: string | number): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Array<Array<string | number>>): string {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

/**
 * Results export: one row per recorded swim, ordered by event, then heat, then
 * finish place.
 */
export function resultsToCsv(
  detail: MeetDetail,
  /** Year and squad as of this meet, keyed by athlete. Empty is fine. */
  enrollments: Map<string, Enrollment> = new Map(),
): string {
  const byId = new Map(detail.athletes.map((a) => [a.id, a] as const));

  const rows: Array<Array<string | number>> = [
    [
      "Event #",
      "Event",
      "Heat",
      "Lane",
      "Athlete",
      "Gender",
      "Year",
      "Squad",
      "Time",
      "Time (ms)",
      "Status",
      "Exhibition",
      "Place",
      "Entry",
    ],
  ];

  // Every swim that has a time. A swim with nothing against it is somebody
  // whose time never arrived, which is a hole rather than a row to export.
  const swims = detail.swims
    .map((seed) => ({ seed, time: swimTime(detail, seed.id) }))
    .filter((row): row is { seed: Swim; time: SwimTime } => row.time !== null);

  detail.events.forEach((event, eventIndex) => {
    const forEvent = swims.filter(({ seed }) => seed.eventId === event.id);

    // Place is scored across the whole event, not within a heat, and an
    // exhibition swim never has one.
    const place = new Map(
      forEvent
        .filter(({ seed, time }) => time.status === "OK" && !seed.exhibition)
        .sort((a, b) => a.time.timeMs - b.time.timeMs)
        .map((row, i) => [row.seed.id, i + 1] as const),
    );

    // Listed as swum: heat by heat, fastest first within each.
    const ordered = [...forEvent].sort(
      (a, b) => a.seed.heat - b.seed.heat || a.time.timeMs - b.time.timeMs,
    );

    for (const { seed, time } of ordered) {
      const athlete = byId.get(seed.athleteId);
      const enrolled = enrollments.get(seed.athleteId);
      rows.push([
        eventIndex + 1,
        eventName(event),
        seed.heat,
        seed.lane,
        athlete ? athleteName(athlete) : "(unknown)",
        athlete?.gender ?? "",
        enrolled?.year ?? "",
        enrolled?.squad ?? "",
        time.status === "OK" ? formatTime(time.timeMs) : time.status,
        time.status === "OK" ? time.timeMs : "",
        time.status,
        seed.exhibition ? "Yes" : "",
        place.get(seed.id) ?? "",
        // Whether a stopwatch in this app ran the race, or the number was
        // typed in from a handheld or the board.
        currentWatches(detail, seed.id).some(fromStopwatch)
          ? "stopwatch"
          : "manual",
      ]);
    }
  });

  return toCsv(rows);
}

export function downloadFile(
  filename: string,
  contents: string,
  mimeType: string,
): void {
  const blob = new Blob([contents], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
