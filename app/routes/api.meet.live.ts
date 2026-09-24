import type { Route } from "./+types/api.meet.live";
import { currentUser, requireDb, resolveUser, type SyncEnv } from "~/lib/api.server";
import { canEditMeet } from "~/lib/access";
import { getMeet } from "~/lib/meets.server";
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
 * cookie or a grant token itself, the same separation `access.ts`/
 * `grants.server.ts` already keep for every other route.
 *
 * `useMeetLive` (`app/lib/meet-live.ts`) is the client side of this.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const env = context.cloudflare.env;
  const db = requireDb(env as SyncEnv);
  const meetId = params.meetId!;
  const [rawUser, meet] = await Promise.all([
    currentUser(request, env as SyncEnv),
    getMeet(db, meetId),
  ]);
  const user = await resolveUser(db, rawUser, request);

  let role: MeetRole = "spectator";
  if (meet && canEditMeet({ meet, user })) {
    role = "admin";
  } else if (meet && meet.teamIds.some((id) => user.coachOf.includes(id))) {
    role = "coach";
  } else {
    const grant = await grantFor(db, grantToken(request));
    if (grant && grant.meetId === meetId) role = "timer";
  }

  const forwardUrl = new URL(request.url);
  forwardUrl.searchParams.set("meetId", meetId);
  forwardUrl.searchParams.set("role", role);
  if (user.userId) forwardUrl.searchParams.set("userId", user.userId);

  const stub = env.MEET_DO.getByName(meetId);
  return stub.fetch(new Request(forwardUrl, request));
}
