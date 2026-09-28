import { useCallback, useMemo } from "react";
import { useFetcher, useRevalidator, useRouteLoaderData } from "react-router";
import type { loader as rootLoader } from "~/root";

/**
 * Who's signed in, as the screens see it.
 *
 * Not a store and not a fetch: the root loader answered this before the page
 * was rendered, and this reads that answer. What it replaced was a provider
 * that fetched `/api/auth/session` on every boot, kept the result in
 * localStorage so an offline reload had something to show, and carried a
 * `stale` flag to say which of the two you were looking at — three mechanisms
 * standing in for a cookie the browser was sending anyway.
 *
 * It keeps the name and the shape it had, so the screens that read it did not
 * have to change when the machinery underneath did.
 */

export interface SessionUser {
  id: string;
  contact: string;
  contactKind: string;
  name: string | null;
  lastSeasonId: string | null;
}

/** A team, as the session knows it: what it's called and how big it is. */
export interface SessionTeam {
  teamId: string;
  name: string;
  code: string;
  athletes: number;
  meets: number;
}

export interface JoinableTeam extends SessionTeam {
  /** False when nobody coaches it yet, which is what makes it claimable. */
  claimed: boolean;
}

export interface Session {
  user: SessionUser | null;
  /** The teams this person coaches. There is no other standing to have. */
  teams: SessionTeam[];
  openTeamId: string | null;
}

/** A signed-out session, so callers never have to handle a null of their own. */
export const SIGNED_OUT: Session = {
  user: null,
  teams: [],
  openTeamId: null,
};

interface SessionState extends Session {
  /**
   * "in" or "out", and never "loading".
   *
   * There is no third state left to be in: the page arrived knowing. The
   * screens still ask, because "signed in" is a question they genuinely have.
   */
  status: "in" | "out";
  /** Ask the server again — after something changed who you are to it. */
  refresh: () => Promise<void>;
  signOut: (everywhere?: boolean) => void;
}

export function useSession(): SessionState {
  const data = useRouteLoaderData<typeof rootLoader>("root");
  const revalidator = useRevalidator();
  const out = useFetcher();

  const session = data?.session ?? SIGNED_OUT;

  const refresh = useCallback(
    () => revalidator.revalidate(),
    // The revalidator is rebuilt each render; calling it is the whole body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /**
   * Sign out, here or on every device.
   *
   * A submission rather than a fetch, because ending a session is a write and
   * the page around it has to be re-read afterwards — which is exactly what a
   * fetcher does for free. The redirect lands whoever did it on the sign-in
   * screen, so no caller has to arrange that either.
   */
  const signOut = useCallback(
    (everywhere = false) => {
      out.submit(null, {
        method: "post",
        action: everywhere ? "/session?everywhere" : "/session",
      });
    },
    // Submitting is the effect; the fetcher identity is not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return useMemo(
    () => ({
      ...session,
      status: session.user ? "in" : "out",
      refresh,
      signOut,
    }),
    [session, refresh, signOut],
  );
}
