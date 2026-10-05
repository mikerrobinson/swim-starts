import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useFetcher, useNavigate, useParams } from "react-router";
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
  fromStopwatch,
  laneProgress,
  laneTime,
  OK_DISCREPANCY_MS,
  runningWatches,
  stoppedWatches,
  swimTime,
  swimsComplete,
  type LaneProgress,
  type LaneTime,
} from "~/lib/timing";
import { useHeat, type HeatManifest, type LaneManifest } from "~/hooks/useHeat";
import { useMeet } from "~/hooks/useMeet";
import { useMeetMutation } from "~/hooks/useMeetMutation";
import { useDeviceId, useUser } from "~/state/user";
import { useViewPrefs } from "~/state/view-prefs";
import {
  athleteName,
  eventName,
  displayName,
  getSortedEvents,
  type Event,
} from "~/types/meet";
import type { NameOrder } from "~/types/preferences";
import type { EntityMutation } from "~/types/mutations";
import { type ResultStatus, type Swim, type SwimIdentity } from "~/types/swim";
import type { Watch, WatchRole } from "~/types/watch";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Admin · Swim Starts" }];
}

/** A full-object swim upsert — every mutation re-sends the whole row, not a
 *  diff, so a partial `changes` can never accidentally drop a sibling field. */
function swimMutation(
  swim: Swim,
  changes: Partial<Omit<Swim, keyof SwimIdentity>>,
): EntityMutation {
  return {
    entity: "swim",
    op: "upsert",
    key: { eventId: swim.eventId, heat: swim.heat, lane: swim.lane },
    patch: {
      athleteId: swim.athleteId,
      athleteName: swim.athleteName,
      athleteTeam: swim.athleteTeam,
      exhibition: swim.exhibition,
      status: swim.status,
      officialTimeMs: swim.officialTimeMs,
      decidedAt: swim.decidedAt,
      decidedBy: swim.decidedBy,
      ...changes,
    },
  };
}

/**
 * One heat's desk — `/meets/:meetId/admin/:event/:heat`, both 1-based
 * display positions rather than row ids, same as the running order.
 */
export default function AdminHeat() {
  const params = useParams();
  const meetId = params.meetId!;
  const eventId = params.event!;
  const heatNumber = Number(params.heat);
  const meet = useMeet();
  const navigate = useNavigate();
  const {
    viewPrefs: { nameOrder },
  } = useViewPrefs();
  const addHeat = useFetcher<{ ok: boolean; heat: number }>();
  const { send } = useMeetMutation(meet.id);

  const heat = useHeat(eventId, heatNumber);
  const event = heat?.event;

  const [assigningLane, setAssigningLane] = useState<number | null>(null);

  const addedHeat = addHeat.data?.ok ? addHeat.data.heat : null;
  useEffect(() => {
    if (addedHeat != null && event) {
      navigate(`/meets/${meet.id}/admin/${event.position + 1}/${addedHeat}`);
    }
  }, [addedHeat, event, meet.id, navigate]);

  const goTo = (ref: { eventId: string; heat: number } | null) => {
    if (!ref) return;
    const position = meet.events[ref.eventId]?.position;
    if (position === undefined) return;
    navigate(`/meets/${meet.id}/admin/${position + 1}/${ref.heat}`);
  };

  if (!event || !heat) {
    return (
      <EmptyState title="No such event">Pick one from the list.</EmptyState>
    );
  }

  const roster = Object.values(meet.athletes);

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" onClick={() => goTo(heat.prev)} disabled={!heat.prev}>
          ‹ Heat
        </Button>
        <p className="text-sm text-slate-500">
          {
            Object.values(meet.entries).filter((e) => e.eventId === event.id)
              .length
          }{" "}
          entered
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
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
          <Button
            size="sm"
            onClick={() => goTo(heat.next)}
            disabled={!heat.next}
          >
            Heat ›
          </Button>
        </div>
      </div>

      <HeatCard
        event={event}
        heatNumber={heatNumber}
        heat={heat}
        nameOrder={nameOrder}
        onAssign={setAssigningLane}
      />

      {assigningLane != null && (
        <LaneAssignSheet
          meet={meet}
          eventId={event.id}
          heat={heatNumber}
          lane={assigningLane}
          roster={roster}
          nameOrder={nameOrder}
          onAssign={(athleteId) => {
            const athlete = meet.athletes[athleteId];
            const existing = heat.lanes[assigningLane]?.swim;
            send({
              entity: "swim",
              op: "upsert",
              key: { eventId: event.id, heat: heatNumber, lane: assigningLane },
              patch: {
                athleteId,
                athleteName: athlete ? athleteName(athlete) : "",
                athleteTeam: athlete
                  ? (meet.teams[athlete.teamId]?.code ?? "")
                  : "",
                exhibition: existing?.exhibition ?? false,
              },
            });
            setAssigningLane(null);
          }}
          onClose={() => setAssigningLane(null)}
        />
      )}
    </>
  );
}

