import {
  useParams,
  Form,
  useNavigation,
  useNavigate,
  Link,
} from "react-router";
import { useState, useRef, useCallback } from "react";
import { getNextHeat, getPreviousHeat, toSwimKey } from "~/types/meet";
import { useMeet } from "~/hooks/useMeet";

export default function TimerLaneKiosk() {
  const params = useParams();
  const navigate = useNavigate();
  const navigation = useNavigation();

  // Read directly from the parent shell loader
  const meet = useMeet();

  const meetId = params.meetId!;
  const eventId = params.event!;
  const heat = Number(params.heat);
  const lane = Number(params.lane);

  // O(1) direct slot lookup
  const swimKey = toSwimKey({
    eventId: eventId,
    heat: heat,
    lane: lane,
  });
  const swim = meet.swims[swimKey];
  const event = meet.events[eventId];

  const nextHeat = getNextHeat(meet, eventId, heat);
  const previousHeat = getPreviousHeat(meet, eventId, heat);

  // High-performance touch timing state
  const [stopwatchMs, setStopwatchMs] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const startTimestamp = useRef<number>(0);
  const animFrameRef = useRef<number>(0);
  const nextHeatLink =
    nextHeat == null
      ? ""
      : `/meets/${meetId}/timer/alt/${nextHeat.eventId}/${nextHeat?.heat}/${lane}`;
  const previousHeatLink =
    previousHeat == null
      ? ""
      : `/meets/${meetId}/timer/alt/${previousHeat.eventId}/${previousHeat?.heat}/${lane}`;

  const startStopwatch = useCallback(
    (e: React.TouchEvent | React.MouseEvent) => {
      e.preventDefault();
      startTimestamp.current = e.timeStamp;
      setIsRunning(true);

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
      cancelAnimationFrame(animFrameRef.current);
      const finalElapsed = Math.round(
        performance.now() - startTimestamp.current,
      );
      setStopwatchMs(finalElapsed);
      setIsRunning(false);
    },
    [],
  );

  return (
    <div className="flex h-dvh flex-col select-none touch-none overscroll-none p-4">
      {/* Header Info Banner */}
      <header className="flex justify-between items-center pb-4">
        {previousHeatLink == null ? (
          <p>at start</p>
        ) : (
          <Link to={previousHeatLink} />
        )}
        {nextHeatLink == null ? <p>at end</p> : <Link to={nextHeatLink} />}
      </header>

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

        {/* Submission Form */}
        <Form method="post" className="flex gap-2">
          <input type="hidden" name="timeMs" value={stopwatchMs ?? 0} />
          <input type="hidden" name="deviceId" value="timer-client-1" />

          <button
            type="submit"
            disabled={
              isRunning ||
              stopwatchMs === null ||
              navigation.state === "submitting"
            }
            onClick={() => setTimeout(handleNextHeat, 50)}
            className="w-full py-4 bg-teal-500 disabled:bg-slate-800 disabled:text-slate-600 active:bg-teal-600 text-slate-950 font-bold rounded-xl text-lg"
          >
            {navigation.state === "submitting"
              ? "Saving..."
              : "Submit & Advance"}
          </button>
        </Form>
      </div>
    </div>
  );
}
