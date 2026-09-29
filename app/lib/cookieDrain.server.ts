import type { LiveSocketMessage } from "./meetCache";

// app/lib/cookieDrain.server.ts
const COOKIE_PREFIX = "__mb_";

export interface DrainResult {
  mutations: LiveSocketMessage[];
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
  const mutations: LiveSocketMessage[] = [];
  const clearHeaders = new Headers();
  const path = `/meets/${meetId}`;

  for (const cookie of cookies) {
    if (!cookie.startsWith(COOKIE_PREFIX)) continue;

    const [rawName, rawValue] = cookie.split("=");
    if (!rawName || !rawValue) continue;

    try {
      const decodedValue = JSON.parse(decodeURIComponent(rawValue));

      // 1. Parse Watch Cookie: __mb_e_${eventId}_${heat}_${lane}_${userId}_${slot}
      if (rawName.startsWith(`${COOKIE_PREFIX}e_`)) {
        const parts = rawName.replace(`${COOKIE_PREFIX}e_`, "").split("_");
        const [eventId, athleteId] = parts;

        mutations.push({
          type: "ENTRY",
          entry: {
            eventId,
            athleteId,
            teamId: decodedValue.teamId,
            exhibition: false,
            enteredAt: Date.now(),
            enteredBy: "",
          },
          isDelete: decodedValue.d,
        });
      }

      //   // 2. Parse Swim Status Cookie: __mb_s_${eventId}_${heat}_${lane}
      //   else if (rawName.startsWith(`${COOKIE_PREFIX}s_`)) {
      //     const parts = rawName.replace(`${COOKIE_PREFIX}s_`, "").split("_");
      //     const [eventId, heatStr, laneStr] = parts;

      //     mutations.push({
      //       type: "SWIM_STATUS_UPDATED",
      //       swim: {
      //         eventId,
      //         heat: Number(heatStr),
      //         lane: Number(laneStr),
      //       },
      //       status: decodedValue.st,
      //       officialTimeMs: decodedValue.ot,
      //     });
      //   }

      // Instruct browser to delete this processed cookie
      clearHeaders.append(
        "Set-Cookie",
        `${rawName}=; Path=${path}; Max-Age=0; SameSite=Lax; Secure`,
      );
    } catch (err) {
      console.error("Failed to parse outbox cookie:", rawName, err);
    }
  }

  return { mutations, clearHeaders };
}
