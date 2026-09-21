import { useEffect, useMemo, useRef, useState } from "react";
import {
  data,
  Link,
  useFetcher,
  useNavigate,
  useRevalidator,
  useRouteLoaderData,
  type LinkProps,
} from "react-router";
import type { Route } from "./+types/timer";
import type { loader as shellLoader } from "./timer-shell";
import { Button } from "~/components/ui";
import { SwimmerPicker } from "~/components/SwimmerPicker";
import { formatClock, formatTime, parseTime } from "~/lib/time";
import {
  earliestAllowed,
  loadFurthest,
  loadRole,
  runningOrder,
  saveFurthest,
  timerPath,
  watchCount,
  type QueuedAthlete,
  type TimerAthlete,
} from "~/lib/timer";
import { stopPath, timerCookiePath } from "~/lib/timer-path";
import { eventName, type LaneRef as SwimKey } from "~/types/meet";
import { queueState, saveSeedRecord } from "~/lib/seed-queue";
import {
  decodeSeedRecord,
  emptySeedRecord,
  encodeSeedRecord,
  seedCookieName,
  type SeedRecord,
} from "~/lib/seed-cookie";
import { applySeedCookies } from "~/lib/seed-cookie.server";
import {
  clearSeedCookies,
  resolveTimerRequest,
} from "~/lib/timer-request.server";

/**
 * Every write in this workspace — a seat, an exhibition flag, an armed or
 * stopped watch, the final sheet — is the same shape: the screen's whole
 * `SeedRecord` for this lane, submitted as one form field. `clientAction`
 * writes it into the seed cookie exactly the way `loader` would pick it up
 * from a plain navigation, then calls `serverAction` to deliver it now
 * rather than leaving it for the next request that happens to reach here.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const meetId = params.meetId!;
  const headers = new Headers();
  const resolved = await resolveTimerRequest(
    request,
    context.cloudflare.env,
    meetId,
  );
  if (!resolved.ok) {
    return data({ error: resolved.error }, { status: 400, headers });
  }

  const { db, stub, detail, timerId, deviceCookie } = resolved.value;
  if (deviceCookie) headers.append("set-cookie", deviceCookie);

  const { cleared } = await applySeedCookies(
    db,
    stub,
    detail,
    timerId,
    request,
  );
  clearSeedCookies(headers, request, meetId, cleared);

  return data({ ok: true }, { headers });
}

export async function clientAction({
  params,
  request,
  serverAction,
}: Route.ClientActionArgs) {
  const formData = await request.clone().formData();
  const raw = formData.get("record");
  const record = typeof raw === "string" ? decodeSeedRecord(raw) : null;
  if (record) {
    const at: SwimKey = {
      event: Number(params.event),
      heat: Number(params.heat),
      lane: Number(params.lane),
    };
    saveSeedRecord(timerCookiePath(params.meetId!), at, record);
  }

  try {
    return await serverAction();
  } catch {
    // Offline: the cookie already has it, and the next request that reaches
    // the server at all — any of them — carries it the rest of the way.
    return null;
  }
}

/**
 * The stopwatch a volunteer holds behind a lane.
 *
 * The whole screen is built around one assumption: the person using it is
 * untrained, distracted, and should be watching the water rather than the
 * phone. So there is exactly one big button at any moment, the current swimmer
 * is stated rather than chosen, and nothing that isn't the next thing to do
 * competes for the thumb.
 *
 * It is also deliberately alone. No shared heat state, no coach driving it
 * from elsewhere: this timer starts and stops their own watch, submits, and
 * moves on. Pool wifi may be gone the entire time and nothing here notices —
 * every local action writes its lane's whole record to a cookie and tries to
 * deliver it immediately; if that fails, the cookie already has it, and
 * whatever request reaches the timer workspace next (a revalidation, a
 * navigation, this screen's own next action) carries it the rest of the way.
 *
 * At a meet whose lanes carry two or three watches, a phone that said it has
 * the sheet gets the other screen: no stopwatch of its own, a column per
 * timer standing behind the lane, and one submit that files all of them. It
 * is the same page otherwise — same lane, same swimmer, same queue, same walk
 * through the heats — because it is the same job done the way a deck actually
 * does it, with the handheld watches doing the timing and this holding what
 * they read.
 */
