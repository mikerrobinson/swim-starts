import { useParams, useNavigate, Link } from "react-router";
import { useEffect, useRef, useState } from "react";
import { eventName } from "~/types/meet";
import { useHeat } from "~/hooks/useHeat";
import { useMeetMutation } from "~/hooks/useMeetMutation";
import { useDeviceId, useUser } from "~/state/user";
import { Button } from "~/components/ui";
import { Modal } from "~/components/Modal";
import type { Watch } from "~/types/watch";
import { useWatch } from "~/hooks/useWatch";

function formatSeconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(2);
}

export function StopwatchDisplay({
  running,
  startedAt,
  frozenMs = 0,
  className,
}: {
  running: boolean;
  startedAt: number;
  frozenMs?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!running || !startedAt) return;

    let frameId: number;
    const tick = () => {
      if (ref.current) {
        ref.current.textContent = formatSeconds(Date.now() - startedAt);
      }
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [running, startedAt]);

  const initialMs =
    running && startedAt > 0 ? Date.now() - startedAt : frozenMs;

  return (
    <span ref={ref} className={className}>
      {formatSeconds(initialMs)}
    </span>
  );
}

// -------------------------------------------------------------
// Parent Route Wrapper: Only manages route parameter identity
// -------------------------------------------------------------
export default function TimerLaneKiosk() {
  const params = useParams();
  const meetId = params.meetId!;
  const eventId = params.event!;
  const heatNumber = Number(params.heat);
  const lane = Number(params.lane);
  const navigate = useNavigate();

  const device = useDeviceId();
  const user = useUser();
  const heat = useHeat(eventId, heatNumber);
  const { send } = useMeetMutation(meetId);
  const [confirmingReset, setConfirmingReset] = useState(false);

  // Directly subscribed in O(1) time
  const watch = useWatch({
    meetId,
    eventId,
    heat: heatNumber,
    lane,
    deviceId: device,
  });

  if (!heat) {
    return <h1>Loading heat...</h1>;
  }

  // Purely derived states
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
      navigate(
        `/meets/${meetId}/timer/alt/${heat.next.eventId}/${heat.next.heat}/${lane}`,
      );
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

  return (
    <div className="flex h-dvh flex-col select-none touch-none overscroll-none p-4">
      <header className="flex justify-between items-center pb-4">
        {heat.prev ? (
          <Link
            to={`/meets/${meetId}/timer/alt/${heat.prev.eventId}/${heat.prev.heat}/${lane}`}
          >
            &lt;
          </Link>
        ) : (
          <p>at start</p>
        )}
        {eventName(heat.event)}
        {heat.next ? (
          <Link
            to={`/meets/${meetId}/timer/alt/${heat.next.eventId}/${heat.next.heat}/${lane}`}
          >
            &gt;
          </Link>
        ) : (
          <p>at end</p>
        )}
      </header>

      <div>
        {heat.lanes[lane]?.athlete ? (
          <span>
            {heat.lanes[lane].athlete?.firstName}{" "}
            {heat.lanes[lane].athlete?.lastName}
          </span>
        ) : (
          <span>No athlete</span>
        )}
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
    </div>
  );
}
