/**
 * The timer's own device state, and the running order it walks through.
 *
 * Everything here is a small cookie or a pure function — no network. The
 * meet itself arrives via `timer-shell.tsx`'s loader now; this is only what a
 * *device* remembers about itself: which role it answered at the lane picker,
 * and how far it has got, neither of which the URL can say.
 */

import { appBasePath } from "./http";
import { A_WEEK, readCookie } from "./cookies";
import { splitTypedName } from "./names";
import { generateId } from "./id";
import type { Event, Swim } from "~/types/meet";
import type { Athlete } from "~/types/athlete";

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
  meet: { timersPerLane: number } | undefined,
  role: TimerRole | null,
): number {
  const expected = Math.max(1, meet?.timersPerLane ?? 1);
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
  swims: Swim[];
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
 * event's swims, so an empty one cannot arise.
 */
export function runningOrder(events: Event[], swims: Swim[]): Stop[] {
  const order: Stop[] = [];
  for (const event of events) {
    const forEvent = swims.filter((swim) => swim.eventId === event.id);
    const heats = [...new Set(forEvent.map((s) => s.heat))].sort(
      (a, b) => a - b,
    );
    heats.forEach((heat, index) => {
      order.push({
        event,
        heat,
        swims: forEvent
          .filter((s) => s.heat === heat)
          .sort((a, b) => a.lane - b.lane),
        number: index + 1,
        of: heats.length,
      });
    });
  }
  return order;
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

/* -------------------------------------------------------------- athletes */

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
  /** What a walk-up's seed cookie names this team by — see `SeedRecord.team`. */
  code: string;
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
 * A swimmer a timer typed in.
 *
 * The id minted here is the athlete's real id, not a placeholder — the seed
 * cookie carries it straight through to `addWalkupAthlete`, which creates the
 * person under this exact id rather than minting its own. That's what lets
 * re-applying the same not-yet-acknowledged cookie converge on one person
 * instead of a duplicate.
 */
export function newVisitingAthlete(
  name: string,
  teamId: string,
  gender: Athlete["gender"],
): QueuedAthlete {
  // The same split the server will apply when it creates the athlete, so the
  // lane doesn't show one thing now and another once it's created.
  return {
    id: generateId(),
    ...splitTypedName(name),
    gender,
    teamId: teamId || undefined,
  };
}

export function timerPath(
  meetId: string,
  event?: number,
  heat?: number,
  lane?: number,
): string {
  if (![event, heat, lane].every((n) => n! && Number.isInteger(n) && n > 0)) {
    return `/meets/${meetId}`;
  }
  return `/meets/${meetId}/timer/${event}/${heat}/${lane}`;
}
