import {
  useParams,
  Form,
  useNavigation,
  useNavigate,
  Link,
} from "react-router";
import { useState, useRef, useCallback } from "react";
import { eventName } from "~/types/meet";
import { useMeet } from "~/hooks/useMeet";
import { useHeat } from "~/hooks/useHeat";
import { useMeetMutation } from "~/hooks/useMeetMutation";
import { useDeviceId } from "~/state/user";
import { timerCookiePath } from "~/lib/timer-path";

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
  const watch = heat?.lanes[lane].watches.find(
    (w) => w.deviceId == device && w.slot == 0,
  );

  // High-performance touch timing state
  const [stopwatchMs, setStopwatchMs] = useState<number | null>(
    heat?.lanes[lane].watches.find((w) => w.deviceId == device && w.slot == 0)
      ?.timeMs || null,
  );
  const [isRunning, setIsRunning] = useState(false);
  const startTimestamp = useRef<number>(0);
  const stopTimestamp = useRef<number>(0);
  const timeMs = useRef<number>(0);
  const animFrameRef = useRef<number>(0);

  const sendWatch = () => {
    send({
      entity: "watch",
      op: "upsert",
      key: {
        eventId: heat?.event.id || "",
        heat: heat?.heatNumber || 1,
        lane,
        deviceId: device,
        slot: 0,
      },
      patch: {
        startedAt: startTimestamp.current,
        stoppedAt: 0,
        timeMs: 0,
      },
    });
  };
  const startStopwatch = useCallback(
    (e: React.TouchEvent | React.MouseEvent) => {
      e.preventDefault();
      startTimestamp.current = e.timeStamp;
      stopTimestamp.current = 0;
      setStopwatchMs(0);
      setIsRunning(true);
      sendWatch();
      const update = () => {
        setStopwatchMs(Math.round(performance.now() - startTimestamp.current));
        animFrameRef.current = requestAnimationFrame(update);
      };
      animFrameRef.current = requestAnimationFrame(update);
    },
    [],
  );

  const stopStopwatch = useCallback(
    (e: React.TouchEvent | React.MouseEvent) => {
      e.preventDefault();
      stopTimestamp.current = e.timeStamp;
      sendWatch();
      cancelAnimationFrame(animFrameRef.current);
      const finalElapsed = Math.round(
        stopTimestamp.current - startTimestamp.current,
      );
      setStopwatchMs(finalElapsed);
      setIsRunning(false);
    },
    [],
  );

  const resetStopwatch = () => {
    startTimestamp.current = 0;
    stopTimestamp.current = 0;
    timeMs.current = 0;
    setStopwatchMs(0);
  };

  const submitStopwatch = () => {
    sendWatch();
    resetStopwatch();
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
        <span className="text-6xl font-mono tracking-tight font-bold">
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

        <button
          type="submit"
          disabled={
            isRunning ||
            stopwatchMs === null ||
            navigation.state === "submitting"
          }
          onClick={submitStopwatch}
          className="w-full py-4 bg-teal-500 disabled:bg-slate-800 disabled:text-slate-600 active:bg-teal-600 text-slate-950 font-bold rounded-xl text-lg"
        >
          {navigation.state === "submitting" ? "Saving..." : "Submit & Advance"}
        </button>
      </div>
    </div>
  );
}
