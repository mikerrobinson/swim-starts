/**
 * Shared plumbing for the API routes: the database binding, the two response
 * shapes, and the two ways a caller can prove who it is. The syncing itself
 * lives in `sync.server.ts`, and accounts in `auth.server.ts`.
 */

import { bearerToken, userForToken } from "./auth.server";
import type { User } from "~/types/user";

export function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function errorResponse(error: unknown): Response {
  console.error("API failure:", error);
  return json({ error: "Server error" }, 500);
}

/** Whoever is signed in on this request, or null. */
export async function currentUser(
  request: Request,
  db: D1Database,
): Promise<User | null> {
  if (!db) return null;
  return userForToken(db, bearerToken(request));
}

export async function requireUser(
  request: Request,
  db: D1Database,
): Promise<User> {
  const user = await currentUser(request, db);
  if (!user) throw new Error("Sign in first");
  return user;
}

/**
 * Where the app lives, worked out from the request rather than from anything
 * the caller said.
 *
 * This ends up in an emailed link, so it must not be something a caller can
 * choose — otherwise asking for a code to someone else's address would be a
 * way to send them a link to your own site. Only the origin comes from the
 * request; the path under it is the router's own basename, the same value
 * `root.tsx` builds its icon and manifest links from.
 *
 * It used to find the base by cutting `/api/` off the pathname, which was true
 * only while every link was minted by an endpoint under `/api/`. An invitation
 * sent from a screen's own action is posted to that screen's URL, and the
 * trick would have quietly produced a link to the domain root.
 */
export function appBaseUrl(request: Request): string {
  return `${new URL(request.url).origin}${import.meta.env.BASE_URL}`;
}
