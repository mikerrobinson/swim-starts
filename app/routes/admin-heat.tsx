import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useFetcher, useNavigate, useSubmit } from "react-router";
import type { Route } from "./+types/admin-heat";
import {
  Button,
  Card,
  EmptyState,
  SectionTitle,
  TextInput,
} from "~/components/ui";
import { LaneAssignSheet } from "~/components/LaneAssignSheet";
import { formatClock, formatTime, parseTime } from "~/lib/time";
import {
  currentWatches,
  fromStopwatch,
  swimsComplete,
  heatsOf,
  laneProgress,
  laneTime,
  OK_DISCREPANCY_MS,
  runningWatches,
  swimsForHeat,
  stoppedWatches,
  swimTime,
  type LaneProgress,
  type LaneTime,
} from "~/lib/timing";
import { currentUser, requireDb, type SyncEnv } from "~/lib/api.server";
import {
  canDecideMeet,
  canEditMeet,
  canRecordTime,
  type MeetFacts,
} from "~/lib/access";
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
  displayName,
  eventName,
  getHeatSwims,
  getSortedEvents,
  type Event,
  type Meet,
  type ResultStatus,
  type Swim,
  type Watch,
  type WatchRole,
  type WatchSlotKey,
} from "~/types/meet";
import type { Athlete } from "~/types/athlete";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Admin · Swim Starts" }];
}

/** What `canRecordTime`/`canDecideMeet` fall back to when the meet's own D1
 *  row is somehow missing — nobody may record or decide a time for a meet
 *  that isn't there. */
const EMPTY_MEET_FACTS: MeetFacts = {
  adminIds: [],
  teamIds: [],
  athletesMayEnter: false,
};

/** Every racing team's roster, for the season the meet's date falls in —
 *  what `LaneAssignSheet`'s picker draws from. Same helper `splits-heat.tsx`
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
 * `meet` (D1's facts, for `canRecordTime`/`canDecideMeet`) and the racing
 * teams' season roster (for `LaneAssignSheet`'s picker) — everything else
 * this screen shows comes from `useMeet()`'s `MeetManifest` in the
 * component below.
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
 * lane, mark exhibition, decide or un-decide its result), or upsert a watch
 * (a time typed at the desk) — and the two matching deletes (empty a lane,
 * drop a watch).
 *
 * `kind` says which permission a swim upsert needs, since the object shape
 * alone can't: `"seat"` (seating, exhibition) is `canRecordTime` — any
 * coach of a racing team, same as `splits-heat.tsx`'s writes — but
 * `"decide"` (a status is being set or cleared) is `canDecideMeet`,
 * administrators only, and this is also the one place `decidedBy`/
 * `decidedAt` get stamped from the resolved session (or `"auto"` when the
 * desk's own effect proposed it) rather than trusted from the client.
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

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const stub = env.MEET_DO.getByName(meetId);

  if (intent === "upsert-swim") {
    const kind = String(form.get("kind") ?? "seat");
    const swim = JSON.parse(String(form.get("swim"))) as Swim;
    if (kind === "decide") {
      if (!canDecideMeet({ meet, userId })) {
        throw new Response("Whoever is running this meet decides a lane.", {
          status: 403,
        });
      }
      if (swim.status) {
        swim.decidedBy =
          form.get("auto") === "true" ? "auto" : (userId ?? undefined);
        swim.decidedAt = Date.now();
      } else {
        swim.decidedBy = undefined;
        swim.decidedAt = undefined;
      }
    } else {
      const coachedTeamIds = userId ? await teamsCoachedBy(db, userId) : [];
      if (!canRecordTime({ meet, userId, coachedTeamIds })) {
        throw new Response("Only the teams racing can seed a lane.", {
          status: 403,
        });
      }
    }
    await stub.upsertSwim(meetId, swim);
    return { ok: true };
  }

  if (intent === "delete-swim") {
    const coachedTeamIds = userId ? await teamsCoachedBy(db, userId) : [];
    if (!canRecordTime({ meet, userId, coachedTeamIds })) {
      throw new Response("Only the teams racing can empty a lane.", {
        status: 403,
      });
    }
    await stub.deleteSwim(meetId, {
      eventId: String(form.get("eventId")),
      heat: Number(form.get("heat")),
      lane: Number(form.get("lane")),
    });
    return { ok: true };
  }

  if (intent === "upsert-watch" || intent === "delete-watch") {
    const coachedTeamIds = userId ? await teamsCoachedBy(db, userId) : [];
    if (!canRecordTime({ meet, userId, coachedTeamIds })) {
      throw new Response("Only the teams racing can record times.", {
        status: 403,
      });
    }
    if (intent === "upsert-watch") {
      const watch = JSON.parse(String(form.get("watch"))) as Watch;
      await stub.upsertWatch(meetId, watch);
    } else {
      await stub.deleteWatch(meetId, {
        eventId: String(form.get("eventId")),
        heat: Number(form.get("heat")),
        lane: Number(form.get("lane")),
        deviceId: String(form.get("deviceId")),
        slot: Number(form.get("slot")),
      });
    }
    return { ok: true };
  }

  return { ok: false };
}

/**
 * The tick (or the empty lane, or the dropped watch, or the decision) moves
 * the instant it's tapped: patch `meetCache`'s cached manifest the same
 * shape the matching broadcast would, then hand off to the real request —
 * same pattern `splits-heat.tsx` uses for its four write shapes.
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

/**
 * One heat's desk — `/meets/:meetId/admin/:event/:heat`.
 *
 * Addressed the same way the timer already addresses a lane: the event's
 * place in the running order and the heat number, both 1-based, neither a
 * row id. Everything shown is derived from `useMeet()`: the watches are
 * what the timers sent, the proposed time is what those work out to, and
 * "official" means every lane that swam has been signed off.
 */
