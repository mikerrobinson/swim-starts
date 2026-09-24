import { Outlet } from "react-router";

/**
 * `/meets/:meetId/splits` and everything under it.
 *
 * No sidebar of its own to keep alive across heats — unlike admin's event
 * rail, splits has always been one heat at a time (see splits-heat.tsx), so
 * there's nothing for a shell to hold. `splits-index.tsx` and
 * `splits-heat.tsx` load their own data. See routes.ts.
 */
export default function SplitsLayout() {
  return <Outlet />;
}
