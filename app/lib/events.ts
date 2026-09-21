import { generateId } from "./id";
import { DIVING_DISTANCE, isDiving, isRelay, raceKey } from "~/types/meet";
import type { Gender } from "~/types/athlete";
import type {
  EntryLimits,
  EventGender,
  MeetCourse,
  Event,
  Stroke,
} from "~/types/meet";
import type { Gender } from "~/types/athlete";

/**
 * What the entry-limit checks need: the programme, who's in what, and the
 * caps. A loader has all three; nothing here wants a whole meet.
 */
export interface EntryContext {
  events: Event[];
  /** eventId -> athleteIds registered in it. */
  entries: Record<string, string[]>;
  limits: EntryLimits;
}

/**
 * A standard high-school dual meet, in the order it's swum — relays included,
 * which is where they actually fall: medley opens, free relay closes, and
 * diving breaks up the middle after the 50 free.
 *
 * Written in yards, the US high-school norm. Every distance here is swum
 * unchanged in a metric pool bar one: the distance event is a 400 rather than
 * a 500, which is what `dualMeetOrder` swaps.
 */
const DUAL_MEET_ORDER: Array<{ distance: number; stroke: Stroke }> = [
  { distance: 200, stroke: "Medley Relay" },
  { distance: 200, stroke: "Free" },
  { distance: 200, stroke: "IM" },
  { distance: 50, stroke: "Free" },
  { distance: DIVING_DISTANCE, stroke: "Diving" },
  { distance: 100, stroke: "Fly" },
  { distance: 100, stroke: "Free" },
  { distance: 500, stroke: "Free" },
  { distance: 200, stroke: "Free Relay" },
  { distance: 100, stroke: "Back" },
  { distance: 100, stroke: "Breast" },
  { distance: 400, stroke: "Free Relay" },
];

function isYards(course: MeetCourse): boolean {
  return course === "SCY";
}

/** The standard order as plain races, for building a lineup or naming one. */
export function standardOrder(
  course: MeetCourse,
  includeDiving = true,
): Array<{ distance: number; stroke: Stroke }> {
  return DUAL_MEET_ORDER.filter(
    (e) => includeDiving || e.stroke !== "Diving",
  ).map((e) =>
    !isYards(course) && e.distance === 500 && e.stroke === "Free"
      ? { ...e, distance: 400 }
      : e,
  );
}

/** Races in the standard order — half the event count of a split lineup. */
export function dualMeetRaceCount(includeDiving: boolean): number {
  return includeDiving
    ? DUAL_MEET_ORDER.length
    : DUAL_MEET_ORDER.filter((e) => e.stroke !== "Diving").length;
}

/**
 * A new event.
 *
 * `position` is left at zero: the order of a lineup is the order of the array
 * the caller is building, and `renumber` stamps it on the way to the database.
 * Keeping the two apart means every list operation here — adding diving,
 * flipping the lead gender, converting distances — is ordinary array work.
 */
export function makeEvent(
  meetId: string,
  distance: number,
  stroke: Stroke,
  gender: EventGender = "Open",
): Event {
  return { id: generateId(), position: 0, distance, stroke, gender };
}

/** Stamp array order onto `position`, ready to be written. */
export function renumber(events: Event[]): Event[] {
  return events.map((event, position) => ({ ...event, position }));
}

export function otherGender(gender: Gender): Gender {
  return gender === "F" ? "M" : "F";
}

/**
 * Build a default event order.
 *
 * "split" is the high-school norm: each race swum twice, girls and boys back to
 * back, with `leadGender` going first. "open" collapses that to one race per
 * event, which suits an inter-squad meet or a time trial.
 */
export function defaultEvents(
  meetId: string,
  {
    mode = "split",
    leadGender = "F",
    includeDiving = true,
    course = "SCY",
  }: {
    mode?: "split" | "open";
    leadGender?: Gender;
    includeDiving?: boolean;
    course?: MeetCourse;
  } = {},
): Event[] {
  const order = standardOrder(course, includeDiving);

  if (mode === "open") {
    return renumber(
      order.map((e) => makeEvent(meetId, e.distance, e.stroke, "Open")),
    );
  }
  const second = otherGender(leadGender);
  return renumber(
    order.flatMap((e) => [
      makeEvent(meetId, e.distance, e.stroke, leadGender),
      makeEvent(meetId, e.distance, e.stroke, second),
    ]),
  );
}

