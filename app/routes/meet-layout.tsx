import type { Route } from "./+types/meet-layout";

import {
  NavLink,
  Outlet,
  useLoaderData,
  useLocation,
  useMatches,
  useNavigation,
} from "react-router";
import { useEffect, useState } from "react";
import { getMeet } from "~/lib/meets.server";
import { readResultsManifest } from "~/lib/results.server";
import { meetCache, type LiveSocketMessage } from "~/lib/meetCache";
import { AccountMenu } from "~/components/AccountMenu";
import { HeaderToggles } from "~/components/HeaderToggles";
import type { MeetRouteHandle } from "~/lib/route-handle";
import { meetSubtitle, type MeetManifest } from "~/types/meet";

export async function loader({ params, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  const meetId = params.meetId!;

  const [meetFacts] = await Promise.all([getMeet(db, meetId)]);
  if (!meetFacts) throw new Response("Meet Not Found", { status: 404 });

  if (meetFacts.status === "complete") {
    return { meet: await readResultsManifest(meetId, db) };
  }

  const stub = context.cloudflare.env.MEET_DO.getByName(meetId);
  return { meet: await stub.getMeetManifest(meetId) };
}

export async function clientLoader({
  params,
  serverLoader,
}: Route.ClientLoaderArgs) {
  const meetId = params.meetId!;
  const cached = meetCache.getMeet(meetId);

  if (cached) {
    serverLoader()
      .then((fresh) => {
        meetCache.saveMeet(meetId, fresh.meet);
      })
      .catch(() => {});
    return { meet: cached };
  }

  const fresh = await serverLoader();
  meetCache.saveMeet(meetId, fresh.meet);
  return fresh;
}
clientLoader.hydrate = true;

export function shouldRevalidate() {
  return false;
}

export default function MeetRootLayout() {
  const { meet } = useLoaderData<typeof loader>();
  const [connected, setConnected] = useState(true);
  const location = useLocation();
  const navigation = useNavigation();
  const matches = useMatches();

  const leafHandle = matches[matches.length - 1]?.handle as
    | MeetRouteHandle
    | undefined;
  const toggleGroup =
    leafHandle?.headerToggle?.({
      pathname: location.pathname,
      searchParams: new URLSearchParams(location.search),
      meet,
    }) ?? null;

  // TBD: limit by role
  const tabs = [
    { to: "/meets", label: "Meets", icon: "‹" },
    { to: `/meets/${meet.id}`, label: "Info", icon: "📄" },
    { to: `/meets/${meet.id}/entries`, label: "Entries", icon: "📋" },
    { to: `/meets/${meet.id}/admin`, label: "Admin", icon: "🖥️" },
    { to: `/meets/${meet.id}/splits`, label: "Splits", icon: "⏱️" },
    { to: `/meets/${meet.id}/results`, label: "Results", icon: "🏅" },
  ];
  const isTimingRoute = location.pathname.includes("/timer");

  const status: { text: string; tone: string } | null =
    navigation.state !== "idle"
      ? {
          text: "Loading…",
          tone: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
        }
      : null;

  const subtitle = meetSubtitle(meet.details);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {!isTimingRoute && (
        <header className="sticky top-0 z-30 h-[var(--app-chrome-top)] border-b border-slate-200 bg-white/95 pt-[env(safe-area-inset-top)] backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
          <div
            className={`mx-auto grid h-full items-center gap-3 px-4 ${
              toggleGroup
                ? "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
                : "grid-cols-[minmax(0,1fr)_auto]"
            } "max-w-none"`}
          >
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold leading-tight">
                {meet.name}
              </h1>
              {subtitle && (
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {subtitle}
                </p>
              )}
            </div>

            {toggleGroup && (
              <div className="justify-self-center">
                <HeaderToggles
                  label={toggleGroup.label}
                  options={toggleGroup.options}
                />
              </div>
            )}

            {/* Status and the account control share the right-hand cell. The
              chip is about what the app is doing; the circle is about the
              person. */}
            <div className="flex items-center gap-2 justify-self-end">
              {status && (
                <span
                  className={`rounded-full px-2 py-1 text-xs font-semibold ${status.tone}`}
                >
                  {status.text}
                </span>
              )}
              <AccountMenu />
            </div>
          </div>
        </header>
      )}

      {/* Bottom padding clears the fixed tab bar, including the iOS home bar.
          The full-width screens opt out of the centered column so their own
          grids can spread across the full window. */}
      <main className="mx-auto px-4 pt-4 pb-[calc(var(--app-chrome-bottom)+1rem)] max-w-none">
        {/* Headless socket listener living safely at the layout boundary */}
        {meet.status !== "complete" && (
          <LiveMeetSync meetId={meet.id} onConnectedChange={setConnected} />
        )}
        <Outlet />
      </main>

      {!isTimingRoute && (
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-slate-800 dark:bg-slate-900">
          <div className="mx-auto flex h-[var(--app-nav-h)] max-w-3xl">
            {tabs.map((tab) => {
              // The back arrow points at the meet list, which would otherwise
              // light up as the active tab while you're inside a meet.
              const isBackLink = tab.to === "/meets";
              return (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  className={({ isActive }) =>
                    `flex flex-1 touch-manipulation flex-col items-center justify-center gap-0.5 text-xs font-semibold transition-colors ${
                      isActive && !isBackLink
                        ? "text-blue-600 dark:text-blue-400"
                        : "text-slate-500 dark:text-slate-400"
                    }`
                  }
                >
                  <span aria-hidden className="text-xl leading-none">
                    {tab.icon}
                  </span>
                  {tab.label}
                </NavLink>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}

/** How long to wait before each successive reconnect attempt — the same
 *  ladder `meet-live.ts` uses for the old model's own live connection. */
const RECONNECT_MS = [1000, 3000, 8000, 20_000];

/**
 * The only place a WebSocket exists in the client codebase.
 *
 * A message patches `meetCache`'s in-memory copy of the manifest directly,
 * in place, and — only if that patch actually changed something —
 * revalidates so the active route's `clientLoader` re-reads it. No React
 * state here of its own beyond the connection bookkeeping below — this
 * component still renders nothing, so a lane timer mid-stopwatch never
 * repaints because Lane 1 three heats away touched the wall.
 *
 * Reconnects on its own with backoff rather than leaving a dropped socket
 * dropped: a phone that sleeps or loses signal for a few seconds shouldn't
 * need a reload to start hearing about the meet again. `onConnectedChange`
 * is the only way that state leaves this component — no module-level
 * connection registry the way `meet-live.ts` has one, because there is
 * only ever this one socket for this one mounted instance, never several
 * components sharing it.
 */
function LiveMeetSync({
  meetId,
  onConnectedChange,
}: {
  meetId: string;
  onConnectedChange: (connected: boolean) => void;
}) {
  useEffect(() => {
    let stopped = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    const handleVisibilityChange = () => {
      // If mutations landed while backgrounded, flush the debounced
      // re-render immediately rather than waiting out the coalescing
      // window — the tab is back, so there's no more bursting to wait for.
      if (document.visibilityState === "visible") {
        meetCache.flushNotify(meetId);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    const connect = () => {
      if (stopped) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${protocol}//${window.location.host}/api/meets/${meetId}/live`,
      );
      ws = socket;

      socket.onopen = () => {
        reconnectAttempt = 0;
        onConnectedChange(true);
      };

      socket.onmessage = (event) => {
        console.log("GOT MESSAGE ", event.data);
        if (typeof event.data !== "string") return;
        let msg: LiveSocketMessage;
        try {
          msg = JSON.parse(event.data) as LiveSocketMessage;
        } catch {
          return; // Not something we sent; not something we can apply.
        }
        meetCache.applyPatch(meetId, msg);
      };

      socket.onclose = () => {
        // A reconnect already in flight replaced `ws` with a newer socket
        // before this one's own close event caught up — its retry is the
        // one that should run, not a second one from this stale handler.
        if (stopped || ws !== socket) return;
        onConnectedChange(false);
        const delay =
          RECONNECT_MS[Math.min(reconnectAttempt, RECONNECT_MS.length - 1)];
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      // A socket that errors also closes; `onclose` above is what actually
      // schedules the retry, so this only needs to hurry that along.
      socket.onerror = () => socket.close();
    };

    connect();

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [meetId, onConnectedChange]);

  return null;
}
