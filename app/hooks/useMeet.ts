import { useSyncExternalStore } from "react";
import { useParams, useRouteLoaderData } from "react-router";
import { meetCache } from "~/lib/meetCache";
import type { MeetManifest } from "~/types/meet";
import type { Route } from "../routes/+types/meet-layout";

export function useMeet(): MeetManifest {
  const { meetId } = useParams();

  // Hydrated route loader data serves as the baseline snapshot
  const routeData =
    useRouteLoaderData<Route.ComponentProps["loaderData"]>(
      "routes/meet-layout",
    );

  const cachedMeet = useSyncExternalStore(
    meetCache.subscribe,
    () => (meetId ? meetCache.getMeet(meetId) : null),
    () => routeData?.meet ?? null,
  );

  const meet = cachedMeet ?? routeData?.meet;
  if (!meet) {
    throw new Error(`useMeet: No meet found for ID "${meetId}"`);
  }

  return meet;
}
