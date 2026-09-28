import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Route } from "./+types/timer-lanes";
import { loadRole, runningOrder, saveRole, type TimerRole } from "~/lib/timer";
import { firstStopPath, stopPath } from "~/lib/timer-path";
import { useMeet } from "~/hooks/useMeet";

/**
 * Standing behind a lane is the first thing that happens.
 *
 * Its own screen and its own address, reached straight off the QR code. Until
 * it's answered nothing else means anything, and once it is, the answer is in
 * the URL rather than in the device — which is what lets a volunteer swap ends
 * of the pool by going back, and what makes "which lane am I?" a question with
 * a visible answer rather than a remembered one.
 *
 * The lanes are very nearly the only thing on screen. A person who has just
 * been handed a phone and a clipboard is being asked one question, and it is a
 * big-buttoned one they can answer without reading.
 *
 * At a meet whose lanes carry two or three watches there is a second question
 * above it — is this phone one timer's stopwatch, or the sheet all of them are
 * read onto? — because the meet cannot answer it. "Three timers a lane" is
 * true both when three parents each hold a phone and when one of them holds
 * the clipboard and the other two hold watches. The answer sticks to the
 * device, so it is asked once and not again at every lane change.
 */
export default function TimerLanes({ params }: Route.ComponentProps) {
  const meet = useMeet();
  const [searchParams] = useSearchParams();

  /**
   * What this phone is: its own stopwatch, or the clipboard for the lane.
   *
   * Only asked at a meet whose lanes have more than one watch, and remembered
   * on the device from then on — so a volunteer answers once, not at every
   * lane change. `null` until the cookie has been read, which cannot happen
   * during the server render.
   */
  const [role, setRole] = useState<TimerRole | null>(null);

  useEffect(() => {
    // A phone that has already said which it is keeps that answer. One that
    // hasn't gets the clipboard, because a coach only sets "three timers a
    // lane" when the lanes have three watches on them and one sheet.
    setRole(loadRole() ?? "clipboard");
  }, []);

  const choose = (next: TimerRole) => {
    setRole(next);
    saveRole(params.meetId!, next);
  };

  const events = Object.values(meet.events);
  const swims = Object.values(meet.swims);

  /**
   * Where a lane choice sends this phone: back to the heat it just left —
   * `?event=&heat=`, set by `timer.tsx`'s "change lane" link (`lanesPath`)
   * — if there is one, or the meet's first seeded heat for a fresh scan.
   * Without this, swapping lanes mid-meet silently restarted every timer
   * back at event 1 heat 1 rather than picking up where they were.
   */
  const order = runningOrder(events, swims);
  const returnEvent = Number(searchParams.get("event"));
  const returnHeat = Number(searchParams.get("heat"));
  const returnStop = order.find(
    (s) => s.event.position + 1 === returnEvent && s.heat === returnHeat,
  );
  const laneHref = (lane: number) =>
    returnStop
      ? stopPath(params.meetId!, returnStop, lane)
      : firstStopPath({ events, swims }, params.meetId!, lane);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <h1 className="mb-1 text-center text-xl font-bold">{meet.name}</h1>
      <p className="mb-6 text-center text-slate-600 dark:text-slate-300">
        Which lane are you timing?
      </p>

      {/* The other question a lane with several watches has to answer, and the
          only place it is asked. Absent at a meet whose lanes are one watch
          each, where there is nothing to choose between. */}
      {meet.details.timersPerLane > 1 && (
        <div className="mb-6">
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                [
                  "clipboard",
                  `I have the sheet for ${meet.details.timersPerLane} watches`,
                ],
                ["own", "Just my own watch"],
              ] as Array<[TimerRole, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => choose(value)}
                aria-pressed={role === value}
                className={`min-h-16 touch-manipulation rounded-2xl border-2 px-3 py-2 text-sm font-semibold ${
                  role === value
                    ? "border-blue-600 bg-blue-600 text-white"
                    : "border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: meet.details.laneCount }, (_, i) => i + 1).map(
          (lane) => (
            <Link
              key={lane}
              to={laneHref(lane)}
              className="flex min-h-24 touch-manipulation items-center justify-center rounded-2xl border-2 border-slate-300 text-4xl font-bold active:bg-blue-600 active:text-white dark:border-slate-700"
            >
              {lane}
            </Link>
          ),
        )}
      </div>
    </main>
  );
}
