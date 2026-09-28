import { useMemo } from "react";
import { Outlet, useNavigate, useParams } from "react-router";
import type { Route } from "./+types/admin";
import { Card, SectionTitle } from "~/components/ui";
import { currentUser } from "~/lib/api.server";
import { canEditMeet } from "~/lib/access";
import { getMeet } from "~/lib/meets.server";
import { heatsOf, swimsComplete } from "~/lib/timing";
import { useMeet } from "~/hooks/useMeet";
import {
  eventName,
  getEventSwims,
  getSortedEvents,
  type Event,
  type Swim,
} from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Admin · Swim Starts" }];
}

/**
 * One more heat for an event, on request — a blank swim at lane 1 of the
 * next heat number, just enough to make `heatsOf` see it; the desk fills
 * the rest of the lanes the same way it fills any other, via
 * `LaneAssignSheet`. Admin-only, unlike seating a swimmer into an existing
 * heat (`canRecordTime`, in `admin-heat.tsx`) — opening a new heat is a
 * running-order decision, not evidence.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB;
  const meetId = params.meetId!;
  const [rawUser, meet] = await Promise.all([
    currentUser(request, db),
    getMeet(db, meetId),
  ]);
  const userId = rawUser?.id ?? null;
  if (!meet || !canEditMeet({ meet, userId })) {
    throw new Response("Whoever is running this meet adds a heat.", {
      status: 403,
    });
  }

  const { eventId } = (await request.json()) as { eventId: string };
  const stub = context.cloudflare.env.MEET_DO.getByName(meetId);
  const manifest = await stub.getMeetManifest(meetId);
  const heats = Object.values(manifest.swims)
    .filter((s: Swim) => s.eventId === eventId)
    .map((s: Swim) => s.heat);
  const heat = (heats.length > 0 ? Math.max(...heats) : 0) + 1;

  await stub.upsertSwim(meetId, { eventId, heat, lane: 1, exhibition: false });
  return { ok: true, heat };
}

/**
 * The desk's shell: the running order down the side, one heat's desk in the
 * rest of the screen.
 *
 * Split out of what used to be `run-control.tsx`, and split again here: the
 * event rail lives at this level so it survives moving between heats, and
 * the heat desk itself (`admin-heat.tsx`) is addressed by event and heat in
 * the URL. No context passed down to it at all — `useMeet()`/`useUser()`
 * are hooks, callable from any descendant, so there's nothing left for an
 * Outlet context to carry that the leaf couldn't already reach itself.
 */
export default function AdminShell() {
  const meet = useMeet();
  const params = useParams();
  const navigate = useNavigate();

  const events = getSortedEvents(meet);

  if (events.length === 0) {
    return (
      <Card>
        <SectionTitle>No events yet</SectionTitle>
        <p className="text-sm text-slate-500">
          Set the running order under Info before running the meet.
        </p>
      </Card>
    );
  }

  const swims = Object.values(meet.swims);
  const openEventNo = Number(params.event) || undefined;

  const goToEvent = (event: Event) => {
    const heats = heatsOf({ swims }, event.id);
    navigate(`/meets/${meet.id}/admin/${event.position + 1}/${heats[0] ?? 1}`);
  };

  return (
    <div className="lg:grid lg:grid-cols-[minmax(15rem,28%)_minmax(0,1fr)] lg:gap-4">
      <EventRail
        events={events}
        swims={swims}
        openEventNo={openEventNo}
        onOpen={goToEvent}
      />
      <div className="mt-4 min-w-0 space-y-4 lg:mt-0">
        <Outlet />
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
  events,
  swims,
  openEventNo,
  onOpen,
}: {
  events: Event[];
  swims: Swim[];
  openEventNo: number | undefined;
  onOpen: (event: Event) => void;
}) {
  const meet = useMeet();
  const entriesByEvent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of Object.values(meet.entries)) {
      counts.set(entry.eventId, (counts.get(entry.eventId) ?? 0) + 1);
    }
    return counts;
  }, [meet.entries]);

  const done = events.filter((e) =>
    swimsComplete(getEventSwims(meet, e.id)),
  ).length;

  return (
    <Card className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-var(--app-chrome-top)-var(--app-chrome-bottom)-2rem)] lg:overflow-y-auto">
      <SectionTitle>
        {done} of {events.length} official
      </SectionTitle>

      <ol className="-mx-2">
        {events.map((event, index) => {
          const official = swimsComplete(getEventSwims(meet, event.id));
          const open = event.position + 1 === openEventNo;
          const entered = entriesByEvent.get(event.id) ?? 0;
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
