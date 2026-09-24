import type { Route } from "./+types/api.meet.live";
import { currentUser, requireDb, type SyncEnv } from "~/lib/api.server";
import { canEditMeet } from "~/lib/access";
import { teamsCoachedBy } from "~/lib/coaches.server";
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
  const userId = rawUser?.id ?? null;

  let role: MeetRole = "spectator";
  if (meet && canEditMeet({ meet, userId })) {
    role = "admin";
  } else if (meet && userId) {
    const coachedTeamIds = await teamsCoachedBy(db, userId);
    if (meet.teamIds.some((id) => coachedTeamIds.includes(id))) role = "coach";
  }
  if (role === "spectator") {
    const grant = await grantFor(db, grantToken(request));
    if (grant && grant.meetId === meetId) role = "timer";
  }

  const forwardUrl = new URL(request.url);
  forwardUrl.searchParams.set("meetId", meetId);
  forwardUrl.searchParams.set("role", role);
  if (userId) forwardUrl.searchParams.set("userId", userId);

  const stub = env.MEET_DO.getByName(meetId);
  return stub.fetch(new Request(forwardUrl, request));
}
