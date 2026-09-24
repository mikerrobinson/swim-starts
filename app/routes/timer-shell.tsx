import { data, Outlet, useLoaderData } from "react-router";
import type { Route } from "./+types/timer-shell";
import { Button } from "~/components/ui";
import { resolveTimerAccess } from "~/lib/timer-request.server";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Timing · Swim Starts" }];
}

/**
 * One grant check for the whole timer workspace: is this a valid, unexpired
 * scan of this meet's code? The meet's own live state comes from `useMeet()`
 * (`meet-layout.tsx`'s shared manifest, kept live by its one shared socket) like
 * every other screen under a meet now — this shell only decides whether a
 * phone gets to look at it at all.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const meetId = params.meetId!;
  const resolved = await resolveTimerAccess(
    request,
    context.cloudflare.env,
    meetId,
  );
  const headers = new Headers();
  if (resolved.ok && resolved.value.deviceCookie) {
    headers.append("set-cookie", resolved.value.deviceCookie);
  }
  return data(
    { error: resolved.ok ? undefined : resolved.error },
    { headers },
  );
}

export default function TimerShell() {
  const { error } = useLoaderData<typeof loader>();

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
