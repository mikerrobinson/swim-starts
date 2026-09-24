import { redirect } from "react-router";
import type { Route } from "./+types/splits-index";

/**
 * `/meets/:meetId/splits` on its own — used to send whoever's here to the
 * first event's heat via a `meetDetail` D1 read. Events/entries/swims/
 * watches moved into the meet's own Durable Object (see `meets2.tsx`), and
 * this old-model splits screen hasn't been ported to read from it, so
 * there's nowhere to look that up from — the leaf (`splits-heat.tsx`)
 * renders its own "no events yet" state for this same fallback address.
 */
export async function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/meets/${params.meetId}/splits/1/1`);
}

export default function SplitsIndex() {
  return null;
}