export default function Timer({ params }: Route.ComponentProps) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const fetcher = useFetcher<typeof action>();

  /**
   * Everything about where this timer is standing comes from the URL.
   *
   * There is no "current heat" in state to drift from the address bar, no
   * lane remembered on the device, and nothing to restore on reload. The page
   * *is* the position.
   */
  const meetId = params.meetId;
  const lane = Number(params.lane);
  const eventNo = Number(params.event);
  const heatNo = Number(params.heat);

  // The shell has already confirmed this exists before rendering an Outlet.
  const snapshot =
    useRouteLoaderData<typeof shellLoader>("routes/timer-shell")!.snapshot!;

  const [furthest, setFurthest] = useState(-1);
  const [picking, setPicking] = useState(false);
  /**
   * Set when somebody deliberately re-arms a heat they've already sent.
   *
   * Going back to a submitted heat shows that it's done rather than a green
   * START, but correcting the time you just took is exactly what going back
   * is *for* — `earliestAllowed` lets you reach one heat behind the last
   * submission precisely so you can. So the way through is there, one
   * deliberate tap away, rather than absent. Lives in state, so it lasts until
   * this screen is left.
   */
  const [retiming, setRetiming] = useState(false);

  /**
   * What this phone still owes, and whether it has stopped being a blip.
   *
   * A count is normal — a cookie sits unconsumed for a second on a good
   * connection and a minute on a bad one. `overflow` is not: it means a
   * record could not be *stored*, because the browser's cookie limits were
   * reached, and no amount of waiting fixes that. Only that second one earns
   * a colour, because a timer glancing down mid-heat should see nothing
   * unless something is genuinely wrong.
   */
  const [queue, setQueue] = useState(() => queueState());
  const refreshQueue = () => setQueue(queueState());

  // Whatever the last revalidation (however it was triggered) or submit
  // settled to is what this screen should be showing as still outstanding.
  useEffect(() => {
    if (revalidator.state === "idle") refreshQueue();
  }, [revalidator.state]);
  useEffect(() => {
    if (fetcher.state === "idle") refreshQueue();
  }, [fetcher.state]);

  /**
   * Whether this phone is a stopwatch or a sheet, as it answered at the lane
   * picker. `null` until the cookie has been read, which cannot happen on the
   * server — and reads as a clipboard once it has, for the same reason the
   * picker defaults that way.
   */
  const [role, setRole] = useState<ReturnType<typeof loadRole>>(null);
  useEffect(() => {
    setFurthest(loadFurthest());
    setRole(loadRole() ?? "clipboard");
  }, []);

  /**
   * What the clipboard has written down so far, as typed, one string per
   * column.
   *
   * Text rather than milliseconds because that is what is in front of the
   * person: half of "30.4" is not a time yet, and a field that reinterpreted
   * itself on every keystroke would fight the thumb entering it. Read through
   * `parseTime`, which is the same reader the desk uses, so "3045" and
   * "30.45" mean what they do everywhere else in the app.
   */
  const [sheet, setSheet] = useState<string[]>([]);

  /**
   * This device's own claim about each lane it's touched — the seat, the
   * exhibition flag, its own watch(es) — ahead of the next revalidation
   * catching up. One `SeedRecord` per lane, by cookie name, held as plain
   * state rather than re-derived from the cookie itself: see `seed-cookie.ts`
   * for why reading it back mid-session is exactly the bug this avoids.
   */
  const [pending, setPending] = useState<Record<string, SeedRecord>>({});
  // Swimmers typed in on this device; they may not have reached the server yet.
  const [added, setAdded] = useState<QueuedAthlete[]>([]);

  /* ------------------------------------------------------------- stopwatch */

  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [stopped, setStopped] = useState<{ ms: number; at: number } | null>(
    null,
  );
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (startedAt === null) return;
    const tick = () => {
      setElapsed(Date.now() - startedAt);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [startedAt]);

  /**
   * A clock belongs to the race it was started for.
   *
   * Moving to another heat changes this route's params rather than matching a
   * different route, so React keeps the component and everything above would
   * otherwise follow the timer down the pool. It did: STOP, then ›, and heat 2
   * opened showing heat 1's time above a live Submit that would have filed it
   * against the new lane.
   */
  useEffect(() => {
    setStartedAt(null);
    setStopped(null);
    setElapsed(0);
    setRetiming(false);
    setPicking(false);
    // Three times written down for heat 1 are not heat 2's times, for the
    // same reason the clock above isn't heat 2's clock.
    setSheet([]);
    // Same route, new params — the browser has no page load to reset scroll
    // on, so a heat scrolled down to reach Submit would otherwise open the
    // next one already scrolled.
    window.scrollTo(0, 0);
  }, [eventNo, heatNo, lane]);

  /* ----------------------------------------------------------------- state */

  const order = useMemo(
    () => runningOrder(snapshot.events, snapshot.swims),
    [snapshot],
  );
  /**
   * The heat this page is about, found by the numbering in its own URL.
   *
   * Undefined when the address names a heat this meet doesn't have — a stale
   * link, or a reseed that removed it — which the render below turns into
   * something readable rather than a blank screen.
   */
  const stopIndex = order.findIndex(
    (s) => s.event.position === eventNo - 1 && s.heat === heatNo,
  );
  const stop = stopIndex >= 0 ? order[stopIndex] : undefined;

  const floor = earliestAllowed(furthest);

  const athletes = useMemo(() => {
    const seen = new Set(snapshot.athletes.map((a) => a.id));
    return [
      ...snapshot.athletes,
      ...added.filter((a) => !seen.has(a.id)),
    ] as TimerAthlete[];
  }, [snapshot, added]);

  const byId = useMemo(
    () => new Map(athletes.map((a) => [a.id, a])),
    [athletes],
  );

  const ownTeam = snapshot.ownTeam;

  /**
   * How many columns this phone is filling in — one for a stopwatch, one per
   * timer behind the lane for a sheet.
   *
   * The only thing that decides which screen this is. Everything downstream
   * reads the number rather than the role, so a clipboard at a meet that has
   * gone back to one watch a lane is simply a stopwatch again.
   */
  const watches = watchCount(snapshot.meet, role);
  const clipboard = watches > 1;

  /**
   * Where this screen is, as the meet numbers it — event 7, heat 1, lane 3.
   * The same three integers the seed cookie's name is built from, so what the
   * phone queues and what the person is looking at cannot disagree.
   */
  const where: SwimKey | null =
    stop && lane
      ? { event: stop.event.position + 1, heat: stop.heat, lane }
      : null;

  /** The swim in this lane, if anybody has said who is in it. */
  const seed = stop?.swims.find((s) => s.lane === lane);
  const laneKey = where ? seedCookieName(where) : null;
  const record = laneKey ? pending[laneKey] : undefined;
  const swimmerId = (record?.athleteId ?? seed?.athleteId) || null;
  const swimmer = swimmerId ? byId.get(swimmerId) : undefined;
  const exhibition = record?.exhibition ?? seed?.exhibition ?? false;

  /**
   * This phone's own times for this swim, once the server has them, by column.
   *
   * A watch with no time on it is a stopwatch running — this phone's own, or
   * one of the handheld ones it armed — and is not a time sent. A column that
   * never got one stays empty, which is exactly what the screen has to show
   * when two of three timers came back with something.
   */
  const sent = useMemo(() => {
    const times: Array<number | null> = Array.from(
      { length: watches },
      () => null,
    );
    if (!seed) return times;
    for (const watch of snapshot.mine) {
      if (watch.swimId !== seed.id || watch.timeMs === undefined) continue;
      if (watch.slot <= watches) times[watch.slot - 1] = watch.timeMs;
    }
    return times;
  }, [snapshot, seed, watches]);

  const alreadyTimed = sent.some((ms) => ms !== null);
  const sentLabel = sent
    .filter((ms): ms is number => ms !== null)
    .map(formatTime)
    .join(", ");

  /* --------------------------------------------------------------- actions */

  /**
   * What this lane's record starts from before this device has touched
   * anything about it — the seat and exhibition flag the meet already
   * agrees on, no watches of its own yet. Patching from this rather than an
   * empty record means arming a stopwatch can't accidentally blank a seat
   * assigned moments earlier at the desk, and vice versa.
   */
  const baseRecord = (): SeedRecord => ({
    ...emptySeedRecord(),
    athleteId: seed?.athleteId ?? "",
    exhibition: seed?.exhibition ?? false,
  });

  /**
   * Apply one change to this lane's record and push the whole thing to the
   * server as a single write. The record lives in `pending` state, not the
   * cookie — `clientAction` is what turns it into one — so there is nothing
   * to read back and no chance of building the next change off a copy the
   * server already cleared.
   */
  const updateRecord = (patch: (record: SeedRecord) => SeedRecord) => {
    if (!where || !laneKey) return;
    const next = patch({
      ...(pending[laneKey] ?? baseRecord()),
      updatedAt: Date.now(),
    });
    setPending((current) => ({ ...current, [laneKey]: next }));
    fetcher.submit({ record: encodeSeedRecord(next) }, { method: "post" });
  };

  /**
   * Move to another heat by going to its page.
   *
   * The clock is cleared on the way, by the effect above rather than here, so
   * that every arrival at a heat behaves the same whether it came from these
   * arrows, from Submit, or from the back button.
   */
  const move = (to: number) => {
    const target = order[Math.max(floor, Math.min(order.length - 1, to))];
    if (target) navigate(stopPath(meetId, target, lane));
  };

  /**
   * Say who's in this lane, straight away.
   *
   * A swimmer picked from the list travels as an id the server already
   * knows. One typed in here travels as an id this device just minted,
   * alongside the name and team it needs to create that person under — the
   * only side that could tell a genuinely new person from a name it already
   * has is the one holding the whole roster, but the id has to be settled now
   * so re-applying this same cookie later converges rather than duplicates.
   */
  const claimLane = (athleteId: string, newcomer?: QueuedAthlete) => {
    if (!where) return;
    updateRecord((record) =>
      newcomer
        ? {
            ...record,
            athleteId,
            team:
              snapshot.meet.teams.find((t) => t.id === newcomer.teamId)?.code ??
              null,
            name: `${newcomer.firstName} ${newcomer.lastName}`.trim(),
            gender: newcomer.gender,
          }
        : { ...record, athleteId, team: null, name: "", gender: null },
    );
  };

  /**
   * Say whether this lane's swim counts, straight away — the same way a seat
   * goes up, because it's a fact about the swim rather than evidence to
   * reconcile with anyone else's later.
   */
  const toggleExhibition = () => {
    if (!where) return;
    updateRecord((record) => ({ ...record, exhibition: !exhibition }));
  };

  /**
   * Arm the lane.
   *
   * Sent on its own, straight away, because this is the one message whose
   * value is entirely in arriving early: the desk wants to see a lane armed
   * before the gun, which is the only moment anything can be done about it.
   * Only ever this phone's own watch — a clipboard's other columns come off
   * handheld stopwatches this app never sees start, only their final reading.
   */
  const arm = () => {
    const at = Date.now();
    setStartedAt(at);
    setElapsed(0);
    updateRecord((record) => ({
      ...record,
      watches: [{ startedAt: at, stoppedAt: null, timeMs: null }],
    }));
  };

  /**
   * File this lane's times and move on.
   *
   * Takes the whole sheet, one entry per watch and `null` where a watch has
   * nothing, because that is what the lane is saying: not "here is a time"
   * but "here is what the watches on this lane read". One phone with one
   * stopwatch says the same thing with one column. Each slot keeps its own
   * start/stop telemetry from `pending` — the same in-memory record arming
   * and stopping already wrote to, never a copy read back off the cookie.
   */
  const submit = (times: Array<number | null>) => {
    if (!where || !times.some((ms) => ms !== null)) return;

    updateRecord((record) => ({
      ...record,
      watches: times.map((timeMs, i) => ({
        startedAt: record.watches[i]?.startedAt ?? null,
        stoppedAt: record.watches[i]?.stoppedAt ?? null,
        timeMs,
      })),
    }));

    // How far this device has got. The only thing about a timer's progress
    // that is still device state — the URL says where they *are*, not the
    // furthest they have been, and going back past a submitted heat is what
    // this exists to prevent.
    const reached = Math.max(furthest, stopIndex);
    setFurthest(reached);
    saveFurthest(meetId, reached);

    // Clear the clock before moving. Usually the navigation below does it, by
    // changing the heat in the URL — but on the last heat of the meet there is
    // nowhere further to go, nothing in the address changes, and without this
    // the time just submitted stays on screen above a Submit button offering
    // to send it again.
    setStartedAt(null);
    setStopped(null);
    setElapsed(0);
    setRetiming(false);
    setSheet([]);

    // On to the next heat, which is the next page.
    const next = order[Math.min(order.length - 1, stopIndex + 1)];
    if (next) navigate(stopPath(meetId, next, lane));
  };

  /* ---------------------------------------------------------------- render */

  if (!stop) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6 text-center">
        <div>
          <p className="text-lg font-bold">Nothing to time yet</p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            The coach hasn&rsquo;t set the heats for this meet. This screen will
            catch up on its own.
          </p>
        </div>
      </main>
    );
  }

  const running = startedAt !== null && !stopped;
  /**
   * Whether walking away from this heat is currently refused.
   *
   * A stopwatch mid-race is: the arrows and the lane link would abandon a
   * clock that is the only record of a swim in progress. A clipboard's isn't
   * — nothing is being measured here, the watches are in other people's
   * hands, and there is no stop button coming that would ever unlock it.
   */
  const locked = running && !clipboard;
  const inEvent = new Set(snapshot.entries[stop.event.id] ?? []);

  const alarm = queue.overflow ? "not saving — find signal" : null;

  return (
    <main className="flex min-h-screen flex-col bg-slate-50 dark:bg-slate-950">
      {/* Where we are. Small: it's context, not the job. */}
      <EventHeader />

      <div
        className={`flex flex-1 flex-col p-4 ${
          clipboard ? "gap-3" : "justify-between"
        }`}
      >
        <div className="space-y-3">
          {/* Back to the lane picker, which is a page rather than a state —
              so this is a link, and the browser's own back button does the
              same thing. A timer swapping ends of the pool mid-meet is the
              case it exists for. */}
          <Link
            to={timerPath(meetId)}
            className={`flex w-full touch-manipulation items-center justify-between rounded-2xl bg-white px-4 py-3 text-left dark:bg-slate-900 ${
              locked ? "pointer-events-none opacity-60" : ""
            }`}
          >
            <span className="text-3xl font-bold">Lane {lane}</span>
            <span className="text-sm font-semibold text-blue-600">change</span>
          </Link>

          <button
            type="button"
            onClick={() => setPicking(true)}
            className="flex w-full touch-manipulation items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 text-left dark:bg-slate-900"
          >
            <span className="min-w-0">
              <span className="block truncate text-2xl font-bold">
                {swimmer
                  ? `${swimmer.firstName} ${swimmer.lastName}`.trim()
                  : "Empty lane"}
              </span>
              <span className="block truncate text-sm text-slate-500">
                {swimmer ? (swimmer.team ?? ownTeam) : "Tap to say who's here"}
              </span>
            </span>
            <span className="shrink-0 text-sm font-semibold text-blue-600">
              change
            </span>
          </button>

          {/* Doesn't need a name or a time to be true, so it's here rather
              than buried in the sheet below — a call a timer can make about
              the lane before the race is even swum. */}
          <button
            type="button"
            onClick={toggleExhibition}
            aria-pressed={exhibition}
            className={`flex w-full touch-manipulation items-center justify-between rounded-2xl px-4 py-3 text-left ${
              exhibition
                ? "bg-amber-500 text-white"
                : "bg-white dark:bg-slate-900"
            }`}
          >
            <span className="font-semibold">Exhibition</span>
            <span className={`text-sm ${exhibition ? "" : "text-slate-500"}`}>
              {exhibition
                ? "Won't score or place"
                : "Time counts, but not for scoring"}
            </span>
          </button>
        </div>

        {clipboard ? (
          <ClipboardView
            watches={watches}
            values={sheet}
            onChange={(column, value) =>
              setSheet((current) => {
                const next = [...current];
                next[column] = value;
                return next;
              })
            }
            sent={sent}
            retiming={retiming}
            onRetime={() => {
              // Whatever went up is what a correction starts from — the point
              // of coming back is usually one column, not all three.
              setSheet(sent.map((ms) => (ms === null ? "" : formatTime(ms))));
              setRetiming(true);
            }}
            onSubmit={submit}
          />
        ) : (
          <StopwatchView />
        )}
      </div>

      {picking && (
        <SwimmerPicker
          athletes={athletes}
          inEvent={inEvent}
          current={swimmer}
          ownTeam={ownTeam}
          meetTeams={snapshot.meet.teams}
          eventGender={stop.event.gender === "M" ? "M" : "F"}
          onPick={(athlete) => {
            claimLane(athlete.id);
            setPicking(false);
          }}
          onAdd={(athlete) => {
            setAdded((current) => [...current, athlete]);
            claimLane(athlete.id, athlete);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </main>
  );
}

interface SmartLinkProps extends Partial<LinkProps> {
  children: React.ReactNode;
}

export function SmartLink({ to, children, ...props }: SmartLinkProps) {
  // Check if "to" is falsy, an empty string, or hash only
  const isDisabled = !to || to === "" || to === "#";

  if (isDisabled) {
    return (
      <span
        className={props.className}
        style={{ cursor: "not-allowed", opacity: 0.6 }}
        aria-disabled="true"
      >
        {children}
      </span>
    );
  }

  // Typecast safely because we already verified "to" exists
  return (
    <Link to={to} {...props}>
      {children}
    </Link>
  );
}

function EventHeader({
  isStopwatchRunning,
  previousHeat,
  currentHeat,
  nextHeat,
}: {
  isStopwatchRunning: boolean;
  previousHeat?: SwimKey | null;
  currentHeat?: SwimKey | null;
  nextHeat?: SwimKey | null;
}) {
  const nextHeatLink = nextHeat
    ? timerPath(nextHeat.meetId, nextHeat.event, nextHeat.heat, nextHeat.lane)
    : null;
  const previousHeatLink = previousHeat
    ? timerPath(
        previousHeat.meetId,
        previousHeat.event,
        previousHeat.heat,
        previousHeat.lane,
      )
    : null;
  return (
    <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] dark:border-slate-800 dark:bg-slate-900">
      <SmartLink
        className="text-2xl font-bold"
        to={!isStopwatchRunning && previousHeatLink ? previousHeatLink : "#"}
        aria-label="Previous heat"
      >
        ‹
      </SmartLink>
      <div className="min-w-0 flex-1 text-center">
        <p className="truncate text-sm font-bold">{eventName(stop.event)}</p>
        <p className="text-xs text-slate-500">
          Heat {stop.number} of {stop.of}
          {alarm
            ? ` · ${alarm}`
            : queue.pending.length > 0 && ` · ${queue.pending.length} to send`}
        </p>
      </div>
      <SmartLink
        className="text-2xl font-bold"
        to={!isStopwatchRunning && nextHeatLink ? nextHeatLink : "#"}
        aria-label="Next heat"
      >
        ›
      </SmartLink>
    </header>
  );
}

function StopwatchView({}: {}) {
  return (
    <>
      <div className="py-6 text-center">
        <p className="font-mono text-6xl font-bold tabular-nums">
          {stopped ? formatTime(stopped.ms) : formatClock(elapsed)}
        </p>
        {alreadyTimed && !stopped && startedAt === null && (
          <p className="mt-2 text-sm text-slate-500">
            Sent {sentLabel} for this heat.
            {retiming && " Timing again replaces it."}
          </p>
        )}
      </div>

      <div className="space-y-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {stopped ? (
          <div className="grid grid-cols-3 gap-2">
            <Button
              size="xl"
              variant="success"
              className="col-span-2"
              onClick={() => submit([stopped.ms])}
            >
              Submit
            </Button>
            <Button
              size="xl"
              onClick={() => {
                setStopped(null);
                setStartedAt(null);
                setElapsed(0);
              }}
            >
              Redo
            </Button>
          </div>
        ) : alreadyTimed && !retiming ? (
          /* This heat is done, and says so where the button would be.
                 A green START here invites re-timing a heat whose sheet has
                 already gone to the desk — and reads identically to the heat in
                 front of you, which is the one that matters. */
          <>
            <Button
              size="xl"
              variant="success"
              full
              disabled
              className="min-h-32 text-4xl"
            >
              Submitted
            </Button>
            <Button variant="ghost" full onClick={() => setRetiming(true)}>
              Time it again
            </Button>
          </>
        ) : running ? (
          <Button
            size="xl"
            variant="danger"
            full
            className="min-h-32 text-4xl"
            onClick={() => {
              const at = Date.now();
              setStopped({ ms: at - (startedAt ?? at), at });
              // Sent straight away, like the start: the desk should see
              // this lane has stopped (and stop counting it as running)
              // well before this thumb gets around to submitting a
              // final sheet.
              updateRecord((record) => ({
                ...record,
                watches: record.watches.map((w) => ({
                  ...w,
                  stoppedAt: at,
                })),
              }));
            }}
          >
            STOP
          </Button>
        ) : (
          <Button
            size="xl"
            variant="success"
            full
            className="min-h-32 text-4xl"
            onClick={arm}
          >
            START
          </Button>
        )}
      </div>
    </>
  );
}

