import { useParams, useNavigation, useNavigate, Link } from "react-router";
import { useEffect, useRef, useState } from "react";
import { eventName } from "~/types/meet";
import { useMeet } from "~/hooks/useMeet";
import { useHeat } from "~/hooks/useHeat";
import { useMeetMutation } from "~/hooks/useMeetMutation";
import { useDeviceId, useUser } from "~/state/user";
import { StopwatchDisplay } from "~/components/StopwatchDisplay";
import { Button, Sheet } from "~/components/ui";
import type { Watch } from "~/types/watch";

/** Plain seconds to two decimals — "12.34", not "0:12.34". */
function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2);
}

/**
 * What this lane's stopped clock reads, if anything. A watch started but
 * never stopped (the device was closed or refreshed mid-race) has
 * `stoppedAt` still at 0 — `stoppedAt - startedAt` would read as a large
 * negative number instead of "nothing to show yet".
 */
function stoppedMsOf(watch: Watch): number {
  if (watch.timeMs > 0) return watch.timeMs;
  return watch.stoppedAt > watch.startedAt
    ? watch.stoppedAt - watch.startedAt
    : 0;
}

export default function TimerLaneKiosk() {
  const params = useParams();
  const meetId = params.meetId!;
  const navigate = useNavigate();
  const navigation = useNavigation();

  const device = useDeviceId();
  const user = useUser();

  const { send } = useMeetMutation(meetId);

  const lane = Number(params.lane);
  const heat = useHeat(params.event!, Number(params.heat));

  const DEFAULT_WATCH: Watch = {
    eventId: heat?.event.id || "",
    heat: heat?.heatNumber || 0,
    lane: lane,
    deviceId: device,
    slot: 0,
    startedAt: 0,
    stoppedAt: 0,
    timeMs: 0,
    role: "timer",
    recordedAt: 0,
  };

  const watch =
    heat?.lanes[lane].watches.find(
      (w) => w.deviceId == device && w.slot == 0,
    ) || DEFAULT_WATCH;

  // The watch being built for this lane. It's a ref, not state: nothing in
  // this component is rendered from it directly (the ticking display below
  // reads `stopwatchMs`), and a ref means start/stop always read the value
  // they just wrote instead of a closure still holding the pre-update watch.
  const watchRef = useRef<Watch>(watch);

  const [stopwatchMs, setStopwatchMs] = useState<number>(stoppedMsOf(watch));
  const [isRunning, setIsRunning] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const isAlreadySubmitted = Boolean(watch && watch.timeMs > 0);

  // The one action button at the bottom of the screen walks through these in
  // order — never back, except via the explicit Reset that only shows up on
  // "stopped" (there's no un-submitting; a result is a decision).
  const phase: "start" | "running" | "stopped" | "submitted" =
    isAlreadySubmitted
      ? "submitted"
      : isRunning
        ? "running"
        : stopwatchMs > 0
          ? "stopped"
          : "start";

  // A clock belongs to the race it was started for. Moving to another heat
  // changes this route's params rather than matching a different route, so
  // React keeps this component mounted — without this, a watch left running
  // (or just-stopped) would carry over onto the next heat's screen.
  //
  // Guarded on `heat` itself: a momentary loader hiccup (a revalidation that
  // briefly has no data yet) must never be read as "nothing recorded for
  // this lane" — that would stomp a real stopped/submitted time with 0 and,
  // since the dependency array is keyed on heat/lane identity rather than on
  // `watch`, there'd be no later render to correct it once the hiccup
  // passes and the identity settles back to where it already was.
  useEffect(() => {
    if (!heat) return;
    watchRef.current = watch;
    setStopwatchMs(stoppedMsOf(watch));
    setIsRunning(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heat?.event.id, heat?.heatNumber, lane]);

  const sendWatch = (next: Watch) => {
    send({
      entity: "watch",
      op: "upsert",
      key: {
        eventId: next.eventId,
        heat: next.heat,
        lane: next.lane,
        deviceId: next.deviceId,
        slot: next.slot,
      },
      patch: {
        recordedAt: Date.now(),
        startedAt: next.startedAt,
        stoppedAt: next.stoppedAt,
        userId: user?.id,
        timeMs: next.timeMs,
        role: "timer",
      },
    });
  };

  const startStopwatch = (e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    const lag = performance.now() - e.timeStamp;
    const startedAt = Math.round(Date.now() - lag);

    const next: Watch = {
      ...watchRef.current,
      startedAt,
      stoppedAt: 0,
      timeMs: 0,
    };
    watchRef.current = next;
    sendWatch(next);

    setStopwatchMs(0);
    setIsRunning(true);
  };

  const stopStopwatch = (e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    const lag = performance.now() - e.timeStamp;
    const stoppedAt = Math.round(Date.now() - lag);

    const timeMs = stoppedAt - watchRef.current.startedAt;
    const next: Watch = { ...watchRef.current, stoppedAt };
    watchRef.current = next;
    sendWatch(next);

    setIsRunning(false);
    setStopwatchMs(timeMs);
  };

  const submitStopwatch = () => {
    if (stopwatchMs === null || stopwatchMs <= 0) return;

    const next: Watch = { ...watchRef.current, timeMs: stopwatchMs };
    watchRef.current = next;
    sendWatch(next);
    heat?.next
      ? navigate(
          `/meets/${meetId}/timer/alt/${heat.next.eventId}/${heat.next.heat}/${lane}`,
        )
      : "";
  };

  // Forgets this device's own watch entirely rather than just clearing the
  // display — a fat-fingered stop shouldn't leave a phantom watch behind for
  // the admin to sort out later.
  const resetStopwatch = () => {
    const next: Watch = {
      ...watchRef.current,
      startedAt: 0,
      stoppedAt: 0,
      timeMs: 0,
    };
    watchRef.current = next;
    send({
      entity: "watch",
      op: "delete",
      key: {
        eventId: next.eventId,
        heat: next.heat,
        lane: next.lane,
        deviceId: next.deviceId,
        slot: next.slot,
      },
    });

    setStopwatchMs(0);
    setIsRunning(false);
  };

  if (heat == null) {
    return <h1>no heat</h1>;
  }
  return (
    <div className="flex h-dvh flex-col select-none touch-none overscroll-none p-4">
      {/* Header Info Banner */}
      <header className="flex justify-between items-center pb-4">
        {heat?.prev == null ? (
          <p>at start</p>
        ) : (
          <Link
            to={`/meets/${meetId}/timer/alt/${heat.prev.eventId}/${heat.prev.heat}/${lane}`}
          >
            &lt;
          </Link>
        )}
        {eventName(heat?.event)}
        {heat?.next == null ? (
          <p>at end</p>
        ) : (
          <Link
            to={`/meets/${meetId}/timer/alt/${heat.next.eventId}/${heat.next.heat}/${lane}`}
          >
            &gt;
          </Link>
        )}
      </header>

      <div>
        {heat.lanes[lane].athlete ? (
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
          startedAt={watchRef.current.startedAt}
          frozenMs={stopwatchMs}
          format={formatSeconds}
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
            onTouchStart={startStopwatch}
            onMouseDown={startStopwatch}
            className="min-h-24 flex-1 rounded-2xl bg-green-700 active:bg-green-600 text-3xl font-black text-white shadow-lg"
          >
            START
          </button>
        )}
        {phase === "running" && (
          <button
            onTouchStart={stopStopwatch}
            onMouseDown={stopStopwatch}
            className="min-h-24 flex-1 animate-pulse rounded-2xl bg-rose-600 active:bg-rose-700 text-3xl font-black text-white shadow-lg"
          >
            STOP
          </button>
        )}
        {phase === "stopped" && (
          <button
            type="submit"
            onClick={submitStopwatch}
            className="min-h-24 flex-1 rounded-2xl bg-green-700 active:bg-green-600 text-3xl font-black text-white shadow-lg"
          >
            SUBMIT
          </button>
        )}
        {phase === "submitted" && (
          <button
            type="submit"
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
        <Sheet
          open
          title="Reset this time?"
          onClose={() => setConfirmingReset(false)}
        >
          <div className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              This throws away the {formatSeconds(stopwatchMs)}s on the clock.
              It can&rsquo;t be undone.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button size="lg" full onClick={() => setConfirmingReset(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="lg"
                full
                onClick={() => {
                  resetStopwatch();
                  setConfirmingReset(false);
                }}
              >
                Reset
              </Button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
