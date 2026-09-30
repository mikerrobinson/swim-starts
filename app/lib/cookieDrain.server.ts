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
      const isDelete = parsedValue?._del === 1;

      if (rawName.startsWith(`${COOKIE_PREFIX}e_`)) {
        const parts = rawName.slice(`${COOKIE_PREFIX}e_`.length).split("_");
        if (parts.length >= 5) {
          const [eventId, athleteId] = parts;
          const key = {
            eventId,
            athleteId,
          };

          if (isDelete) {
            mutations.push({
              entity: "entry",
              op: "delete",
              key,
            });
          } else {
            mutations.push({
              entity: "entry",
              op: "upsert",
              key,
              patch: parsedValue,
            });
          }
        }
      }

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
