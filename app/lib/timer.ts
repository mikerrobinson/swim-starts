/**
 * The timer's side of the deck.
 *
 * Everything a timing phone holds lives in localStorage: the grant it scanned,
 * which lane it's standing behind, where it has got to in the running order,
 * and — the important one — any times it hasn't managed to send yet.
 *
 * There is no IndexedDB and no sync engine here, on purpose. This device reads
 * one small document and posts times back. What it must never do is lose a
 * time because the pool wifi dropped, which is what the queue is for.
 */

import { apiUrl, ApiError, appBasePath } from "./http";
import { A_WEEK, readCookie } from "./cookies";
import { splitTypedName } from "./timer-messages";
import { generateId } from "./id";
import type { Athlete } from "~/types/athlete";
import type { Event, Seed, Watch } from "~/types/meet";

/**
 * How far this phone has got, and nothing else.
 *
 * Which lane, which event, which heat and which meet all used to be cookies.
 * They are in the URL now — every timing page is
 * `/meets/{meetId}/timer/{event}/{heat}/{lane}` — so the address bar is the
 * only record of where a timer is standing, the back button works, and a
 * reloaded phone comes back exactly where it was without having remembered
 * anything.
 *
 * What the URL can't say is how far somebody has *been*, which is what stops
 * them wandering back into a heat whose sheet has already gone to the desk.
 * One number, scoped by its own path to this meet, so a different meet starts
 * clean without anything having to notice. A browser is one device, so there
 * is nobody else's progress it could be confused with.
 */
const FURTHEST_COOKIE = "mr_timer_done";

function furthestPath(meetId: string): string {
  return `${appBasePath()}meets/${encodeURIComponent(meetId)}/timer`;
}

/**
 * What this phone is doing behind its lane.
 *
 * `own` is the screen this app started with: one phone, one thumb, one watch.
 * `clipboard` is what a lane usually looks like — two or three people holding
 * handheld stopwatches and reading them out to whoever has the sheet — and
 * makes this phone that sheet.
 *
 * A device answer, not a meet one, and the reason is that both are true at
 * the same meet: the coach sets "three timers a lane" because that is how
 * many watches a lane has, and then one lane is covered by three parents with
 * three phones while the next has a clipboard. The meet says how many
 * watches; each phone says which of them it is holding.
 *
 * Scoped by path to this meet, like `furthest`, so a volunteer who was the
 * clipboard on Tuesday isn't quietly one again on Thursday.
 */
export type TimerRole = "own" | "clipboard";

const ROLE_COOKIE = "mr_timer_role";

export function loadRole(): TimerRole | null {
  const raw = readCookie(ROLE_COOKIE);
  return raw === "clipboard" || raw === "own" ? raw : null;
}

export function saveRole(meetId: string, role: TimerRole): void {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${ROLE_COOKIE}=${role}` +
    `; Path=${furthestPath(meetId)}; SameSite=Lax` +
    `; Max-Age=${A_WEEK}${secure}`;
}

/**
 * How many watches this phone is filling in, given what it is and what the
 * meet says a lane has.
 *
 * One unless this phone is the clipboard — a phone that is itself a stopwatch
 * is one watch however many are standing beside it — and never more than the
 * meet expects, so turning "three timers" down to two mid-meet takes a column
 * off every clipboard rather than leaving one stranded.
 */
export function watchCount(
  snapshot: Pick<Snapshot, "meet"> | null,
  role: TimerRole | null,
): number {
  const expected = Math.max(1, snapshot?.meet.timersPerLane ?? 1);
  return role === "clipboard" ? expected : 1;
}

/** The furthest heat submitted, as an index into the running order. */
export function loadFurthest(): number {
  const raw = readCookie(FURTHEST_COOKIE);
  const value = Number(raw);
  return raw !== null && Number.isInteger(value) && value >= 0 ? value : -1;
}

export function saveFurthest(meetId: string, index: number): void {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${FURTHEST_COOKIE}=${index}` +
    `; Path=${furthestPath(meetId)}; SameSite=Lax` +
    `; Max-Age=${A_WEEK}${secure}`;
}

/* ------------------------------------------------------- the running order */

/** One heat, flattened into the order the meet is actually swum in. */
export interface Stop {
  event: Event;
  /** Which heat of the event, 1-based. */
  heat: number;
  /** The swims in it, so the phone knows who is in the lane it is timing. */
  seeds: Seed[];
  /** 1-based, for "Heat 2 of 4". */
  number: number;
  of: number;
}

