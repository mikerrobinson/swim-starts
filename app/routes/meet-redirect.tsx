import { redirect } from "react-router";
import type { Route } from "./+types/meet-redirect";

/** `/meets/:meetId` on its own, forwarded to the meet's setup page. */
export async function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/meets/${params.meetId}/info`);
}
