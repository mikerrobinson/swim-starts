/**
 * What every timer request needs before it can do anything: is this a valid,
 * unexpired scan of this meet's code, and which device is this. Shared by
 * the timer shell's `loader` and the per-lane `action`/`loader`, since both
 * have to answer exactly the same question before touching anything.
 *
 * The meet's own live state — events, swims, watches, athletes — comes from
 * `useMeet()` (`meet-layout.tsx`'s shared manifest) like every other screen under
 * a meet now; this module is only about *who's asking*, not what they see.
 */

import { requireDb } from "./api.server";
import { grantToken, grantFor } from "~/lib/grants.server";
import { deviceId, deviceCookie, existingDeviceId } from "./device.server";

export interface TimerAccess {
  db: D1Database;
  deviceId: string;
  /** Set only when this request minted a device id nobody had yet. */
  deviceCookie?: string;
}

export type TimerAccessResult =
  | { ok: true; value: TimerAccess }
  | { ok: false; error: string };

export async function resolveTimerAccess(
  request: Request,
  env: Env,
  meetId: string,
): Promise<TimerAccessResult> {
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

  const id = deviceId(request);
  return {
    ok: true,
    value: {
      db,
      deviceId: id,
      deviceCookie: existingDeviceId(request)
        ? undefined
        : deviceCookie(id, request),
    },
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
