/**
 * What every timer request needs before it can do anything: who's allowed in,
 * which phone this is, and the meet's own state merged with the DO's live
 * tables. Shared by the timer shell's `loader` and the per-lane `action`,
 * since both have to resolve exactly the same things before applying a
 * seed cookie against them.
 */

import { requireDb } from "./api.server";
import { grantToken } from "~/lib/grants.server";
import { grantFor } from "~/lib/grants.server";
import { type Grant } from "~/lib/grants.server";
import type { MeetDurableObject } from "./meet-do.server";
import type { MeetDetail } from "~/types/meet";

export interface TimerRequest {
  db: D1Database;
  stub: DurableObjectStub<MeetDurableObject>;
  grant: Grant;
  timerId: string;
  detail: MeetDetail;
  /** Set only when this request minted a device id nobody had yet. */
  deviceCookie?: string;
}

export type TimerRequestResult =
  | { ok: true; value: TimerRequest }
  | { ok: false; error: string };

export async function resolveTimerRequest(
  request: Request,
  env: Env,
  meetId: string,
): Promise<TimerRequestResult> {
  const db = requireDb(env);

  const token = grantToken(request);
  if (!token) {
    return {
      ok: false,
      error: "Scan the code your coach gave you to start timing.",
    };
  }
  const grant = await grantFor(db, token);
  if (!grant || grant.meetId !== meetId) {
    return {
      ok: false,
      error: "This timing link has expired. Scan the code again.",
    };
  }

  // This resolved to `withLiveTables(await meetDetail(db, meetId), await
  // stub.getSnapshot(meetId))` — `meetDetail` assembled a `MeetDetail` from
  // D1's events/entries/swims/watches tables. Those moved entirely into the
  // meet's Durable Object (see `meets2.tsx`), and this old `MeetDetail`-
  // shaped timer workspace (`timer-shell.tsx`/`timer.tsx`) hasn't been
  // ported to read from it, so it refuses rather than assembling stale or
  // wrong data.
  return {
    ok: false,
    error: "This timer workspace isn't available for this meet.",
  };
}

/** Clears whichever cookies `applySeedCookies` reports as fully consumed. */
export function clearSeedCookies(
  headers: Headers,
  request: Request,
  meetId: string,
  names: string[],
): void {
  if (names.length === 0) return;
  const path = `/meets/${meetId}/timer`;
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  for (const name of names) {
    headers.append(
      "set-cookie",
      `${name}=; Path=${path}; SameSite=Lax; Max-Age=0${secure}`,
    );
  }
}
