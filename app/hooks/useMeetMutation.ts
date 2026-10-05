import { useCallback } from "react";
import { cookieOutbox } from "~/lib/cookieOutbox";
import { meetCache } from "~/lib/meetCache";
import type { EntityMutation } from "~/types/mutations";

export function useMeetMutation(meetId: string) {
  const send = useCallback(
    (mutation: EntityMutation) => {
      // 1. Durability outbox
      void cookieOutbox.enqueue(meetId, mutation);

      // 2. Synchronous in-memory mutation with instant subscriber notification
      meetCache.applyPatch(meetId, mutation, { immediate: true });

      // 3. Fire-and-forget sync to Cloudflare DO
      fetch(`/meets/${meetId}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
      }).catch(() => {
        meetCache.markStale(meetId);
        console.info(
          "[useMeetMutation] Offline: mutation buffered in cookie outbox",
        );
      });
    },
    [meetId],
  );

  return { send };
}
