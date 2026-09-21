/**
 * The seed cookie's `document.cookie` I/O and pending list.
 *
 * One cookie per lane rather than the five per-lane cookies `timer-queue.ts`
 * used: the timer screen keeps a `SeedRecord` per lane as ordinary form
 * state and, on any change, encodes the whole thing and calls
 * `saveSeedRecord` to write it out — this module never reads a cookie back
 * to build the next write, only to enumerate which lanes still have one
 * outstanding.
 *
 * No network here. A loader visiting the timer's base path carries every
 * outstanding `seed-*` cookie along for free and applies it server-side, so
 * there's nothing for this module to fetch — see `seed-cookie.ts`'s header
 * for why that GET is allowed to mutate.
 */

import type { LaneRef } from "~/types/meet";
import { A_WEEK } from "./cookies";
import {
  encodeSeedRecord,
  parseSeedCookieName,
  seedCookieName,
  type SeedRecord,
} from "./seed-cookie";

export interface QueueState {
  /** Lanes with something still to send. */
  pending: LaneRef[];
  /** Set when a record grew too large to store at all. Sticky; needs a person. */
  overflow: boolean;
}

/**
 * Every outstanding seed-* cookie now shares one path, so it's the *total*
 * riding on that path — not any single lane's tiny record — that risks the
 * browser's per-domain cookie budget or the request's Cookie header size.
 * `document.cookie` already reflects everything else attached here, so a
 * write checks what it would add on top of that.
 */
const MAX_TOTAL_BYTES = 3000;

let overflow = false;

export function queueState(): QueueState {
  return { pending: pendingLanes(), overflow };
}

function pendingLanes(): LaneRef[] {
  if (typeof document === "undefined") return [];
  const found: LaneRef[] = [];
  for (const part of document.cookie.split(";")) {
    const at = parseSeedCookieName(part.trim().split("=")[0] ?? "");
    if (at) found.push(at);
  }
  return found;
}

/**
 * Write a lane's whole record to its cookie, replacing whatever was there —
 * the only way this module ever touches a `seed-*` cookie's value.
 */
export function saveSeedRecord(
  basePath: string,
  at: LaneRef,
  record: SeedRecord,
): void {
  if (typeof document === "undefined") return;
  const name = seedCookieName(at);
  const value = encodeURIComponent(encodeSeedRecord(record));

  // Cautiously check to see if we've queued a lot of writes and need to warn the user
  if (
    document.cookie.length + name.length + 1 + value.length >
    MAX_TOTAL_BYTES
  ) {
    overflow = true;
    return;
  }

  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${name}=${value}` +
    `; Path=${basePath}; SameSite=Lax; Max-Age=${A_WEEK}${secure}`;
}
