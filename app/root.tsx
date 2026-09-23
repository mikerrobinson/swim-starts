import {
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
import { currentUser, type SyncEnv } from "./lib/api.server";
import { isTimingPath } from "./lib/timer-path";
import { sessionPayload } from "./lib/auth.server";
import { SIGNED_OUT } from "./state/session";
import "./app.css";

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  if (!env.DB) return { session: SIGNED_OUT };

  const user = await currentUser(request, env);
  // A phone with no cookie — every timer, and every first visit — costs
  // nothing here: there is no token to look up.
  if (!user) return { session: SIGNED_OUT };

  return { session: await sessionPayload(env.DB, user) };
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
