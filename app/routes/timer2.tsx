import { useParams, useNavigate, Link } from "react-router";
import { useState } from "react";
import { eventName } from "~/types/meet";
import { useHeat } from "~/hooks/useHeat";
import { useMeet } from "~/hooks/useMeet";
import { useMeetMutation } from "~/hooks/useMeetMutation";
import { useDeviceId, useUser } from "~/state/user";
import { Button } from "~/components/ui";
import { Modal } from "~/components/Modal";
import { AthletePicker } from "~/components/AthletePicker";
import type { Watch } from "~/types/watch";
import { useWatch } from "~/hooks/useWatch";
import { formatSeconds } from "~/lib/time";
import { StopwatchDisplay } from "~/components/StopwatchDisplay";
import { altLanesPath, altPath } from "~/lib/timer-path";

export default function Timer() {
  const params = useParams();
  const meetId = params.meetId!;
  const eventId = params.event!;
  const heatNumber = Number(params.heat);
  const lane = Number(params.lane);
  const navigate = useNavigate();

  const device = useDeviceId();
  const user = useUser();
  const meet = useMeet();
  const heat = useHeat(eventId, heatNumber);
  const { send } = useMeetMutation(meetId);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [picking, setPicking] = useState(false);

  const watch = useWatch({
    meetId,
    eventId,
    heat: heatNumber,
    lane,
    deviceId: device,
  });

  if (!heat) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6 text-center">
        <div>
          <p className="text-lg font-bold">Nothing to time yet</p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            The coach hasn&rsquo;t set the heats for this meet. This screen
            will catch up on its own.
          </p>
        </div>
      </main>
    );
  }

  const athlete = heat.lanes[lane]?.athlete;
  const teamLabel = (teamId: string) =>
    meet.teams[teamId]?.code || meet.teams[teamId]?.name || "";

  const isRunning =
    watch.startedAt > 0 && watch.stoppedAt === 0 && watch.timeMs === 0;
  const isStopped = watch.stoppedAt > watch.startedAt && watch.timeMs === 0;
  const isSubmitted = watch.timeMs > 0;

  const phase: "start" | "running" | "stopped" | "submitted" = isSubmitted
    ? "submitted"
    : isRunning
      ? "running"
      : isStopped
        ? "stopped"
        : "start";

  const stoppedMs = isSubmitted
    ? watch.timeMs
    : isStopped
      ? watch.stoppedAt - watch.startedAt
      : 0;

  const sendWatch = (patch: Partial<Watch>) => {
    send({
      entity: "watch",
      op: "upsert",
      key: {
        eventId,
        heat: heatNumber,
        lane,
        deviceId: device,
        slot: 0,
      },
      patch: {
        recordedAt: Date.now(),
        startedAt: watch.startedAt,
        stoppedAt: watch.stoppedAt,
        userId: user?.id,
        timeMs: watch.timeMs,
        role: "timer",
        ...patch,
      },
    });
  };

  const handleStart = (e: React.PointerEvent) => {
    e.preventDefault();
    if (e.button !== 0) return;
    const lag = performance.now() - e.timeStamp;
    sendWatch({
      startedAt: Math.round(Date.now() - lag),
      stoppedAt: 0,
      timeMs: 0,
    });
  };

  const handleStop = (e: React.PointerEvent) => {
    e.preventDefault();
    if (e.button !== 0) return;
    const lag = performance.now() - e.timeStamp;
    sendWatch({
      stoppedAt: Math.round(Date.now() - lag),
    });
  };

  const handleSubmit = (e: React.PointerEvent) => {
    e.preventDefault();
    if (e.button !== 0 || stoppedMs <= 0) return;
    sendWatch({ timeMs: stoppedMs });

    if (heat.next) {
      navigate(altPath(meetId, heat.next, lane));
    }
  };

  const handleReset = () => {
    send({
      entity: "watch",
      op: "delete",
      key: {
        eventId,
        heat: heatNumber,
        lane,
        deviceId: device,
        slot: 0,
      },
    });
  };

  /** Say who's in this lane. A roster pick travels as the id the server
   *  already knows, name/team resolved here since the picker only hands
   *  back the id. Exhibition, if the lane already had one, rides along
   *  untouched — picking a swimmer is a fact about the swim's seat, not
   *  about whether it counts. */
  const seatAthlete = (athleteId: string) => {
    const picked = meet.athletes[athleteId];
    send({
      entity: "swim",
      op: "upsert",
      key: { eventId, heat: heatNumber, lane },
      patch: {
        athleteId,
        athleteName: picked
          ? `${picked.firstName} ${picked.lastName}`.trim()
          : "",
        athleteTeam: picked ? teamLabel(picked.teamId) : "",
        exhibition: heat.lanes[lane]?.swim?.exhibition ?? false,
      },
    });
    setPicking(false);
  };

  /** A walk-up never mints an athlete anywhere — there's no roster row to
   *  create any more. The name and team the picker hands back are exactly
   *  what `Swim.athleteName`/`athleteTeam` already carry, so they're
   *  stamped straight on with no id at all. */
  const seatWalkup = (walkup: {
    firstName: string;
    lastName: string;
    athleteTeam: string;
  }) => {
    send({
      entity: "swim",
      op: "upsert",
      key: { eventId, heat: heatNumber, lane },
      patch: {
        athleteId: undefined,
        athleteName: `${walkup.firstName} ${walkup.lastName}`.trim(),
        athleteTeam: walkup.athleteTeam,
        exhibition: heat.lanes[lane]?.swim?.exhibition ?? false,
      },
    });
    setPicking(false);
  };

  return (
    <div className="flex h-dvh flex-col select-none touch-none overscroll-none p-4">
      <header className="flex justify-between items-center pb-4">
        {heat.prev ? (
          <Link to={altPath(meetId, heat.prev, lane)}>&lt;</Link>
        ) : (
          <p>at start</p>
        )}
        {eventName(heat.event)}
        {heat.next ? (
          <Link to={altPath(meetId, heat.next, lane)}>&gt;</Link>
        ) : (
          <p>at end</p>
        )}
      </header>

      <div className="space-y-3">
        <Link
          to={altLanesPath(meetId, { eventId, heat: heatNumber })}
          aria-disabled={isRunning}
          className={`flex w-full touch-manipulation items-center justify-between rounded-2xl bg-white px-4 py-3 text-left dark:bg-slate-900 ${
            isRunning ? "pointer-events-none opacity-60" : ""
          }`}
        >
          <span className="text-2xl font-bold">Lane {lane}</span>
          <span className="text-sm font-semibold text-blue-600">change</span>
        </Link>

        <button
          type="button"
          onClick={() => setPicking(true)}
          disabled={isRunning}
          className="flex w-full touch-manipulation items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 text-left disabled:opacity-60 dark:bg-slate-900"
        >
          <span className="min-w-0">
            <span className="block truncate text-xl font-bold">
              {athlete
                ? `${athlete.firstName} ${athlete.lastName}`.trim()
                : "Empty lane"}
            </span>
            <span className="block truncate text-sm text-slate-500">
              {athlete ? teamLabel(athlete.teamId) : "Tap to say who's here"}
            </span>
          </span>
          <span className="shrink-0 text-sm font-semibold text-blue-600">
            change
          </span>
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center pb-32">
        <StopwatchDisplay
          running={isRunning}
          startedAt={watch.startedAt}
          frozenMs={stoppedMs}
          className="text-6xl font-mono tracking-tight font-bold"
        />
        <span className="text-xs text-slate-400 mt-2">seconds</span>
      </div>

      <div
        className="fixed inset-x-0 bottom-0 flex items-stretch p-4"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        {phase === "start" && (
          <button
            onPointerDown={handleStart}
            className="min-h-24 flex-1 rounded-2xl bg-green-700 active:bg-green-600 text-3xl font-black text-white shadow-lg touch-none"
          >
            START
          </button>
        )}
        {phase === "running" && (
          <button
            onPointerDown={handleStop}
            className="min-h-24 flex-1 animate-pulse rounded-2xl bg-rose-600 active:bg-rose-700 text-3xl font-black text-white shadow-lg touch-none"
          >
            STOP
          </button>
        )}
        {phase === "stopped" && (
          <button
            type="button"
            onPointerDown={handleSubmit}
            className="min-h-24 flex-1 rounded-2xl bg-green-700 active:bg-green-600 text-3xl font-black text-white shadow-lg"
          >
            SUBMIT
          </button>
        )}
        {phase === "submitted" && (
          <button
            type="button"
            disabled
            className="min-h-24 flex-1 rounded-2xl bg-slate-800 text-3xl font-black text-slate-600 shadow-lg"
          >
            SUBMITTED
          </button>
        )}

        <div
          className={`grid overflow-hidden transition-[grid-template-columns] duration-300 ease-in-out ${
            phase === "stopped" ? "grid-cols-[1fr]" : "grid-cols-[0fr]"
          }`}
        >
          <div className="overflow-hidden">
            <button
              type="button"
              onClick={() => setConfirmingReset(true)}
              className="ml-3 h-full whitespace-nowrap rounded-2xl bg-rose-600 active:bg-rose-700 px-6 text-lg font-black text-white shadow-lg"
            >
              RESET
            </button>
          </div>
        </div>
      </div>

      {confirmingReset && (
        <Modal
          title="Confirm Reset"
          onClose={() => setConfirmingReset(false)}
          showClose={false}
        >
          <div className="space-y-4">
            <Button
              variant="danger"
              size="lg"
              full
              onClick={() => {
                handleReset();
                setConfirmingReset(false);
              }}
            >
              Discard {formatSeconds(stoppedMs)}
            </Button>
            <Button size="lg" full onClick={() => setConfirmingReset(false)}>
              Cancel
            </Button>
          </div>
        </Modal>
      )}

      {picking && (
        <AthletePicker
          meet={meet}
          eventId={eventId}
          heat={heatNumber}
          lane={lane}
          current={athlete}
          onPick={seatAthlete}
          onAddWalkup={seatWalkup}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
