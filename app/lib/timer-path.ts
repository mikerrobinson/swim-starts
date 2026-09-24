import { appBasePath } from "./http";
import { runningOrder, timerPath, type Stop } from "./timer";
import type { Event, Swim } from "~/types/meet";

/**
 * The same address, but as an absolute cookie `Path` rather than a route to
 * navigate to — prefixed with the app's own base, which a `<Link>` never
 * needs (the router already knows its basename) but a `Path` attribute does.
 * Every `seed-*` cookie is scoped to exactly this string, so whatever's
 * pending rides along on any request under the timer workspace.
 */
export function timerCookiePath(meetId: string): string {
  return `${appBasePath()}${timerPath(meetId).slice(1)}`;
}

export function stopPath(meetId: string, stop: Stop, lane: number): string {
  return `${timerPath(meetId)}/${stop.event.position + 1}/${stop.heat}/${lane}`;
}

/**
 * The lane picker, but remembering which heat to come back to.
 *
 * A timer's own "change lane" link uses this rather than the bare
 * `timerPath` — swapping lanes mid-meet (the case that link exists for,
 * per `timer.tsx`) means picking up the *same* heat with a different lane,
 * not restarting at the meet's first one. `stop` absent (a fresh scan, from
 * `timer-claim.tsx`) falls back to the bare picker, which is what sends a
 * lane choice there through `firstStopPath` instead.
 */
export function lanesPath(meetId: string, stop?: Stop): string {
  if (!stop) return timerPath(meetId);
  const search = new URLSearchParams({
    event: String(stop.event.position + 1),
    heat: String(stop.heat),
  });
  return `${timerPath(meetId)}?${search}`;
}

/**
 * Where a timer starts: the first heat with anything seeded in it.
 *
 * Not simply the first event. A meet's programme opens with relays that are
 * often unseeded, and dropping somebody on "event 1, heat 1 — nobody here"
 * makes them think the app is broken before they have pressed anything.
 */
export function firstStopPath(
  meet: { events: Event[]; swims: Swim[] },
  meetId: string,
  lane: number,
): string {
  // The first heat with anything in it — which, since a heat *is* its swims,
  // is simply the first heat there is.
  const order = runningOrder(meet.events, meet.swims);
  const first = order[0];

  // A meet with no heats seeded at all still has to go somewhere, and event 1
  // heat 1 is where seeding will put the first one.
  if (!first) return `${timerPath(meetId)}/1/1/${lane}`;
  return stopPath(meetId, first, lane);
}
