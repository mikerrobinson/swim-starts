import { useMemo } from "react";
import { Outlet, useNavigate, useOutletContext, useParams } from "react-router";
import type { Route } from "./+types/admin";
import { Card, EmptyState, SectionTitle } from "~/components/ui";
import { currentUser, requireDb, resolveUser, type SyncEnv } from "~/lib/api.server";
import { canEditMeet, type UserIdentity } from "~/lib/access";
import { getMeet } from "~/lib/meets.server";
import type { Meet } from "~/types/meet";
import { eventClosed, heatsOf } from "~/lib/timing";
import { applyPending } from "~/lib/pending";
import { usePending } from "~/state/outbox";
import { useMeetLive } from "~/hooks/use-meet-live";
import type { MeetDetail } from "~/types/meet";
import { eventName, withLiveTables } from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Admin · Swim Starts" }];
}

/**
 * The desk's own read: meet setup used to come from D1 (events, teams, lane
 * count) merged with the four live tables from the meet's Durable Object.
 * D1 no longer holds a meet's programme/entries/swims/watches at all — see
 * `meets2.tsx` — and this old-model admin desk hasn't been ported to read
 * the DO's `MeetManifest` shape instead, so `detail` stays `null` (the
 * component's already-handled "no such meet" state) until it is.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const meetId = params.meetId!;
  const [rawUser, meet] = await Promise.all([
    currentUser(request, env),
    getMeet(db, meetId),
  ]);
  const user = await resolveUser(db, rawUser, request);
  return { detail: null as MeetDetail | null, meet, user };
}

/**
 * One more heat for an event, on request.
 *
 * Used to write straight to D1's `swims` table (`addHeat` in
 * `meets.server.ts`), which no longer exists — see the loader's doc comment.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const meetId = params.meetId!;
  const [rawUser, meet] = await Promise.all([
    currentUser(request, env),
    getMeet(db, meetId),
  ]);
  const user = await resolveUser(db, rawUser, request);
  if (!meet || !canEditMeet({ meet, user })) {
    throw new Response("Whoever is running this meet adds a heat.", {
      status: 403,
    });
  }

  throw new Response("Adding a heat isn't available for this meet yet.", {
    status: 501,
  });
}

interface AdminContext {
  detail: MeetDetail;
  meet: Meet | null;
  user: UserIdentity;
}

/** The shell's own live-merged data, for the leaf below it — not
 *  `useMeet()`, which only carries the meet's metadata. Read from the
 *  Outlet's context rather than route loader data, since what the leaf
 *  needs is the shell's *live* state (loader data folded with the DO's
 *  broadcasts and this device's own pending writes), not the one-time
 *  server read alone. */
export function useAdmin(): AdminContext {
  const data = useOutletContext<AdminContext | undefined>();
  if (!data) throw new Error("useAdmin used outside the admin workspace");
  return data;
}

/**
 * The desk's shell: the running order down the side, one heat's desk in the
 * rest of the screen.
 *
 * Split out of what used to be `run-control.tsx`, and split again here: the
 * event rail lives at this level so it survives moving between heats, and
 * the heat desk itself (`admin-heat.tsx`) is addressed by event and heat in
 * the URL. What used to be every heat of the open event stacked and
 * scrolled is now one heat, navigated heat-to-heat, the same shape
 * `splits.tsx` uses.
 *
 * Kept live by `useMeetLive`: the loader's read seeds it, the DO's
 * broadcasts keep it current, and this device's own not-yet-acknowledged
 * writes are folded on top the same way the outbox always has been — one
 * `applyPending` overlay, now over a snapshot the WS keeps fresh instead of
 * one a poll used to.
 */
export default function AdminShell({ loaderData }: Route.ComponentProps) {
  const live = useMeetLive(loaderData.detail?.meet.id, loaderData.detail ?? undefined);
  const pending = usePending();
  const detail = useMemo(() => {
    if (!loaderData.detail) return null;
    return applyPending(withLiveTables(loaderData.detail, live.snapshot), pending);
  }, [loaderData.detail, live.snapshot, pending]);

  const params = useParams();
  const navigate = useNavigate();

  if (!detail) {
    return <EmptyState title="No such meet">It may have been deleted.</EmptyState>;
  }

  if (detail.events.length === 0) {
    return (
      <Card>
        <SectionTitle>No events yet</SectionTitle>
        <p className="text-sm text-slate-500">
          Set the running order under Info before running the meet.
        </p>
      </Card>
    );
  }

  const openEventNo = Number(params.event) || undefined;

  const goToEvent = (event: (typeof detail.events)[number]) => {
    const heats = heatsOf(detail, event.id);
    navigate(`/meets/${detail.meet.id}/admin/${event.position + 1}/${heats[0] ?? 1}`);
  };

  return (
    <div className="lg:grid lg:grid-cols-[minmax(15rem,28%)_minmax(0,1fr)] lg:gap-4">
      <EventRail
        detail={detail}
        openEventNo={openEventNo}
        onOpen={goToEvent}
      />
      <div className="mt-4 min-w-0 space-y-4 lg:mt-0">
        <Outlet
          context={
            { detail, meet: loaderData.meet, user: loaderData.user } satisfies AdminContext
          }
        />
      </div>
    </div>
  );
}

/**
 * The running order, down the side.
 *
 * A list rather than a wrapping block of buttons. Twenty-four events laid out
 * as chips reflow into a wall of different-width targets that's genuinely hard
 * to read down — and reading down is the whole job, because the question an
 * administrator asks over and over is "what's left?".
 */
function EventRail({
  detail,
  openEventNo,
  onOpen,
}: {
  detail: MeetDetail;
  openEventNo: number | undefined;
  onOpen: (event: MeetDetail["events"][number]) => void;
}) {
  const done = detail.events.filter((e) => eventClosed(detail, e.id)).length;

  return (
    <Card className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-var(--app-chrome-top)-var(--app-chrome-bottom)-2rem)] lg:overflow-y-auto">
      <SectionTitle>
        {done} of {detail.events.length} official
      </SectionTitle>

      <ol className="-mx-2">
        {detail.events.map((event, index) => {
          const official = eventClosed(detail, event.id);
          const open = event.position + 1 === openEventNo;
          const entered = (detail.entries[event.id] ?? []).length;
          return (
            <li key={event.id}>
              <button
                type="button"
                onClick={() => onOpen(event)}
                aria-current={open ? "true" : undefined}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors ${
                  open
                    ? "bg-blue-600 text-white"
                    : "hover:bg-slate-100 dark:hover:bg-slate-800"
                }`}
              >
                <span
                  className={`w-5 shrink-0 text-right tabular-nums ${
                    open ? "text-white/70" : "text-slate-400"
                  }`}
                >
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {eventName(event)}
                </span>
                <span
                  className={`shrink-0 text-xs tabular-nums ${
                    open
                      ? "text-white/80"
                      : official
                        ? "font-semibold text-emerald-600 dark:text-emerald-400"
                        : "text-slate-500"
                  }`}
                >
                  {official ? "✓" : entered > 0 ? entered : "—"}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
