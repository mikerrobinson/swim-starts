import { Outlet } from "react-router";

/**
 * `/meets/:meetId/results` and everything under it.
 *
 * Nothing but an `Outlet` — the selector (`results-index.tsx`) and each view
 * (`results-view.tsx`) load their own data. See routes.ts.
 */
export default function ResultsLayout() {
  return <Outlet />;
}
