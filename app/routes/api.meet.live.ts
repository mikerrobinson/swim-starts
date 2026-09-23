import type { Route } from "./+types/api.meet.live";
import { currentUser, requireDb, type SyncEnv } from "~/lib/api.server";
import { meetAccess } from "~/lib/access.server";
import { grantToken } from "~/lib/grants.server";
import { grantFor } from "~/lib/grants.server";
import type { MeetRole } from "~/lib/meet-do.server";

/**
 * The meet's live connection: one WebSocket per client, fed by the Meet
 * Durable Object's broadcasts as writes happen.
 *
 *   GET /api/meets/:meetId/live   (Upgrade: websocket)
 *
 * Auth happens here, once, before the upgrade ever reaches the DO. The DO
 * trusts `role`/`userId` on the forwarded request rather than parsing a
 * cookie or a grant token itself, the same separation
 * `access.server.ts`/`grants.server.ts` already keep for every other route.
 *
 * `useMeetLive` (`app/lib/meet-live.ts`) is the client side of this.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const env = context.cloudflare.env;
  const db = requireDb(env as SyncEnv);
  const meetId = params.meetId;
  const user = await currentUser(request, env as SyncEnv);
  const access = await meetAccess(db, meetId, user);

  let role: MeetRole = "spectator";
  if (access.admin) {
    role = "admin";
  } else if (access.coachOf.length > 0) {
    role = "coach";
  } else {
    const grant = await grantFor(db, grantToken(request));
    if (grant && grant.meetId === meetId) role = "timer";
  }

  const forwardUrl = new URL(request.url);
  forwardUrl.searchParams.set("meetId", meetId);
  forwardUrl.searchParams.set("role", role);
  if (user) forwardUrl.searchParams.set("userId", user.id);

  const stub = env.MEET_DO.getByName(meetId);
  return stub.fetch(new Request(forwardUrl, request));
}
