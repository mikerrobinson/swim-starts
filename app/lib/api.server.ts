/**
 * Shared plumbing for the API routes: the database binding, the two response
 * shapes, and the two ways a caller can prove who it is. The syncing itself
 * lives in `sync.server.ts`, and accounts in `auth.server.ts`.
 */

import { bearerToken, userForToken } from "./auth.server";
import type { NotifyEnv } from "./notify.server";
import type { User } from "~/types/user";

export interface SyncEnv extends NotifyEnv {
  DB?: D1Database;
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

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
  if (error instanceof SyncError) {
    return json({ error: error.message }, error.status);
  }
  console.error("Sync failure:", error);
  return json({ error: "Server error" }, 500);
}


export function requireDb(env: SyncEnv): D1Database {
  if (!env.DB) {
    throw new SyncError(
      "No D1 database is bound to this worker (expected a binding named DB)",
      503,
    );
  }
  return env.DB;
}

/** Whoever is signed in on this request, or null. */
export async function currentUser(
  request: Request,
  env: SyncEnv,
): Promise<User | null> {
  if (!env.DB) return null;
  return userForToken(env.DB, bearerToken(request));
}

export async function requireUser(request: Request, env: SyncEnv): Promise<User> {
  const user = await currentUser(request, env);
  if (!user) throw new SyncError("Sign in first", 401);
  return user;
}

export async function readJson<T>(request: Request): Promise<T> {
  const body = (await request.json().catch(() => null)) as T | null;
  if (!body || typeof body !== "object") {
    throw new SyncError("Expected a JSON body", 400);
  }
  return body;
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
