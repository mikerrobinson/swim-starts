// app/utils/session.server.ts
import { createCookieSessionStorage, redirect } from "react-router";

// 1. Set up your session storage
const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__session",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secrets: [env.SESSION_SECRET || "default_secret"],
    secure: env.NODE_ENV === "production",
  },
});

// 2. Helper to get the raw session
export function getSession(request: Request) {
  return sessionStorage.getSession(request.headers.get("Cookie"));
}

/**
 * Mandates a valid user session.
 * If found, returns the user ID (or user object).
 * If missing, throws a redirect to the login page immediately.
 */
export async function requireUser(request: Request) {
  const session = await getSession(request);
  const userId = session.get("userId");

  // If there's no user ID in the cookie session, boot them out
  if (!userId) {
    throw redirect("/login");
  }

  return userId; // Or fetch and return the full user object from your DB here
}
