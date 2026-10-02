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
import type { Entry, EntryKey } from "./entry";
import type { NameOrder } from "./preferences";
import type { Swim, SwimKey } from "./swim";
import type { Team } from "./team";
import type { User } from "./user";
import type { Watch } from "./watch";

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

/* -------------------------------------------------------------------- meet */

export type MeetType =
  | "intersquad"
  | "dual"
  | "tri"
  | "invitational"
  | "time-trial";

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
 * Scheduled/in-progress vs. archived. The one thing D1 needs to know about a
 * meet's lifecycle without waking its Durable Object: not-complete means "all
 * data comes from the DO", complete means "all data comes from D1's `results`
 * table instead, and the DO for it should never be spun up."
 */
export type MeetStatus = "scheduled" | "complete";

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

/**
 * The D1 row: static, decided-at-setup facts about a meet, plus its
 * lifecycle `status`. Deliberately doesn't carry `events`/`swims` or a live
 * pointer like `currentEventId` — that's the meet's Durable Object's
 * business (see `MeetManifest`), not D1's.
 */
export interface Meet {
  id: string;
  name: string;
  date: string;
  type: MeetType;
  course: MeetCourse;
  location?: string;
  teamIds: string[];
  /** Who runs this meet — `meet_admins`' user ids. Together with `teamIds`,
   *  everything `access.ts`'s pure `canEditMeet`/`canRecordTime`/`canEnter`
   *  need to decide anything about this meet, with no further D1 read. */
  adminIds: string[];
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
  status: MeetStatus;
}

/**
 * The meet's own settings, edited from `meet-info.tsx`: everything a coach
 * decides before race day except who's racing (`teamIds`/`hostTeamId` stay
 * D1's — see `Meet` — since "who's racing" is a `meet_teams` join, not a
 * setting to broadcast).
 *
 * DO-owned, like `MeetManifest`'s other tables: `MeetDurableObject.setDetails`
 * is the only writer, and it always replaces the whole object rather than
 * patching fields — the same "send the object" convention `setEvents` uses.
 * D1's copy of these same fields (on `Meet`) is kept current too:
 * `setDetails` pushes every edit straight through to D1's `meets` row in
 * the same call, synchronously — so the meets list (D1-only, on purpose)
 * never shows a stale name, date, or lane count. The DO is still the one
 * source of truth being read from; D1 is a write-through copy, not a
 * second place anything is decided.
 */
export interface MeetDetails {
  name: string;
  date: string;
  type: MeetType;
  course: MeetCourse;
  location?: string;
  laneCount: LaneCount;
  timersPerLane: TimersPerLane;
  leadGender: Gender;
  includeDiving: boolean;
  entryVisibility: EntryVisibility;
  athletesMayEnter: boolean;
  limits: EntryLimits;
  laneAssignments: LaneAssignments;
  scoring: ScoringRules;
}

/** Pick `MeetDetails`' fields off a D1 `Meet` row — what seeds a meet's
 *  Durable Object at creation (`meets.tsx`) and what a completed meet's
 *  archive read falls back to (`results.server.ts`). */
export function meetDetailsFrom(meet: Meet): MeetDetails {
  return {
    name: meet.name,
    date: meet.date,
    type: meet.type,
    course: meet.course,
    location: meet.location,
    laneCount: meet.laneCount,
    timersPerLane: meet.timersPerLane,
    leadGender: meet.leadGender,
    includeDiving: meet.includeDiving,
    entryVisibility: meet.entryVisibility,
    athletesMayEnter: meet.athletesMayEnter,
    limits: meet.limits,
    laneAssignments: meet.laneAssignments,
    scoring: meet.scoring,
  };
}

/**
 * An athlete as this meet's Durable Object knows them: `Athlete` plus which
 * team they're racing for *at this meet* — `team_id`, local to the DO's own
 * `athletes` row (`addTeam`/`addWalkupAthlete` set it) and deliberately not
 * part of `Athlete` itself, which carries no team of its own (see
 * `types/athlete.ts`). `addTeam` copies a whole roster in, so this is every
 * swimmer racing this meet, not only whoever a swim or entry already names.
 */
export interface MeetAthlete extends Athlete {
  teamId: string;
}

