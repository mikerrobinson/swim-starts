import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSubmit } from "react-router";
import type { Route } from "./+types/splits-heat";
import type { SwimTime } from "~/lib/timing";
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
import {
  currentWatches,
  fromStopwatch,
  heatsOf,
  swimsForHeat,
  swimTime,
} from "~/lib/timing";

import { formatClock, formatTime, parseTime } from "~/lib/time";
import { currentUser, requireDb, type SyncEnv } from "~/lib/api.server";
import { canEditMeet, canRecordTime, type MeetFacts } from "~/lib/access";
import { teamsCoachedBy } from "~/lib/coaches.server";
import { getMeet } from "~/lib/meets.server";
import {
  getTeam,
  listSeasons,
  roster as teamRoster,
  seasonForDate,
  type RosterEntry,
} from "~/lib/teams.server";
import { meetCache } from "~/lib/meetCache";
import { useMeet } from "./meet-layout";
import { useUser, useDeviceId } from "~/state/user";
import { useViewPrefs } from "~/state/view-prefs";
import {
  athleteName,
  byAthlete,
  displayName,
  eventName,
  getSortedEvents,
  isDiving,
  type Event,
  type LaneLayout,
  type MeetAthlete,
  type Swim,
  type SwimSlot,
  type Watch,
  type WatchSlotKey,
} from "~/types/meet";
import type { Meet } from "~/types/meet";
import { type NameOrder } from "~/types/preferences";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Splits · Swim Starts" }];
}

/** What `canRecordTime` falls back to when the meet's own D1 row is somehow
 *  missing — nobody may record a time for a meet that isn't there. */
const EMPTY_MEET_FACTS: MeetFacts = {
  adminIds: [],
  teamIds: [],
  athletesMayEnter: false,
};

/** Every racing team's roster, for the season the meet's date falls in —
 *  what `LaneAssignSheet`'s picker draws from. Same shape `entries.tsx`
 *  builds; `useMeet()`'s own roster (`meet.athletes`) is whoever a swim or
 *  entry already names, not the whole season list a walk-up gets chosen
 *  from. */
async function meetRoster(db: D1Database, meet: Meet): Promise<RosterEntry[]> {
  const perTeam = await Promise.all(
    meet.teamIds.map(async (teamId) => {
      const [team, seasons] = await Promise.all([
        getTeam(db, teamId),
        listSeasons(db, teamId),
      ]);
      const season = seasonForDate(seasons, team?.currentSeasonId, meet.date);
      return teamRoster(db, teamId, season?.id);
    }),
  );
  return perTeam.flat();
}

/**
 * `meet` (D1's facts, for `canRecordTime`) and the racing teams' season
 * roster (for `LaneAssignSheet`'s picker) — everything else this screen
 * shows comes from `useMeet()`'s `MeetManifest` in the component below.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const meetId = params.meetId!;
  const meet = await getMeet(db, meetId);
  const rosterEntries = meet ? await meetRoster(db, meet) : [];

  return {
    meet,
    roster: rosterEntries.map((r) => r.athlete),
    enrollments: rosterEntries.map((r) => r.enrollment),
  };
}

/**
 * Everything this screen writes is one of two shapes: upsert a swim (seat a
 * lane, mark exhibition), or upsert a watch (a stopwatch's time) — and the
 * two matching deletes (empty a lane, drop a watch). `canRecordTime` gates
 * all four the same way `api.meet.writes.ts` gates the outbox's — a coach
 * of a racing team, or the administrator.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env;
  const db = requireDb(env as SyncEnv);
  const meetId = params.meetId!;
  const [rawUser, meet] = await Promise.all([
    currentUser(request, env as SyncEnv),
    getMeet(db, meetId),
  ]);
  if (!meet) throw new Response("No such meet", { status: 404 });
  const userId = rawUser?.id ?? null;
  const coachedTeamIds = userId ? await teamsCoachedBy(db, userId) : [];
  if (!canRecordTime({ meet, userId, coachedTeamIds })) {
    throw new Response("Only the teams racing can record times.", {
      status: 403,
    });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const stub = env.MEET_DO.getByName(meetId);

  if (intent === "upsert-swim") {
    const swim = JSON.parse(String(form.get("swim"))) as Swim;
    await stub.upsertSwim(meetId, swim);
    return { ok: true };
  }
  if (intent === "delete-swim") {
    await stub.deleteSwim(meetId, {
      eventId: String(form.get("eventId")),
      heat: Number(form.get("heat")),
      lane: Number(form.get("lane")),
    });
    return { ok: true };
  }
  if (intent === "upsert-watch") {
    const watch = JSON.parse(String(form.get("watch"))) as Watch;
    await stub.upsertWatch(meetId, watch);
    return { ok: true };
  }
  if (intent === "delete-watch") {
    await stub.deleteWatch(meetId, {
      eventId: String(form.get("eventId")),
      heat: Number(form.get("heat")),
      lane: Number(form.get("lane")),
      deviceId: String(form.get("deviceId")),
      slot: Number(form.get("slot")),
    });
    return { ok: true };
  }
  return { ok: false };
}

/**
 * The tick (or the empty lane, or the dropped watch) moves the instant it's
 * tapped: patch `meetCache`'s cached manifest the same shape the matching
 * broadcast would, then hand off to the real request — same pattern
 * `entries.tsx` uses for its one write kind, extended to this screen's four.
 */
