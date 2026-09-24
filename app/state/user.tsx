import { useRouteLoaderData } from "react-router";
import type { loader as rootLoader } from "~/root";
import { ANONYMOUS_USER, type UserIdentity } from "~/lib/access";

export type { UserIdentity };

/**
 * Who's asking — read once at the root from cookies (`root.tsx`'s loader,
 * via `resolveUser`), rather than every route re-deriving it.
 *
 * Deliberately *not* a per-meet access decision: whether this person may
 * administer meet X still has to ask D1 about meet X specifically, via
 * `access.ts`'s `canEditMeet({ meet, user })` — this is only the
 * meet-agnostic half, who they are rather than what they may do on any one
 * meet. A screen passes this straight into that predicate alongside
 * whichever `meet` it already loaded.
 */
export function useUser(): UserIdentity {
  const data = useRouteLoaderData<typeof rootLoader>("root");
  if (!data) return ANONYMOUS_USER;
  return {
    userId: data.userId,
    athleteId: data.athleteId,
    coachOf: data.coachOf,
    deviceId: data.deviceId,
    signedIn: data.signedIn,
  };
}
