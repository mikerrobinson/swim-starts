import { useRouteLoaderData } from "react-router";
import type { MeetManifest } from "~/types/meet";
import type { Route } from "../routes/+types/meet-layout";

export function useMeet(): MeetManifest {
  const data =
    useRouteLoaderData<Route.ComponentProps["loaderData"]>(
      "routes/meet-layout",
    );
  if (!data?.meet) throw new Error("useMeet used outside a meet route");
  return data.meet;
}