/**
 * Whether a lineup is split by gender, so diving can be added to match. An
 * empty lineup counts as split — that's the high-school default everything
 * else here assumes.
 */
function isSplitLineup(events: Event[]): boolean {
  return events.length === 0 || events.some((e) => e.gender !== "Open");
}

/**
 * Add Diving to a lineup, in the place a program would put it: straight after
 * the 50 free, or at the end if there isn't one. Matches the lineup's own
 * shape — a gendered pair in a split meet, a single event otherwise.
 */
export function withDiving(
  meetId: string,
  events: Event[],
  leadGender: Gender,
): Event[] {
  if (events.some(isDiving)) return events;

  const diving = isSplitLineup(events)
    ? [
        makeEvent(meetId, DIVING_DISTANCE, "Diving", leadGender),
        makeEvent(meetId, DIVING_DISTANCE, "Diving", otherGender(leadGender)),
      ]
    : [makeEvent(meetId, DIVING_DISTANCE, "Diving", "Open")];

  const lastFifty = events.reduce(
    (found, e, i) => (e.distance === 50 && e.stroke === "Free" ? i : found),
    -1,
  );
  const at = lastFifty >= 0 ? lastFifty + 1 : events.length;
  return [...events.slice(0, at), ...diving, ...events.slice(at)];
}

export function withoutDiving(events: Event[]): Event[] {
  return events.filter((e) => !isDiving(e));
}

/**
 * Reorder an existing lineup so `leadGender` swims first in every pair.
 *
 * Deliberately a reorder, not a rebuild: event ids are preserved, so entries
 * and recorded times come along. Runs of events sharing a race stay together
 * and keep their position in the meet; anything unpaired is left alone.
 */
export function orderByLeadGender(
  events: Event[],
  leadGender: Gender,
): Event[] {
  const ordered: Event[] = [];

  for (let i = 0; i < events.length; ) {
    const key = raceKey(events[i]);
    let end = i;
    while (end < events.length && raceKey(events[end]) === key) end++;

    const run = events.slice(i, end);
    // Only a gendered pair has an order worth choosing.
    const lead = run.filter((e) => e.gender === leadGender);
    const rest = run.filter((e) => e.gender !== leadGender);
    ordered.push(...lead, ...rest);

    i = end;
  }

  return ordered;
}

/**
 * Distances with a counterpart in the other measure. Only these three differ:
 * everything from the 25 up to the 200 is swum at the same number in either
 * pool, which is why a lineup converts so cleanly.
 */
const DISTANCE_PAIRS: Array<[yards: number, metres: number]> = [
  [500, 400],
  [1000, 800],
  [1650, 1500],
];

/**
 * Rewrite a lineup's distances when a meet moves between yards and metres —
 * the 500 free becomes a 400, the mile becomes the metric mile.
 *
 * Event ids are kept, so entries, heats and any recorded times come along.
 * Relays are left alone: a 400 free relay is a 400 free relay in either pool,
 * and converting it would silently turn it into a 500.
 */
export function convertDistances(
  events: Event[],
  from: MeetCourse,
  to: MeetCourse,
): Event[] {
  if (isYards(from) === isYards(to)) return events;

  const toMetres = isYards(from);
  const swap = new Map(
    DISTANCE_PAIRS.map(([yards, metres]) =>
      toMetres ? [yards, metres] : [metres, yards],
    ),
  );

  return events.map((event) => {
    if (isRelay(event) || isDiving(event)) return event;
    const distance = swap.get(event.distance);
    return distance ? { ...event, distance } : event;
  });
}

/**
 * Distances offered in the "add event" picker, for the course this meet is
 * swum in — a yards pool has no 400 free, a metric one no 500. The meet knows
 * its course, so the picker doesn't have to offer both and hope.
 */
