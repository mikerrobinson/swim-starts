import { useParams, Form, useNavigation, useNavigate } from "react-router";
import { useState, useRef, useCallback } from "react";
import type {
  ActionFunctionArgs,
  ClientActionFunctionArgs,
} from "react-router";
import { useMeet } from "~/routes/meets2";
import { toSwimKey } from "~/types/meet";

// Server action: executed on the Cloudflare Worker/DO
export async function action({ request, params, context }: ActionFunctionArgs) {
  const { id: meetId, heat, lane } = params;
  // const formData = await request.formData();

  // const timeMs = Number(formData.get("timeMs"));
  // const deviceId = String(formData.get("deviceId"));

  // const doId = context.env.MEET_DO.idFromName(meetId!);
  // const stub = context.env.MEET_DO.get(doId);

  // await stub.recordTime({
  //   heatNumber: Number(heat),
  //   laneNumber: Number(lane),
  //   timeMs,
  //   deviceId,
  // });

  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      // Clear the disaster-recovery cookie once acknowledged by server
      "Set-Cookie": `pending_time_${lane}=; Max-Age=0; Path=/; SameSite=Strict; Secure`,
    },
  });
}

// Client action: optimistic execution and local persistence
export async function clientAction({
  request,
  params,
  serverAction,
}: ClientActionFunctionArgs) {
  // const { heat, lane } = params;
  // const formData = await request.clone().formData();
  // const timeMs = Number(formData.get("timeMs"));
  // const cacheKey = `heat:${heat}:lane:${lane}`;

  // // 1. Optimistically commit to local cache
  // meetCache.setOptimisticLocal(cacheKey, { timeMs, status: "valid" });

  // // 2. Stage backup cookie directly in document.cookie for webview crash protection
  // document.cookie = `pending_time_${lane}=${timeMs}; Path=/; SameSite=Strict; Secure`;

  // // 3. Fire-and-forget server sync in background
  // serverAction()
  //   .then(() => meetCache.ackSync(cacheKey))
  //   .catch(() =>
  //     console.warn("Offline: time queued in local store and cookie."),
  //   );

  return { success: true };
}

export default function TimerLaneKiosk() {
  const params = useParams();
  const navigate = useNavigate();
  const navigation = useNavigation();

  // Read directly from the parent shell loader
  const meet = useMeet();

  const currentEventNo = Number(params.event);
  const currentHeat = Number(params.heat);
  const currentLane = Number(params.lane);

  // O(1) direct slot lookup
  const swimKey = toSwimKey({
    event: currentEventNo,
    heat: currentHeat,
    lane: currentLane,
  });
  const currentSwim = meet?.swims[swimKey];
  const currentEvent = meet?.events[currentEventNo];

  // High-performance touch timing state
  const [stopwatchMs, setStopwatchMs] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const startTimestamp = useRef<number>(0);
  const animFrameRef = useRef<number>(0);

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

  const handleNextHeat = () => {
    const nextHeat = currentHeat + 1;
    navigate(`/meets/${meet?.id}/timer/${nextHeat}/${currentLane}`);
  };

  return (
    <div className="flex h-dvh flex-col select-none touch-none overscroll-none p-4">
      {/* Header Info Banner */}
      <header className="flex justify-between items-center pb-4">
        <div>
          <span className="text-xs font-semibold tracking-wider uppercase">
            {currentEvent?.name ?? "Event"}
          </span>
          <h1 className="text-2xl font-bold">
            Heat {currentHeat} • Lane {currentLane}
          </h1>
          <p className="text-sm">
            Swimmer:{" "}
            <span className="font-medium">
              {currentSwim?.athleteId ?? "Open Lane"}
            </span>
          </p>
        </div>
        <button
          onClick={handleNextHeat}
          className="px-3 py-1 text-sm border border-black rounded-md"
        >
          Skip Heat →
        </button>
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
