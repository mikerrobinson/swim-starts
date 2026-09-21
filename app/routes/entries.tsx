import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Route } from "./+types/entries";
import { AthleteSheet } from "~/components/AthleteSheet";
import { Button, EmptyState, TextInput } from "~/components/ui";
import { enrollmentIndex } from "~/lib/roster";
import { whyNotEnter } from "~/lib/events";
import { requireDb, type SyncEnv } from "~/lib/api.server";
import { meetDetail } from "~/lib/meets.server";
import { useMeet } from "./meet-layout";
import { useMeetLive } from "~/hooks/use-meet-live";
import { usePending, useSend } from "~/state/outbox";
import { applyPending } from "~/lib/pending";
import { useViewPrefs } from "~/state/view-prefs";
import {
  byAthlete,
  displayName,
  raceKey,
  shortStroke,
  withLiveTables,
  type Event,
  type Stroke,
} from "~/types/meet";
import type { Athlete, Gender } from "~/types/athlete";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Entries · Swim Starts" }];
}

/**
 * This screen's own whole-meet read.
 *
 * Same URL, same grid, same everything as before the meet's live tables
 * moved into a Durable Object — `meet-layout`'s loader doesn't hand this down
 * for free (see its doc comment), so it's read here instead.
 *
 * The four live tables — entries included, now that `declareEntry` makes
 * them genuinely DO-owned — come from the meet's Durable Object rather than
 * D1, same reasoning as admin/splits/results.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  const db = requireDb(env as SyncEnv);
  const detail = await meetDetail(db, params.meetId);
  if (!detail) return { detail: null };

  const live = await env.MEET_DO.getByName(params.meetId).getSnapshot(
    params.meetId,
  );
  return { detail: withLiveTables(detail, live) };
}

/**
 * Hidden for now so the grid gets the whole screen. Flip to true to bring back
 * the search box and the "+ Swimmer" button; swimmers can still be added under
 * Team either way.
 */
const SHOW_ROSTER_CONTROLS = false;

/**
 * Zebra striping. Both tones are fully opaque: the name column is sticky, so a
 * translucent background would let the cells scrolling underneath show through.
 */
const ROW_TONES = [
  { name: "bg-white dark:bg-slate-900", cell: "bg-white dark:bg-slate-900" },
  {
    name: "bg-slate-50 dark:bg-slate-800",
    cell: "bg-slate-50 dark:bg-slate-800",
  },
];

/** Width of the pinned athlete column. */
const NAME_COL = "9rem";
/** Floor for a race column before the grid starts scrolling sideways. */
const MIN_RACE_COL = "3.5rem";

/**
 * One column of the grid: a distance/stroke pair, holding whichever gendered
 * versions of it the lineup contains. A split lineup swims each race twice,
 * but there's no reason to make the coach tap through twice as many columns
 * when the swimmer's gender already says which of the two they belong in.
 */
interface Race {
  key: string;
  distance: number;
  stroke: Stroke;
  /**
   * 1-based event numbers in swum order — what the meet program calls them.
   * Kept off the header to save a line, but surfaced in its tooltip.
   */
  numbers: number[];
  girls?: Event;
  boys?: Event;
  open?: Event;
}

/** The event in this race that a given athlete would actually swim. */
/** How a race reads in prose — diving has no distance worth printing. */
function raceLabel(race: Race): string {
  return race.stroke === "Diving"
    ? "Diving"
    : `${race.distance} ${race.stroke}`;
}

function eventFor(race: Race, athlete: Athlete): Event | undefined {
  const own = athlete.gender === "F" ? race.girls : race.boys;
  return own ?? race.open;
}

