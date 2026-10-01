import type { EntityMutation } from "~/types/mutations";
import { COOKIE_PREFIX } from "./cookieOutbox";

export interface DrainResult {
  mutations: EntityMutation[];
  clearHeaders: Headers;
}

/**
 * Parses all pending outbox cookies from the request, converts them to domain
 * messages, and produces Set-Cookie headers that delete them.
 */
export function drainOutboxCookies(
  request: Request,
  meetId: string,
): DrainResult {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const mutations: EntityMutation[] = [];
  const clearHeaders = new Headers();
  const path = `/meets/${meetId}`;

  for (const cookie of cookies) {
    if (!cookie.startsWith(COOKIE_PREFIX)) continue;

    const [rawName, rawValue] = cookie.split("=");
    if (!rawName || !rawValue) continue;

    try {
      const parsedValue = JSON.parse(decodeURIComponent(rawValue));
      const parts = rawName.slice(`${COOKIE_PREFIX}e_`.length).split("_");

      if (rawName.startsWith(`${COOKIE_PREFIX}e_`)) {
        const mutation = getEntryMutationFromCookie(parts, parsedValue);
        if (mutation) mutations.push(mutation);
      } else if (rawName.startsWith(`${COOKIE_PREFIX}w_`)) {
        const mutation = getWatchMutationFromCookie(parts, parsedValue);
        if (mutation) mutations.push(mutation);
      } else if (rawName.startsWith(`${COOKIE_PREFIX}s_`)) {
        const mutation = getSwimMutationFromCookie(parts, parsedValue);
        if (mutation) mutations.push(mutation);
      } else if (rawName.startsWith(`${COOKIE_PREFIX}a_`)) {
        const mutation = getAthleteMutationFromCookie(parts, parsedValue);
        if (mutation) mutations.push(mutation);
      }

      // Instruct browser to delete this processed cookie
      clearHeaders.append(
        "Set-Cookie",
        `${rawName}=; Path=${path}; Max-Age=0; SameSite=Lax;`,
      );
    } catch (err) {
      console.error("Failed to parse outbox cookie:", rawName, err);
    }
  }

  return { mutations, clearHeaders };
}

function getEntryMutationFromCookie(
  [eventId, athleteId]: string[],
  value: any,
): EntityMutation | undefined {
  const key = {
    eventId,
    athleteId,
  };
  if (value?._del === 1) {
    return {
      entity: "entry",
      op: "delete",
      key,
    };
  } else {
    return {
      entity: "entry",
      op: "upsert",
      key,
      patch: value,
    };
  }
}

function getAthleteMutationFromCookie(
  [id]: string[],
  value: any,
): EntityMutation | undefined {
  const key = {
    id,
  };
  if (value?._del === 1) {
    return {
      entity: "athlete",
      op: "delete",
      key,
    };
  } else {
    return {
      entity: "athlete",
      op: "upsert",
      key,
      patch: value,
    };
  }
}

function getWatchMutationFromCookie(
  [eventId, heat, lane, deviceId, slot]: string[],
  value: any,
): EntityMutation | undefined {
  const key = {
    eventId,
    heat: Number(heat),
    lane: Number(lane),
    deviceId,
    slot: Number(slot),
  };
  if (value?._del === 1) {
    return {
      entity: "watch",
      op: "delete",
      key,
    };
  } else {
    return {
      entity: "watch",
      op: "upsert",
      key,
      patch: value,
    };
  }
}

function getSwimMutationFromCookie(
  [eventId, heat, lane]: string[],
  value: any,
): EntityMutation | undefined {
  const key = {
    eventId,
    heat: Number(heat),
    lane: Number(lane),
  };
  if (value?._del === 1) {
    return {
      entity: "swim",
      op: "delete",
      key,
    };
  } else {
    return {
      entity: "swim",
      op: "upsert",
      key,
      patch: value,
    };
  }
}