function HeatCard({
  event,
  heatNumber,
  heat,
  nameOrder,
  onAssign,
}: {
  event: Event;
  heatNumber: number;
  heat: HeatManifest;
  nameOrder: NameOrder;
  onAssign: (lane: number) => void;
}) {
  const meet = useMeet();
  const user = useUser();
  const { send } = useMeetMutation(meet.id);

  const lanes = useMemo(
    () =>
      Object.entries(heat.lanes).map(([lane, l]) => [Number(lane), l] as const),
    [heat.lanes],
  );
  const identity = (lane: number): SwimIdentity => ({
    eventId: event.id,
    heat: heatNumber,
    lane,
  });

  const swims = lanes.map(([, l]) => l.swim).filter((s): s is Swim => !!s);
  const closed = swimsComplete(swims);

  // Only while a thumb is actually down somewhere in this heat — a watch
  // that's stopped and waiting on its submit doesn't need ticking.
  const now = useTicker(
    lanes.some(
      ([lane, l]) =>
        runningWatches({ watches: l.watches }, identity(lane)).length > 0,
    ),
  );

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
    const entry = fields.current.get(laneNumber);
    (kind === "name" ? entry?.name : entry?.time)?.focus();
  };

  /**
   * A lane with one clean time isn't a decision, it's the timing table
   * agreeing with itself — so OK is set the moment a time exists and taken
   * back the moment the watches stop agreeing. A DQ, an NS or an OK a
   * person actually clicked is never touched here; only a person undoes a
   * call. `decidedBy: "auto"` marks which, so a later disagreement knows
   * it's safe to take back only its own earlier writing.
   */
  useEffect(() => {
    if (closed) return;
    for (const [, l] of lanes) {
      const swim = l.swim;
      if (!swim) continue;
      const derived = laneTime(l.watches);

      if (!swim.status) {
        if (
          derived &&
          (derived.discrepancyMs === null ||
            derived.discrepancyMs <= OK_DISCREPANCY_MS)
        ) {
          send(
            swimMutation(swim, {
              status: "OK",
              officialTimeMs: derived.timeMs,
              decidedBy: "auto",
              decidedAt: Date.now(),
            }),
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
        send(
          swimMutation(swim, {
            status: undefined,
            officialTimeMs: undefined,
            decidedBy: undefined,
            decidedAt: undefined,
          }),
        );
      } else if (derived.timeMs !== swim.officialTimeMs) {
        send(
          swimMutation(swim, {
            status: "OK",
            officialTimeMs: derived.timeMs,
            decidedBy: "auto",
            decidedAt: Date.now(),
          }),
        );
      }
    }
  }, [lanes, closed, send]);

  const anyActivity = lanes.some(([, l]) => l.watches.length > 0);
  const anyOk = swims.some((swim) => swim.status === "OK");
  const allNS = swims.length > 0 && swims.every((swim) => swim.status === "NS");
  const readyToComplete = anyOk || swims.length === 0 || allNS;

  const markComplete = () => {
    for (const [, l] of lanes) {
      if (!l.swim || l.swim.status) continue;
      const derived = laneTime(l.watches);
      send(
        swimMutation(l.swim, {
          status: derived ? "OK" : "NS",
          officialTimeMs: derived ? derived.timeMs : 0,
          decidedBy: user?.id,
          decidedAt: Date.now(),
        }),
      );
    }
  };

  const fixResults = () => {
    for (const [, l] of lanes) {
      if (!l.swim?.status) continue;
      send(
        swimMutation(l.swim, {
          status: undefined,
          officialTimeMs: undefined,
          decidedBy: undefined,
          decidedAt: undefined,
        }),
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
        {eventName(event)} · heat {heatNumber}
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
            {lanes.map(([lane, l]) => (
              <LaneRow
                key={lane}
                event={event}
                heatNumber={heatNumber}
                lane={lane}
                laneManifest={l}
                nameOrder={nameOrder}
                now={now}
                closed={closed}
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

/** Amber is "this is in hand"; grey is "nobody is on this lane" — the
 *  distinction a desk watching a heat go off actually needs. */
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
  return ROLE_LABEL[time.from];
}

function LaneRow({
  event,
  heatNumber,
  lane,
  laneManifest,
  nameOrder,
  now,
  closed,
  onAssign,
  registerField,
  focusField,
}: {
  event: Event;
  heatNumber: number;
  lane: number;
  laneManifest: LaneManifest;
  nameOrder: NameOrder;
  now: number;
  closed: boolean;
  onAssign: (lane: number) => void;
  registerField: (
    lane: number,
    kind: "name" | "time",
    el: HTMLButtonElement | HTMLInputElement | null,
  ) => void;
  focusField: (lane: number, kind: "name" | "time") => void;
}) {
  const meet = useMeet();
  const user = useUser();
  const deviceId = useDeviceId();
  const { send } = useMeetMutation(meet.id);

  const { swim, athlete, watches } = laneManifest;
  const identity: SwimIdentity = { eventId: event.id, heat: heatNumber, lane };

  /** What's in the box while somebody is typing — `null` means read the
   *  swim's own time instead, so a background poll can't clobber a keystroke. */
  const [draft, setDraft] = useState<string | null>(null);

  const timed = watches.filter((w) => w.timeMs > 0);
  const running = runningWatches({ watches }, identity);
  const stopped = stoppedWatches({ watches }, identity);
  const derived = laneTime(watches);
  const progress = laneProgress({ watches }, identity);
  const accepted = swimTime({ swims: swim ? [swim] : [], watches }, identity);
  const signedOff = !!swim?.status;
  const idle = !swim;

  const typeTime = (timeMs: number) => {
    if (!swim) return;
    send({
      entity: "watch",
      op: "upsert",
      key: {
        eventId: swim.eventId,
        heat: swim.heat,
        lane: swim.lane,
        deviceId,
        slot: 1,
      },
      patch: {
        role: "admin",
        userId: user?.id,
        startedAt: 0,
        stoppedAt: 0,
        timeMs,
        recordedAt: Date.now(),
      },
    });
  };

  const removeWatch = (w: Watch) => {
    send({
      entity: "watch",
      op: "delete",
      key: {
        eventId: w.eventId,
        heat: w.heat,
        lane: w.lane,
        deviceId: w.deviceId,
        slot: w.slot,
      },
    });
  };

  // `swimTime` rather than the raw watches, so the box agrees with every
  // other screen: a signed-off swim shows what was accepted, not whatever
  // the watches say now, so a late watch can't move it.
  const shownTime = draft ?? (accepted ? formatTime(accepted.timeMs) : "");

  const commitTime = () => {
    const text = draft;
    setDraft(null);
    if (text === null || !swim || closed) return;

    const mine = watches.find(
      (w) => w.role === "admin" && w.deviceId === deviceId,
    );
    if (text.trim() === "") {
      if (mine) removeWatch(mine);
      return;
    }

    const ms = parseTime(text);
    if (ms === null || ms === accepted?.timeMs) return;
    typeTime(ms);
  };

  const signOff = (status: ResultStatus) => {
    if (!swim || closed) return;
    send(
      swimMutation(swim, {
        status,
        officialTimeMs: accepted?.timeMs ?? 0,
        decidedBy: user?.id,
        decidedAt: Date.now(),
      }),
    );
  };

  const toggleExhibition = () => {
    if (!swim || closed) return;
    send(swimMutation(swim, { exhibition: !swim.exhibition }));
  };

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
          {swim && !athlete && (
            <span className="block text-xs text-amber-700 dark:text-amber-400">
              {timed.length > 0
                ? "timed, nobody named — tap to assign"
                : "a stopwatch running on a lane with no name"}
            </span>
          )}
        </button>
      </td>

      <td className="py-2 pr-2">
        <span className="flex flex-wrap items-center gap-1">
          {timed.length === 0 &&
            running.length === 0 &&
            stopped.length === 0 && (
              <span className="text-xs text-slate-400">—</span>
            )}

          {running.map((a) => (
            <span
              key={`${a.deviceId}:${a.slot}`}
              title={`Timer ${a.deviceId} is still timing this lane`}
              className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs tabular-nums text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              <span aria-hidden className="text-[0.6rem]">
                ▶
              </span>
              {formatClock(Math.max(0, now - a.startedAt), {
                hundredths: false,
              })}
            </span>
          ))}
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
                Math.max(0, a.stoppedAt - (a.startedAt || a.stoppedAt)),
              )}
            </span>
          ))}
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
                {formatTime(w.timeMs)}
                {!fromStopwatch(w) && "✎"}
                <button
                  type="button"
                  aria-label={`Discard the ${formatTime(w.timeMs)} watch`}
                  title="Discard this watch"
                  disabled={closed}
                  tabIndex={-1}
                  onClick={() => !closed && removeWatch(w)}
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
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
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
            const current = swim?.status ?? "OK";
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
                : swim?.exhibition
                  ? "Exhibition — doesn't count towards scoring or placing. Tap to make it count again."
                  : "Mark exhibition — the time stands, but it won't score or place."
            }
            onClick={toggleExhibition}
            className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
              swim?.exhibition
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
