import type { Route } from "./+types/api.teams";
import { currentUser, errorResponse, json } from "~/lib/api.server";
import { teamsCoachedBy } from "~/lib/coaches.server";
import { listPublicTeams } from "~/lib/public.server";

/**
 * The teams this server knows about.
 *
 *   GET /api/teams          -> all of them, public
 *   GET /api/teams?mine=1   -> only the ones the caller is actually on
 *
 * The plain list is open, because a team's name and size are on every heat
 * sheet and someone setting up a meet has to be able to find their opponent.
 * `mine=1` is the ones this person coaches — what a device uses to decide
 * which season it holds — and answers with nothing at all when nobody is
 * signed in.
 *
 * Reading only. Making a team is the business of whichever screen you are on
 * when you notice yours isn't here, and each of those has an action — see
 * `findOrCreateTeam`, which is the one rule all of them obey.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  try {
    const db = context.cloudflare.env.DB;
    const teams = await listPublicTeams(db);

    if (new URL(request.url).searchParams.get("mine") !== "1") {
      return json({ teams });
    }

    const user = await currentUser(request, db);
    if (!user) return json({ teams: [] });

    const mine = new Set(await teamsCoachedBy(db, user.id));
    return json({ teams: teams.filter((team) => mine.has(team.id)) });
  } catch (error) {
    return errorResponse(error);
  }
}
