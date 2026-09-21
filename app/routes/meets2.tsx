// app/routes/meets.$id.tsx
import type { Route } from "./+types/meets2";

import {
  Outlet,
  useLoaderData,
  useLocation,
  useRevalidator,
} from "react-router";
import { useEffect } from "react";
import { meetCache, type MeetManifest } from "~/lib/meetCache";

export type LoaderData = { meet: MeetManifest };

export async function loader({ params, context }: Route.LoaderArgs) {
  const meetId = params.meetId!;
  // Fetch initial meet program from Cloudflare DO or database
  const meet: MeetManifest | null = { isLive: false, id: meetId } as any; //
  //context.env.db.getMeet(meetId);

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
  //   const cached = meetCache.getManifest(meetId);

  //   if (cached) {
  //     // Background stale-while-revalidate fetch
  //     serverLoader()
  //       .then((fresh) => {
  //         if (fresh?.meet) meetCache.saveManifest(meetId, fresh.meet);
  //       })
  //       .catch(() => {});

  //     return { meet: cached };
  //   }

  //   // Cold cache fallback: load from network and seed cache
  //   const data = await serverLoader();
  //   meetCache.saveManifest(meetId, data.meet);
  const meet = { isLive: false, id: meetId } as any; //
  console.log("clientLoader meet", meet);
  return { meet };
}

export default function MeetRootLayout() {
  const { meet } = useLoaderData<typeof loader>();
  const location = useLocation();

  // Only open WebSockets for active meets on live deck routes
  const isArchiveView = location.pathname.includes("/archive/");
  const shouldConnectLive = meet.isLive && !isArchiveView;

  return (
    <div className="min-h-screen bg-white text-black">
      {shouldConnectLive && <LiveMeetSync meetId={meet.id} />}
      <Outlet />
    </div>
  );
}

/**
 * Headless synchronization provider.
 * The ONLY place WebSockets exist in the client codebase.
 */
function LiveMeetSync({ meetId }: { meetId: string }) {
  const revalidator = useRevalidator();

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/meets/${meetId}/live`,
    );

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "LANE_TIME_SUBMITTED") {
        meetCache.setServerState(
          `heat:${msg.heatId}:lane:${msg.lane}`,
          msg.data,
        );
        // Nudge Remix: active loaders re-run cleanly
        revalidator.revalidate();
      }
    };

    return () => ws.close();
  }, [meetId, revalidator]);

  return null;
}
