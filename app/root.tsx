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
import { currentUser } from "./lib/api.server";
import { sessionPayload } from "./lib/auth.server";
import { SIGNED_OUT } from "./state/session";
import { deviceCookie, deviceId, existingDeviceId } from "./lib/device.server";
import "./app.css";
import { ViewPrefsProvider } from "./state/view-prefs";

export async function loader({ request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  const user = await currentUser(request, context.cloudflare.env.DB);
  const device = deviceId(request);

  // Minted once, on whatever request happens to be first — every timer, and
  // every first visit of any kind — and carried in a cookie from then on.
  const headers = new Headers();
  if (!existingDeviceId(request)) {
    headers.append("set-cookie", deviceCookie(device, request));
  }

  // A phone with no cookie — every timer, and every first visit — costs
  // nothing here: there is no token to look up.
  const session = db && user ? await sessionPayload(db, user) : SIGNED_OUT;

  return data({ session, user, deviceId: device }, { headers });
}

export function shouldRevalidate() {
  return false;
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
        <link
          rel="icon"
          type="image/png"
          sizes="192x192"
          href="/icon-192.png"
        />
        <link rel="icon" href="/favicon.ico" sizes="any" />
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
  return (
    <ViewPrefsProvider>
      <Outlet />
    </ViewPrefsProvider>
  );
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
