// app/lib/cookieOutbox.ts
import type { LiveSocketMessage } from "./meetCache";

const COOKIE_PREFIX = "__mb_";

export interface OutboxCookieItem {
  cookieName: string;
  meetId: string;
  message: LiveSocketMessage;
}

/**
 * Encodes a domain message into a deterministic, path-scoped cookie name & value.
 * Example cookie name: __mb_w_101_1_4_u1_s0 (Event 101, Heat 1, Lane 4, User 1, Slot 0)
 */
function serializeMutation(
  meetId: string,
  msg: LiveSocketMessage,
): { name: string; value: string } {
  switch (msg.type) {
    case "ENTRY": {
      const w = msg.entry;
      const name = `${COOKIE_PREFIX}e_${w.eventId}_${w.athleteId}`;
      // Compact JSON or delimited string: timeMs:startedAt:stoppedAt
      const value = encodeURIComponent(
        JSON.stringify({
          d: msg.isDelete,
          teamId: w.teamId,
        }),
      );
      return { name, value };
    }

    // case "SWIM_STATUS_UPDATED": {
    //   const s = msg.swim;
    //   const name = `${COOKIE_PREFIX}s_${s.eventId}_${s.heat}_${s.lane}`;
    //   const value = encodeURIComponent(JSON.stringify({
    //     st: msg.status,
    //     ot: msg.officialTimeMs ?? null,
    //   }));
    //   return { name, value };
    // }

    default:
      throw new Error(`Unsupported cookie outbox message type: ${msg.type}`);
  }
}

class CookieOutboxManager {
  /**
   * Sets a mutation cookie scoped to the active meet path.
   * Runs synchronously in document.cookie (0ms).
   */
  enqueue(meetId: string, message: LiveSocketMessage): void {
    if (typeof document === "undefined") return;

    const { name, value } = serializeMutation(meetId, message);
    const path = `/meets/${meetId}`;

    // Non-HttpOnly so client JS can write; 7-day TTL; SameSite=Lax
    document.cookie = `${name}=${value}; Path=${path}; Max-Age=604800; SameSite=Lax; Secure`;
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
