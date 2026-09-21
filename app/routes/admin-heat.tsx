import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useFetcher, useNavigate } from "react-router";
import type { Route } from "./+types/admin-heat";
import {
  Button,
  Card,
  EmptyState,
  SectionTitle,
  TextInput,
} from "~/components/ui";
import { LaneAssignSheet } from "~/components/LaneAssignSheet";
import { formatClock, formatTime, parseTime } from "~/lib/time";
import { enrollmentIndex } from "~/lib/roster";
import { generateId } from "~/lib/id";
import {
  currentWatches,
  fromStopwatch,
  heatClosed,
  heatsOf,
  laneProgress,
  laneTime,
  OK_DISCREPANCY_MS,
  runningWatches,
  swimsForHeat,
  stoppedWatches,
  swimTime,
} from "~/lib/timing";
import { useSend } from "~/state/outbox";
import type { Write } from "~/lib/outbox";
import type { LaneProgress, LaneTime } from "~/lib/timing";
import { useAdmin } from "./admin";
import { useViewPrefs } from "~/state/view-prefs";
import {
  displayName,
  eventName,
  findAthlete,
  type MeetDetail,
  type Event,
  type ResultStatus,
  type WatchRole,
} from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Admin · Swim Starts" }];
}

/**
 * One heat's desk — `/meets/:meetId/admin/:event/:heat`.
 *
 * Addressed the same way the timer already addresses a lane: the event's
 * place in the running order and the heat number, both 1-based, neither a
 * row id. This used to be every heat of the open event stacked and
 * scrolled; now it's one heat, with heat-to-heat navigation the same shape
 * `splits.tsx` uses.
 *
 * Everything shown is still derived: the watches are what the timers sent,
 * the proposed time is what those work out to, and "official" means every
 * lane that swam has been signed off.
 */
