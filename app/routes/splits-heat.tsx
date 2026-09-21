import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Route } from "./+types/splits-heat";
import type { SwimTime } from "~/lib/timing";
import { requireDb, type SyncEnv } from "~/lib/api.server";
import { meetDetail } from "~/lib/meets.server";
import { LaneAssignSheet } from "~/components/LaneAssignSheet";
import { LaneTile } from "~/components/LaneTile";
import {
  Banner,
  Button,
  EmptyState,
  Field,
  Sheet,
  TextInput,
} from "~/components/ui";
import { useElapsed, useWakeLock } from "~/hooks/use-stopwatch";
import { useMeetLive } from "~/hooks/use-meet-live";
import {
  currentWatches,
  fromStopwatch,
  heatsOf,
  swimsForHeat,
  swimTime,
} from "~/lib/timing";

import { formatClock, formatTime, parseTime } from "~/lib/time";
import { enrollmentIndex } from "~/lib/roster";
import { applyPending } from "~/lib/pending";
import { generateId } from "~/lib/id";
import { usePending, useSend } from "~/state/outbox";
import { useMeet } from "./meet-layout";
import { useViewPrefs } from "~/state/view-prefs";
import {
  byAthlete,
  displayName,
  eventName,
  findAthlete,
  isDiving,
  withLiveTables,
  type MeetDetail,
  type Event,
  type Watch,
} from "~/types/meet";
import { type NameOrder } from "~/types/preferences";
import type { Athlete } from "~/types/athlete";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Splits · Swim Starts" }];
}

/** How an official time was arrived at, for the lane sheet. */
const METHOD_LABEL: Record<string, string> = {
  single: "one watch",
  average: "average of 2",
  median: "middle of 3",
  official: "set by hand",
};

/**
 * This screen's own read: meet setup from D1, the four live tables from the
 * meet's Durable Object — see admin.tsx's loader doc comment; the same
 * reasoning applies here.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  const db = requireDb(env as SyncEnv);
  const detail = await meetDetail(db, params.meetId);
  if (!detail) return { detail: null };

  const live = await env.MEET_DO.getByName(params.meetId).getSnapshot(
    params.meetId,
  );
  return { detail: withLiveTables(detail, live) };
}

/** Lane numbers in the order they should be drawn for a layout. */
function orderedLanes(laneCount: number, layout: LaneLayout): number[] {
  const lanes = Array.from({ length: laneCount }, (_, i) => i + 1);
  return layout === "list-desc" ? lanes.reverse() : lanes;
}

/**
 * The multi-lane stopwatch a coach runs the deck from — one heat,
 * addressed as `/meets/:meetId/splits/:event/:heat` the same way the timer
 * already addresses a lane, replacing the `loadProgress`/`saveProgress`
 * local-storage position it used to track this with. Same screen, same
 * writes, same one-heat-at-a-time shape it always had — only where "which
 * heat" lives has moved.
 *
 * Kept live by `useMeetLive` instead of the polling this screen used to do
 * — the loader's read seeds it, the DO's broadcasts keep it current, and
 * this device's own pending writes are folded on top the same way they
 * always were.
 */
