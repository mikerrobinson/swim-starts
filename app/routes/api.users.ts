import type { Route } from "./+types/api.users";
import { errorResponse, json, requireUser } from "~/lib/api.server";
import { searchUsers } from "~/lib/auth.server";

/**
 * Finding a person by name.
 *
 *   GET /api/users?q=… -> { users }
 *
 * Signed in only, and only ever in answer to a search — two characters
 * minimum, enforced in `searchUsers`. Between them those two rules are what
 * keep this from being a downloadable list of every family's email address:
 * you can confirm somebody is here, but you can't ask who everybody is.
 *
 * Unscoped by team on purpose. The only thing that needs it is appointing a
 * meet administrator, which is the one role in the app that belongs to no
 * team — see `searchUsers` for why that forces the wider list.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  try {
    const db = context.cloudflare.env.DB;
    await requireUser(request, db);

    const q = new URL(request.url).searchParams.get("q") ?? "";
    return json({ users: await searchUsers(db, q) });
  } catch (error) {
    return errorResponse(error);
  }
}
