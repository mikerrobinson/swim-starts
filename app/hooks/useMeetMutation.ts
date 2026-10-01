import { useCallback, useRef } from "react";
import { useRevalidator } from "react-router";
import { cookieOutbox } from "~/lib/cookieOutbox";
import { meetCache } from "~/lib/meetCache";
import type { EntityMutation } from "~/types/mutations";

export function useMeetMutation(meetId: string) {
  const revalidator = useRevalidator();

  // Keep a mutable ref to the latest revalidator instance
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  const send = useCallback(
    (mutation: EntityMutation) => {
      // 1. Persist to outbox cookie (for offline durability)
      void cookieOutbox.enqueue(meetId, mutation);

      // 12 Mutate local RAM and revalidate loader data immediately (0ms UI paint)
      meetCache.applyPatch(meetId, mutation, {
        onRevalidate: () => revalidatorRef.current.revalidate(),
        immediate: true,
      });

      // 3. Fire-and-forget background sync to Cloudflare DO
      fetch(`/meets/${meetId}`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
      })
        .then((res) => {
          if (!res.ok) {
            console.warn(
              `[useMeetMutation] Server status ${res.status}: mutation preserved in cookie`,
            );
          }
          // On HTTP 200, the browser processes Set-Cookie: Max-Age=0 to clear the cookie outbox
        })
        .catch((err) => {
          // Normal on a pool deck when offline; cookie remains safely in document.cookie
          console.info(
            "[useMeetMutation] Offline: mutation buffered in cookie outbox",
          );
        });
    },
    [meetId, revalidator],
  );

  return { send };
}