export default function SplitsHeat({
  loaderData,
  params,
}: Route.ComponentProps) {
  const live = useMeetLive(
    loaderData.detail?.meet.id,
    loaderData.detail ?? undefined,
  );
  const { access } = useMeet();
  const pending = usePending();
  const send = useSend();
  // The parent (meet-layout.tsx) already renders its own "no such meet" state
  // instead of this Outlet when the meet doesn't exist, same guarantee every
  // other leaf under it trusts.
  const loaded = loaderData.detail!;
  const detail = useMemo(
    () => applyPending(withLiveTables(loaded, live.snapshot), pending),
    [loaded, live.snapshot, pending],
  );
  const navigate = useNavigate();
  const { laneLayout: layout, timerId, nameOrder } = useViewPrefs();

  /**
   * Who this screen's watches belong to.
   *
   * A signed-in coach is the *person*, not the iPad — so the watch they take
   * on lane 3 is theirs whichever device they pick up, and switching devices
   * mid-meet doesn't leave two watches on one lane disagreeing. The device id
   * is the fallback for anyone with no account, which on this screen means
   * nobody today and is the honest default rather than a guess.
   */
  const mine = access.userId ?? timerId;

  /**
   * What a watch taken on this screen is worth.
   *
   * The same screen serves an administrator who also holds a stopwatch and a
   * coach who only does, and their readings are not weighed the same — so it
   * follows whoever is looking rather than the screen they are on. The server
   * decides it again from the session; this keeps the optimistic overlay in
   * step until it answers.
   */
  const myRole = access.admin ? "admin" : access.userId ? "coach" : "timer";

  // Watching other people work: the desk for a lane reseated there, another
  // coach's stopwatch for a time this device hasn't taken yet — now the
  // meet's live connection (`live`, above) rather than a poll.
  const meet = detail.meet;
  const roster = detail.athletes;

  /**
   * The clock, and the one place it lives.
   *
   * Component state. A stopwatch is a fact about the device holding it —
   * three timers behind one lane each start their own on the strobe, and
   * nobody's clock is anybody else's. It used to be a field on the meet, which
   * meant one person tapping START reached into every other device's copy and,
   * because starting a heat also cleared it, deleted times the phones had
   * already sent.
   */
  const [clock, setClock] = useState<{
    eventId: string;
    heat: number;
    startedAt: number;
    /** Lanes that already had a time when this run started. */
    alreadyTimed: number[];
  } | null>(null);

  const [editingLane, setEditingLane] = useState<number | null>(null);
  const [assigningLane, setAssigningLane] = useState<number | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  // Where the URL puts this device in the running order. An administrator
  // signing off event 4 while the deck swims event 6 is the normal case, not
  // a conflict — each tab's own address says where it is.
  const eventIndex = Math.min(
    Math.max(0, (Number(params.event) || 1) - 1),
    Math.max(0, detail.events.length - 1),
  );
  const event = detail.events[eventIndex];
  const heats = useMemo(
    () => (event ? heatsOf(detail, event.id) : []),
    [detail, event],
  );
  const heatNo = Number(params.heat) || 1;
  const heatIndex = Math.max(0, heats.indexOf(heatNo));
  const heat: number | undefined = heats[heatIndex];

  /** The swims in the heat on screen. A lane with nobody in it isn't one. */
  const seeds = useMemo(
    () =>
      event && heat !== undefined ? swimsForHeat(detail, event.id, heat) : [],
    [detail, event, heat],
  );
  const seedByLane = useMemo(
    () => new Map(seeds.map((s) => [s.lane, s] as const)),
    [seeds],
  );

  const running =
    heat !== undefined && clock?.heat === heat && clock?.eventId === event?.id;

  // Derived, not stored: each lane's time comes from the watches on it, so
  // several timers can be recording at once without colliding.
  const timeByLane = useMemo(() => {
    const map = new Map<number, NonNullable<ReturnType<typeof swimTime>>>();
    for (const seed of seeds) {
      const time = swimTime(detail, seed.id);
      if (time) map.set(seed.lane, time);
    }
    return map;
  }, [detail, seeds]);

  /**
   * The lanes *this device* has stopped.
   *
   * The heat is complete when the person holding this stopwatch has taken
   * every lane in front of them — not when times turn up from the timing
   * phones. Reading the shared times instead meant a lane a phone submitted
   * mid-race counted as stopped here, and the clock could vanish from under a
   * coach while swimmers were still in the water.
   */
  const stoppedByMe = useMemo(() => {
    const lanes = new Set<number>();
    for (const seed of seeds) {
      if (
        currentWatches(detail, seed.id).some(
          (w) => w.submittedBy === mine && w.timeMs !== undefined,
        )
      ) {
        lanes.add(seed.lane);
      }
    }
    return lanes;
  }, [detail, seeds, mine]);

  const occupiedLanes = seeds.map((s) => s.lane);

  /**
   * Nothing left on this screen that still wants a time *for this run*.
   *
   * Either this device took the lane, or a time arrived on it from somebody
   * else since the clock started. All three parts were learned by running it:
   * counting only this device's watches left a coach who times two lanes
   * waiting forever on the four the phones cover; counting every time let a
   * phone end the heat while swimmers were in the water; and counting times
   * that predate the start made pressing START on a re-swim declare the heat
   * over on the spot.
   */
  const allStopped =
    occupiedLanes.length > 0 &&
    occupiedLanes.every(
      (lane) =>
        stoppedByMe.has(lane) ||
        (timeByLane.has(lane) && !(clock?.alreadyTimed ?? []).includes(lane)),
    );

  /**
   * The three states of the action panel below the lanes: swimmers are still
   * in the water, the heat is complete, or nothing has been started. Exactly
   * one of these owns that space at any moment.
   */
  const clockRunning = running && !allStopped;
  const heatComplete = running && allStopped;

  // Anchored to the wall clock, and the frame loop stops as soon as the last
  // lane is in — there's nothing left to animate.
  const elapsed = useElapsed(clockRunning ? clock!.startedAt : null);
  useWakeLock(running);

  useEffect(() => {
    if (!heatComplete) setConfirmReset(false);
  }, [heatComplete]);

  /**
   * Move to a different heat, by event and heat index (0-based) rather than
   * event position and heat number — the shape the arrows below already
   * think in. Clamped and resolved to a heat *number* only at the last
   * moment, since that's what the URL wants.
   */
  const goToHeat = (nextEventIndex: number, nextHeatIndex: number) => {
    const clampedEventIndex = Math.min(
      Math.max(nextEventIndex, 0),
      Math.max(0, detail.events.length - 1),
    );
    const nextEvent = detail.events[clampedEventIndex];
    if (!nextEvent) return;
    const nextHeats = heatsOf(detail, nextEvent.id);
    const clampedHeatIndex = Math.min(
      Math.max(nextHeatIndex, 0),
      Math.max(0, nextHeats.length - 1),
    );
    const targetHeat = nextHeats[clampedHeatIndex] ?? 1;

    // Never carry a running clock across a heat change.
    setClock(null);
    setEditingLane(null);
    setAssigningLane(null);
    navigate(
      `/meets/${meet.id}/splits/${nextEvent.position + 1}/${targetHeat}`,
    );
  };

  const nextHeat = () => {
    if (heatIndex + 1 < heats.length) {
      goToHeat(eventIndex, heatIndex + 1);
    } else if (eventIndex + 1 < detail.events.length) {
      goToHeat(eventIndex + 1, 0);
    }
  };

  const prevHeat = () => {
    if (heatIndex > 0) goToHeat(eventIndex, heatIndex - 1);
    else if (eventIndex > 0) goToHeat(eventIndex - 1, 0);
  };

  if (!event) {
    return (
      <EmptyState title="No events yet">
        <Link
          to={`/meets/${meet.id}`}
          className="font-semibold text-blue-600 underline"
        >
          Add events under Info
        </Link>{" "}
        before running the meet.
      </EmptyState>
    );
  }

  const isLastHeat =
    heatIndex + 1 >= heats.length && eventIndex + 1 >= detail.events.length;

  return (
    <div className="space-y-3">
      {/* Event navigation */}
      <div className="flex items-center gap-2">
        <Button
          size="md"
          aria-label="Previous event"
          disabled={clockRunning || eventIndex === 0}
          onClick={() => goToHeat(eventIndex - 1, 0)}
        >
          ‹
        </Button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-xl font-bold leading-tight">
            {eventName(event)}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Event {eventIndex + 1} of {detail.events.length}
            {heats.length > 0 && ` · Heat ${heatIndex + 1} of ${heats.length}`}
          </p>
        </div>
        <Button
          size="md"
          aria-label="Next event"
          disabled={clockRunning || eventIndex + 1 >= detail.events.length}
          onClick={() => goToHeat(eventIndex + 1, 0)}
        >
          ›
        </Button>
      </div>

      {isDiving(event) ? (
        <DivingPanel
          detail={detail}
          event={event}
          roster={roster}
          nameOrder={nameOrder}
        />
      ) : heats.length === 0 || !heat ? (
        <EmptyState title="Nobody is entered in this event">
          <Link
            to={`/meets/${detail.meet.id}/entries`}
            className="font-semibold text-blue-600 underline"
          >
            Enter swimmers
          </Link>
          , then come back. You can also skip ahead with the arrows above.
        </EmptyState>
      ) : (
        <>
          {/* Lane buttons, arranged per the meet's layout option. */}
          <div
            className={`grid gap-2 ${
              layout === "grid" ? "grid-cols-2" : "grid-cols-1"
            }`}
          >
            {orderedLanes(meet.laneCount, layout).map((lane) => (
              <LaneTile
                key={lane}
                lane={lane}
                athlete={findAthlete(
                  roster,
                  seedByLane.get(lane)?.athleteId ?? null,
                )}
                time={timeByLane.get(lane)}
                exhibition={seedByLane.get(lane)?.exhibition ?? false}
                stoppedHere={stoppedByMe.has(lane)}
                running={running}
                clockRunning={clockRunning}
                layout={layout}
                laneCount={meet.laneCount}
                nameOrder={nameOrder}
                onStop={() => {
                  const seed = seedByLane.get(lane);
                  if (!seed) return;
                  const at = Date.now();
                  send({
                    kind: "watch",
                    meetId: meet.id,
                    swimId: seed.id,
                    timerId: mine,
                    userId: access.userId ?? undefined,
                    role: myRole,
                    timeMs: at - clock!.startedAt,
                    submittedAt: at,
                    startedAt: clock!.startedAt,
                    stoppedAt: at,
                  });
                }}
                onEdit={() => setEditingLane(lane)}
                onAssign={() => setAssigningLane(lane)}
              />
            ))}
          </div>

          {/* Action panel. One fixed-height block in the easiest place to
              reach with a thumb, holding whichever of the three states is
              current — so the lane grid above it never shifts. */}
          {clockRunning ? (
            <div className="flex min-h-24 items-center justify-center rounded-2xl bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-white">
              <span className="text-6xl font-bold leading-none tabular-nums">
                {formatClock(elapsed)}
              </span>
            </div>
          ) : heatComplete && confirmReset ? (
            /* Cancel sits where Reset just was, so a double tap lands on the
               harmless half rather than erasing the heat. */
            <div className="grid min-h-24 grid-cols-2 gap-2">
              <Button
                size="xl"
                className="!min-h-24 !text-xl"
                onClick={() => setConfirmReset(false)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="xl"
                className="!min-h-24 !text-xl"
                onClick={() => {
                  // This device's own watches, and nobody else's. A timer at
                  // the far end of the pool doesn't lose their afternoon
                  // because somebody reset a heat here.
                  for (const seed of seeds) {
                    send({
                      kind: "drop-watch",
                      meetId: meet.id,
                      swimId: seed.id,
                      timerId: mine,
                    });
                  }
                  setClock(null);
                  setConfirmReset(false);
                }}
              >
                Erase {stoppedByMe.size} time
                {stoppedByMe.size === 1 ? "" : "s"}
              </Button>
            </div>
          ) : heatComplete ? (
            <div className="grid min-h-24 grid-cols-2 gap-2">
              <Button
                size="xl"
                className="!min-h-24"
                onClick={() => setConfirmReset(true)}
              >
                Reset
              </Button>
              <Button
                variant="primary"
                size="xl"
                className="!min-h-24"
                onClick={nextHeat}
                disabled={isLastHeat}
              >
                {heatIndex + 1 < heats.length ? "Next heat" : "Next event"}
              </Button>
            </div>
          ) : (
            <Button
              variant="success"
              size="xl"
              full
              className="!min-h-24 !text-4xl"
              onClick={() => {
                // A false start's watches aren't times of the race about to
                // be swum, so this device drops its own before starting.
                for (const seed of seeds) {
                  send({
                    kind: "drop-watch",
                    meetId: meet.id,
                    swimId: seed.id,
                    timerId: mine,
                  });
                }
                // Whatever else is already on these lanes belongs to the
                // previous swim, not this one.
                setClock({
                  eventId: event.id,
                  heat: heat!,
                  startedAt: Date.now(),
                  alreadyTimed: [...timeByLane.keys()],
                });
              }}
            >
              START
            </Button>
          )}

          {!running && (
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                onClick={prevHeat}
                disabled={eventIndex === 0 && heatIndex === 0}
              >
                ‹ Back
              </Button>
              <Button size="sm" onClick={nextHeat} disabled={isLastHeat}>
                Skip ›
              </Button>
            </div>
          )}

          {!running && timeByLane.size > 0 && (
            <Banner tone="info">
              This heat already has {timeByLane.size} time
              {timeByLane.size === 1 ? "" : "s"}
              {stoppedByMe.size > 0
                ? `, ${stoppedByMe.size} of them taken here. Starting again clears those and leaves the rest.`
                : ", none of them taken here. Starting again leaves them alone."}
            </Banner>
          )}
        </>
      )}

      {heat && assigningLane !== null && (
        <LaneAssignSheet
          detail={detail}
          eventId={event.id}
          roster={roster}
          enrollments={enrollmentIndex(detail.enrollments)}
          nameOrder={nameOrder}
          heat={heat}
          lane={assigningLane}
          onAssign={(athleteId) =>
            send({
              kind: "swim",
              meetId: meet.id,
              eventId: event.id,
              heat: heat!,
              lane: assigningLane,
              athleteId,
              swimId: generateId(),
            })
          }
          onClose={() => setAssigningLane(null)}
        />
      )}

      {editingLane !== null &&
        (() => {
          const seed = seedByLane.get(editingLane);
          if (!seed) return null;
          const athlete = findAthlete(roster, seed.athleteId);
          return (
            <LaneSheet
              lane={editingLane}
              onClose={() => setEditingLane(null)}
              time={timeByLane.get(editingLane)}
              swimmerLabel={
                athlete
                  ? displayName(athlete, nameOrder)
                  : `Lane ${editingLane}`
              }
              watches={currentWatches(detail, seed.id).filter(
                (w) => w.timeMs !== undefined,
              )}
              timerId={mine}
              exhibition={seed.exhibition ?? false}
              onToggleExhibition={() =>
                send({
                  kind: "exhibition",
                  meetId: meet.id,
                  swimId: seed.id,
                  exhibition: !seed.exhibition,
                })
              }
              onSaveTime={(timeMs) => {
                send({
                  kind: "watch",
                  meetId: meet.id,
                  swimId: seed.id,
                  timerId: mine,
                  userId: access.userId ?? undefined,
                  role: myRole,
                  timeMs,
                  submittedAt: Date.now(),
                });
                setEditingLane(null);
              }}
              onRemoveWatch={(who) =>
                send({
                  kind: "drop-watch",
                  meetId: meet.id,
                  swimId: seed.id,
                  timerId: who,
                })
              }
              onRemoveFromLane={() => {
                send({ kind: "unswim", meetId: meet.id, swimId: seed.id });
                setEditingLane(null);
              }}
            />
          );
        })()}
    </div>
  );
}

/**
 * Diving keeps its place in the running order so the event numbers match the
 * printed program, but there is nothing to time here — the board runs on its
 * own sheet. All this does is show who's on it and let you move past.
 */
function DivingPanel({
  detail,
  event,
  roster,
  nameOrder,
}: {
  detail: MeetDetail;
  event: Event;
  roster: Athlete[];
  nameOrder: NameOrder;
}) {
  const divers = (detail.entries[event.id] ?? [])
    .map((id) => findAthlete(roster, id))
    .filter((s): s is Athlete => s !== undefined)
    .sort(byAthlete(nameOrder));

  return (
    <div className="rounded-2xl bg-sky-50 p-4 dark:bg-sky-950/40">
      <p className="text-sm font-semibold text-sky-900 dark:text-sky-100">
        Diving isn&rsquo;t timed here — scored on the diving sheet.
      </p>
      {divers.length === 0 ? (
        <p className="mt-2 text-sm text-sky-800 dark:text-sky-200">
          Nobody is on the board.{" "}
          <Link
            to={`/meets/${detail.meet.id}/entries`}
            className="font-semibold underline"
          >
            Add divers
          </Link>{" "}
          if that&rsquo;s not right.
        </p>
      ) : (
        <ul className="mt-2 space-y-0.5">
          {divers.map((diver) => (
            <li
              key={diver.id}
              className="text-base font-semibold text-sky-900 dark:text-sky-100"
            >
              {displayName(diver, nameOrder)}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-sky-700 dark:text-sky-300">
        Use the arrows above to carry on with the next event.
      </p>
    </div>
  );
}

/**
 * Fix a lane after the fact: a missed stop button, a fat-fingered tap, or a DQ.
 * Without this a single mistake would cost the whole heat.
 */
function LaneSheet({
  lane,
  swimmerLabel,
  time,
  watches,
  timerId,
  exhibition,
  onClose,
  onSaveTime,
  onToggleExhibition,
  onRemoveWatch,
  onRemoveFromLane,
}: {
  lane: number;
  swimmerLabel: string;
  time?: SwimTime;
  /** Every watch on this lane, so a coach can see what the time is made of. */
  watches: Watch[];
  timerId: string;
  /** Whether this swim counts towards scoring and placing. */
  exhibition: boolean;
  onClose: () => void;
  onSaveTime: (timeMs: number) => void;
  onToggleExhibition: () => void;
  onRemoveWatch: (watchId: string) => void;
  onRemoveFromLane: () => void;
}) {
  // Prefilled with this device's own watch, since typing a time replaces that
  // one — never somebody else's.
  const own = watches.find((w) => w.submittedBy === timerId);
  const [value, setValue] = useState(own ? formatTime(own.timeMs!) : "");

  // Parsed on every keystroke so the sheet can show what will actually be
  // saved — "101.45" becoming 1:01.45 should never be a surprise.
  const parsed = parseTime(value);
  const typed = value.trim() !== "";

  return (
    <Sheet open title={`Lane ${lane} · ${swimmerLabel}`} onClose={onClose}>
      {
        <div className="space-y-3">
          <Field
            label="Time"
            hint={'Just digits — "3045" is 30.45, "11127" is 1:11.27.'}
          >
            <TextInput
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="decimal"
              placeholder="11127"
              autoFocus
            />
          </Field>

          {typed &&
            (parsed !== null ? (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Saves as{" "}
                <strong className="text-base tabular-nums text-slate-900 dark:text-white">
                  {formatTime(parsed)}
                </strong>
              </p>
            ) : (
              <p className="text-sm font-semibold text-red-600 dark:text-red-400">
                Can&rsquo;t read that as a time. Try 3045 for 30.45, or 11127
                for 1:11.27.
              </p>
            ))}

          {/* Doesn't need a time or a sign-off to be true — a swim can be
              flagged before it's even run. The time still counts for the
              swimmer; only the place and the points don't. */}
          <button
            type="button"
            onClick={onToggleExhibition}
            aria-pressed={exhibition}
            className={`flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left ${
              exhibition
                ? "bg-amber-500 text-white"
                : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"
            }`}
          >
            <span className="font-semibold">Exhibition</span>
            <span className="text-xs">
              {exhibition
                ? "Won't score or place — tap to undo"
                : "Time counts, but not for scoring"}
            </span>
          </button>

          <Button
            variant="primary"
            size="lg"
            full
            disabled={parsed === null}
            onClick={() => parsed !== null && onSaveTime(parsed)}
          >
            {own ? "Replace my time" : "Save time"}
          </Button>

          {watches.length > 0 && (
            <div className="rounded-2xl bg-slate-100 p-3 dark:bg-slate-800">
              <p className="mb-1 text-xs font-bold text-slate-600 dark:text-slate-300">
                {watches.length} watch{watches.length === 1 ? "" : "es"} on this
                lane
                {time && !time.official && (
                  <span className="font-normal">
                    {" "}
                    · official {formatTime(time.timeMs)}
                  </span>
                )}
              </p>
              <ul className="divide-y divide-slate-200 dark:divide-slate-700">
                {watches.map((watch) => (
                  <li
                    key={watch.id}
                    className="flex items-center justify-between gap-2 py-1"
                  >
                    <span className="text-sm tabular-nums">
                      {formatTime(watch.timeMs!)}
                      <span className="ml-2 text-xs text-slate-500">
                        {watch.submittedBy === timerId
                          ? "you"
                          : "another timer"}
                        {!fromStopwatch(watch) && " · typed"}
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Discard the ${formatTime(watch.timeMs!)} watch`}
                      onClick={() => onRemoveWatch(watch.submittedBy)}
                      className="h-8 w-8 shrink-0 touch-manipulation rounded-lg text-sm text-red-600"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* A DQ, a no-show and signing a lane off are calls, and a call is
              a decision — it belongs at the control desk, where the person
              making it can see every watch on the lane. The deck's job is
              evidence: take a time, fix your own, say who's in the lane. */}
          {!time?.official && (
            /* Undo for a wrong pick. Only offered while the lane has no time
               on it — otherwise clear the time first. */
            <Button variant="ghost" full onClick={onRemoveFromLane}>
              Remove from lane
            </Button>
          )}
        </div>
      }
    </Sheet>
  );
}
