import {
  data,
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import { ViewPrefsProvider } from "./state/view-prefs";
import { OutboxProvider } from "./state/outbox";
import { currentUser, resolveUser, type SyncEnv } from "./lib/api.server";
import { isTimingPath } from "./lib/timer-path";
import { sessionPayload } from "./lib/auth.server";
import { SIGNED_OUT } from "./state/session";
import { deviceCookie, existingDeviceId } from "./lib/device.server";
import "./app.css";

/**
 * The identity facts read once here, from cookies, so no route below has to
 * re-derive them: who's signed in, the athlete their account is linked to,
 * every team they coach, and which device this is — the identity a phone
 * with nobody signed into it still has, same cookie the timer workspace
 * already used. `resolveUser` (`api.server.ts`) is the shared resolution;
 * `useUser()` (`state/user.tsx`) is the client-side read of what it
 * resolves here.
 *
 * This is deliberately *not* a per-meet access decision — whether someone
 * may administer meet X still has to ask D1 about meet X specifically
 * (`access.ts`'s `canEditMeet`, given the meet each route already loaded).
 * What's here is meet-agnostic: facts about the person, not about what
 * they may do on any one meet.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const user = env.DB ? await currentUser(request, env) : null;
  const identity = await resolveUser(env.DB, user, request);

  // Minted once, on whatever request happens to be first — every timer, and
  // every first visit of any kind — and carried in a cookie from then on.
  const headers = new Headers();
  if (!existingDeviceId(request)) {
    headers.append("set-cookie", deviceCookie(identity.deviceId, request));
  }

  // A phone with no cookie — every timer, and every first visit — costs
  // nothing here: there is no token to look up.
  const session =
    env.DB && user ? await sessionPayload(env.DB, user) : SIGNED_OUT;

  return data({ session, ...identity }, { headers });
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <link rel="manifest" href="manifest.webmanifest" />
        <link rel="apple-touch-icon" href="icon-180.png" />
        <link rel="icon" type="image/png" sizes="192x192" href="icon-192.png" />
        <link rel="icon" href="favicon.ico" sizes="any" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Swim Starts" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="application-name" content="Swim Starts" />

        <meta
          name="theme-color"
          content="#f8fafc"
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content="#020617"
          media="(prefers-color-scheme: dark)"
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Something went wrong";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "Not found" : "Error";
    details =
      error.status === 404
        ? "That page doesn't exist."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-bold">{message}</h1>
      <p className="mt-2 text-slate-600 dark:text-slate-300">{details}</p>
      {stack && (
        <pre className="mt-4 w-full overflow-x-auto rounded-xl bg-slate-100 p-4 text-xs dark:bg-slate-900">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
