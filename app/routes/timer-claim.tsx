import { data, redirect } from "react-router";
import type { Route } from "./+types/timer-claim";
import { requireDb, type SyncEnv } from "~/lib/api.server";
import { deviceCookie, deviceId } from "~/lib/device.server";
import { grantCookie } from "~/lib/grants.server";
import { grantFor } from "~/lib/grants.server";
import { timerPath } from "~/lib/timer";

/**
 * What a scanned QR code lands on, and never renders.
 *
 * Two jobs, both done on the server during a redirect: trade the token in the
 * URL for a cookie, and work out who this phone is. Then send it to the
 * meet's lane picker — `/meets/{meetId}/timer`.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const grant = await grantFor(db, params.token);

  /**
   * The app's own base, read off the URL we were reached at.
   *
   * It scopes the cookies, and *only* the cookies. The redirect below is a
   * bare path because the framework prefixes the basename itself on the way
   * out; building an absolute one here as well produced a `Location` of
   * `/…`.
   */
  const headers = new Headers();
  headers.append(
    "set-cookie",
    grantCookie(grant ? params.token! : null, request, {
      meetId: grant?.meetId,
      expiresAt: grant?.expiresAt,
    }),
  );

  if (!grant) return data({ expired: true }, { headers });

  const device = deviceId(request);
  headers.append("set-cookie", deviceCookie(device, request));

  return redirect(timerPath(grant.meetId), { headers });
}

export default function TimerClaim() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-bold text-slate-900 dark:text-white">
        Invalid or expired timing link
      </h1>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        This timing link has expired, or it has been replaced by a newer one.
        See a meet administrator for a new code.
      </p>
    </main>
  );
}
