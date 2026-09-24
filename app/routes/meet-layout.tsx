import { Link, Outlet, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/meet-layout";
import { EmptyState } from "~/components/ui";
import { currentUser, requireDb, resolveUser, type SyncEnv } from "~/lib/api.server";
import type { UserIdentity } from "~/lib/access";
import { getMeet } from "~/lib/meets.server";
import type { Meet } from "~/types/meet";

/**
 * Everything under `/meets/:meetId`: the meet's own metadata, and what you
 * may do to it. Nothing more.
 *
 * This used to also load the whole `MeetDetail` — every event, entry, seed,
 * watch and result — for every screen under a meet, whether or not that
 * screen touched any of it: a meet's programme rarely changes and is cheap
 * to read once here, but the live tables are exactly what shouldn't be
 * fetched this way on every navigation. Each child route now reads or
 * subscribes to only what it actually needs — a plain `meetDetail` read where
 * that's still the simplest thing (entries, results, meet-info), the meet's
 * Durable Object where it's the live, multi-writer state (admin, splits,
 * timer).
 *
 * The meet and the access decision still come back together, from the same
 * request — that pairing is what stops a screen from rendering "you may edit
 * this" while the server would refuse the write, and vice versa.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);

  const [rawUser, meet] = await Promise.all([
    currentUser(request, env),
    getMeet(db, params.meetId),
  ]);
  const user = await resolveUser(db, rawUser, request);

  return { meet, user };
}

export interface MeetContext {
  meet: Meet;
  user: UserIdentity;
}

/**
 * The meet this screen is under, and what you may do to it.
 *
 * Children call this instead of taking a `meet` prop or reaching for a store.
 * It throws rather than returning null: the layout has already established the
 * meet exists, so a child reaching here without one is a routing bug, not a
 * state to render around.
 *
 * Doesn't carry the meet's events/entries/seeds/watches/results any more —
 * see the loader's doc comment. A child that needs those reads them itself.
 */
export function useMeet(): MeetContext {
  const data = useRouteLoaderData<typeof loader>("routes/meet-layout");
  if (!data?.meet) throw new Error("useMeet used outside a meet route");
  return { meet: data.meet, user: data.user };
}

export default function MeetLayout({ loaderData }: Route.ComponentProps) {
  if (!loaderData.meet) {
    return (
      <EmptyState title="No such meet">
        It may have been deleted.{" "}
        <Link to="/meets" className="font-semibold text-blue-600 underline">
          Back to meets
        </Link>
        .
      </EmptyState>
    );
  }
  return <Outlet />;
}