function ClipboardView({
  watches,
  values,
  onChange,
  sent,
  retiming,
  onRetime,
  onSubmit,
}: {
  watches: number;
  /** What has been typed, by column. Sparse until somebody types. */
  values: string[];
  onChange: (column: number, value: string) => void;
  /** What this phone has already filed for this swim, by column. */
  sent: Array<number | null>;
  retiming: boolean;
  onRetime: () => void;
  onSubmit: (times: Array<number | null>) => void;
}) {
  const columns = Array.from({ length: watches }, (_, index) => index);
  const typed = columns.map((column) => (values[column] ?? "").trim());
  const parsed = typed.map((text) => (text ? parseTime(text) : null));

  const done = sent.some((ms) => ms !== null) && !retiming;
  const unreadable = typed.some((text, i) => text !== "" && parsed[i] === null);
  const count = parsed.filter((ms) => ms !== null).length;

  return (
    <div className="space-y-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {columns.map((column) => (
        <label
          key={column}
          className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3 dark:bg-slate-900"
        >
          <span className="w-20 shrink-0 text-sm font-bold text-slate-500">
            Watch {column + 1}
          </span>
          {done ? (
            <span className="min-w-0 flex-1 text-right font-mono text-3xl font-bold tabular-nums">
              {sent[column] === null ? "—" : formatTime(sent[column]!)}
            </span>
          ) : (
            <input
              // Shown formatted — "3045" reads back as "30.45" while the
              // thumb is still typing it, so the separators never have to be
              // typed and a misread digit shows up immediately rather than
              // waiting for a preview off to the side.
              value={
                typed[column] === ""
                  ? ""
                  : parsed[column] !== null
                    ? formatTime(parsed[column]!)
                    : typed[column]
              }
              onChange={(event) =>
                onChange(
                  column,
                  event.target.value.replace(/\D/g, "").slice(0, 7),
                )
              }
              inputMode="numeric"
              placeholder={"—"}
              aria-label={`Watch ${column + 1}`}
              className="min-w-0 flex-1 rounded-xl border-2 border-slate-300 bg-slate-50 px-3 py-2.5 text-right font-mono text-4xl font-bold tabular-nums outline-none focus:border-blue-500 placeholder:text-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:placeholder:text-slate-600"
            />
          )}
        </label>
      ))}

      {/* Nothing to explain about a sheet that has already gone up. */}
      {!done && (
        <p
          className={`px-1 text-xs ${
            unreadable ? "font-bold text-red-600" : "text-slate-500"
          }`}
        >
          {unreadable
            ? "One of those can’t be read as a time. 3045 is 30.45."
            : "Just digits — 3045 is 30.45, 11127 is 1:11.27."}
        </p>
      )}

      {done ? (
        /* Already gone to the desk, and says so where the button would be —
           a live Submit here invites sending a sheet that has already been
           read out. Coming back to fix one column is exactly what the ghost
           button under it is for. */
        <>
          <Button
            size="xl"
            variant="success"
            full
            disabled
            className="min-h-24 text-3xl"
          >
            Submitted
          </Button>
          <Button variant="ghost" full onClick={onRetime}>
            Change these times
          </Button>
        </>
      ) : (
        <Button
          size="xl"
          variant="success"
          full
          className="min-h-24 text-3xl"
          disabled={unreadable || count === 0}
          onClick={() => onSubmit(parsed)}
        >
          Submit
        </Button>
      )}
    </div>
  );
}