export async function clientAction({
  params,
  request,
  serverAction,
}: Route.ClientActionArgs) {
  const meetId = params.meetId!;
  const form = await request.clone().formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "upsert-swim") {
    const swim = JSON.parse(String(form.get("swim"))) as Swim;
    meetCache.applyPatch(
      meetId,
      { type: "SWIM", swim, isDelete: false },
      () => {},
    );
  } else if (intent === "delete-swim") {
    meetCache.applyPatch(
      meetId,
      {
        type: "SWIM",
        swim: {
          eventId: String(form.get("eventId")),
          heat: Number(form.get("heat")),
          lane: Number(form.get("lane")),
          exhibition: false,
        },
        isDelete: true,
      },
      () => {},
    );
  } else if (intent === "upsert-watch") {
    const watch = JSON.parse(String(form.get("watch"))) as Watch;
    meetCache.applyPatch(
      meetId,
      { type: "WATCH", watch, isDelete: false },
      () => {},
    );
  } else if (intent === "delete-watch") {
    meetCache.applyPatch(
      meetId,
      {
        type: "WATCH",
        watch: {
          eventId: String(form.get("eventId")),
          heat: Number(form.get("heat")),
          lane: Number(form.get("lane")),
          deviceId: String(form.get("deviceId")),
          slot: Number(form.get("slot")),
          role: "timer",
          recordedAt: Date.now(),
        },
        isDelete: true,
      },
      () => {},
    );
  }

  return serverAction();
}

/** Lane numbers in the order they should be drawn for a layout. */
function orderedLanes(laneCount: number, layout: LaneLayout): number[] {
  const lanes = Array.from({ length: laneCount }, (_, i) => i + 1);
  return layout === "list-desc" ? lanes.reverse() : lanes;
}

/**
 * The multi-lane stopwatch a coach runs the deck from — one heat,
 * addressed as `/meets/:meetId/splits/:event/:heat` the same way the timer
 * already addresses a lane. Same screen, same writes, same one-heat-at-a-
 * time shape it always had — only where the meet's own state lives has
 * moved: `useMeet()` now, kept live by `meet-layout.tsx`'s one shared socket
 * rather than a `useMeetLive` of this screen's own.
 */
