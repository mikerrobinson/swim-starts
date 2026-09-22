import type { Route } from "./+types/meets2";

import {
  Outlet,
  useLoaderData,
  useLocation,
  useRevalidator,
} from "react-router";
import { useEffect } from "react";
import { meetCache } from "~/lib/meetCache";
import type { MeetManifest } from "~/types/meet";
import { toSwimKey } from "~/types/meet";

export type LoaderData = typeof loader;

export async function loader({ params, context }: Route.LoaderArgs) {
  const meetId = params.meetId!;
  const meet: MeetManifest = {
    id: "123",
    name: "Sample Meet",
    isLive: false,
    currentEventId: undefined,
    currentHeatNumber: undefined,
    events: {},
    entries: {},
    swims: {},
    watches: {},
    athletes: {},
  };
  meet.events["1"] = {
    id: "1",
    position: 1,
    eventNumber: 1,
    distance: 100,
    stroke: "Free",
    gender: "M",
    totalHeats: 1,
  };
  meet.events["2"] = {
    id: "2",
    position: 2,
    eventNumber: 2,
    distance: 200,
    stroke: "Back",
    gender: "F",
    totalHeats: 1,
  };
  // create dummy swims using toSwimKey
  meet.swims[toSwimKey({ event: 1, heat: 1, lane: 1 })] = {
    id: "s1",
    eventId: "1",
    heat: 1,
    lane: 1,
    athleteId: "a1",
    exhibition: false,
  };
  meet.swims[toSwimKey({ event: 2, heat: 1, lane: 1 })] = {
    id: "s2",
    eventId: "2",
    heat: 1,
    lane: 1,
    athleteId: "a2",
    exhibition: false,
  };

  if (!meet) {
    throw new Response("Meet Not Found", { status: 404 });
  }

  console.log("loader meet", meet);
  return { meet };
}

// ClientLoader: Cache-First stale-while-revalidate pattern for SPA transitions
export async function clientLoader({
  params,
  serverLoader,
}: Route.ClientLoaderArgs) {
  const meetId = params.meetId!;
  const cached = meetCache.getManifest(meetId);

  // Stale-While-Revalidate if cached in memory/localStorage
  if (cached) {
    serverLoader()
      .then((loaderData) => {
        if (loaderData?.meet) meetCache.saveManifest(meetId, loaderData.meet);
      })
      .catch(() => {});
    return { meet: cached };
  }

  const fresh = await serverLoader();
  meetCache.saveManifest(meetId, fresh.meet);
  return fresh;
}

export default function MeetRootLayout() {
  const { meet } = useLoaderData<typeof loader>();

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col">
      {/* Headless socket listener living safely at the layout boundary */}
      {meet.isLive && <LiveMeetSync meetId={meet.id} />}

      {/* Child views render here */}
      <main className="flex-1 flex flex-col">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * Headless synchronization provider.
 * The ONLY place WebSockets exist in the client codebase.
 */
function LiveMeetSync({ meetId }: { meetId: string }) {
  const revalidator = useRevalidator();

  // useEffect(() => {
  //   const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  //   const ws = new WebSocket(
  //     `${protocol}//${window.location.host}/api/meets/${meetId}/live`,
  //   );

  //   ws.onmessage = (event) => {
  //     // const msg = JSON.parse(event.data);

  //     // if (msg.type === "LANE_TIME_SUBMITTED") {
  //     //   meetCache.setServerState(
  //     //     `heat:${msg.heatId}:lane:${msg.lane}`,
  //     //     msg.data,
  //     //   );
  //     //   // Nudge Remix: active loaders re-run cleanly
  //     //   revalidator.revalidate();
  //     // }
  //   };

  //   return () => ws.close();
  // }, [meetId, revalidator]);

  return null;
}
