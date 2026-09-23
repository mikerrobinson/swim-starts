/**
 * What every timer request needs before it can do anything: who's allowed in,
 * which phone this is, and the meet's own state merged with the DO's live
 * tables. Shared by the timer shell's `loader` and the per-lane `action`,
 * since both have to resolve exactly the same things before applying a
 * seed cookie against them.
 */

import { requireDb } from "./api.server";
import { deviceCookie, deviceId, existingDeviceId } from "./device.server";
import { grantToken } from "~/lib/grants.server";
import { grantFor } from "~/lib/grants.server";
import { type Grant } from "~/lib/grants.server";
import { meetDetail } from "./meets.server";
import type { MeetDurableObject } from "./meet-do.server";
import { withLiveTables, type MeetDetail } from "~/types/meet";

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

  const loaded = await meetDetail(db, meetId);
  if (!loaded) {
    return { ok: false, error: "That meet is no longer on the server" };
  }

  const stub = env.MEET_DO.getByName(meetId);
  const live = await stub.getSnapshot(meetId);
  const detail = withLiveTables(loaded, live);

  const known = existingDeviceId(request);
  const timerId = known ?? deviceId(request);

  return {
    ok: true,
    value: {
      db,
      stub,
      grant,
      timerId,
      detail,
      deviceCookie: known ? undefined : deviceCookie(timerId, request),
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
