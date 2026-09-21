/**
 * Where a timing screen lives.
 *
 * `/meets/{meetId}/timer/{event}/{heat}/{lane}` — the same shape as the
 * endpoint that lane posts to, and for the same reason: everything about
 * where a timer is standing belongs in the address rather than on the device.
 * Moving to the next heat is then a link, going back is the back button, and
 * the screen holds no idea of "where am I" that could disagree with the URL.
 *
 * *Which phone* is the one thing that was in here and isn't. It was, as
 * `/timers/{timerId}/…`, and it never earned its place: the device id is a
 * cookie the browser attaches to every request anyway, the server has to read
 * that cookie to be sure of it — a segment in a URL is only ever what the URL
 * says — and nobody standing on a deck can use it. The page is where somebody
 * is standing; who they are is a credential, and credentials travel in
 * cookies here.
 */

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
 * Whether a URL is one of the timing screens.
 *
 * Read by `root.tsx` to keep its session loader from revalidating as somebody
 * walks between heats. That revalidation is a network request, and out of
 * signal it fails the *navigation* — a phone that has just queued a time and
 * tapped through to the next heat would land on an error page instead, which
 * is precisely the moment none of this may depend on the pool's wifi.
 *
 * Deliberately a suffix match rather than an anchored one: in production the
 * app is served under a base path, and this is handed whole pathnames.
 */
const TIMING = /\/meets\/[^/]+\/timer(\/|$)/;

export function isTimingPath(pathname: string): boolean {
  return TIMING.test(pathname);
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
