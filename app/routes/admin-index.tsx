import { redirect } from "react-router";
import type { Route } from "./+types/admin-index";

/**
 * `/meets2/:meetId/admin` on its own — sends whoever's here to the first
 * event's first heat; `admin.tsx`'s shell renders its own "no events yet"
 * state if there isn't one, same as `splits-index.tsx` does for splits.
 */
export async function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/meets2/${params.meetId}/admin/1/1`);
}
