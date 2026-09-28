import { useReducer, useEffect } from "react";
import { useRouteLoaderData } from "react-router";
import { meetCache } from "~/lib/meetCache";
import type { MeetManifest } from "~/types/meet";
import type { Route } from "../routes/+types/meet-layout";

/**
 * The live meet manifest. `meet-layout.tsx`'s own loader/`clientLoader`
 * only ever runs once per mount — its `shouldRevalidate` opts out on
 * purpose, so a live patch never races a full refetch and flashes
 * stale-then-fresh — so this can't just read `useRouteLoaderData` and
 * expect it to change. `meetCache.applyPatch` mutates the cached manifest
 * in place instead; `meetCache.subscribe` is what turns that mutation into
 * a re-render here, independent of the router's own data flow.
 */
export function useMeet(): MeetManifest {
  const data =
    useRouteLoaderData<Route.ComponentProps["loaderData"]>(
      "routes/meet-layout",
    );
  if (!data?.meet) throw new Error("useMeet used outside a meet route");
  const meetId = data.meet.id;

  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
  useEffect(() => meetCache.subscribe(meetId, forceUpdate), [meetId]);

  return meetCache.getMeet(meetId) ?? data.meet;
}
