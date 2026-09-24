import type { Route } from "./+types/meets2";

import {
  Outlet,
  useLoaderData,
  useRevalidator,
  useRouteLoaderData,
} from "react-router";
import { useEffect, useState } from "react";
import { requireDb, type SyncEnv } from "~/lib/api.server";
import { getMeetGate } from "~/lib/meets.server";
import { readResultsManifest } from "~/lib/results.server";
import { meetCache, type LiveSocketMessage } from "~/lib/meetCache";
import type { MeetManifest } from "~/types/meet";

/**
 * The shell for the MeetManifest-shaped client (see `app/types/meet.ts`'s
 * `MeetManifest` and `app/lib/meetCache.ts`): one loader hands back a single
 * manifest, `clientLoader` caches it so a child route can render instantly —
 * even offline — and `LiveMeetSync` below is the *only* place a WebSocket
 * exists in this tree. Everything under `<Outlet/>` reads the manifest via
 * `useLoaderData`/`useRouteLoaderData` rather than holding a subscription of
 * its own; a socket message lands in `meetCache`, which nudges Remix to
 * re-run `clientLoader`, which is what actually updates the screen.
 *
 * Where the manifest comes from depends on the one thing D1 needs to answer
 * before anything else: is this meet `"complete"`? If so, everything —
 * events, swims, results — is read straight from D1's `results` archive and
 * the meet's Durable Object is never woken. Otherwise, the DO is the whole
 * story: `getMeetGate` is the only D1 read this path makes.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  const db = requireDb(env as SyncEnv);
  const meetId = params.meetId!;

  const gate = await getMeetGate(db, meetId);
  if (!gate) throw new Response("Meet Not Found", { status: 404 });

  if (gate.status === "complete") {
    return { meet: await readResultsManifest(meetId, db) };
  }

  const stub = env.MEET_DO.getByName(meetId);
  return { meet: await stub.getMeetManifest(meetId) };
}

/** Cache-first, stale-while-revalidate: render whatever's already in
 *  `meetCache` (memory, or localStorage on a cold load) so the workspace is
 *  usable the instant it mounts, then quietly replace it with the server's
 *  copy once that lands. */
export async function clientLoader({
  params,
  serverLoader,
}: Route.ClientLoaderArgs) {
  const meetId = params.meetId!;
  const cached = meetCache.getMeet(meetId);

  if (cached) {
    serverLoader()
      .then((fresh) => meetCache.saveMeet(meetId, fresh.meet))
      .catch(() => {});
    return { meet: cached };
  }

  const fresh = await serverLoader();
  meetCache.saveMeet(meetId, fresh.meet);
  return fresh;
}
clientLoader.hydrate = true;

export default function MeetRootLayout() {
  const { meet } = useLoaderData<typeof loader>();
  const [connected, setConnected] = useState(true);

  return (
    <>
      {/* Headless socket listener living safely at the layout boundary */}
      {meet.isLive && (
        <LiveMeetSync meetId={meet.id} onConnectedChange={setConnected} />
      )}
      <Outlet />
    </>
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
  const revalidator = useRevalidator();

  useEffect(() => {
    let stopped = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

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
        if (typeof event.data !== "string") return;
        let msg: LiveSocketMessage;
        try {
          msg = JSON.parse(event.data) as LiveSocketMessage;
        } catch {
          return; // Not something we sent; not something we can apply.
        }
        meetCache.applyPatch(meetId, msg, () => revalidator.revalidate());
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
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [meetId, revalidator, onConnectedChange]);

  return null;
}

export function useMeet(): MeetManifest {
  const data = useRouteLoaderData<typeof loader>("routes/meets2");
  if (!data?.meet) throw new Error("useMeet used outside a meet route");
  return data.meet;
}