/**
 * Every heat in the order they'll be swum.
 *
 * The timer moves through this one step at a time. Events with nothing seeded
 * are skipped rather than shown empty — there is nothing to time, and a screen
 * offering a stopwatch for a heat that doesn't exist is a screen that gets a
 * time recorded against nothing. A heat is the distinct heats across an
 * event's seeds, so an empty one cannot arise.
 */
export function runningOrder(events: Event[], seeds: Seed[]): Stop[] {
  const order: Stop[] = [];
  for (const event of events) {
    const forEvent = seeds.filter((seed) => seed.eventId === event.id);
    const heats = [...new Set(forEvent.map((s) => s.heat))].sort(
      (a, b) => a - b,
    );
    heats.forEach((heat, index) => {
      order.push({
        event,
        heat,
        seeds: forEvent
          .filter((s) => s.heat === heat)
          .sort((a, b) => a.lane - b.lane),
        number: index + 1,
        of: heats.length,
      });
    });
  }
  return order;
}

/* ------------------------------------------------------------------ wire */

/**
 * The grant is the whole credential, and the browser carries it.
 *
 * Nothing is attached here: the cookie `/t/:token` set rides every same-origin
 * request by itself. There is no token in this file to attach, which is the
 * point — a credential no script can read is one no script can leak.
 */
async function timerFetch(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError("No signal", 0);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      (body as { error?: string } | null)?.error ??
        `Failed (${response.status})`,
      response.status,
    );
  }
  return body;
}

function timerPost(path: string, body: unknown): Promise<unknown> {
  return timerFetch(path, { method: "POST", body: JSON.stringify(body) });
}

export interface TimerAthlete {
  id: string;
  firstName: string;
  lastName: string;
  /** Display label for whichever team enrolled them. */
  team?: string;
}

export interface TimerTeam {
  id: string;
  name: string;
}

export interface Snapshot {
  serverTime: number;
  expiresAt: number;
  meet: {
    id: string;
    name: string;
    date: string;
    laneCount: number;
    /** How many watches a lane is timed by. One is a phone per timer. */
    timersPerLane: number;
    teams: TimerTeam[];
  };
  /** What to call athletes with no team label of their own. */
  ownTeam: string;
  events: Event[];
  seeds: Seed[];
  /** eventId -> athleteIds registered in it. */
  entries: Record<string, string[]>;
  athletes: TimerAthlete[];
  mine: Watch[];
}

/**
 * Nothing is passed. Both halves of "which meet, and whose watches" are
 * cookies the browser attaches by itself — the grant says which meet, and the
 * device cookie says which phone's own times to mark as already sent.
 */
export function fetchSnapshot(): Promise<Snapshot> {
  return timerFetch(`/api/timer/meet`) as Promise<Snapshot>;
}

/**
 * The earliest heat a timer may go back to.
 *
 * One behind whatever they last submitted, and no further. The reason is the
 * one thing timers can't do on paper either: once a runner has collected the
 * sheet and a result has been reconciled, the facts underneath it must not
 * quietly change. Correcting the time you just took is fair; rewriting an
 * event that has been announced is not.
 *
 * Takes the furthest heat reached rather than a position, now that where a
 * timer *is* comes from the URL and only where they have *been* is remembered.
 */
export function earliestAllowed(furthest: number): number {
  return Math.max(0, furthest - 1);
}

/**
 * A person a timer typed in.
 *
 * Carries the team the timer tapped, because a visiting swimmer belongs to a
 * real roster and guessing which one is how a season ends up with two Sofias.
 */
export interface QueuedAthlete extends Athlete {
  teamId?: string;
}

/**
 * A swimmer a timer typed in, for the screen to show immediately.
 *
 * The id minted here is local and temporary. The `seat` message carries the
 * *name*, and the server mints the id that lasts — it is the only side that
 * can tell a genuinely new person from one it already has, which a phone
 * holding a partial roster cannot. The next snapshot replaces this one, so
 * nothing is allowed to key off it.
 */
export function newVisitingAthlete(
  name: string,
  teamId: string,
  gender: Athlete["gender"],
): QueuedAthlete {
  // The same split the server will apply to the name in the `seat` message,
  // so the lane doesn't show one thing now and another after the next poll.
  return {
    id: generateId(),
    ...splitTypedName(name),
    gender,
    teamId: teamId || undefined,
  };
}