export function distancesFor(course: MeetCourse): number[] {
  return isYards(course)
    ? [25, 50, 100, 200, 500, 1000, 1650]
    : [25, 50, 100, 200, 400, 800, 1500];
}

/**
 * Relays are only ever swum at these distances, so the picker follows suit.
 * The same four in either course — a 200 free relay is a 200 free relay.
 */
export const RELAY_DISTANCES = [100, 200, 400, 800];

/* ------------------------------------------------------------ entry limits */

export interface EntryTally {
  individual: number;
  relay: number;
  total: number;
}

/** What a swimmer is already in, counted the way the limits are written. */
export function tallyEntries(
  ctx: Pick<EntryContext, "entries" | "events">,
  athleteId: string,
): EntryTally {
  const byId = new Map(ctx.events.map((e) => [e.id, e] as const));
  let individual = 0;
  let relay = 0;

  for (const [eventId, ids] of Object.entries(ctx.entries)) {
    if (!ids.includes(athleteId)) continue;
    const event = byId.get(eventId);
    // Diving holds a place in the running order but isn't a swim, so it
    // doesn't count against a swimming cap.
    if (!event || isDiving(event)) continue;
    if (isRelay(event)) relay += 1;
    else individual += 1;
  }

  return { individual, relay, total: individual + relay };
}

/**
 * Why a swimmer can't be added to an event, or null if they can.
 *
 * Returns the reason rather than a boolean because every caller wants to say
 * it out loud — a greyed-out cell that won't explain itself is how a coach
 * ends up counting on their fingers.
 *
 * Counts what they'd have *after* the entry, and ignores an event they're
 * already in, so re-checking an existing entry never reports a breach.
 */
export function whyNotEnter(
  ctx: EntryContext,
  athleteId: string,
  eventId: string,
): string | null {
  const event = ctx.events.find((e) => e.id === eventId);
  if (!event) return "That race isn't in this meet.";
  if ((ctx.entries[eventId] ?? []).includes(athleteId)) return null;
  if (isDiving(event)) return null;

  const { limits } = ctx;
  const tally = tallyEntries(ctx, athleteId);
  const relay = isRelay(event);

  if (
    relay &&
    limits.maxRelays !== undefined &&
    tally.relay >= limits.maxRelays
  ) {
    return `Already in ${tally.relay} relay${tally.relay === 1 ? "" : "s"}, and this meet allows ${limits.maxRelays}.`;
  }
  if (
    !relay &&
    limits.maxIndividual !== undefined &&
    tally.individual >= limits.maxIndividual
  ) {
    return `Already in ${tally.individual} individual event${tally.individual === 1 ? "" : "s"}, and this meet allows ${limits.maxIndividual}.`;
  }
  if (limits.maxTotal !== undefined && tally.total >= limits.maxTotal) {
    return `Already in ${tally.total} events, and this meet allows ${limits.maxTotal}.`;
  }

  return null;
}

/**
 * Whether a team has filled its allowance in a race.
 *
 * Separate from the per-swimmer check because it's a different question with a
 * different answer: a swimmer under their own cap can still be turned away
 * because their team already has enough in that heat.
 */
export function teamFullFor(
  ctx: Pick<EntryContext, "entries" | "limits">,
  eventId: string,
  teamAthleteIds: Set<string>,
): boolean {
  const cap = ctx.limits.maxPerTeamPerEvent;
  if (cap === undefined) return false;
  const entered = (ctx.entries[eventId] ?? []).filter((id) =>
    teamAthleteIds.has(id),
  );
  return entered.length >= cap;
}

/**
 * How many swimmers are in an event.
 *
 * This used to return an orphan count alongside it. Entries referenced
 * athletes by id, a roster re-import minted new ids, and the leftovers counted
 * without rendering — which is how a race read "9 entered" above three ticks.
 * With entries as rows and a loader that fetches exactly the people its rows
 * name, there is nothing left to be orphaned from.
 */
export function enteredCount(
  entries: Record<string, string[]>,
  eventId: string,
): number {
  return (entries[eventId] ?? []).length;
}
