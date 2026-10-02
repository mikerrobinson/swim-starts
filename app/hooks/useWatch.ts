import { useSyncExternalStore } from "react";
import { useRouteLoaderData } from "react-router";
import { meetCache } from "~/lib/meetCache";
import { toWatchKey, type Watch } from "~/types/watch";
import type { Route } from "../routes/+types/meet-layout";

const DEFAULT_WATCH: Watch = {
  eventId: "",
  heat: 0,
  lane: 0,
  deviceId: "",
  slot: 0,
  startedAt: 0,
  stoppedAt: 0,
  timeMs: 0,
  role: "timer",
  recordedAt: 0,
};

export function useWatch({
  meetId,
  eventId,
  heat,
  lane,
  deviceId,
  slot = 0,
}: {
  meetId: string;
  eventId: string;
  heat: number;
  lane: number;
  deviceId: string;
  slot?: number;
}): Watch {
  // Read loader data delivered by the server / layout loader
  const routeData =
    useRouteLoaderData<Route.ComponentProps["loaderData"]>(
      "routes/meet-layout",
    );

  const watchKey = toWatchKey({ eventId, heat, lane, deviceId, slot });

  const serverWatch = routeData?.meet?.watches[watchKey] ?? {
    ...DEFAULT_WATCH,
    eventId,
    heat,
    lane,
    deviceId,
    slot,
  };

  if (typeof window === "undefined") {
    console.log("SERVER WATCH", JSON.stringify(serverWatch, null, 2));
    console.log(
      "SERVER WATCHES: ",
      JSON.stringify(routeData?.meet?.watches, null, 2),
    );
  }
  return useSyncExternalStore(
    meetCache.subscribe,
    () => meetCache.getMeet(meetId)?.watches[watchKey] ?? serverWatch,
    // Server snapshot: exact value rendered by the server
    () => serverWatch,
  );
}
