import { redirect } from "react-router";
import type { Route } from "./+types/session";
import { currentUser } from "~/lib/api.server";
import {
  bearerToken,
  endAllSessions,
  endSession,
  sessionCookie,
} from "~/lib/auth.server";

/**
 * Ending a session.
 *
 *   POST /session             -> sign out here
 *   POST /session?everywhere  -> sign out on every device
 *
 * The one thing about an account that isn't a screen of its own. Signing in is
 * the sign-in page's action and changing your contacts is the profile's; this
 * is reachable from the account menu on every page, so it has nowhere else to
 * live.
 *
 * "Everywhere" is the answer to a lost phone, which is why it's offered next
 * to the ordinary one rather than buried: the moment you need it, you need it
 * from whatever device you still have.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB;
  const user = await currentUser(request, db);

  // In the query rather than the body, so this reads nothing off the request
  // but the cookie. Signing out is the move most likely to be reached from a
  // page in a strange state, and a body is one more thing that can be missing.
  if (user) {
    if (new URL(request.url).searchParams.has("everywhere")) {
      await endAllSessions(db, user.id);
    } else {
      const token = bearerToken(request);
      if (token) await endSession(db, token);
    }
  }

  // Cleared whatever the server made of it. A token already dead should still
  // leave the device signed out, or signing out would appear not to work in
  // exactly the case it is needed.
  return redirect("/sign-in", {
    headers: { "set-cookie": sessionCookie(null, request) },
  });
}
