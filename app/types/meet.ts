/**
 * The data model, as plain objects.
 *
 * Three things, and only one of them owns anything. **Athletes** are people,
 * global and durable — a swimmer is one record whether they swim for a school,
 * a club, or both. A **team** owns its seasons and says, through enrollments,
 * who swam for it and when. A **meet** is one day's racing between one or more
 * teams, and belongs to none of them.
 *
 * That last point is the load-bearing one. A meet referencing teams rather than
 * being owned by one is what lets a dual meet be a single shared thing instead
 * of two half-copies, and what keeps a visiting swimmer from being retyped into
 * the home team's roster.
 *
 * Everything here is a POCO: one interface per table row, no version numbers,
 * no `updatedAt` for merging, no `deletedAt` tombstones. The server is the
 * source of truth, rows are written by the people who own them, and a delete
 * is a DELETE.
 */

import type { Athlete, Gender } from "./athlete";
<<<<<<< Updated upstream
import type { NameOrder } from "./preferences";
import type { Enrollment, Team } from "./team";
=======
>>>>>>> Stashed changes

/** Events can be restricted to one gender, or open to everyone. */
export type EventGender = Gender | "Open";

export type Stroke =
  | "Free"
  | "Back"
  | "Breast"
  | "Fly"
  | "IM"
  | "Free Relay"
  | "Medley Relay"
  | "Diving";

/**
 * Strokes offered when adding an event by hand. Diving is deliberately absent:
 * it's added and removed by the meet's "include diving" option, not picked with
 * a distance like a swim.
 */
export const STROKES: Stroke[] = [
  "Free",
  "Back",
  "Breast",
  "Fly",
  "IM",
  "Free Relay",
  "Medley Relay",
];

/**
 * Diving sits in the event list purely so divers can see it on the
 * registration grid alongside their swims — plenty of divers swim too. It
 * isn't timed, scored, or run here; the app is not a diving tool.
 */
export function isDiving(event: Pick<Event, "stroke">): boolean {
  return event.stroke === "Diving";
}

/** Placeholder distance for diving, which has none. Never displayed. */
export const DIVING_DISTANCE = 1;

/**
 * Relays are timed exactly like any other event: one lane, one clock, one
 * time. The app doesn't model the four legs — a relay lane is held by a single
 * athlete standing in for the squad, usually whoever leads off.
 */
export function isRelay(event: Pick<Event, "stroke">): boolean {
  return event.stroke.endsWith("Relay");
}

/** Squeezed for the registration grid, where a column is about 3.5rem wide. */
export function shortStroke(stroke: Stroke): string {
  if (stroke === "Free Relay") return "Free R";
  if (stroke === "Medley Relay") return "Mdly R";
  return stroke;
}

export type LaneCount = 4 | 5 | 6 | 8 | 10;

/**
 * Offered widths, likeliest first: six lanes is the high-school norm, and a
 * five- or four-lane pool is a real thing at a small school.
 */
export const LANE_COUNTS: LaneCount[] = [6, 8, 10, 5, 4];

export function isLaneCount(value: unknown): value is LaneCount {
  return LANE_COUNTS.includes(value as LaneCount);
}

/**
 * How many stopwatches a lane is timed by.
 *
 * A deck fact rather than a preference: a lane has one, two or three people
 * standing behind it with watches, and everything about how times reach the
 * app follows from which. One is a phone per timer, self-reporting. Two or
 * three is the arrangement this was built for — the timers hold handheld
 * watches and read them out to whoever is holding the clipboard, who is the
 * only one with a phone.
 *
 * Three is the ceiling because three is what the hand-timing rules are for:
 * the third watch is the one that outvotes a slow thumb, and a fourth adds
 * nothing the median didn't already have.
 */
export type TimersPerLane = 1 | 2 | 3;

export const TIMERS_PER_LANE: TimersPerLane[] = [1, 2, 3];

export function isTimersPerLane(value: unknown): value is TimersPerLane {
  return TIMERS_PER_LANE.includes(value as TimersPerLane);
}

<<<<<<< Updated upstream
/**
 * How the lane buttons are arranged while running a heat. The two list
 * layouts put the lanes in a single column in pool order, so whoever is
 * watching from the side maps a finish straight onto a button without having
 * to work out which column it's in.
 *
 * A device preference rather than a meet option — it depends on where the
 * person holding the phone is standing, not on the meet — so it lives in
 * `storage.ts` and is never written to the server.
 */