export default function Registration({ loaderData }: Route.ComponentProps) {
  const loaded = loaderData.detail!;
  const { access } = useMeet();
  // Two coaches enter their own swimmers on this grid at the same time, and
  // they write different rows — so each should see the other's ticks appear
  // rather than find out at seeding. The meet's live connection now, rather
  // than a poll — entries are DO-owned like the other three live tables.
  const live = useMeetLive(loaded.meet.id, loaded);
  const pending = usePending();
  const send = useSend();
  // What the server has acknowledged, plus what this device has said since.
  const detail = useMemo(
    () => applyPending(withLiveTables(loaded, live.snapshot), pending),
    [loaded, live.snapshot, pending],
  );
  const { meet, events: meetEvents, entries, athletes } = detail;
  const { nameOrder } = useViewPrefs();

  const [params] = useSearchParams();
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const param = params.get("g");
  const genderFilter: Gender | "all" =
    param === "f" ? "F" : param === "m" ? "M" : "all";

  const enrollments = useMemo(
    () => enrollmentIndex(detail.enrollments),
    [detail.enrollments],
  );

  /**
   * Everyone enterable in this meet, before the screen's own filters.
   *
   * Kept separate from `swimmers` because the column counts have to mean the
   * same thing whatever the Girls/Boys toggle is set to — counting the visible
   * rows would make a header change when you filtered, which is a header
   * measuring the wrong thing.
   *
   * A coach with no admin rights sees only their own teams' athletes rather
   * than every team entered in the meet — the same boundary `mayEditFor`
   * draws below. That narrowing is specifically for coaches: an admin sees
   * everyone, and so does anyone here only because `entryVisibility` opened
   * the meet's entries to the public — narrowing their view by team would
   * take away exactly the transparency that setting grants.
   */
  const roster = useMemo(() => {
    const mine =
      !access.admin && access.coachOf.length > 0
        ? detail.enrollments.filter((e) => access.coachOf.includes(e.teamId))
        : detail.enrollments;
    const onRoster = new Set(mine.map((e) => e.athleteId));
    return athletes.filter((a) => onRoster.has(a.id));
  }, [athletes, detail.enrollments, access.admin, access.coachOf]);

  const swimmers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return roster
      .filter((s) => genderFilter === "all" || s.gender === genderFilter)
      .filter(
        (s) =>
          !query ||
          `${s.firstName} ${s.lastName}`.toLowerCase().includes(query),
      )
      .sort(byAthlete(nameOrder));
  }, [roster, genderFilter, search, nameOrder]);

  // Changing the filter changes which rows exist. Holding the old scroll
  // offset would leave you looking at an arbitrary slice of the new list
  // instead of its start, which reads as the list having reordered itself.
  // Vertical only — which columns you're on is a separate question.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = 0;
  }, [genderFilter]);

  /** Collapse the lineup into races, keeping the order they're first swum in. */
  const races = useMemo(() => {
    const byKey = new Map<string, Race>();
    meetEvents.forEach((event, index) => {
      const key = raceKey(event);
      let race = byKey.get(key);
      if (!race) {
        race = {
          key,
          distance: event.distance,
          stroke: event.stroke,
          numbers: [],
        };
        byKey.set(key, race);
      }
      race.numbers.push(index + 1);
      // First one wins, so a lineup with accidental duplicates stays sane.
      if (event.gender === "F") race.girls ??= event;
      else if (event.gender === "M") race.boys ??= event;
      else race.open ??= event;
    });
    return [...byKey.values()];
  }, [meetEvents]);

  /** Registration lookup as a set of "eventId|athleteId" keys. */
  const registered = useMemo(() => {
    const keys = new Set<string>();
    for (const [eventId, ids] of Object.entries(entries)) {
      for (const id of ids) keys.add(`${eventId}|${id}`);
    }
    return keys;
  }, [entries]);

  const perAthlete = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ids of Object.values(entries)) {
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [entries]);

  // A meet can keep lineups to the teams they belong to. Before the racing, a
  // lineup is competitive information; a reader with no stake in the meet has
  // no claim on it, and the results are public either way.
  const mayLook =
    meet.entryVisibility === "everyone" ||
    access.admin ||
    access.coachOf.length > 0;
  if (!mayLook) {
    return (
      <EmptyState title="Entries aren't public for this meet">
        The coaches involved can see their own. Results appear here as they
        happen, whatever this is set to.
      </EmptyState>
    );
  }

  // The header count reads the same scope as the rows below it — a coach
  // sees their own team's count under a column of their own team's ticks,
  // not the whole meet's.
  const rosterIds = new Set(roster.map((a) => a.id));
  const entryCount = (event?: Event) =>
    event
      ? (entries[event.id] ?? []).filter((id) => rosterIds.has(id)).length
      : 0;

  /** What the limit checks read. Assembled once rather than per cell. */
  const entryContext = {
    events: meetEvents,
    entries,
    limits: meet.limits,
  };

  /** Whose entries this person may change — see `mayEnter` on the server. */
  const mayEditFor = (athleteId: string): boolean => {
    if (access.admin) return true;
    const teams = detail.enrollments
      .filter((e) => e.athleteId === athleteId)
      .map((e) => e.teamId);
    if (teams.some((t) => access.coachOf.includes(t))) return true;
    return meet.athletesMayEnter && access.athleteId === athleteId;
  };

  /**
   * One tap, one row, queued.
   *
   * The tick moves immediately because the queue is folded over loader data
   * above; the write goes out behind it and the grid settles onto the
   * server's answer when it lands. On a deck with no signal the ticks keep
   * working and the header says how many are waiting.
   */
  const toggle = (eventId: string, athleteId: string, entering: boolean) => {
    send({ kind: "entry", meetId: meet.id, eventId, athleteId, entering });
  };

  /** The count line under a column header, phrased for the current filter. */
  const headerCount = (race: Race): string => {
    if (genderFilter === "F")
      return String(entryCount(race.girls ?? race.open));
    if (genderFilter === "M") return String(entryCount(race.boys ?? race.open));
    if (race.girls && race.boys) {
      return `${entryCount(race.girls)}/${entryCount(race.boys)}`;
    }
    if (race.girls) return `G ${entryCount(race.girls)}`;
    if (race.boys) return `B ${entryCount(race.boys)}`;
    return String(entryCount(race.open));
  };

  if (races.length === 0 || swimmers.length === 0) {
    return (
      <EmptyState title="Nothing to register yet">
        {roster.length === 0 ? (
          <>
            The team roster is empty.{" "}
            <Link
              // Their own team if they coach one of the ones racing, since
              // that is the roster they can actually add to; otherwise the
              // host's, which is the one they came to look at.
              to={`/teams/${access.coachOf[0] ?? meet.hostTeamId ?? meet.teamIds[0] ?? ""}`}
              className="font-semibold text-blue-600 underline"
            >
              Add swimmers
            </Link>
            .
          </>
        ) : races.length === 0 ? (
          <>
            This meet has no events.{" "}
            <Link
              to={`/meets/${meet.id}/setup`}
              className="font-semibold text-blue-600 underline"
            >
              Set them up
            </Link>
            .
          </>
        ) : (
          <>No {genderFilter === "F" ? "girls" : "boys"} on the roster.</>
        )}
      </EmptyState>
    );
  }

  return (
    /* Sized to the gap between the app chrome so the grid — not the page —
       owns vertical scrolling. Sticky headers pin to their scroll container,
       so the header row only stays put if that container is the thing
       scrolling. The negative margins bleed it past the shell's padding so
       every pixel of the window goes to the grid. */
    <div
      className="-mt-4 flex flex-col"
      style={{
        maxHeight:
          "calc(100dvh - var(--app-chrome-top) - var(--app-chrome-bottom) - 1rem)",
      }}
    >
      {SHOW_ROSTER_CONTROLS && (
        <div className="shrink-0 space-y-3 py-3">
          <div className="flex gap-2">
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search swimmers"
            />
            <Button variant="primary" onClick={() => setAdding(true)}>
              + Athlete
            </Button>
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400">
            Tap a cell to enter or scratch a athlete. Greyed cells are races the
            athlete isn't eligible for.
          </p>
        </div>
      )}

      {/* One scroll container: the name column pins left, headers pin top. */}
      <div
        ref={scrollerRef}
        className="-mx-4 min-h-0 flex-1 overflow-auto overscroll-contain"
      >
        {/* table-fixed + w-full spreads the race columns evenly across
            whatever width is left over. minWidth keeps them tappable once
            there are more races than the screen can spread out, at which
            point the container scrolls sideways instead. */}
        <table
          className="w-full table-fixed border-separate border-spacing-0"
          style={{
            minWidth: `calc(${NAME_COL} + ${races.length} * ${MIN_RACE_COL})`,
          }}
        >
          <thead>
            <tr>
              <th
                style={{ width: NAME_COL }}
                className="sticky left-0 top-0 z-30 border-b border-r border-slate-300 bg-slate-100 px-2 py-1 text-left text-xs font-bold dark:border-slate-700 dark:bg-slate-800"
              >
                Athlete
              </th>
              {races.map((race) => (
                <th
                  key={race.key}
                  className="sticky top-0 z-20 border-b border-r border-slate-300 bg-slate-100 px-0.5 py-1 text-center text-[11px] font-bold leading-tight dark:border-slate-700 dark:bg-slate-800"
                  title={`${raceLabel(race)} · event ${race.numbers.join(", ")}`}
                >
                  {race.stroke === "Diving" ? (
                    // No distance to show, so the name takes both lines.
                    <span className="block py-1.5">Diving</span>
                  ) : (
                    <>
                      <span className="block">{race.distance}</span>
                      <span className="block">{shortStroke(race.stroke)}</span>
                    </>
                  )}
                  <span className="block font-normal text-slate-500">
                    {headerCount(race)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {swimmers.map((athlete, rowIndex) => {
              const tone = ROW_TONES[rowIndex % ROW_TONES.length];
              return (
                <tr key={athlete.id}>
                  <th
                    scope="row"
                    style={{ width: NAME_COL }}
                    className={`sticky left-0 z-10 border-b border-r border-slate-300 px-2 py-1 text-left dark:border-slate-700 ${tone.name}`}
                  >
                    <span className="block truncate text-sm font-semibold">
                      {displayName(athlete, nameOrder)}
                    </span>
                    <span className="block text-[11px] font-normal text-slate-500">
                      {athlete.gender}
                      {enrollments.get(athlete.id)?.year &&
                        ` · ${enrollments.get(athlete.id)?.year}`}{" "}
                      · {perAthlete.get(athlete.id) ?? 0} ev
                    </span>
                  </th>
                  {races.map((race) => {
                    // The gendered event this athlete belongs in; absent means
                    // the lineup has no version of this race for them.
                    const event = eventFor(race, athlete);
                    const isIn =
                      event !== undefined &&
                      registered.has(`${event.id}|${athlete.id}`);
                    // Who may change this cell is a per-swimmer question: an
                    // administrator may change any, a coach only their own
                    // team's, a swimmer only their own and only when the meet
                    // allows it.
                    const mayEdit =
                      event !== undefined && mayEditFor(athlete.id);
                    // Entry limits are the meet's rules, so they're checked
                    // here rather than discovered after the tap.
                    const blocked =
                      event !== undefined && !isIn
                        ? whyNotEnter(entryContext, athlete.id, event.id)
                        : null;
                    const locked =
                      event !== undefined && (!mayEdit || blocked !== null);
                    return (
                      <td
                        key={race.key}
                        className="border-b border-r border-slate-300 p-0 dark:border-slate-700"
                      >
                        <button
                          type="button"
                          disabled={event === undefined || locked}
                          aria-pressed={isIn}
                          aria-label={`${displayName(athlete, nameOrder)} in ${raceLabel(race)}`}
                          // The reason travels with the control, so a cell
                          // that won't take a tap can say why instead of just
                          // refusing.
                          title={blocked ?? undefined}
                          onClick={() =>
                            event && toggle(event.id, athlete.id, !isIn)
                          }
                          className={`flex h-12 w-full touch-manipulation items-center justify-center text-xl font-bold transition-colors ${
                            event === undefined
                              ? "cursor-not-allowed bg-slate-100 text-slate-300 dark:bg-slate-800/60 dark:text-slate-700"
                              : isIn
                                ? `bg-emerald-500 text-white ${mayEdit ? "active:bg-emerald-600" : "opacity-80"}`
                                : locked
                                  ? `${tone.cell} cursor-not-allowed text-transparent`
                                  : `${tone.cell} text-transparent active:bg-slate-200 dark:active:bg-slate-700`
                          }`}
                        >
                          {event === undefined ? "·" : "✓"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
