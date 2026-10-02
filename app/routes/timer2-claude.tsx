import { useParams, useNavigation, useNavigate, Link } from "react-router";
import { useState, useRef, useEffect, useCallback } from "react";
import { eventName } from "~/types/meet";
import { useMeet } from "~/hooks/useMeet";
import { useHeat } from "~/hooks/useHeat";
import { useMeetMutation } from "~/hooks/useMeetMutation";
import { useDeviceId } from "~/state/user";
import type { Watch } from "~/types/watch";

export default function TimerLaneKiosk() {
  const params = useParams();
  const meetId = params.meetId!;
  const eventId = params.event!;
  const heatNumber = Number(params.heat);
  const lane = Number(params.lane);

  const navigate = useNavigate();
  const navigation = useNavigation();

  const meet = useMeet();
  const device = useDeviceId();
  const { send } = useMeetMutation(meetId);

  const heat = useHeat(eventId, heatNumber);

  // Look up existing watch in the current heat
  const existingWatch = heat?.lanes[lane]?.watches?.find(
    (w) => w.deviceId === device && w.slot === 0,
  );

  const previouslySubmitted = Boolean(
    existingWatch && existingWatch.timeMs > 0,
  );

  // High-performance display state
  const [stopwatchMs, setStopwatchMs] = useState<number | null>(
    existingWatch?.timeMs ?? null,
  );
  const [isRunning, setIsRunning] = useState(false);

  // Timing references (avoids stale React state during 60fps raf loop)
  const animFrameRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const startEpochRef = useRef<number>(0);
  const recordedTimeMsRef = useRef<number>(existingWatch?.timeMs || 0);

  // Reset local timing states when navigating between events/heats/lanes
  useEffect(() => {
    cancelAnimationFrame(animFrameRef.current);
    setIsRunning(false);
    const existingMs = existingWatch?.timeMs ?? null;
    setStopwatchMs(existingMs);
    recordedTimeMsRef.current = existingMs ?? 0;
  }, [eventId, heatNumber, lane, existingWatch?.timeMs]);

  // Clean up animation frames on unmount
  useEffect(() => {
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  const startStopwatch = (e: React.SyntheticEvent) => {
    e.preventDefault();

    // Use performance.now() for high-precision relative elapsed time
    const perfNow = performance.now();
    const epochNow = Date.now();

    startTimeRef.current = perfNow;
    startEpochRef.current = epochNow;
    setIsRunning(true);
    setStopwatchMs(0);

    const update = () => {
      const elapsed = Math.round(performance.now() - startTimeRef.current);
      setStopwatchMs(elapsed);
      animFrameRef.current = requestAnimationFrame(update);
    };

    cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = requestAnimationFrame(update);
  };

  const stopStopwatch = (e: React.SyntheticEvent) => {
    e.preventDefault();
    cancelAnimationFrame(animFrameRef.current);

    const totalElapsedMs = Math.round(performance.now() - startTimeRef.current);
    recordedTimeMsRef.current = totalElapsedMs;
    setStopwatchMs(totalElapsedMs);
    setIsRunning(false);

    // Auto-record the stop touch
    send({
      entity: "watch",
      op: "upsert",
      key: {
        eventId,
        heat: heatNumber,
        lane,
        userId: device,
        slot: 0,
      },
      patch: {
        timeMs: totalElapsedMs,
        startedAt: startEpochRef.current,
        stoppedAt: startEpochRef.current + totalElapsedMs,
        role: "timer",
        recordedAt: Date.now(),
      },
    });
  };

  const submitStopwatch = () => {
    const finalTime = recordedTimeMsRef.current;
    if (finalTime <= 0) return;

    // Send final official confirmation
    send({
      entity: "watch",
      op: "upsert",
      key: {
        eventId,
        heat: heatNumber,
        lane,
        userId: device,
        slot: 0,
      },
      patch: {
        timeMs: finalTime,
        startedAt: startEpochRef.current,
        stoppedAt: startEpochRef.current + finalTime,
        role: "timer",
        recordedAt: Date.now(),
      },
    });

    // Advance to next heat
    if (heat?.next) {
      navigate(
        `/meets/${meetId}/timer/alt/${heat.next.eventId}/${heat.next.heat}/${lane}`,
      );
    }
  };

  if (!heat) {
    return <h1>no heat</h1>;
  }

  const assignedAthlete = heat.lanes[lane]?.athlete;

  return (
    <div className="flex h-dvh flex-col select-none touch-none overscroll-none p-4">
      {/* Header Info Banner */}
      <header className="flex justify-between items-center pb-4">
        {heat.prev == null ? (
          <p className="text-slate-400">at start</p>
        ) : (
          <Link
            to={`/meets/${meetId}/timer/alt/${heat.prev.eventId}/${heat.prev.heat}/${lane}`}
            className="px-3 py-1 bg-slate-800 text-white rounded font-bold"
          >
            &lt;
          </Link>
        )}
        <span className="font-semibold text-lg">{eventName(heat.event)}</span>
        {heat.next == null ? (
          <p className="text-slate-400">at end</p>
        ) : (
          <Link
            to={`/meets/${meetId}/timer/alt/${heat.next.eventId}/${heat.next.heat}/${lane}`}
            className="px-3 py-1 bg-slate-800 text-white rounded font-bold"
          >
            &gt;
          </Link>
        )}
      </header>

      <div className="text-center font-medium text-slate-300">
        {assignedAthlete ? (
          <span>
            {assignedAthlete.firstName} {assignedAthlete.lastName}
          </span>
        ) : (
          <span className="italic text-slate-500">No athlete assigned</span>
        )}
      </div>

      {/* Main Display Box */}
      <div className="flex-1 flex flex-col items-center justify-center">
        <span className="text-7xl font-mono tracking-tight font-black tabular-nums">
          {stopwatchMs !== null ? (stopwatchMs / 1000).toFixed(2) : "0.00"}
        </span>
        <span className="text-xs text-slate-400 mt-2 uppercase tracking-wider font-semibold">
          seconds
        </span>
      </div>

      {/* Touch-Trigger Timing Zone */}
      <div className="h-2/5 flex flex-col gap-3">
        {!isRunning ? (
          <button
            onPointerDown={startStopwatch}
            className="flex-1 w-full bg-green-700 active:bg-green-600 text-3xl font-black text-white rounded-2xl shadow-lg"
          >
            START
          </button>
        ) : (
          <button
            onPointerDown={stopStopwatch}
            className="flex-1 w-full bg-rose-600 active:bg-rose-700 text-3xl font-black text-white rounded-2xl shadow-lg animate-pulse"
          >
            TOUCH / FINISH
          </button>
        )}

        {previouslySubmitted ? (
          <button
            type="button"
            disabled
            className="w-full py-4 bg-slate-800 text-slate-500 font-bold rounded-xl text-lg"
          >
            Recorded for Heat {heatNumber}
          </button>
        ) : (
          <button
            type="button"
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