export default function SplitsHeat({
  loaderData,
  params,
}: Route.ComponentProps) {
  const meet = useMeet();
  const user = useUser();
  const deviceId = useDeviceId();
  const submit = useSubmit();
  const navigate = useNavigate();
  const { laneLayout: layout, timerId, nameOrder } = useViewPrefs();

  const meetFacts = loaderData.meet ?? EMPTY_MEET_FACTS;
  const isAdmin = canEditMeet({ meet: meetFacts, userId: user?.id ?? null });

  /**
   * Who this screen's watches belong to.
   *
   * A watch's whole identity is the device that took it (`event/heat/lane/
   * device/slot` — see `meet-do.server.ts`), so this device's own watches
   * are always found by `deviceId`, signed in or not. `userId` still rides
   * along on the row for attribution — it's just no longer what a watch is
   * keyed by, the way `submittedBy` used to conflate the two.
   */
  const mine = deviceId || timerId;

  /**
   * What a watch taken on this screen is worth.
   *
   * The same screen serves an administrator who also holds a stopwatch and a
   * coach who only does, and their readings are not weighed the same — so it
   * follows whoever is looking rather than the screen they are on. The server
   * decides it again from the session; this keeps the optimistic overlay in
   * step until it answers.
   */
  const myRole = isAdmin ? "admin" : user ? "coach" : "timer";

  /** Send a swim upsert/delete, or a watch upsert/delete — the four shapes
   *  `action`/`clientAction` above understand. */
  const sendSwim = (swim: Swim) => {
    const form = new FormData();
    form.set("intent", "upsert-swim");
    form.set("swim", JSON.stringify(swim));
    submit(form, { method: "post", navigate: false });
  };
  const removeSwim = (slot: SwimSlot) => {
    const form = new FormData();
    form.set("intent", "delete-swim");
    form.set("eventId", slot.eventId);
    form.set("heat", String(slot.heat));
    form.set("lane", String(slot.lane));
    submit(form, { method: "post", navigate: false });
  };
  const sendWatch = (watch: Watch) => {
    const form = new FormData();
    form.set("intent", "upsert-watch");
    form.set("watch", JSON.stringify(watch));
    submit(form, { method: "post", navigate: false });
  };
  const removeWatch = (key: WatchSlotKey) => {
    const form = new FormData();
    form.set("intent", "delete-watch");
    form.set("eventId", key.eventId);
    form.set("heat", String(key.heat));
    form.set("lane", String(key.lane));
    form.set("deviceId", key.deviceId);
    form.set("slot", String(key.slot));
    submit(form, { method: "post", navigate: false });
  };

  const roster = loaderData.roster;
  const enrollments = useMemo(
    () => new Map(loaderData.enrollments.map((e) => [e.athleteId, e] as const)),
    [loaderData.enrollments],
  );

  /**
   * The clock, and the one place it lives.
   *
   * Component state. A stopwatch is a fact about the device holding it —
   * three timers behind one lane each start their own on the strobe, and
   * nobody's clock is anybody else's.
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

  const events = useMemo(() => getSortedEvents(meet), [meet]);
  const swims = useMemo(() => Object.values(meet.swims), [meet.swims]);
  const watches = useMemo(() => Object.values(meet.watches), [meet.watches]);

  // Where the URL puts this device in the running order. An administrator
  // signing off event 4 while the deck swims event 6 is the normal case, not
  // a conflict — each tab's own address says where it is.
  const eventIndex = Math.min(
    Math.max(0, (Number(params.event) || 1) - 1),
    Math.max(0, events.length - 1),
  );
  const event = events[eventIndex];
  const heats = useMemo(
    () => (event ? heatsOf({ swims }, event.id) : []),
    [swims, event],
  );
  const heatNo = Number(params.heat) || 1;
  const heatIndex = Math.max(0, heats.indexOf(heatNo));
  const heat: number | undefined = heats[heatIndex];

  /** The swims in the heat on screen. A lane with nobody in it isn't one. */
  const seeds = useMemo(
    () =>
      event && heat !== undefined
        ? swimsForHeat({ swims }, event.id, heat)
        : [],
    [swims, event, heat],
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
      const time = swimTime({ swims, watches }, seed);
      if (time) map.set(seed.lane, time);
    }
    return map;
  }, [swims, watches, seeds]);

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
        currentWatches({ watches }, seed).some(
          (w) => w.deviceId === mine && w.timeMs !== undefined,
        )
      ) {
        lanes.add(seed.lane);
      }
    }
    return lanes;
  }, [watches, seeds, mine]);

  const occupiedLanes = seeds.map((s) => s.lane);

  /**
   * Nothing left on this screen that still wants a time *for this run*.
   *
   * Either this device took the lane, or a time arrived on it from somebody
   * else since the clock started.
   */
  const allStopped =
    occupiedLanes.length > 0 &&
    occupiedLanes.every(
      (lane) =>
        stoppedByMe.has(lane) ||
        (timeByLane.has(lane) && !(clock?.alreadyTimed ?? []).includes(lane)),
    );

  const clockRunning = running && !allStopped;
  const heatComplete = running && allStopped;

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
      Math.max(0, events.length - 1),
    );
    const nextEvent = events[clampedEventIndex];
    if (!nextEvent) return;
    const nextHeats = heatsOf({ swims }, nextEvent.id);
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
    } else if (eventIndex + 1 < events.length) {
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
    heatIndex + 1 >= heats.length && eventIndex + 1 >= events.length;

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
            Event {eventIndex + 1} of {events.length}
            {heats.length > 0 && ` · Heat ${heatIndex + 1} of ${heats.length}`}
          </p>
        </div>
        <Button
          size="md"
          aria-label="Next event"
          disabled={clockRunning || eventIndex + 1 >= events.length}
          onClick={() => goToHeat(eventIndex + 1, 0)}
        >
          ›
        </Button>
      </div>

      {isDiving(event) ? (
        <DivingPanel event={event} nameOrder={nameOrder} />
      ) : heats.length === 0 || !heat ? (
        <EmptyState title="Nobody is entered in this event">
          <Link
            to={`/meets/${meet.id}/entries`}
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
            {orderedLanes(meet.details.laneCount, layout).map((lane) => {
              const seed = seedByLane.get(lane);
              return (
                <LaneTile
                  key={lane}
                  lane={lane}
                  athlete={
                    seed?.athleteId ? meet.athletes[seed.athleteId] : undefined
                  }
                  time={timeByLane.get(lane)}
                  exhibition={seed?.exhibition ?? false}
                  stoppedHere={stoppedByMe.has(lane)}
                  running={running}
                  clockRunning={clockRunning}
                  layout={layout}
                  laneCount={meet.details.laneCount}
                  nameOrder={nameOrder}
                  onStop={() => {
                    if (!seed) return;
                    const at = Date.now();
                    sendWatch({
                      eventId: seed.eventId,
                      heat: seed.heat,
                      lane: seed.lane,
                      deviceId: mine,
                      slot: 1,
                      role: myRole,
                      userId: user?.id ?? undefined,
                      timeMs: at - clock!.startedAt,
                      startedAt: clock!.startedAt,
                      stoppedAt: at,
                      recordedAt: at,
                    });
                  }}
                  onEdit={() => setEditingLane(lane)}
                  onAssign={() => setAssigningLane(lane)}
                />
              );
            })}
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
                    removeWatch({
                      eventId: seed.eventId,
                      heat: seed.heat,
                      lane: seed.lane,
                      deviceId: mine,
                      slot: 1,
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
                  removeWatch({
                    eventId: seed.eventId,
                    heat: seed.heat,
                    lane: seed.lane,
                    deviceId: mine,
                    slot: 1,
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
          meet={meet}
          eventId={event.id}
          roster={roster}
          enrollments={enrollments}
          nameOrder={nameOrder}
          heat={heat}
          lane={assigningLane}
          onAssign={(athleteId) => {
            const athlete = roster.find((a) => a.id === athleteId);
            const teamId = enrollments.get(athleteId)?.teamId;
            const team = teamId ? meet.teams[teamId] : undefined;
            sendSwim({
              eventId: event.id,
              heat,
              lane: assigningLane,
              athleteId,
              athleteName: athlete ? athleteName(athlete) : "",
              athleteTeam: team?.code ?? "",
              exhibition: false,
            });
            setAssigningLane(null);
          }}
          onClose={() => setAssigningLane(null)}
        />
      )}

      {editingLane !== null &&
        (() => {
          const seed = seedByLane.get(editingLane);
          if (!seed) return null;
          const athlete = seed.athleteId
            ? meet.athletes[seed.athleteId]
            : undefined;
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
              watches={currentWatches({ watches }, seed).filter(
                (w) => w.timeMs !== undefined,
              )}
              deviceId={mine}
              exhibition={seed.exhibition ?? false}
              onToggleExhibition={() =>
                sendSwim({ ...seed, exhibition: !seed.exhibition })
              }
              onSaveTime={(timeMs) => {
                sendWatch({
                  eventId: seed.eventId,
                  heat: seed.heat,
                  lane: seed.lane,
                  deviceId: mine,
                  slot: 1,
                  role: myRole,
                  userId: user?.id ?? undefined,
                  timeMs,
                  recordedAt: Date.now(),
                });
                setEditingLane(null);
              }}
              onRemoveWatch={(watch) =>
                removeWatch({
                  eventId: watch.eventId,
                  heat: watch.heat,
                  lane: watch.lane,
                  deviceId: watch.deviceId,
                  slot: watch.slot,
                })
              }
              onRemoveFromLane={() => {
                removeSwim(seed);
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
  event,
  nameOrder,
}: {
  event: Event;
  nameOrder: NameOrder;
}) {
  const meet = useMeet();
  const divers = Object.values(meet.entries)
    .filter((e) => e.eventId === event.id)
    .map((e) => meet.athletes[e.athleteId])
    .filter((a): a is MeetAthlete => !!a)
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
            to={`/meets/${meet.id}/entries`}
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
  deviceId,
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
  deviceId: string;
  /** Whether this swim counts towards scoring and placing. */
  exhibition: boolean;
  onClose: () => void;
  onSaveTime: (timeMs: number) => void;
  onToggleExhibition: () => void;
  onRemoveWatch: (watch: Watch) => void;
  onRemoveFromLane: () => void;
}) {
  // Prefilled with this device's own watch, since typing a time replaces that
  // one — never somebody else's.
  const own = watches.find((w) => w.deviceId === deviceId);
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
                    key={`${watch.deviceId}:${watch.slot}`}
                    className="flex items-center justify-between gap-2 py-1"
                  >
                    <span className="text-sm tabular-nums">
                      {formatTime(watch.timeMs!)}
                      <span className="ml-2 text-xs text-slate-500">
                        {watch.deviceId === deviceId ? "you" : "another timer"}
                        {!fromStopwatch(watch) && " · typed"}
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Discard the ${formatTime(watch.timeMs!)} watch`}
                      onClick={() => onRemoveWatch(watch)}
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
