import {
  useParams,
  Form,
  useNavigation,
  useNavigate,
  Link,
} from "react-router";
import { useEffect, useRef, useState } from "react";
import { eventName } from "~/types/meet";
import { useMeet } from "~/hooks/useMeet";
import { useHeat } from "~/hooks/useHeat";
import { useMeetMutation } from "~/hooks/useMeetMutation";
import { useDeviceId } from "~/state/user";
import type { Watch } from "~/types/watch";

export default function TimerLaneKiosk() {
  const params = useParams();
  const meetId = params.meetId!;
  const navigate = useNavigate();
  const navigation = useNavigation();

  // Read directly from the parent shell loader
  const meet = useMeet();
  const device = useDeviceId();

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

  const w = heat?.lanes[lane].watches.find(
    (w) => w.deviceId == device && w.slot == 0,
  );

  const previouslySubmitted = !!w && w.timeMs > 0;

  // The watch being built for this lane. It's a ref, not state: nothing in
  // this component is rendered from it directly (the ticking display below
  // reads `stopwatchMs`), and a ref means start/stop always read the value
  // they just wrote instead of a closure still holding the pre-update watch.
  const watchRef = useRef<Watch>(w ?? DEFAULT_WATCH);

  const [stopwatchMs, setStopwatchMs] = useState<number | null>(
    w?.timeMs || null,
  );
  const [isRunning, setIsRunning] = useState(false);
  const animFrameRef = useRef<number>(0);
  const displayRef = useRef<HTMLSpanElement>(null);

  // A clock belongs to the race it was started for. Moving to another heat
  // changes this route's params rather than matching a different route, so
  // React keeps this component mounted — without this, a watch left running
  // (or just-stopped) would carry over onto the next heat's screen.
  useEffect(() => {
    cancelAnimationFrame(animFrameRef.current);
    watchRef.current = w ?? DEFAULT_WATCH;
    setStopwatchMs(w?.timeMs || null);
    setIsRunning(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heat?.event.id, heat?.heatNumber, lane]);

  useEffect(() => {
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  const sendWatch = (next: Watch) => {
    send({
      entity: "watch",
      op: "upsert",
      key: next,
      patch: next,
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

    const update = () => {
      const ms = Math.round(Date.now() - startedAt);
      if (displayRef.current) {
        displayRef.current.textContent = (ms / 1000).toFixed(2);
      }
      animFrameRef.current = requestAnimationFrame(update);
    };
    animFrameRef.current = requestAnimationFrame(update);
  };

  const stopStopwatch = (e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    const lag = performance.now() - e.timeStamp;
    const stoppedAt = Math.round(Date.now() - lag);

    cancelAnimationFrame(animFrameRef.current);

    const timeMs = stoppedAt - watchRef.current.startedAt;
    const next: Watch = { ...watchRef.current, stoppedAt, timeMs };
    watchRef.current = next;
    sendWatch(next);

    setIsRunning(false);
    setStopwatchMs(timeMs);
  };

  const submitStopwatch = () => {
    sendWatch(watchRef.current);
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
        <span
          ref={displayRef}
          className="text-6xl font-mono tracking-tight font-bold"
        >
          {stopwatchMs !== null ? (stopwatchMs / 1000).toFixed(2) : "0.00"}
        </span>
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

        {previouslySubmitted ? (
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
            disabled={isRunning || stopwatchMs === null}
            onClick={submitStopwatch}
            className="w-full py-4 bg-teal-500 disabled:bg-slate-800 disabled:text-slate-600 active:bg-teal-600 text-slate-950 font-bold rounded-xl text-lg"
          >
            {navigation.state === "submitting"
              ? "Saving..."
              : "Submit & Advance"}
          </button>
        )}
      </div>
    </div>
  );
}
