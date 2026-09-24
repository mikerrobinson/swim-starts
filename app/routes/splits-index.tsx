import { redirect } from "react-router";
import type { Route } from "./+types/splits-index";

/**
 * `/meets/:meetId/splits` on its own — sends whoever's here to the first
 * event's first heat; `splits-heat.tsx` renders its own "no events yet"
 * state if there isn't one.
 */
export async function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/meets/${params.meetId}/splits/1/1`);
}

export default function SplitsIndex() {
  return null;
}
