import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Sheet, TextInput } from "./ui";
import { swimsForEvent, swimTime } from "~/lib/timing";
import {
  byAthlete,
  displayName,
  eventName,
  isEligible,
  athleteName,
  type MeetManifest,
} from "~/types/meet";
import { type NameOrder } from "~/types/preferences";
import { type Enrollment } from "~/types/team";
import type { Athlete } from "~/types/athlete";

interface Candidate {
  athlete: Athlete;
  /** Where they already sit in this event, if anywhere. */
  seatedAt?: { heatNumber: number; lane: number };
  /** They've already swum this event, so they can't be moved into it again. */
  swum: boolean;
}

/**
 * Pick a athlete for an empty lane, mid-meet. Choosing one seats them and
 * enters them in the event in a single step — for the athlete who decides to
 * swim while walking up behind the blocks.
 */
export function LaneAssignSheet({
  meet,
  roster,
  enrollments,
  nameOrder,
  eventId,
  heat,
  lane,
  onAssign,
  onClose,
}: {
  meet: MeetManifest;
  /** This meet's season roster — anyone off it can't be entered. */
  roster: Athlete[];
  /** Their year and squad this season, keyed by athlete id. */
  enrollments: Map<string, Enrollment>;
  nameOrder: NameOrder;
  /** The lane being filled, as the meet numbers it. */
  eventId: string;
  heat: number;
  lane: number;
  onAssign: (athleteId: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLUListElement>(null);

  const event = meet.events[eventId];
  const swims = useMemo(() => Object.values(meet.swims), [meet.swims]);
  const watches = useMemo(() => Object.values(meet.watches), [meet.watches]);

  /** Whichever team the meet's lane split says this lane belongs to, if any. */
  const laneTeamId = useMemo(() => {
    for (const [teamId, lanes] of Object.entries(
      meet.details.laneAssignments ?? {},
    )) {
      if (lanes.includes(lane)) return teamId;
    }
    return undefined;
  }, [meet.details.laneAssignments, lane]);

  const candidates = useMemo<Candidate[]>(() => {
    // Where everybody in this event already sits, so the picker can say
    // "already in heat 2, lane 4" rather than silently moving them.
    const seats = new Map<string, { heatNumber: number; lane: number }>();
    for (const seed of swimsForEvent({ swims }, eventId)) {
      if (seed.athleteId) {
        seats.set(seed.athleteId, { heatNumber: seed.heat, lane: seed.lane });
      }
    }

    // Anyone whose swim in this event already has a time. Moving them would
    // move the time with them.
    const swum = new Set(
      swimsForEvent({ swims }, eventId)
        .filter((seed) => swimTime({ swims, watches }, seed) !== null)
        .map((seed) => seed.athleteId),
    );

    const query = search.trim().toLowerCase();

    return roster
      .filter((s) => !event || isEligible(s, event))
      .filter((s) => !query || athleteName(s).toLowerCase().includes(query))
      .map((s) => ({
        athlete: s,
        seatedAt: seats.get(s.id),
        swum: swum.has(s.id),
      }))
      .sort((a, b) => {
        // Whoever isn't already in the event is nearly always who you're
        // reaching for, so float them to the top.
        const aFree = a.seatedAt ? 1 : 0;
        const bFree = b.seatedAt ? 1 : 0;
        if (aFree !== bFree) return aFree - bFree;

        // Then whoever swims for the team this lane belongs to — at a dual
        // meet the lane already says which side of the pool you're looking
        // at, so that team's roster is who you're almost always reaching for.
        if (laneTeamId) {
          const aSame =
            enrollments.get(a.athlete.id)?.teamId === laneTeamId ? 0 : 1;
          const bSame =
            enrollments.get(b.athlete.id)?.teamId === laneTeamId ? 0 : 1;
          if (aSame !== bSame) return aSame - bSame;
        }

        return byAthlete(nameOrder)(a.athlete, b.athlete);
      });
  }, [
    roster,
    nameOrder,
    swims,
    watches,
    eventId,
    event,
    search,
    enrollments,
    laneTeamId,
  ]);

  /**
   * Up and down walk the visible list of candidates; the search box feeds
   * into the same list rather than owning a separate arrow behavior of its
   * own. Enter needs nothing extra — a focused `<button>` already answers it.
   */
  const moveFocus = (delta: number) => {
    const buttons = listRef.current
      ? Array.from(
          listRef.current.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        )
      : [];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      at === -1
        ? delta > 0
          ? 0
          : buttons.length - 1
        : Math.min(Math.max(at + delta, 0), buttons.length - 1);
    buttons[next]?.focus();
  };

  const onListArrow = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(-1);
    }
  };

  return (
    <Sheet open title={`Lane ${lane} · who's swimming?`} onClose={onClose}>
      {event && (
        <p className="-mt-2 mb-3 text-sm text-slate-500 dark:text-slate-400">
          They'll be entered in {eventName(event)} as well.
        </p>
      )}

      <TextInput
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={onListArrow}
        placeholder="Search swimmers"
        autoFocus
      />

      {candidates.length === 0 ? (
        <p className="py-6 text-center text-slate-500">
          No eligible swimmers match that.
        </p>
      ) : (
        <ul
          ref={listRef}
          className="mt-2 max-h-[45vh] divide-y divide-slate-200 overflow-y-auto overscroll-contain dark:divide-slate-800"
        >
          {candidates.map(({ athlete, seatedAt, swum }) => (
            <li key={athlete.id}>
              <button
                type="button"
                disabled={swum}
                onClick={() => {
                  onAssign(athlete.id);
                  onClose();
                }}
                onKeyDown={onListArrow}
                className="flex min-h-14 w-full touch-manipulation items-center justify-between gap-3 px-1 py-2 text-left disabled:opacity-40"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">
                    {displayName(athlete, nameOrder)}
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    {athlete.gender}
                    {meet.teams[enrollments.get(athlete.id)?.teamId ?? ""] &&
                      ` · ${meet.teams[enrollments.get(athlete.id)!.teamId].name}`}
                    {enrollments.get(athlete.id)?.year &&
                      ` · ${enrollments.get(athlete.id)?.year}`}
                    {enrollments.get(athlete.id)?.squad &&
                      ` · ${enrollments.get(athlete.id)?.squad}`}
                  </span>
                </span>

                {swum ? (
                  <span className="shrink-0 rounded-full bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                    already swam
                  </span>
                ) : seatedAt ? (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    move from H{seatedAt.heatNumber} L{seatedAt.lane}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