export default function AdminHeat({
  params,
  loaderData,
}: Route.ComponentProps) {
  const meet = useMeet();
  const user = useUser();
  const deviceId = useDeviceId();
  const submit = useSubmit();
  const navigate = useNavigate();
  const { nameOrder } = useViewPrefs();
  const addHeat = useFetcher<{ ok: boolean; heat: number }>();

  const meetFacts = loaderData.meet ?? EMPTY_MEET_FACTS;
  const userId = user?.id ?? null;
  const isAdmin = canEditMeet({ meet: meetFacts, userId });

  const [assigning, setAssigning] = useState<{
    heat: number;
    lane: number;
  } | null>(null);

  const events = useMemo(() => getSortedEvents(meet), [meet]);
  const swims = useMemo(() => Object.values(meet.swims), [meet.swims]);

  const eventNo = Number(params.event);
  const heatNo = Number(params.heat);
  const event = meet.events[params.event]; // events.find((e) => e.position === eventNo - 1);
  const swimsInHeat = getHeatSwims(meet, params.event, heatNo);

  const heats = useMemo(
    () => (event ? heatsOf({ swims }, event.id) : []),
    [swims, event],
  );

  // A heat just added lands here automatically rather than leaving the desk
  // to find it on the rail.
  const addedHeat = addHeat.data?.ok ? addHeat.data.heat : null;
  useEffect(() => {
    if (addedHeat != null && event) {
      navigate(`/meets/${meet.id}/admin/${event.position + 1}/${addedHeat}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addedHeat]);

  const goTo = (eventPos: number, heat: number) =>
    navigate(`/meets/${meet.id}/admin/${eventPos}/${heat}`);

  const heatIndex = heats.indexOf(heatNo);

  const prevHeat = () => {
    if (!event) return;
    if (heatIndex > 0) return goTo(eventNo, heats[heatIndex - 1]);
    const prevEvent = events[event.position - 1];
    if (!prevEvent) return;
    const prevHeats = heatsOf({ swims }, prevEvent.id);
    goTo(prevEvent.position + 1, prevHeats[prevHeats.length - 1] ?? 1);
  };

  const nextHeat = () => {
    if (!event) return;
    if (heatIndex + 1 < heats.length)
      return goTo(eventNo, heats[heatIndex + 1]);
    const nextEvent = events[event.position + 1];
    if (!nextEvent) return;
    const nextHeats = heatsOf({ swims }, nextEvent.id);
    goTo(nextEvent.position + 1, nextHeats[0] ?? 1);
  };

  const hasPrev = !!event && (heatIndex > 0 || event.position > 0);
  const hasNext =
    !!event &&
    (heatIndex + 1 < heats.length || event.position + 1 < events.length);

  /** Send a swim upsert/delete, or a watch upsert/delete — the shapes
   *  `action`/`clientAction` above understand. */
  const sendSwim = (
    swim: Swim,
    kind: "seat" | "decide" = "seat",
    auto = false,
  ) => {
    const form = new FormData();
    form.set("intent", "upsert-swim");
    form.set("kind", kind);
    form.set("auto", String(auto));
    form.set("swim", JSON.stringify(swim));
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

  if (!event) {
    return (
      <EmptyState title="No such event">Pick one from the list.</EmptyState>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" onClick={prevHeat} disabled={!hasPrev}>
          ‹ Heat
        </Button>
        <p className="text-sm text-slate-500">
          {
            Object.values(meet.entries).filter((e) => e.eventId === event.id)
              .length
          }{" "}
          entered
          {heats.length === 0 ? ", no heats yet" : ""}
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!isAdmin}
            onClick={() =>
              addHeat.submit(
                { eventId: event.id },
                {
                  method: "post",
                  action: `/meets/${meet.id}/admin`,
                  encType: "application/json",
                },
              )
            }
          >
            {addHeat.state === "submitting" ? "Adding…" : "+ Add heat"}
          </Button>
          <Button size="sm" onClick={nextHeat} disabled={!hasNext}>
            Heat ›
          </Button>
        </div>
      </div>

      {heatNo > 0 && heats.includes(heatNo) ? (
        <HeatCard
          event={event}
          heat={heatNo}
          nameOrder={nameOrder}
          swims={swimsInHeat}
          watches={Object.values(meet.watches)}
          athletes={meet.athletes}
          laneCount={meet.details.laneCount}
          deviceId={deviceId}
          sendSwim={sendSwim}
          sendWatch={sendWatch}
          removeWatch={removeWatch}
          onAssign={(lane) => setAssigning({ heat: heatNo, lane })}
        />
      ) : (
        <EmptyState title="No such heat">
          {heats.length > 0
            ? "Pick a heat with the arrows above."
            : "Nobody is in this event yet — add a heat, or wait for entries to seat one."}
        </EmptyState>
      )}

      {assigning && (
        <LaneAssignSheet
          meet={meet}
          eventId={event.id}
          heat={assigning.heat}
          lane={assigning.lane}
          roster={roster}
          enrollments={enrollments}
          nameOrder={nameOrder}
          onAssign={(athleteId) => {
            const athlete = roster.find((a) => a.id === athleteId);
            const teamId = enrollments.get(athleteId)?.teamId;
            const team = teamId ? meet.teams[teamId] : undefined;
            sendSwim({
              eventId: event.id,
              heat: assigning.heat,
              lane: assigning.lane,
              athleteId,
              athleteName: athlete ? athleteName(athlete) : "",
              athleteTeam: team?.code ?? "",
              exhibition: false,
            });
            setAssigning(null);
          }}
          onClose={() => setAssigning(null)}
        />
      )}
    </>
  );
}

function HeatCard({
  event,
  heat,
  nameOrder,
  swims,
  watches,
  athletes,
  laneCount,
  deviceId,
  sendSwim,
  sendWatch,
  removeWatch,
  onAssign,
}: {
  event: Event;
  heat: number;
  nameOrder: "first" | "last";
  swims: Swim[];
  watches: Watch[];
  athletes: Record<string, Athlete>;
  laneCount: number;
  deviceId: string;
  sendSwim: (swim: Swim, kind?: "seat" | "decide", auto?: boolean) => void;
  sendWatch: (watch: Watch) => void;
  removeWatch: (key: WatchSlotKey) => void;
  onAssign: (lane: number) => void;
}) {
  const closed = swimsComplete(swims);

  // Only while a thumb is actually down somewhere in this heat — a watch
  // that's been stopped and is just waiting on its submit doesn't need
  // ticking, it needs to sit still.
  const now = useTicker(
    swims.some((s) => runningWatches({ watches }, s).length > 0),
  );

  /**
   * Where the keyboard goes next, without every `LaneRow` needing to know
   * about its neighbors.
   */
  const fields = useRef(
    new Map<
      number,
      { name: HTMLButtonElement | null; time: HTMLInputElement | null }
    >(),
  );
  const registerField = (
    laneNumber: number,
    kind: "name" | "time",
    el: HTMLButtonElement | HTMLInputElement | null,
  ) => {
    const entry = fields.current.get(laneNumber) ?? { name: null, time: null };
    if (kind === "name") entry.name = el as HTMLButtonElement | null;
    else entry.time = el as HTMLInputElement | null;
    fields.current.set(laneNumber, entry);
  };
  const focusField = (laneNumber: number, kind: "name" | "time") => {
    if (laneNumber < 1 || laneNumber > laneCount) return;
    const entry = fields.current.get(laneNumber);
    (kind === "name" ? entry?.name : entry?.time)?.focus();
  };

  /**
   * Keep each lane's status honest, without anybody having to press
   * anything.
   *
   * A lane with one clean time is not a decision — it is the timing table
   * agreeing with itself, and OK is the only status that can be inferred
   * rather than chosen. So it is set the moment a time exists and taken
   * straight back the moment the watches stop agreeing, and it never touches
   * a DQ, an NS or an OK a person actually clicked — those are calls, and
   * only a person undoes a call.
   *
   * Sent with `kind: "decide", auto: true` so the server stamps
   * `decidedBy: "auto"` rather than this admin's own id — a later
   * disagreement can then tell its own earlier writing apart from a real
   * decision and take back only that.
   */
  useEffect(() => {
    if (closed) return;
    for (const swim of swims) {
      const derived = laneTime(currentWatches({ watches }, swim));

      if (!swim.status) {
        if (
          derived &&
          (derived.discrepancyMs === null ||
            derived.discrepancyMs <= OK_DISCREPANCY_MS)
        ) {
          sendSwim(
            { ...swim, status: "OK", officialTimeMs: derived.timeMs },
            "decide",
            true,
          );
        }
        continue;
      }

      if (swim.decidedBy !== "auto") continue;

      if (
        !derived ||
        (derived.discrepancyMs !== null &&
          derived.discrepancyMs > OK_DISCREPANCY_MS)
      ) {
        sendSwim(
          { ...swim, status: undefined, officialTimeMs: undefined },
          "decide",
        );
      } else if (derived.timeMs !== swim.officialTimeMs) {
        sendSwim(
          { ...swim, status: "OK", officialTimeMs: derived.timeMs },
          "decide",
          true,
        );
      }
    }
    // `swims`/`watches` carry the pending overlay via `meetCache`, so this
    // settles itself as soon as a write above lands in it — no extra guard
    // needed against re-firing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swims, watches, closed]);

  // Once anybody's clock has moved, sitting on "not started" would be a lie —
  // and once a lane reads OK on its own, or there is nothing left to time,
  // there is nothing more the timing table can add.
  const anyActivity = swims.some(
    (swim) => currentWatches({ watches }, swim).length > 0,
  );
  const anyOk = swims.some((swim) => swim.status === "OK");
  const allNS = swims.length > 0 && swims.every((swim) => swim.status === "NS");
  const readyToComplete = anyOk || swims.length === 0 || allNS;

  /**
   * The one press that closes a heat out.
   *
   * Everything with a time on the clock — even one the discrepancy check
   * wouldn't trust on its own — is accepted as the administrator's own call
   * the moment they press this; a lane with nothing on it at all is recorded
   * as a no-show rather than left to sit open forever.
   */
  const markComplete = () => {
    for (const swim of swims) {
      if (swim.status) continue;
      const derived = laneTime(currentWatches({ watches }, swim));
      sendSwim(
        {
          ...swim,
          status: derived ? "OK" : "NS",
          officialTimeMs: derived ? derived.timeMs : 0,
        },
        "decide",
      );
    }
  };

  /** Reopen every lane in the heat, so a correction can be made and the
   *  automatic status can pick the swims back up on its own. */
  const fixResults = () => {
    for (const swim of swims) {
      if (!swim.status) continue;
      sendSwim(
        { ...swim, status: undefined, officialTimeMs: undefined },
        "decide",
      );
    }
  };

  const heatButton = closed
    ? {
        label: "Fix Results",
        onClick: fixResults,
        variant: "ghost" as const,
        disabled: false,
      }
    : readyToComplete
      ? {
          label: "Mark as Complete",
          onClick: markComplete,
          variant: "primary" as const,
          disabled: false,
        }
      : anyActivity
        ? {
            label: "In progress",
            onClick: undefined,
            variant: undefined,
            disabled: true,
          }
        : {
            label: "Not started",
            onClick: undefined,
            variant: undefined,
            disabled: true,
          };

  return (
    <Card>
      <SectionTitle
        action={
          <Button
            size="sm"
            variant={heatButton.variant}
            disabled={heatButton.disabled}
            onClick={heatButton.onClick}
          >
            {heatButton.label}
          </Button>
        }
      >
        {eventName(event)} · heat {heat}
        {closed && (
          <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            closed
          </span>
        )}
      </SectionTitle>

      {swims.length === 0 && (
        <p className="mb-2 text-sm text-slate-500">
          Nobody is in this heat yet.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-1 pr-2 font-semibold">Lane</th>
              <th className="py-1 pr-2 font-semibold">Swimmer</th>
              <th className="py-1 pr-2 font-semibold">Watches</th>
              <th className="py-1 pr-2 font-semibold">Time</th>
              <th className="py-1 pr-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {/* Every lane of the pool, not only the seeded ones: an empty
                lane is where somebody gets added, and a lane the desk can't
                see is a lane it can't fill. */}
            {Array.from({ length: laneCount }, (_, i) => i + 1).map((lane) => (
              <LaneRow
                key={lane}
                event={event}
                heat={heat}
                lane={lane}
                nameOrder={nameOrder}
                swims={swims}
                watches={watches}
                athletes={athletes}
                deviceId={deviceId}
                now={now}
                closed={closed}
                sendSwim={sendSwim}
                sendWatch={sendWatch}
                removeWatch={removeWatch}
                onAssign={onAssign}
                registerField={registerField}
                focusField={focusField}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * Re-render on a one-second beat, and only while a stopwatch is actually
 * running somewhere in this heat.
 */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const STATUSES: ResultStatus[] = ["OK", "DQ", "NS"];

/**
 * How the time box reads at a glance, before anybody reads the number.
 *
 * The distinction that earns its keep is the middle one. A lane with nothing
 * on it and a lane whose timers are all still holding their clocks show the
 * same empty box, and they want opposite responses — send somebody to cover
 * it, or leave it alone. Amber is "this is in hand"; grey is "nobody is on
 * this lane".
 */
const TIME_TONE: Record<LaneProgress, string> = {
  none: "border-dashed border-slate-300 bg-transparent text-slate-400 dark:border-slate-700",
  waiting:
    "border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100",
  complete:
    "border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-600 dark:bg-emerald-950 dark:text-emerald-100",
};

const PROGRESS_HINT: Record<LaneProgress, string> = {
  none: "No stopwatch on this lane yet",
  waiting: "Timing in progress — not every watch is in",
  complete: "Every watch on this lane is in",
};

const ROLE_LABEL: Record<WatchRole, string> = {
  timer: "Timer",
  coach: "A coach",
  admin: "Entered at the desk",
};

function describeTime(time: LaneTime): string {
  if (time.from === "admin") return "yours";
  return `${ROLE_LABEL[time.from]}`;
}

function LaneRow({
  event,
  heat,
  lane,
  nameOrder,
  swims,
  watches,
  athletes,
  deviceId,
  now,
  closed,
  sendSwim,
  sendWatch,
  removeWatch,
  onAssign,
  registerField,
  focusField,
}: {
  event: Event;
  heat: number;
  lane: number;
  nameOrder: "first" | "last";
  swims: Swim[];
  watches: Watch[];
  athletes: Record<string, Athlete>;
  deviceId: string;
  now: number;
  /** The heat this lane belongs to has been marked complete — nothing here
   *  may change until "Fix Results" reopens it. */
  closed: boolean;
  sendSwim: (swim: Swim, kind?: "seat" | "decide", auto?: boolean) => void;
  sendWatch: (watch: Watch) => void;
  removeWatch: (key: WatchSlotKey) => void;
  onAssign: (lane: number) => void;
  registerField: (
    lane: number,
    kind: "name" | "time",
    el: HTMLButtonElement | HTMLInputElement | null,
  ) => void;
  focusField: (lane: number, kind: "name" | "time") => void;
}) {
  /**
   * What's in the box while somebody is typing in it.
   *
   * `null` means nobody is, and the box shows the lane's time. It has to be
   * this way round because the screen re-reads the meet every few seconds: a
   * plain controlled value would be overwritten mid-keystroke by a poll, and
   * a plain uncontrolled one would never show a time arriving from a phone.
   */
  const [draft, setDraft] = useState<string | null>(null);

  /** The swim in this lane, if anybody has said who is in it. */
  const seed = swims.find(
    (s) => s.eventId === event.id && s.heat === heat && s.lane === lane,
  );
  const watchesHere = seed ? currentWatches({ watches }, seed) : [];
  const timed = watchesHere.filter((w) => w.timeMs !== undefined);
  const running = seed ? runningWatches({ watches }, seed) : [];
  const stopped = seed ? stoppedWatches({ watches }, seed) : [];
  const result = seed?.status ? seed : undefined;
  const accepted = seed ? swimTime({ swims, watches }, seed) : null;
  const derived = laneTime(watchesHere);
  const progress = seed ? laneProgress({ watches }, seed) : "none";

  const athlete = seed?.athleteId ? athletes[seed.athleteId] : undefined;
  const signedOff = result !== undefined;

  // A lane with nobody in it and nothing against it is just an empty lane.
  const idle = !seed;

  /**
   * Type a time in at the desk.
   *
   * It is a **watch**, not a ruling — one more reading of the same race,
   * filed under whoever typed it exactly as a phone's is filed under the
   * phone. A time is a time however it reached the meet: off a multi-lane
   * stopwatch, off a handheld read out down the pool, or off the board.
   *
   * It used to be written onto the call, where it outranked every watch on
   * the lane. That made the desk's number a silent override with nothing to
   * show what it overrode — and it meant the same act of reading a clock was
   * stored two different ways depending on who did it. Discarding a watch the
   * desk doesn't believe is the honest version of the same power, and it
   * leaves the reason visible in what's left.
   */
  const typeTime = (timeMs: number) => {
    if (!seed) return;
    sendWatch({
      eventId: seed.eventId,
      heat: seed.heat,
      lane: seed.lane,
      deviceId,
      slot: 1,
      // Only an administrator reaches this screen, and the server checks it
      // again — this is what the overlay needs to rank the row correctly
      // before the server answers.
      role: "admin",
      timeMs,
      recordedAt: Date.now(),
    });
  };

  /**
   * What the box shows: what somebody is typing, or the swim's time.
   *
   * `swimTime` rather than `laneTime` directly, because it is the one every
   * other screen reads and the box must not disagree with the results page
   * about what this lane swam. It adds the thing that matters: a signed-off
   * swim reads the number that was accepted rather than what the watches say
   * now, so a late watch cannot move it.
   */
  const shownTime = draft ?? (accepted ? formatTime(accepted.timeMs) : "");

  /**
   * Take what was typed, if it changed anything.
   *
   * Unchanged is the common case — the desk tabs through a heat reading times
   * without meaning to alter one — so an unchanged box must write nothing at
   * all, or every glance would file a ruling. Emptying it withdraws the
   * desk's own reading and lets the swim fall back to the watches, which is
   * the way out of a number typed by mistake.
   */
  const commitTime = () => {
    const text = draft;
    setDraft(null);
    if (text === null || !seed || closed) return;

    const mine = watchesHere.find(
      (w) => w.role === "admin" && w.deviceId === deviceId,
    );
    if (text.trim() === "") {
      if (mine) {
        removeWatch({
          eventId: mine.eventId,
          heat: mine.heat,
          lane: mine.lane,
          deviceId: mine.deviceId,
          slot: mine.slot,
        });
      }
      return;
    }

    const ms = parseTime(text);
    if (ms === null || ms === accepted?.timeMs) return;
    typeTime(ms);
  };

  /**
   * Sign the swim off, as whatever it was.
   *
   * One act rather than two: the status is chosen *as* the lane is accepted,
   * and the number written down is the one that was on screen — so a watch
   * landing in the same second cannot sign off a time nobody looked at.
   * Taking it back is un-deciding, which sends the same swim without a
   * status.
   */
  const signOff = (status: ResultStatus) => {
    if (!seed || closed) return;
    sendSwim(
      {
        ...seed,
        status,
        // A no-show or a disqualification needn't have a time behind it.
        officialTimeMs: accepted?.timeMs ?? 0,
      },
      "decide",
    );
  };

  /**
   * Say whether this swim counts.
   *
   * Not a call in the sense a DQ is — it doesn't need every watch on the lane
   * in front of it, and it can be set before there's a time at all. It just
   * has to land on the same row a DQ would, which is why it's open to the same
   * people who may record a time rather than the desk alone.
   */
  const toggleExhibition = () => {
    if (!seed || closed) return;
    sendSwim({ ...seed, exhibition: !seed.exhibition });
  };

  /**
   * The keyboard's own map of the row: right off the name onto the time,
   * left back, up and down onto the same field one lane over.
   */
  const onNameKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusField(lane, "time");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusField(lane + 1, "name");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusField(lane - 1, "name");
    }
  };

  const onTimeKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commitTime();
    else if (e.key === "Escape") setDraft(null);
    else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusField(lane, "name");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusField(lane + 1, "time");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusField(lane - 1, "time");
    }
  };

  return (
    <tr
      className={`border-t border-slate-100 dark:border-slate-800 ${
        signedOff ? "bg-emerald-50/60 dark:bg-emerald-950/30" : ""
      }`}
    >
      <td className="py-2 pr-2 font-bold tabular-nums">{lane}</td>

      <td className="py-2 pr-2">
        <button
          type="button"
          ref={(el) => registerField(lane, "name", el)}
          tabIndex={athlete ? -1 : 0}
          onKeyDown={onNameKeyDown}
          onClick={() => onAssign(lane)}
          className="text-left"
        >
          <span className="block font-medium">
            {athlete ? displayName(athlete, nameOrder) : "— assign —"}
          </span>
          {seed && !athlete && (
            <span className="block text-xs text-amber-700 dark:text-amber-400">
              {timed.length > 0
                ? "timed, nobody named — tap to assign"
                : "a stopwatch running on a lane with no name"}
            </span>
          )}
        </button>
      </td>

      {/* Every timer's own send, one chip each. Shown in full rather than
          summarised because a single slow thumb is obvious side by side and
          invisible once averaged — and because the median only means anything
          if you can see what it chose between. */}
      <td className="py-2 pr-2">
        <span className="flex flex-wrap items-center gap-1">
          {timed.length === 0 &&
            running.length === 0 &&
            stopped.length === 0 && (
              <span className="text-xs text-slate-400">—</span>
            )}

          {/* A stopwatch that is still going. */}
          {running.map((a) => (
            <span
              key={`${a.deviceId}:${a.slot}`}
              title={`Timer ${a.deviceId} is still timing this lane`}
              className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs tabular-nums text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              <span aria-hidden className="text-[0.6rem]">
                ▶
              </span>
              {formatClock(Math.max(0, now - a.startedAt!), {
                hundredths: false,
              })}
            </span>
          ))}
          {/* A stopwatch that's been stopped but hasn't submitted yet. */}
          {stopped.map((a) => (
            <span
              key={`${a.deviceId}:${a.slot}`}
              title={`Timer ${a.deviceId} stopped their watch — waiting for it to submit`}
              className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            >
              <span aria-hidden className="text-[0.6rem]">
                ■
              </span>
              {formatClock(
                Math.max(0, a.stoppedAt! - (a.startedAt ?? a.stoppedAt!)),
              )}
            </span>
          ))}
          {/* Each watch with a way to drop it. */}
          {timed.map((w) => {
            const counted = derived !== null && w.role === derived.from;
            return (
              <span
                key={`${w.deviceId}:${w.slot}`}
                title={
                  `${ROLE_LABEL[w.role]}` +
                  (fromStopwatch(w) ? " · off a stopwatch" : " · typed in") +
                  (counted ? "" : " · not counted, outranked")
                }
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs tabular-nums ${
                  !counted
                    ? "bg-slate-100 text-slate-400 line-through dark:bg-slate-900 dark:text-slate-600"
                    : w.role === "admin"
                      ? "bg-amber-100 font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                      : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                }`}
              >
                {formatTime(w.timeMs!)}
                {!fromStopwatch(w) && "✎"}
                <button
                  type="button"
                  aria-label={`Discard the ${formatTime(w.timeMs!)} watch`}
                  title="Discard this watch"
                  disabled={closed}
                  tabIndex={-1}
                  onClick={() =>
                    !closed &&
                    removeWatch({
                      eventId: w.eventId,
                      heat: w.heat,
                      lane: w.lane,
                      deviceId: w.deviceId,
                      slot: w.slot,
                    })
                  }
                  className="text-red-600 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  ✕
                </button>
              </span>
            );
          })}
        </span>
      </td>

      <td className="py-2 pr-2">
        <TextInput
          ref={(el) => registerField(lane, "time", el)}
          value={shownTime}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.target.select()}
          onBlur={commitTime}
          onKeyDown={onTimeKeyDown}
          inputMode="numeric"
          placeholder={progress === "none" ? "" : "0000"}
          aria-label={`Time for lane ${lane}`}
          title={
            closed
              ? "This heat is complete — Fix Results to change it."
              : PROGRESS_HINT[progress]
          }
          tone={TIME_TONE[progress]}
          readOnly={closed}
          className="!w-28 text-center font-mono tabular-nums disabled:opacity-60"
        />
        {derived && (
          <span className="ml-1 text-xs text-slate-400">
            {describeTime(derived)}
          </span>
        )}
      </td>

      <td className="py-2 pr-2">
        <div className="flex flex-wrap items-center gap-1">
          {STATUSES.map((status) => {
            const current = result?.status ?? "OK";
            const chosen = signedOff && current === status;
            const needsTime = status === "OK" && !accepted;
            return (
              <button
                key={status}
                type="button"
                disabled={idle || closed || needsTime}
                tabIndex={-1}
                title={
                  closed
                    ? "This heat is complete — Fix Results to change it."
                    : needsTime
                      ? "No time recorded yet — wait for a watch to submit."
                      : signedOff
                        ? `Signed off as ${status}`
                        : `Sign this lane off as ${status}`
                }
                onClick={() => signOff(status)}
                className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                  chosen
                    ? status === "OK"
                      ? "bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-900"
                      : "bg-red-600 text-white"
                    : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                } ${idle || closed || needsTime ? "opacity-40" : ""}`}
              >
                {status}
              </button>
            );
          })}
          <button
            type="button"
            disabled={idle || closed}
            tabIndex={-1}
            title={
              closed
                ? "This heat is complete — Fix Results to change it."
                : seed?.exhibition
                  ? "Exhibition — doesn't count towards scoring or placing. Tap to make it count again."
                  : "Mark exhibition — the time stands, but it won't score or place."
            }
            onClick={toggleExhibition}
            className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
              seed?.exhibition
                ? "bg-amber-500 text-white"
                : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            } ${idle || closed ? "opacity-40" : ""}`}
          >
            X
          </button>
        </div>
      </td>
    </tr>
  );
}
