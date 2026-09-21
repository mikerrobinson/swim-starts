import { data, Outlet, useLoaderData, useRevalidator } from "react-router";
import { useEffect } from "react";
import type { Route } from "./+types/timer-shell";
import { Button } from "~/components/ui";
import { useMeetChanges } from "~/hooks/use-meet-changes";
import { loadCachedSnapshot, saveCachedSnapshot } from "~/lib/timer-cache";
import { applySeedCookies } from "~/lib/seed-cookie.server";
import {
  clearSeedCookies,
  resolveTimerRequest,
} from "~/lib/timer-request.server";
import { timerSnapshot, type TimerSnapshot } from "~/lib/timer.server";
import { withLiveTables } from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Timing · Swim Starts" }];
}

export type LoaderData =
  | { error: string; snapshot?: undefined }
  | { error?: undefined; snapshot: TimerSnapshot };

/**
 * Everything under the timer workspace shares this: one grant check, one
 * fetch of the meet's live state, and — the unusual part — this GET also
 * applies whatever `seed-*` cookies rode in with it before answering. That's
 * safe here because every write it can trigger (`seat`, `setExhibition`,
 * `recordWatch`, `dropWatch`, `addWalkupAthlete`) is an upsert; it's
 * necessary because a start/stop armed on a lane has nowhere else to go
 * until *some* request reaches this path, and the whole point is that one
 * ordinarily does — the next navigation, or a revalidation — without a
 * timer's phone ever having to manage its own delivery.
 *
 * `Cache-Control: no-store` because a mutating response is exactly the one
 * a cache must never silently hand back a second time.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const meetId = params.meetId!;
  const env = context.cloudflare.env;
  const headers = new Headers({ "cache-control": "no-store" });

  const resolved = await resolveTimerRequest(request, env, meetId);
  if (!resolved.ok) {
    return data<LoaderData>({ error: resolved.error }, { headers });
  }
  const { db, stub, grant, timerId, deviceCookie } = resolved.value;
  let { detail } = resolved.value;
  if (deviceCookie) headers.append("set-cookie", deviceCookie);

  const { applied, cleared } = await applySeedCookies(
    db,
    stub,
    detail,
    timerId,
    request,
  );
  clearSeedCookies(headers, request, meetId, cleared);

  // Only re-read the DO if something actually changed — the common case on a
  // revalidation with nothing pending is that there's nothing to catch up on.
  if (applied > 0) {
    const live = await stub.getSnapshot(meetId);
    detail = withLiveTables(detail, live);
  }

  const snapshot = timerSnapshot(detail, timerId, grant.expiresAt);
  return data<LoaderData>({ snapshot }, { headers });
}

/**
 * Fresh data first, always — a timer's own snapshot changes too often to
 * default to stale. The cache is read only when the network attempt itself
 * fails, which is what turns "no signal right now" into a screen that still
 * works rather than a hard error with nothing behind it.
 */
export async function clientLoader({
  params,
  serverLoader,
}: Route.ClientLoaderArgs) {
  const meetId = params.meetId!;
  try {
    const result = await serverLoader();
    if (result.snapshot) saveCachedSnapshot(meetId, result.snapshot);
    return result;
  } catch (err) {
    const cached = loadCachedSnapshot<TimerSnapshot>(meetId);
    if (cached) {
      const fallback: LoaderData = { snapshot: cached };
      return fallback;
    }
    throw err;
  }
}
clientLoader.hydrate = true;

export default function TimerShell({ params }: Route.ComponentProps) {
  const { error, snapshot } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  /**
   * Pick up what everyone else has changed — a lane reassigned at the desk,
   * a swimmer another timer corrected, another device's watch landing. Only
   * while the phone is actually being looked at; a pocketed screen has
   * nobody reading it. Coming back to the tab revalidates immediately too,
   * in case something happened while it was out of sight.
   */
  useMeetChanges(params.meetId, () => {
    if (document.visibilityState === "visible") revalidator.revalidate();
  });
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") revalidator.revalidate();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [revalidator]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <p className="text-lg font-bold">Not timing yet</p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {error}
          </p>
        </div>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="flex min-h-screen items-center justify-center text-slate-400">
        Loading…
      </main>
    );
  }

  return <Outlet />;
}

/** Reachable from a child that renders no `error` state of its own. */
export function ErrorBoundary() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <p className="text-lg font-bold">Something went wrong</p>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          Reload, or check the code again if it's been a while.
        </p>
        <div className="mt-4">
          <Button onClick={() => location.reload()}>Reload</Button>
        </div>
      </div>
    </main>
  );
}