export type LaneLayout = "grid" | "list-asc" | "list-desc";

export const LANE_LAYOUTS: LaneLayout[] = ["grid", "list-asc", "list-desc"];

/** Lane numbers in the order they should be drawn for a layout. */
export function orderedLanes(laneCount: number, layout: LaneLayout): number[] {
  const lanes = Array.from({ length: laneCount }, (_, i) => i + 1);
  return layout === "list-desc" ? lanes.reverse() : lanes;
=======
/* ------------------------------------------------------------ people, teams */

/**
 * A team: a name, a code, and the seasons it runs.
 *
 * Deliberately does *not* hold its athletes. The roster is the set of
 * enrollments pointing at global athlete records, so two teams racing the same
 * swimmer point at one person rather than keeping a copy each.
 *
 * A team can exist without anyone owning it. Setting up a meet against a school
 * that has never used the app mints an unclaimed team; a coach from that school
 * claims it later, and the meets it already appears in are unaffected.
 */
export interface Team {
  id: string;
  name: string;
  /** Short code as it appears on a heat sheet or an SD3 file — "CHAP". */
  code: string;
  /** Which season the app works in when nothing says otherwise. */
  currentSeasonId?: string;
  /** Who set it up. Absent for the teams typed in as opponents before this
   *  was recorded, and for the ones that predate accounts entirely. */
  createdBy?: string;
}

/**
 * A team's competitive year. Scoped to the team on purpose: a high-school
 * season and a club season don't line up, so there's no useful global one.
 *
 * Both dates are optional — a season with neither runs from the beginning of
 * time to the end of it.
 */
export interface Season {
  id: string;
  teamId: string;
  /** Free text as the coach writes it — "2026-27", "Summer 2027". */
  name: string;
  /** ISO date (yyyy-mm-dd), inclusive. */
  startDate?: string;
  /** ISO date (yyyy-mm-dd), inclusive. */
  endDate?: string;
}

/**
 * On the roster, but only for a while.
 *
 * Everything seasonal about an athlete lives here rather than on the athlete,
 * so last year's sophomore is this year's junior without anyone editing
 * anything, and an athlete who moves between a club and a school team is one
 * person with two enrollments.
 */
export interface Enrollment {
  id: string;
  teamId: string;
  seasonId: string;
  athleteId: string;
  /** School year as entered — "9", "Fr", "Senior", whatever the CSV had. */
  year: string;
  /** Optional squad/side for an inter-squad meet (e.g. "Blue" / "Gold"). */
  squad?: string;
  /**
   * "inactive" is someone who left mid-season: off the roster for new races,
   * but they were on it, and any times they swam still stand. Someone who
   * simply isn't on the team this year has no enrollment at all.
   */
  status: EnrollmentStatus;
}

export type EnrollmentStatus = "active" | "inactive";

/**
 * How names are ordered and written. "last" gives "Aaronson, Avery" sorted by
 * surname; "first" gives "Avery Aaronson" sorted by given name. A preference
 * of whoever is looking, so it lives on the device.
 */
export type NameOrder = "first" | "last";

/** Team codes are short and upper-case wherever they're exchanged. */
export function normalizeTeamCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

/**
 * Age on a given date — what age-group entries are seeded by, and what an
 * export has to state. Returns null when the birth date is missing or
 * unparseable rather than guessing at one.
 */
export function ageOn(
  athlete: Pick<Athlete, "birthDate">,
  isoDate: string,
): number | null {
  const born = parseIsoDate(athlete.birthDate);
  const on = parseIsoDate(isoDate);
  if (!born || !on) return null;

  let age = on.year - born.year;
  // Not yet had this year's birthday.
  if (on.month < born.month || (on.month === born.month && on.day < born.day)) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}

function parseIsoDate(
  value: string | undefined,
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const [, year, month, day] = match;
  return { year: Number(year), month: Number(month), day: Number(day) };
}

/** Today, as the plain ISO day the rest of the model speaks in. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
>>>>>>> Stashed changes
}

/* -------------------------------------------------------------------- meet */

export type MeetType =
  | "intersquad"
  | "dual"
  | "tri"
  | "invitational"
  | "time-trial";

export interface LaneRef {
  meetId: string;
  event: number;
  heat: number;
  lane: number;
}

export const MEET_TYPES: Array<{ value: MeetType; label: string }> = [
  { value: "intersquad", label: "Inter-squad" },
  { value: "dual", label: "Dual" },
  { value: "tri", label: "Tri" },
  { value: "invitational", label: "Invitational" },
  { value: "time-trial", label: "Time trial" },
];

export function meetTypeLabel(type: MeetType): string {
  return MEET_TYPES.find((t) => t.value === type)?.label ?? "Meet";
}

/**
 * The pool a meet is swum in. Short course yards is the US high-school
 * default; the metric courses cover summer league and club water. Recorded
 * with the meet because a time only means something next to its course.
 */
export type MeetCourse = "SCY" | "LCM" | "SCM";

export const MEET_COURSES: Array<{
  value: MeetCourse;
  label: string;
  detail: string;
}> = [
  { value: "SCY", label: "SCY", detail: "25 yard" },
  { value: "LCM", label: "LCM", detail: "50 meter" },
  { value: "SCM", label: "SCM", detail: "25 meter" },
];

export function isMeetCourse(value: unknown): value is MeetCourse {
  return MEET_COURSES.some((c) => c.value === value);
}

/** Long form for the dropdown, e.g. "SCY — 25 yard". */
export function courseLabel(course: MeetCourse): string {
  const match = MEET_COURSES.find((c) => c.value === course);
  return match ? `${match.label} — ${match.detail}` : course;
}

/**
 * How many races one swimmer may be in.
 *
 * NFHS caps a high-school swimmer at four events, at most two of them
 * individual, and states vary — so these are numbers on the meet rather than
 * constants. Absent means no limit, which is what an inter-squad time trial
 * wants.
 */
export interface EntryLimits {
  maxIndividual?: number;
  maxRelays?: number;
  maxTotal?: number;
  /** How many entries one team may put in a single race. */
  maxPerTeamPerEvent?: number;
}

/**
 * Who may see a meet's entries before it's swum.
 *
 * A lineup is competitive information: at a dual meet, knowing who the other
 * school is putting in the 200 Free is worth something. Results are unaffected
 * either way — those are public once they exist.
 */
export type EntryVisibility = "everyone" | "own-team";

/**
 * Which lanes a team swims, by team id.
 *
 * A team missing from the map hasn't been assigned lanes yet. Nothing here
 * enforces that two teams' lanes don't overlap — this is what the coach typed,
 * not a validated seat chart.
 */
export type LaneAssignments = Record<string, number[]>;

/**
 * "1, 3, 5" -> [1, 3, 5]. Blank and non-numeric entries are dropped, order
 * kept — what a lane list or a points list is typed as and stored as.
 */
export function parseNumberList(text: string): number[] {
  return text
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

/** The reverse of `parseNumberList`, for filling a text box back in. */
export function formatNumberList(values: number[]): string {
  return values.join(", ");
}

export type SwimKey = `${string}:h${number}:l${number}`;

export type EventId = string;

export function makeSwimKey(
  eventId: string,
  heat: number,
  lane: number,
): SwimKey {
  return `${eventId}:h${heat}:l${lane}`;
}

export function parseSwimKey(key: SwimKey): {
  eventId: string;
  heat: number;
  lane: number;
} {
  const [eventId, h, l] = key.split(":");
  return {
    eventId,
    heat: Number(h.replace("h", "")),
    lane: Number(l.replace("l", "")),
  };
}

export interface Meet {
  id: string;
  name: string;
  date: string;
  type: MeetType;
  course: MeetCourse;
  location?: string;
  teamIds: string[];
  hostTeamId?: string;
  createdBy?: string;
  laneCount: LaneCount;
  timersPerLane: TimersPerLane;
  leadGender: Gender;
  includeDiving: boolean;
  limits: EntryLimits;
  entryVisibility: EntryVisibility;
  athletesMayEnter: boolean;
  laneAssignments: LaneAssignments;
  scoring: ScoringRules;
}

<<<<<<< Updated upstream
=======
/** One race in a meet's programme. `position` is the order it's swum in. */
>>>>>>> Stashed changes
export interface Event {
  id: string;
  position: number;
  distance: number;
  stroke: Stroke;
  gender: EventGender;
  name?: string; // optional - if not set, app concatenates gender, distance, and stroke
}

/**
 * One swimmer entered in one race, before there's a lane to put them in.
 *
 * Deliberately thin, and deliberately one-directional: a `Swim` is created
 * *from* entries when an event is seeded, but nothing about a swim ever
 * writes back here. Seating someone — from the registration grid, the admin
 * heat sheet, or a timer's own walk-up — makes a swim only. The two lists
 * are allowed to disagree: an un-entered swim is what a walk-up is until
 * somebody backfills the entry, if anyone ever does.
 */
export interface Entry {
  meetId: string;
  eventId: string;
  athleteId: string;
  /**
   * What the coach expects this swim to go, if they said. The plan is to
   * seed entrants fastest-first by this; today's seeding still orders by
   * entry order alone, so nothing reads it yet.
   */
  seedTimeMs?: number;
  /**
   * Decided at entry time and copied onto the `Swim` the next seeding
   * creates for this entry. The swim's own `exhibition` can still change
   * independently afterwards — known, or changed, by whoever's at the lane.
   */
  exhibition?: boolean;
  enteredAt: number;
  enteredBy?: string;
}

export type ResultStatus = "OK" | "DQ" | "NS";

/**
 * One planned swim: somebody, in a lane, in a heat of an event.
 *
 * The unit everything about running a meet hangs off. Seeding an event makes
 * one of these per entered swimmer; a timer naming the person behind the
 * blocks makes one too, because a lane nobody expected is still a swim.
 * Watches point at it, and once an administrator signs it off, the decision
 * lives right here too — there is no separate table for that. No `final`
 * flag: `status` being absent *is* "not decided yet," and taking a decision
 * back is clearing these same fields, not deleting a row elsewhere.
 *
 * There is no `heats` table. A heat is which heat — a small integer, 1-based,
 * and usually 1 — so "the heats of this event" is the distinct heats across
 * its swims, and a heat cannot exist with nothing in it. A row with an id of
 * its own is what lets a time survive somebody being moved between lanes.
 */
export interface Swim {
  id: string;
  eventId: string;
  /** Which heat of the event, 1-based. Usually 1. */
  heat: number;
  /** Which lane, 1-based. */
  lane: number;
  /**
   * Who is in it — or `""`, meaning nobody has said yet.
   *
   * An empty lane and an unnamed one are different things: the first has no
   * row at all, the second has a swim somebody timed before the name was
   * settled. Only a time arriving for a lane nobody has named creates one,
   * and it stops being empty the moment anybody says who was there.
   */
  athleteId: string;
  /**
   * Name and team, copied in at seat time rather than joined on read. The
   * timer workspace doesn't carry a full roster with it — a lane's own row
   * has to be enough, on its own, to render who's swimming.
   */
  athleteName: string;
  athleteTeam: string;
  /**
   * Swum outside the competition: the time is real and stands for the
   * swimmer, but the swim takes no place and scores no points.
   *
   * A flag on the swim rather than a third value on `status`, because it
   * answers a different question — a DQ says the watches don't count, this
   * says the *place* doesn't. Known (or changed) before there's anything to
   * sign off, by whoever is standing at the lane, not only the desk.
   */
  exhibition?: boolean;
  /** Absent until an administrator signs this swim off. */
  status?: ResultStatus;
  /** Zero for a no-show or a disqualification with nothing on the clock. */
  officialTimeMs?: number;
  decidedAt?: number;
  decidedBy?: string;
}

<<<<<<< Updated upstream
export type ResultStatus = "OK" | "DQ" | "NS";
=======
/**
 * One reading of one stopwatch, on one swim.
 *
 * A lane is timed by whoever is standing at it — often two or three people,
 * plus a coach — so a race produces several readings for the same swim and
 * the official one is worked out from them. Append-only: a correction is a
 * new row, never an edit to an old one, so "evidence, never overwritten" is
 * literal rather than just a rule about upserts. `currentWatches`
 * (`timing.ts`) collapses history down to the latest row per submitter/slot;
 * everything older stays in the table as its own record.
 */
>>>>>>> Stashed changes
export type WatchRole = "timer" | "coach" | "admin";

export interface Watch {
  id: string;
<<<<<<< Updated upstream
  seedId: string;
  timerId: string;
=======
  /** The swim it measures. */
  swimId: string;
  /**
   * Whoever took it, and the identity a slot's history is grouped under.
   *
   * A device id for a volunteer behind a lane, who has no account and is
   * identified only by the phone they scanned with. A *user* id for anybody
   * signed in — a coach on the multi-lane stopwatch, an administrator typing
   * a time at the desk.
   */
  submittedBy: string;
  /**
   * The account behind it, when there was one. Absent for a QR-code timer.
   * The server sets it from the session rather than believing the client.
   */
>>>>>>> Stashed changes
  userId?: string;
  role: WatchRole;
<<<<<<< Updated upstream
  timeMs?: number;
  recordedAt: number;
  startedAt?: number;
  stoppedAt?: number;
}

export interface Swim {
  id: string;
  eventId: EventId;
  heat: number; // 1-based (Heat 1, 2, 3)
  lane: number; // 1-based (Lane 1, 2, 3, 4, 5, 6)
  athleteId?: string; // Optional for open lanes
  athleteName?: string;
  athleteTeam?: string;
  exhibition: boolean;
  status: "pending" | "official" | "dq" | "dns";
  officialTimeMs?: number;
  decidedAt?: number;
  decidedBy?: string;
  watches?: Watch[]; // Hydrated watches for easy UI display
}

/**
 * The official outcome of one swim, and the only thing here an administrator
 * writes.
 *
 * It exists because somebody signed the lane off. That is the whole of its
 * meaning: no `final` flag, because a row that is not signed off is a row that
 * is not there, and no snapshot of what the watches said, because the number
 * that was accepted is written straight in. A late watch cannot move it, a
 * discarded watch cannot move it, and taking it back is deleting it.
 *
 * `athleteId` and `eventId` are copied from the seed so results can be listed,
 * ranked and exported without reassembling the meet — the same reason `meetId`
 * is denormalised everywhere else.
 */
export interface Result {
  seedId: string;
  eventId: string;
  athleteId: string;
  status: ResultStatus;
  /** Zero for a no-show or a disqualification with nothing on the clock. */
  timeMs: number;
  decidedBy?: string;
  decidedAt: number;
=======
  /**
   * Which of this submitter's concurrent stopwatches this is — 1 unless
   * they're holding a clipboard for two or three handheld watches. A real
   * column, not an encoding trick: clipboard mode needs several *concurrent*
   * watches from one submitter to coexist for the median, which is exactly
   * what "latest row wins" must not collapse them into.
   */
  slot: number;
  /**
   * The time, once there is one.
   *
   * Absent means a stopwatch is running and nothing has been submitted yet —
   * which is how the desk tells a lane nobody is covering from one whose
   * timers are still holding their clocks. There is no separate table of
   * armed stopwatches, because a watch with a start and no time says it.
   *
   * Nothing that works out a swim's time may see one of these; they are
   * filtered out in `timedWatches`, which every such reader goes through.
   */
  timeMs?: number;
  /**
   * When the watch was started and stopped, on the server's clock.
   *
   * Both present means a stopwatch in this app ran the race; neither means
   * the time was typed in. Translated from the phone's own clock on the way
   * in, because the desk draws a running stopwatch from `startedAt` and that
   * means comparing it against the desk's now.
   */
  startedAt?: number;
  stoppedAt?: number;
  submittedAt: number;
>>>>>>> Stashed changes
}

export interface MeetDetail {
  meet: Meet;
  teams: Team[];
  events: Event[];
  /** eventId -> athleteIds registered in it. */
  entries: Record<string, string[]>;
  /** Every planned swim: who is in which lane of which heat. */
  swims: Swim[];
  /** Every watch ever submitted, running ones and superseded history included. */
  watches: Watch[];
  /** Everyone these rows refer to, so no screen has to fetch people itself. */
  athletes: Athlete[];
  /**
   * The racing teams' rosters for this meet's season.
   *
   * What the registration grid draws its rows from, and where a swimmer's
   * year and squad come from — as of this meet, not as of today.
   */
  enrollments: Enrollment[];
}

/**
 * The Meet Durable Object's live state: the three race-day tables it owns,
 * plus enough athletes to render names against them. Everything else in a
 * `MeetDetail` — the meet, events, teams, enrollments — is setup data,
 * decided before race day and read straight from D1 rather than pushed by
 * the DO.
 */
export type MeetSnapshot = Pick<
  MeetDetail,
  "entries" | "swims" | "watches" | "athletes"
>;

/**
 * Fold the Durable Object's live tables over a `MeetDetail` read from D1 —
 * what every workspace wired to the DO does with its loader's D1 read and
 * the live snapshot `useMeetLive` hands back.
 *
 * `entries` is included now that `declareEntry` (`MeetDurableObject`) is the
 * only place an entry is ever written — D1's `entries` table is just the
 * last checkpoint's copy, no more current than swims/watches are.
 *
 * `athletes` is a union, not a replacement: `live.athletes` only covers
 * people the DO's live tables currently name (entries/swims/walk-ins), while
 * `detail.athletes` carries the full team rosters from D1 — screens like the
 * registration grid need roster swimmers who haven't been entered yet. Live
 * copies win on id collisions since they can include a just-added walk-in
 * before D1's own read would.
 */
export function withLiveTables(
  detail: MeetDetail,
  live: MeetSnapshot,
): MeetDetail {
  const athletes = new Map(detail.athletes.map((a) => [a.id, a]));
  for (const athlete of live.athletes) athletes.set(athlete.id, athlete);
  return {
    ...detail,
    entries: live.entries,
    swims: live.swims,
    watches: live.watches,
    athletes: [...athletes.values()],
  };
}

/** How places turn into points. Nothing computes these yet. */
export interface ScoringRules {
  /** Points by place, best first: [6, 4, 3, 2, 1] for a dual meet. */
  individual: number[];
  /** Relays usually score differently, and fewer of them place: [8, 4, 2]. */
  relay: number[];
  /** Dual meets score the girls' and boys' halves as separate contests. */
  separateByGender: boolean;
}

/** 6-4-3-2-1 individual, 8-4 relay, girls and boys scored apart. */
export const DUAL_MEET_SCORING: ScoringRules = {
  individual: [6, 4, 3, 2, 1],
  relay: [8, 4, 2],
  separateByGender: true,
};

/* ------------------------------------------------------------------ naming */

export function athleteName(s: Athlete): string {
  return `${s.firstName} ${s.lastName}`.trim();
}

/**
 * Roster order. Whichever name isn't being sorted on breaks the tie, so
 * siblings — same surname, different given name — always land in the same
 * order rather than shuffling between renders.
 */
export function byAthlete(order: NameOrder = "last") {
  return (a: Athlete, b: Athlete): number =>
    order === "first"
      ? a.firstName.localeCompare(b.firstName) ||
        a.lastName.localeCompare(b.lastName)
      : a.lastName.localeCompare(b.lastName) ||
        a.firstName.localeCompare(b.firstName);
}

/**
 * A name written the way the list is sorted, so the part you're scanning comes
 * first: "Aaronson, Avery" under a surname sort, "Avery Aaronson" under a
 * given-name one. Always both names in full — no initials.
 */
export function displayName(s: Athlete, order: NameOrder = "last"): string {
  if (order === "first") return `${s.firstName} ${s.lastName}`.trim();
  const first = s.firstName.trim();
  return first ? `${s.lastName}, ${first}` : s.lastName;
}

export function eventName(
  e: Pick<Event, "name" | "gender" | "stroke" | "distance">,
): string {
  if (e.name) return e.name;
  const prefix =
    e.gender === "Open" ? "" : e.gender === "M" ? "Boys " : "Girls ";
  // Diving carries a placeholder distance, so don't write it out.
  if (isDiving(e)) return `${prefix}Diving`;
  return `${prefix}${e.distance} ${e.stroke}`;
}

/** "Dual vs Central" / "Inter-squad" — the subtitle in the meet list. */
export function meetSubtitle(meet: Pick<Meet, "type">): string {
  return meetTypeLabel(meet.type);
}

/**
 * Girls' and boys' versions of the same race share a key. Registration shows
 * one column per race and picks the right event from the swimmer's gender, so
 * a split lineup doesn't double the width of the grid.
 */
export function raceKey(event: Pick<Event, "distance" | "stroke">): string {
  return `${event.distance}|${event.stroke}`;
}

/** Whether an athlete is eligible for an event, given its gender restriction. */
export function isEligible(
  athlete: Athlete,
  event: Pick<Event, "gender">,
): boolean {
  return event.gender === "Open" || event.gender === athlete.gender;
}

/**
 * Someone by id, from anywhere in the team's history.
 *
 * Results from past meets point at people who may have left the roster since,
 * so this looks through everyone rather than just this season's.
 */
export function findAthlete(
  athletes: Athlete[],
  id: string | null | undefined,
): Athlete | undefined {
  if (!id) return undefined;
  return athletes.find((a) => a.id === id);
}