export interface MeetManifest {
  id: string;
  name: string;
  details: MeetDetails;
  status: MeetStatus;
  currentEventId?: string;
  currentHeatNumber?: number;
  events: Record<string, Event>;
  entries: Record<EntryKey, Entry>;
  swims: Record<SwimKey, Swim>;
  watches: Record<string, Watch>;
  athletes: Record<string, MeetAthlete>;
  teams: Record<string, Team>;
  adminIds: string[];
  version?: number;
}

export interface Event {
  id: string;
  position: number;
  distance: number;
  stroke: Stroke;
  gender: EventGender;
  name?: string; // optional - if not set, app concatenates gender, distance, and stroke
  totalHeats?: number; // optional - can be calculated from swims
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

/** What a meet's settings are before anyone has set any — a meet created
 *  before `MeetDurableObject.setDetails` existed, say. */
export const DEFAULT_MEET_DETAILS: MeetDetails = {
  name: "Meet",
  date: "",
  type: "dual",
  course: "SCY",
  laneCount: 6,
  timersPerLane: 1,
  leadGender: "F",
  includeDiving: false,
  entryVisibility: "everyone",
  athletesMayEnter: false,
  limits: {},
  laneAssignments: {},
  scoring: DUAL_MEET_SCORING,
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

/*
 *  Helpers for working with the running order of a meet, which is the order heats are swum in.
 */
// 1. Get ordered list of events for the meet
export function getSortedEvents(meet: MeetManifest): Event[] {
  return Object.values(meet.events).sort((a, b) => a.position - b.position);
}

// 2. Get all swims for a specific heat (ordered by lane)
export function getHeatSwims(
  meet: MeetManifest,
  eventId: string,
  heatNumber: number,
): Swim[] {
  return Object.values(meet.swims)
    .filter((s) => s.eventId === eventId && s.heat === heatNumber)
    .sort((a, b) => a.lane - b.lane);
}

export function getEventSwims(meet: MeetManifest, eventId: string): Swim[] {
  return Object.values(meet.swims)
    .filter((s) => s.eventId === eventId)
    .sort((a, b) => a.heat - b.heat)
    .sort((a, b) => a.lane - b.lane);
}

// 3. Find the total number of heats in an event
export function getTotalHeatsForEvent(
  meet: MeetManifest,
  eventId: string,
): number {
  const heats = new Set(
    Object.values(meet.swims)
      .filter((s) => s.eventId === eventId)
      .map((s) => s.heat),
  );
  return heats.size;
}

// 4. Stepper: Calculate the next sequential heat/event
export function getNextHeat(
  meet: MeetManifest,
  currentEventId: string,
  currentHeat: number,
): { eventId: string; heat: number } | null {
  const totalHeats = getTotalHeatsForEvent(meet, currentEventId);

  // Still more heats in the current event?
  if (currentHeat < totalHeats) {
    return { eventId: currentEventId, heat: currentHeat + 1 };
  }

  // Move to the next event in the schedule
  const sortedEvents = getSortedEvents(meet);
  const currentEventIdx = sortedEvents.findIndex(
    (e) => e.id === currentEventId,
  );

  if (currentEventIdx !== -1 && currentEventIdx + 1 < sortedEvents.length) {
    const nextEvent = sortedEvents[currentEventIdx + 1];
    return { eventId: nextEvent.id, heat: 1 };
  }

  // Reached end of meet
  return null;
}

export function getPreviousHeat(
  meet: MeetManifest,
  currentEventId: string,
  currentHeat: number,
): { eventId: string; heat: number } | null {
  // Still earlier heats in the current event?
  if (currentHeat > 1) {
    return { eventId: currentEventId, heat: currentHeat - 1 };
  }

  // Move to the previous event in the schedule
  const sortedEvents = getSortedEvents(meet);
  const currentEventIdx = sortedEvents.findIndex(
    (e) => e.id === currentEventId,
  );

  // Is there a prior event?
  if (currentEventIdx > 0) {
    const prevEvent = sortedEvents[currentEventIdx - 1];
    // Land on the last heat of the previous event
    const prevEventTotalHeats = getTotalHeatsForEvent(meet, prevEvent.id);

    return {
      eventId: prevEvent.id,
      heat: Math.max(1, prevEventTotalHeats),
    };
  }

  // Already at the very beginning of the meet (Event 1, Heat 1)
  return null;
}
