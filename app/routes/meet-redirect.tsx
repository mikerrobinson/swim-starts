import { redirect } from "react-router";
import type { Route } from "./+types/meet-redirect";

/**
 * `/meets/:meetId` on its own, forwarded to the new model's setup page.
 *
 * `meet-info.tsx` moved under `meets2.tsx`'s route tree — it reads settings
 * from `useMeet()`'s `MeetManifest.details` now, not the old `meet-layout.tsx`
 * `useMeet()` this path used to render under.
 */
export async function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/meets2/${params.meetId}/info`);
}
