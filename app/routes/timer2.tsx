import { useParams, useNavigation, useNavigate, Link } from "react-router";
import { useEffect, useRef, useState } from "react";
import { eventName } from "~/types/meet";
import { useMeet } from "~/hooks/useMeet";
import { useHeat } from "~/hooks/useHeat";
import { useMeetMutation } from "~/hooks/useMeetMutation";
import { useDeviceId, useUser } from "~/state/user";
import { StopwatchDisplay } from "~/components/StopwatchDisplay";
import type { Watch } from "~/types/watch";

/** Plain seconds to two decimals — "12.34", not "0:12.34". */
function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2);
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

  const [stopwatchMs, setStopwatchMs] = useState<number>(
    watch.timeMs || watch.stoppedAt - watch.startedAt,
  );
  const [isRunning, setIsRunning] = useState(false);

  const isAlreadySubmitted = Boolean(watch && watch.timeMs > 0);
  const hasStoppedTime = !isRunning && stopwatchMs !== null && stopwatchMs > 0;
  const canSubmit = !isAlreadySubmitted && hasStoppedTime;

  // A clock belongs to the race it was started for. Moving to another heat
  // changes this route's params rather than matching a different route, so
  // React keeps this component mounted — without this, a watch left running
  // (or just-stopped) would carry over onto the next heat's screen.
  useEffect(() => {
    watchRef.current = watch;
    setStopwatchMs(watch.timeMs || watch.stoppedAt - watch.startedAt);
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
      {/* Main Display / Manual Override Box */}
      <div className="flex-1 flex flex-col items-center justify-center">
        <StopwatchDisplay
          running={isRunning}
          startedAt={watchRef.current.startedAt}
          frozenMs={stopwatchMs}
          format={formatSeconds}
          className="text-6xl font-mono tracking-tight font-bold"
        />
        <span className="text-xs text-slate-400 mt-2">seconds</span>
      </div>

      {/* Touch-Trigger Timing Zone */}
      <div className="h-2/5 flex flex-col gap-3">
        {!isRunning ? (
          <button
            onTouchStart={startStopwatch}
            onMouseDown={startStopwatch}
            className="flex-1 w-full bg-green-700 active:bg-green-600 text-2xl font-black text-white rounded-2xl shadow-lg"
          >
            START
          </button>
        ) : (
          <button
            onTouchStart={stopStopwatch}
            onMouseDown={stopStopwatch}
            className="flex-1 w-full bg-rose-600 active:bg-rose-700 text-3xl font-black rounded-2xl shadow-lg animate-pulse"
          >
            TOUCH / FINISH
          </button>
        )}

        {isAlreadySubmitted ? (
          <button
            type="submit"
            disabled={true}
            className="w-full py-4 bg-teal-500 disabled:bg-slate-800 disabled:text-slate-600 active:bg-teal-600 text-slate-950 font-bold rounded-xl text-lg"
          >
            Already Submitted
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSubmit}
            onClick={submitStopwatch}
            className="w-full py-4 bg-teal-500 disabled:bg-slate-800 disabled:text-slate-600 active:bg-teal-600 text-slate-950 font-bold rounded-xl text-lg"
          >
            Submit & Advance
          </button>
        )}
      </div>
    </div>
  );
}
