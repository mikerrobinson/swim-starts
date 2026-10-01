// app/lib/cookieOutbox.ts
import type { EntityMutation } from "~/types/mutations";
import type { LiveSocketMessage } from "./meetCache";

export const COOKIE_PREFIX = "__mb_";

export interface OutboxCookieItem {
  cookieName: string;
  meetId: string;
  message: LiveSocketMessage;
}

export function serializeCookieMutation(
  meetId: string,
  mutation: EntityMutation,
) {
  let name = "";

  switch (mutation.entity) {
    case "watch": {
      const k = mutation.key;
      name = `__mb_w_${k.eventId}_${k.heat}_${k.lane}_${k.deviceId}_${k.slot}`;
      break;
    }
    case "swim": {
      const k = mutation.key;
      name = `__mb_s_${k.eventId}_${k.heat}_${k.lane}`;
      break;
    }
    case "athlete": {
      name = `__mb_a_${mutation.key.id}`;
      break;
    }
    case "entry": {
      name = `__mb_e_${mutation.key.eventId}_${mutation.key.athleteId}`;
      break;
    }
  }

  // Tombstone representation
  const value =
    mutation.op === "delete"
      ? encodeURIComponent(JSON.stringify({ _del: 1 }))
      : encodeURIComponent(JSON.stringify(mutation.patch));

  return { name, value };
}

class CookieOutboxManager {
  /**
   * Sets a mutation cookie scoped to the active meet path.
   * Runs synchronously in document.cookie (0ms).
   */
  enqueue(meetId: string, message: EntityMutation): void {
    if (typeof document === "undefined") return;

    const { name, value } = serializeCookieMutation(meetId, message);
    const path = `/meets/${meetId}`;

    // Non-HttpOnly so client JS can write; 7-day TTL; SameSite=Lax
    document.cookie = `${name}=${value}; Path=${path}; Max-Age=604800; SameSite=Lax`;
  }

  /**
   * Removes a cookie on the client if it was processed out-of-band via WebSocket.
   */
  clear(meetId: string, cookieName: string): void {
    if (typeof document === "undefined") return;
    const path = `/meets/${meetId}`;
    document.cookie = `${cookieName}=; Path=${path}; Max-Age=0; SameSite=Lax; Secure`;
  }

  /**
   * Scans document.cookie for any pending outbox items for this meet.
   */
  getPendingCount(): number {
    if (typeof document === "undefined") return 0;
    return document.cookie
      .split(";")
      .filter((c) => c.trim().startsWith(COOKIE_PREFIX)).length;
  }
}

export const cookieOutbox = new CookieOutboxManager();
