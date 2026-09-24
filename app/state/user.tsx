import { useRouteLoaderData } from "react-router";
import type { loader as rootLoader } from "~/root";
import type { User } from "~/types/user";

export type { User };

/**
 * Who's signed in — read once at the root from the session cookie
 * (`root.tsx`'s loader, via `currentUser`), rather than every route
 * re-deriving it. `null` when signed out.
 *
 * Deliberately just the account. Whether this person may administer meet X
 * or coaches team Y is never carried here — that's a fact about meet X or
 * team Y (`access.ts`'s predicates, given the `id` this returns and
 * whatever the screen already loaded), not a standing property of a
 * signed-in person.
 */
export function useUser(): User | null {
  const data = useRouteLoaderData<typeof rootLoader>("root");
  return data?.user ?? null;
}

/**
 * Which browser this is, independent of whether anyone is signed in — the
 * identity a phone with nobody signed into it still has.
 */
export function useDeviceId(): string {
  const data = useRouteLoaderData<typeof rootLoader>("root");
  return data?.deviceId ?? "";
}
