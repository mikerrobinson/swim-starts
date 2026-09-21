/**
 * Device-local preferences: how this person likes names written, how their
 * stopwatch lays out its buttons, where they have got to in a meet. The meet
 * itself lives on the server and arrives through a loader; everything here is
 * deliberately per-device and is never sent anywhere.
 */

import { A_YEAR, readCookie, writeCookie } from "./cookies";
import { local } from "./local";
import { LANE_LAYOUTS, type LaneLayout } from "~/types/meet";
import { type NameOrder } from "~/types/preferences";

const LANE_LAYOUT_KEY = "swim-starts:lane-layout";
const TIMER_ID_KEY = "swim-starts:timer-id";
/**
 * Who this device is when it takes a time, in a cookie.
 *
 * The one piece of device state whose loss corrupts data rather than costing
 * a tap: watches are keyed by it, so a device that forgets its id and mints a
 * new one files a second watch on a lane it already timed, and the proposed
 * time moves. Cookies hold where localStorage is refused, which on a timer's
 * borrowed phone is often enough to matter.
 */
const TIMER_ID_COOKIE = "mr_timer_id";

/**
 * How the stopwatch arranges its lane buttons. A property of whoever is
 * holding the device — where they stand on the deck, which hand they use —
 * rather than of the meet, so it stays here and carries to the next meet
 * instead of being set again on every one.
 */
export function loadLaneLayout(): LaneLayout {
  const stored = local.get(LANE_LAYOUT_KEY) as LaneLayout | null;
  return stored && LANE_LAYOUTS.includes(stored) ? stored : "grid";
}

export function saveLaneLayout(layout: LaneLayout): void {
  local.set(LANE_LAYOUT_KEY, layout);
}

const NAME_ORDER_KEY = "swim-starts:name-order";

/**
 * How this person likes names written and sorted.
 *
 * Moved off the team document, where it used to live. That was defensible
 * while a team was one coach's private season; now that teams are shared and
 * publicly readable, a visiting coach flipping it would have changed how the
 * home team reads its own roster. A display preference belongs to whoever is
 * looking, not to the thing being looked at.
 */
export function loadNameOrder(): NameOrder {
  return local.get(NAME_ORDER_KEY) === "first" ? "first" : "last";
}

export function saveNameOrder(order: NameOrder): void {
  local.set(NAME_ORDER_KEY, order);
}

/**
 * Who this device is when it takes a time.
 *
 * A lane can be timed by several people at once, and each watch is stored
 * under whoever took it — so "this device" needs a name that survives a
 * reload, or every reload would look like a new timer and pile up duplicate
 * times on the same lane. Becomes a user id once there are accounts.
 */
export function loadTimerId(): string {
  if (typeof document === "undefined") return "device";
  // Whatever this page already decided. Two calls on one page must never
  // disagree, whatever the browser will or won't keep for us — that is the
  // difference between one watch on a lane and two.
  if (session) return session;

  // The cookie first, then the key phones that timed on the build before this
  // one still hold. Carrying the old id across rather than minting a fresh one
  // is what stops such a device filing a second watch on a lane it has already
  // timed — and the id it keeps is written to the cookie below, so this is the
  // last time it needs asking.
  const stored = readCookie(TIMER_ID_COOKIE) ?? local.get(TIMER_ID_KEY);

  session = stored || `d-${Math.random().toString(36).slice(2, 10)}`;
  writeCookie(TIMER_ID_COOKIE, session, A_YEAR);
  return session;
}

/**
 * This page's answer, held in the module.
 *
 * The identity has to be stable for as long as the tab is open even when
 * nothing at all can be persisted — a browser that keeps neither cookies nor
 * localStorage would otherwise mint a fresh id on every call, and every watch
 * this device sent would look like it came from a different timer. Several
 * watches on one lane are averaged, so that doesn't just duplicate a time, it
 * changes the one the desk reads.
 */
let session: string | null = null;