export default function AdminHeat({ params }: Route.ComponentProps) {
  // Already live-merged and pending-overlaid by the shell — see admin.tsx.
  const { detail, access } = useAdmin();
  const send = useSend();
  const { nameOrder } = useViewPrefs();
  const navigate = useNavigate();
  const addHeat = useFetcher<{ ok: boolean; heat: number }>();

  const [assigning, setAssigning] = useState<{
    heat: number;
    lane: number;
  } | null>(null);
  const roster = detail.athletes;

  const eventNo = Number(params.event);
  const heatNo = Number(params.heat);
  const event = detail.events.find((e) => e.position === eventNo - 1);
  const heats = useMemo(
    () => (event ? heatsOf(detail, event.id) : []),
    [detail, event],
  );

  // A heat just added lands here automatically rather than leaving the desk
  // to find it on the rail.
  const addedHeat = addHeat.data?.ok ? addHeat.data.heat : null;
  useEffect(() => {
    if (addedHeat != null && event) {
      navigate(
        `/meets/${detail.meet.id}/admin/${event.position + 1}/${addedHeat}`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addedHeat]);

  const goTo = (eventPos: number, heat: number) =>
    navigate(`/meets/${detail.meet.id}/admin/${eventPos}/${heat}`);

  const heatIndex = heats.indexOf(heatNo);

  const prevHeat = () => {
    if (!event) return;
    if (heatIndex > 0) return goTo(eventNo, heats[heatIndex - 1]);
    const prevEvent = detail.events[event.position - 1];
    if (!prevEvent) return;
    const prevHeats = heatsOf(detail, prevEvent.id);
    goTo(prevEvent.position + 1, prevHeats[prevHeats.length - 1] ?? 1);
  };

  const nextHeat = () => {
    if (!event) return;
    if (heatIndex + 1 < heats.length)
      return goTo(eventNo, heats[heatIndex + 1]);
    const nextEvent = detail.events[event.position + 1];
    if (!nextEvent) return;
    const nextHeats = heatsOf(detail, nextEvent.id);
    goTo(nextEvent.position + 1, nextHeats[0] ?? 1);
  };

  const hasPrev = !!event && (heatIndex > 0 || event.position > 0);
  const hasNext =
    !!event &&
    (heatIndex + 1 < heats.length || event.position + 1 < detail.events.length);

  if (!event) {
    return (
      <EmptyState title="No such event">Pick one from the list.</EmptyState>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" onClick={prevHeat} disabled={!hasPrev}>
          ‹ Heat
        </Button>
        <p className="text-sm text-slate-500">
          {(detail.entries[event.id] ?? []).length} entered
          {heats.length === 0 ? ", no heats yet" : ""}
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() =>
              addHeat.submit(
                { eventId: event.id },
                {
                  method: "post",
                  action: `/meets/${detail.meet.id}/admin`,
                  encType: "application/json",
                },
              )
            }
          >
            {addHeat.state === "submitting" ? "Adding…" : "+ Add heat"}
          </Button>
          <Button size="sm" onClick={nextHeat} disabled={!hasNext}>
            Heat ›
          </Button>
        </div>
      </div>

      {heatNo > 0 && heats.includes(heatNo) ? (
        <HeatCard
          detail={detail}
          event={event}
          heat={heatNo}
          nameOrder={nameOrder}
          send={send}
          me={access.userId}
          onAssign={(lane) => setAssigning({ heat: heatNo, lane })}
        />
      ) : (
        <EmptyState title="No such heat">
          {heats.length > 0
            ? "Pick a heat with the arrows above."
            : "Nobody is in this event yet — add a heat, or wait for entries to seat one."}
        </EmptyState>
      )}

      {assigning && (
        <LaneAssignSheet
          detail={detail}
          eventId={event.id}
          heat={assigning.heat}
          lane={assigning.lane}
          roster={roster}
          enrollments={enrollmentIndex(detail.enrollments)}
          nameOrder={nameOrder}
          onAssign={(athleteId) => {
            send({
              kind: "swim",
              meetId: detail.meet.id,
              eventId: event.id,
              heat: assigning.heat,
              lane: assigning.lane,
              athleteId,
              // The id the server will use if this lane is new. When it isn't,
              // the server keeps the row that's there and this is ignored —
              // the overlay agrees either way.
              swimId: generateId(),
            });
            setAssigning(null);
          }}
          onClose={() => setAssigning(null)}
        />
      )}
    </>
  );
}

function HeatCard({
  detail,
  event,
  heat,
  nameOrder,
  send,
  me,
  onAssign,
}: {
  detail: MeetDetail;
  event: Event;
  heat: number;
  nameOrder: "first" | "last";
  send: (write: Write) => void;
  /** Whoever is at the desk — the watch they type is filed under them. */
  me: string | null;
  onAssign: (lane: number) => void;
}) {
  const seeds = swimsForHeat(detail, event.id, heat);
  const closed = heatClosed(detail, event.id, heat);

  // Only while a thumb is actually down somewhere in this heat — a watch
  // that's been stopped and is just waiting on its submit doesn't need
  // ticking, it needs to sit still.
  const now = useTicker(
    seeds.some((s) => runningWatches(detail, s.id).length > 0),
  );

  /**
   * Where the keyboard goes next, without every `LaneRow` needing to know
   * about its neighbors.
   *
   * The fast path through a heat is down one column and then the other —
   * every swimmer, then every time — so the desk never has to reach for the
   * mouse to move between lanes. Kept as a plain ref rather than state: which
   * DOM node sits in which slot never needs to trigger a render of its own.
   */
  const fields = useRef(
    new Map<
      number,
      { name: HTMLButtonElement | null; time: HTMLInputElement | null }
    >(),
  );
  const registerField = (
    laneNumber: number,
    kind: "name" | "time",
    el: HTMLButtonElement | HTMLInputElement | null,
  ) => {
    const entry = fields.current.get(laneNumber) ?? { name: null, time: null };
    if (kind === "name") entry.name = el as HTMLButtonElement | null;
    else entry.time = el as HTMLInputElement | null;
    fields.current.set(laneNumber, entry);
  };
  const focusField = (laneNumber: number, kind: "name" | "time") => {
    if (laneNumber < 1 || laneNumber > detail.meet.laneCount) return;
    const entry = fields.current.get(laneNumber);
    (kind === "name" ? entry?.name : entry?.time)?.focus();
  };

  /**
   * Keep each lane's status honest, without anybody having to press
   * anything.
   *
   * A lane with one clean time is not a decision — it is the timing table
   * agreeing with itself, and OK is the only status that can be inferred
   * rather than chosen. So it is set the moment a time exists and taken
   * straight back the moment the watches stop agreeing, and it never touches
   * a DQ, an NS or an OK a person actually clicked — those are calls, and
   * only a person undoes a call.
   *
   * Marked `auto` on the way out so a later disagreement can tell its own
   * earlier writing apart from somebody's decision and take back only that.
   */
  useEffect(() => {
    if (closed) return;
    for (const seed of seeds) {
      const derived = laneTime(currentWatches(detail, seed.id));

      if (!seed.status) {
        if (
          derived &&
          (derived.discrepancyMs === null ||
            derived.discrepancyMs <= OK_DISCREPANCY_MS)
        ) {
          send({
            kind: "result",
            meetId: detail.meet.id,
            swimId: seed.id,
            status: "OK",
            timeMs: derived.timeMs,
            auto: true,
          });
        }
        continue;
      }

      if (seed.decidedBy !== "auto") continue;

      if (
        !derived ||
        (derived.discrepancyMs !== null &&
          derived.discrepancyMs > OK_DISCREPANCY_MS)
      ) {
        send({ kind: "unresult", meetId: detail.meet.id, swimId: seed.id });
      } else if (derived.timeMs !== seed.officialTimeMs) {
        send({
          kind: "result",
          meetId: detail.meet.id,
          swimId: seed.id,
          status: "OK",
          timeMs: derived.timeMs,
          auto: true,
        });
      }
    }
    // detail carries the pending overlay, so this settles itself as soon as a
    // write above lands in it — no extra guard needed against re-firing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, seeds, closed, send]);

  // Once anybody's clock has moved, sitting on "not started" would be a lie —
  // and once a lane reads OK on its own, or there is nothing left to time,
  // there is nothing more the timing table can add.
  const anyActivity = seeds.some(
    (seed) => currentWatches(detail, seed.id).length > 0,
  );
  const anyOk = seeds.some((seed) => seed.status === "OK");
  const allNS = seeds.length > 0 && seeds.every((seed) => seed.status === "NS");
  const readyToComplete = anyOk || seeds.length === 0 || allNS;

  /**
   * The one press that closes a heat out.
   *
   * Everything with a time on the clock — even one the discrepancy check
   * wouldn't trust on its own — is accepted as the administrator's own call
   * the moment they press this; a lane with nothing on it at all is recorded
   * as a no-show rather than left to sit open forever.
   */
  const markComplete = () => {
    for (const seed of seeds) {
      if (seed.status) continue;
      const derived = laneTime(currentWatches(detail, seed.id));
      send({
        kind: "result",
        meetId: detail.meet.id,
        swimId: seed.id,
        status: derived ? "OK" : "NS",
        timeMs: derived ? derived.timeMs : 0,
      });
    }
  };

  /** Reopen every lane in the heat, so a correction can be made and the
   *  automatic status can pick the swims back up on its own. */
  const fixResults = () => {
    for (const seed of seeds) {
      if (!seed.status) continue;
      send({ kind: "unresult", meetId: detail.meet.id, swimId: seed.id });
    }
  };

  const heatButton = closed
    ? {
        label: "Fix Results",
        onClick: fixResults,
        variant: "ghost" as const,
        disabled: false,
      }
    : readyToComplete
      ? {
          label: "Mark as Complete",
          onClick: markComplete,
          variant: "primary" as const,
          disabled: false,
        }
      : anyActivity
        ? {
            label: "In progress",
            onClick: undefined,
            variant: undefined,
            disabled: true,
          }
        : {
            label: "Not started",
            onClick: undefined,
            variant: undefined,
            disabled: true,
          };

  return (
    <Card>
      <SectionTitle
        action={
          <Button
            size="sm"
            variant={heatButton.variant}
            disabled={heatButton.disabled}
            onClick={heatButton.onClick}
          >
            {heatButton.label}
          </Button>
        }
      >
        {eventName(event)} · heat {heat}
        {closed && (
          <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            closed
          </span>
        )}
      </SectionTitle>

      {seeds.length === 0 && (
        <p className="mb-2 text-sm text-slate-500">
          Nobody is in this heat yet.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-1 pr-2 font-semibold">Lane</th>
              <th className="py-1 pr-2 font-semibold">Swimmer</th>
              <th className="py-1 pr-2 font-semibold">Watches</th>
              <th className="py-1 pr-2 font-semibold">Time</th>
              <th className="py-1 pr-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {/* Every lane of the pool, not only the seeded ones: an empty
                lane is where somebody gets added, and a lane the desk can't
                see is a lane it can't fill. */}
            {Array.from({ length: detail.meet.laneCount }, (_, i) => i + 1).map(
              (lane) => (
                <LaneRow
                  key={lane}
                  detail={detail}
                  event={event}
                  heat={heat}
                  lane={lane}
                  nameOrder={nameOrder}
                  send={send}
                  me={me}
                  now={now}
                  closed={closed}
                  onAssign={onAssign}
                  registerField={registerField}
                  focusField={focusField}
                />
              ),
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * Re-render on a one-second beat, and only while a stopwatch is actually
 * running somewhere in this heat.
 */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const STATUSES: ResultStatus[] = ["OK", "DQ", "NS"];

/**
 * How the time box reads at a glance, before anybody reads the number.
 *
 * The distinction that earns its keep is the middle one. A lane with nothing
 * on it and a lane whose timers are all still holding their clocks show the
 * same empty box, and they want opposite responses — send somebody to cover
 * it, or leave it alone. Amber is "this is in hand"; grey is "nobody is on
 * this lane".
 */
const TIME_TONE: Record<LaneProgress, string> = {
  none: "border-dashed border-slate-300 bg-transparent text-slate-400 dark:border-slate-700",
  waiting:
    "border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100",
  complete:
    "border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-600 dark:bg-emerald-950 dark:text-emerald-100",
};

const PROGRESS_HINT: Record<LaneProgress, string> = {
  none: "No stopwatch on this lane yet",
  waiting: "Timing in progress — not every watch is in",
  complete: "Every watch on this lane is in",
};

const ROLE_LABEL: Record<WatchRole, string> = {
  timer: "Timer",
  coach: "A coach",
  admin: "Entered at the desk",
};

function describeTime(time: LaneTime): string {
  if (time.from === "admin") return "yours";
  if (time.from === "coach") {
    return time.watchCount === 1 ? "1 coach" : `${time.watchCount} coaches`;
  }
  return time.method === "single" ? "1 watch" : time.method;
}

function LaneRow({
  detail,
  event,
  heat,
  lane,
  nameOrder,
  send,
  me,
  now,
  closed,
  onAssign,
  registerField,
  focusField,
}: {
  detail: MeetDetail;
  event: Event;
  heat: number;
  lane: number;
  nameOrder: "first" | "last";
  send: (write: Write) => void;
  me: string | null;
  now: number;
  /** The heat this lane belongs to has been marked complete — nothing here
   *  may change until "Fix Results" reopens it. */
  closed: boolean;
  onAssign: (lane: number) => void;
  registerField: (
    lane: number,
    kind: "name" | "time",
    el: HTMLButtonElement | HTMLInputElement | null,
  ) => void;
  focusField: (lane: number, kind: "name" | "time") => void;
}) {
  /**
   * What's in the box while somebody is typing in it.
   *
   * `null` means nobody is, and the box shows the lane's time. It has to be
   * this way round because the screen re-reads the meet every few seconds: a
   * plain controlled value would be overwritten mid-keystroke by a poll, and
   * a plain uncontrolled one would never show a time arriving from a phone.
   */
  const [draft, setDraft] = useState<string | null>(null);

  /** The swim in this lane, if anybody has said who is in it. */
  const seed = detail.swims.find(
    (s) => s.eventId === event.id && s.heat === heat && s.lane === lane,
  );
  const watches = seed ? currentWatches(detail, seed.id) : [];
  const timed = watches.filter((w) => w.timeMs !== undefined);
  const running = seed ? runningWatches(detail, seed.id) : [];
  const stopped = seed ? stoppedWatches(detail, seed.id) : [];
  const result = seed?.status ? seed : undefined;
  const accepted = seed ? swimTime(detail, seed.id) : null;
  const derived = laneTime(watches);
  const progress = seed ? laneProgress(detail, seed.id) : "none";

  const athlete = findAthlete(detail.athletes, seed?.athleteId ?? null);
  const signedOff = result !== undefined;

  // A lane with nobody in it and nothing against it is just an empty lane.
  const idle = !seed;

  /**
   * Type a time in at the desk.
   *
   * It is a **watch**, not a ruling — one more reading of the same race,
   * filed under whoever typed it exactly as a phone's is filed under the
   * phone. A time is a time however it reached the meet: off a multi-lane
   * stopwatch, off a handheld read out down the pool, or off the board.
   *
   * It used to be written onto the call, where it outranked every watch on
   * the lane. That made the desk's number a silent override with nothing to
   * show what it overrode — and it meant the same act of reading a clock was
   * stored two different ways depending on who did it. Discarding a watch the
   * desk doesn't believe is the honest version of the same power, and it
   * leaves the reason visible in what's left.
   */
  const typeTime = (timeMs: number) => {
    if (!seed) return;
    send({
      kind: "watch",
      meetId: detail.meet.id,
      swimId: seed.id,
      // The server files it under the signed-in user regardless; this is what
      // the optimistic overlay needs to agree with it about.
      timerId: me ?? "desk",
      userId: me ?? undefined,
      // Only an administrator reaches this screen, and the server checks it
      // again — this is what the overlay needs to rank the row correctly
      // before the server answers.
      role: "admin",
      timeMs,
      submittedAt: Date.now(),
    });
  };

  /**
   * What the box shows: what somebody is typing, or the swim's time.
   *
   * `swimTime` rather than `laneTime` directly, because it is the one every
   * other screen reads and the box must not disagree with the results page
   * about what this lane swam. It adds the thing that matters: a signed-off
   * swim reads the number that was accepted rather than what the watches say
   * now, so a late watch cannot move it.
   */
  const shownTime = draft ?? (accepted ? formatTime(accepted.timeMs) : "");

  /**
   * Take what was typed, if it changed anything.
   *
   * Unchanged is the common case — the desk tabs through a heat reading times
   * without meaning to alter one — so an unchanged box must write nothing at
   * all, or every glance would file a ruling. Emptying it withdraws the
   * desk's own reading and lets the swim fall back to the watches, which is
   * the way out of a number typed by mistake.
   */
  const commitTime = () => {
    const text = draft;
    setDraft(null);
    if (text === null || !seed || closed) return;

    const mine = watches.find(
      (w) => w.role === "admin" && w.submittedBy === me,
    );
    if (text.trim() === "") {
      if (mine) {
        send({
          kind: "drop-watch",
          meetId: detail.meet.id,
          swimId: seed.id,
          timerId: mine.submittedBy,
        });
      }
      return;
    }

    const ms = parseTime(text);
    if (ms === null || ms === accepted?.timeMs) return;
    typeTime(ms);
  };

  /**
   * Sign the swim off, as whatever it was.
   *
   * One act rather than two: the status is chosen *as* the lane is accepted,
   * and the number written down is the one that was on screen — so a watch
   * landing in the same second cannot sign off a time nobody looked at.
   * Taking it back is deleting the row, which is what `unresult` does.
   */
  const signOff = (status: ResultStatus) => {
    if (!seed || closed) return;
    send({
      kind: "result",
      meetId: detail.meet.id,
      swimId: seed.id,
      status,
      // A no-show or a disqualification needn't have a time behind it.
      timeMs: accepted?.timeMs ?? 0,
    });
  };

  /**
   * Say whether this swim counts.
   *
   * Not a call in the sense a DQ is — it doesn't need every watch on the lane
   * in front of it, and it can be set before there's a time at all. It just
   * has to land on the same row a DQ would, which is why it's open to the same
   * people who may record a time rather than the desk alone.
   */
  const toggleExhibition = () => {
    if (!seed || closed) return;
    send({
      kind: "exhibition",
      meetId: detail.meet.id,
      swimId: seed.id,
      exhibition: !seed.exhibition,
    });
  };

  /**
   * The keyboard's own map of the row: right off the name onto the time,
   * left back, up and down onto the same field one lane over. Everything
   * else on the row — a DQ, a discarded watch — stays mouse-and-thumb
   * territory, so Tab never has to step over it to get to the next time.
   */
  const onNameKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusField(lane, "time");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusField(lane + 1, "name");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusField(lane - 1, "name");
    }
  };

  const onTimeKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commitTime();
    else if (e.key === "Escape") setDraft(null);
    else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusField(lane, "name");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusField(lane + 1, "time");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusField(lane - 1, "time");
    }
  };

  return (
    <tr
      className={`border-t border-slate-100 dark:border-slate-800 ${
        signedOff ? "bg-emerald-50/60 dark:bg-emerald-950/30" : ""
      }`}
    >
      <td className="py-2 pr-2 font-bold tabular-nums">{lane}</td>

      <td className="py-2 pr-2">
        <button
          type="button"
          ref={(el) => registerField(lane, "name", el)}
          // A lane already named is one Tab past, not one Tab through — the
          // fast path down a heat is time, time, time, and a name nobody
          // needs to change shouldn't cost a stop on the way there. Still
          // reachable: the arrow keys and a click both go straight to it.
          tabIndex={athlete ? -1 : 0}
          onKeyDown={onNameKeyDown}
          onClick={() => onAssign(lane)}
          className="text-left"
        >
          <span className="block font-medium">
            {athlete ? displayName(athlete, nameOrder) : "— assign —"}
          </span>
          {/* A lane somebody timed without saying who was in it. The row is
              here because a watch is, so the time is safe — what's missing is
              the name, and this is the desk where it gets put right. */}
          {seed && !athlete && (
            <span className="block text-xs text-amber-700 dark:text-amber-400">
              {timed.length > 0
                ? "timed, nobody named — tap to assign"
                : "a stopwatch running on a lane with no name"}
            </span>
          )}
        </button>
      </td>

      {/* Every timer's own send, one chip each. Shown in full rather than
          summarised because a single slow thumb is obvious side by side and
          invisible once averaged — and because the median only means anything
          if you can see what it chose between. */}
      <td className="py-2 pr-2">
        <span className="flex flex-wrap items-center gap-1">
          {timed.length === 0 &&
            running.length === 0 &&
            stopped.length === 0 && (
              <span className="text-xs text-slate-400">—</span>
            )}

          {/* A stopwatch that is still going.

              The desk can see the race it is watching, so the number itself is
              not the point — what it answers is which lanes are actually being
              timed, and, once a heat is long over, which timer is still
              holding a clock they forgot to stop. That one is invisible
              otherwise: the lane simply never completes and nobody knows why.

              Counted from the server's clock, which is why the phone's start
              was translated onto it on the way in. Seconds only, no
              hundredths — a digit that only refreshes once a second doesn't
              read as precision, it reads as a typo, so it's dropped while
              this is still counting up. */}
          {running.map((a) => (
            <span
              key={a.id}
              title={`Timer ${a.submittedBy} is still timing this lane`}
              className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs tabular-nums text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              <span aria-hidden className="text-[0.6rem]">
                ▶
              </span>
              {formatClock(Math.max(0, now - a.startedAt!), {
                hundredths: false,
              })}
            </span>
          ))}
          {/* A stopwatch that's been stopped but hasn't submitted yet.
              Frozen, not ticking — its `stoppedAt` already says the elapsed
              time, to full precision, and nothing about it will change until
              the submit lands and gives it a real `timeMs`. Distinct from a
              counted watch below so the desk can see this isn't a time yet
              (and can't sign the lane off OK on the strength of it). */}
          {stopped.map((a) => (
            <span
              key={a.id}
              title={`Timer ${a.submittedBy} stopped their watch — waiting for it to submit`}
              className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            >
              <span aria-hidden className="text-[0.6rem]">
                ■
              </span>
              {formatClock(
                Math.max(0, a.stoppedAt! - (a.startedAt ?? a.stoppedAt!)),
              )}
            </span>
          ))}
          {/* Each watch with a way to drop it.

              This is the desk's real power over a time, and it replaced a
              number typed onto the call that silently outranked everything.
              Throwing out the reading you don't believe says which one you
              didn't believe; overriding it said nothing at all. */}
          {timed.map((w) => {
            // Which watches actually made the number. Everything is kept and
            // everything is shown — a coach's stopwatch is still evidence —
            // but a chip that fed the time has to look different from one
            // that was outranked, or the desk is reading five numbers and
            // guessing which three it is being asked to accept.
            const counted = derived !== null && w.role === derived.from;
            return (
              <span
                key={w.id}
                title={
                  `${ROLE_LABEL[w.role]}${w.userId ? "" : ` ${w.submittedBy}`}` +
                  (fromStopwatch(w) ? " · off a stopwatch" : " · typed in") +
                  (counted ? "" : " · not counted, outranked")
                }
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs tabular-nums ${
                  !counted
                    ? "bg-slate-100 text-slate-400 line-through dark:bg-slate-900 dark:text-slate-600"
                    : w.role === "admin"
                      ? "bg-amber-100 font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                      : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                }`}
              >
                {formatTime(w.timeMs!)}
                {!fromStopwatch(w) && "✎"}
                <button
                  type="button"
                  aria-label={`Discard the ${formatTime(w.timeMs!)} watch`}
                  title="Discard this watch"
                  disabled={closed}
                  tabIndex={-1}
                  onClick={() =>
                    seed &&
                    !closed &&
                    send({
                      kind: "drop-watch",
                      meetId: detail.meet.id,
                      swimId: seed.id,
                      timerId: w.submittedBy,
                    })
                  }
                  className="text-red-600 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  ✕
                </button>
              </span>
            );
          })}
        </span>
      </td>

      {/* Always a box, never a label that turns into one.

          The desk's job on every row is the same — read the time, change it if
          it's wrong — and an Edit button made the second of those a different
          mode to enter. A box that already holds the number is one tap
          shorter and reads the same whether or not you're about to touch it.

          Its colour is the lane's timing, which the number alone can't say:
          blank-and-grey is nobody covering this lane, amber is watches running
          or some in, green is the timing table done. */}
      <td className="py-2 pr-2">
        <TextInput
          ref={(el) => registerField(lane, "time", el)}
          value={shownTime}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.target.select()}
          onBlur={commitTime}
          onKeyDown={onTimeKeyDown}
          inputMode="numeric"
          placeholder={progress === "none" ? "" : "0000"}
          aria-label={`Time for lane ${lane}`}
          title={
            closed
              ? "This heat is complete — Fix Results to change it."
              : PROGRESS_HINT[progress]
          }
          tone={TIME_TONE[progress]}
          readOnly={closed}
          className="!w-28 text-center font-mono tabular-nums disabled:opacity-60"
        />
        {derived && (
          <span className="ml-1 text-xs text-slate-400">
            {describeTime(derived)}
          </span>
        )}
      </td>

      {/* Status is how the lane is signed off, not a separate mark made
          beforehand. Tapping one accepts the swim as that — which is the act
          the desk came to the row to perform, in one tap rather than two. */}
      <td className="py-2 pr-2">
        <div className="flex flex-wrap items-center gap-1">
          {STATUSES.map((status) => {
            const current = result?.status ?? "OK";
            const chosen = signedOff && current === status;
            // OK asserts a real time was recorded — a DQ or an NS doesn't
            // need one, so only OK is gated on a watch (or a typed time)
            // actually landing first.
            const needsTime = status === "OK" && !accepted;
            return (
              <button
                key={status}
                type="button"
                disabled={idle || closed || needsTime}
                tabIndex={-1}
                title={
                  closed
                    ? "This heat is complete — Fix Results to change it."
                    : needsTime
                      ? "No time recorded yet — wait for a watch to submit."
                      : signedOff
                        ? `Signed off as ${status}`
                        : `Sign this lane off as ${status}`
                }
                onClick={() => signOff(status)}
                className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                  chosen
                    ? status === "OK"
                      ? "bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-900"
                      : "bg-red-600 text-white"
                    : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                } ${idle || closed || needsTime ? "opacity-40" : ""}`}
              >
                {status}
              </button>
            );
          })}
          {/* Doesn't count towards scoring or placing, but the time still
              stands — so this is separate from OK/DQ/NS rather than a fourth
              one of them. */}
          <button
            type="button"
            disabled={idle || closed}
            tabIndex={-1}
            title={
              closed
                ? "This heat is complete — Fix Results to change it."
                : seed?.exhibition
                  ? "Exhibition — doesn't count towards scoring or placing. Tap to make it count again."
                  : "Mark exhibition — the time stands, but it won't score or place."
            }
            onClick={toggleExhibition}
            className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
              seed?.exhibition
                ? "bg-amber-500 text-white"
                : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            } ${idle || closed ? "opacity-40" : ""}`}
          >
            X
          </button>
        </div>
      </td>
    </tr>
  );
}
