import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useSearchParams,
  useSubmit,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import type { Route } from "./+types/entries";
import { Button, EmptyState, TextInput } from "~/components/ui";
import { whyNotEnter } from "~/lib/events";
import { currentUser } from "~/lib/api.server";
import {
  canEditMeet,
  canEnter,
  canRecordTime,
  type MeetFacts,
} from "~/lib/access";
import { teamsCoachedBy } from "~/lib/coaches.server";
import { getMeet } from "~/lib/meets.server";
import { meetCache } from "~/lib/meetCache";
import { useMeet } from "~/hooks/useMeet";
import { useViewPrefs } from "~/state/view-prefs";
import type { MeetRouteHandle, ToggleOption } from "~/lib/route-handle";
import {
  byAthlete,
  displayName,
  getSortedEvents,
  raceKey,
  shortStroke,
  type Event,
  type Stroke,
} from "~/types/meet";
import type { Entry } from "~/types/meet";
import type { Athlete, Gender } from "~/types/athlete";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Entries · Swim Starts" }];
}

/**
 * Girls / Boys for the grid below. Rides on a search param (`?g=`) so this
 * screen needn't share state with `meet-layout.tsx`'s chrome — the header
 * reads this screen's `handle.headerToggle` instead of the other way
 * around.
 *
 * There's no "All" button: showing everyone is the default, and tapping the
 * active filter is the way back to it.
 */
function genderOptions(pathname: string, current: string): ToggleOption[] {
  return [
    { value: "f", label: "Girls" },
    { value: "m", label: "Boys" },
  ].map((option) => {
    const active = current === option.value;
    return {
      ...option,
      active,
      title: active
        ? `${option.label} only — tap to show everyone`
        : `${option.label} only`,
      to: active ? pathname : `${pathname}?g=${option.value}`,
    };
  });
}

export const handle: MeetRouteHandle = {
  headerToggle: ({ pathname, searchParams }) => ({
    label: "Filter roster by gender",
    options: genderOptions(pathname, searchParams.get("g") ?? ""),
  }),
};

/**
 * `userId`, `coachedTeamIds`, and `meet` — the things this screen needs
 * that aren't on `MeetManifest` (see `useMeet()` in the component below).
 * `meet` is what `access.ts`'s predicates need to decide anything about
 * *this* meet (`adminIds`/`teamIds`/`athletesMayEnter` — see
 * `canEnter`/`canRecordTime` below). `coachedTeamIds` is every team
 * `userId` coaches, resolved once here (`teamsCoachedBy`,
 * `coaches.server.ts`) because the grid below needs it per cell,
 * client-side — it's not a standing fact carried on `useUser()`.
 *
 * Who's racing and their per-athlete `teamId` come from `useMeet()`'s own
 * `athletes` (a `MeetAthlete`, not a D1 `teams`/`enrollments` join) — the
 * Durable Object's live copy, already hydrated and pushed over the
 * WebSocket, so there's no separate roster fetch to keep in sync with it.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  const meetId = params.meetId!;

  const [user, meet] = await Promise.all([
    currentUser(request, db),
    getMeet(db, meetId),
  ]);
  const userId = user?.id ?? null;
  const coachedTeamIds = userId ? await teamsCoachedBy(db, userId) : [];

  return { userId, coachedTeamIds, meet };
}

/** What `access.ts`'s predicates fall back to when the meet's own D1 row
 *  is somehow missing — nobody may edit or enter a meet that isn't there. */
const EMPTY_MEET_FACTS: MeetFacts = {
  adminIds: [],
  teamIds: [],
  athletesMayEnter: false,
};

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  return currentUrl.pathname === nextUrl.pathname
    ? false
    : defaultShouldRevalidate;
}

/**
 * One tap, one entry. `entering`/`eventId`/`athleteId` are all this needs —
 * see `MeetDurableObject.declareEntry`, which re-checks everything
 * (`canEnter`, `whyNotEnter`) against the session rather than trusting the
 * client's own read of either.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB;
  const meetId = params.meetId!;
  const [user, meet] = await Promise.all([
    currentUser(request, db),
    getMeet(db, meetId),
  ]);
  if (!meet) throw new Response("No such meet", { status: 404 });

  const form = await request.formData();
  const eventId = String(form.get("eventId") ?? "");
  const athleteId = String(form.get("athleteId") ?? "");
  const teamId = String(form.get("teamId"));
  const entering = form.get("entering") === "true";

  const stub = context.cloudflare.env.MEET_DO.getByName(meetId);
  const result = await stub.declareEntry(
    { meetId, eventId, athleteId, teamId, entering },
    meet,
    user?.id ?? null,
  );
  if (!result.ok) {
    throw new Response(result.error, { status: result.status });
  }
  return { ok: true };
}

/**
 * The tick moves the instant it's tapped: patch `meetCache`'s cached
 * manifest the same shape a `MEET_DETAILS`/`ENTRY` broadcast would, then
 * hand off to the real request. Refused writes (an entry limit, mostly)
 * don't reach here in practice — `locked` below disables the tap before it
 * can happen — so there's nothing to roll back on the rare case the server
 * disagrees; the next revalidation just shows what actually stuck.
 */
export async function clientAction({
  params,
  request,
  serverAction,
}: Route.ClientActionArgs) {
  const meetId = params.meetId!;
  const form = await request.clone().formData();
  const eventId = String(form.get("eventId") ?? "");
  const athleteId = String(form.get("athleteId") ?? "");
  const teamId = String(form.get("teamId") ?? "");
  const entering = form.get("entering") === "true";
  // Set by the component from `useUser()` — see `toggle` below. Only for
  // this optimistic patch's own accuracy; the server never trusts it,
  // deciding `entered_by` itself from the session (`declareEntry`).
  const enteredBy = String(form.get("enteredBy") ?? "");

  meetCache.applyPatch(
    meetId,
    {
      type: "ENTRY",
      entry: {
        eventId,
        athleteId,
        teamId,
        exhibition: false,
        enteredAt: Date.now(),
        enteredBy,
      },
      isDelete: !entering,
    },
    () => {},
  );

  return serverAction();
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
  const { userId, coachedTeamIds } = loaderData;
  const meetFacts = loaderData.meet ?? EMPTY_MEET_FACTS;
  const meet = useMeet();
  const submit = useSubmit();
  const {
    viewPrefs: { nameOrder },
  } = useViewPrefs();

  const isAdmin = canEditMeet({ meet: meetFacts, userId });
  // This meet's teams, narrowed to the ones the loader already found this
  // person coaching.
  const myRacingTeams = meetFacts.teamIds.filter((id) =>
    coachedTeamIds.includes(id),
  );

  const [params] = useSearchParams();
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const param = params.get("g");
  const genderFilter: Gender | "all" =
    param === "f" ? "F" : param === "m" ? "M" : "all";

  /** `useMeet().entries` (`Record<EntryKey, Entry>`) regrouped by event —
   *  the shape `whyNotEnter`/the counts below already expect. */
  const entriesByEvent = useMemo(() => {
    const grouped: Record<string, Entry[]> = {};
    for (const entry of Object.values(meet.entries)) {
      (grouped[entry.eventId] ??= []).push(entry);
    }
    return grouped;
  }, [meet.entries]);

  const meetEvents = useMemo(() => getSortedEvents(meet), [meet]);

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
    const all = Object.values(meet.athletes);
    return !isAdmin && myRacingTeams.length > 0
      ? all.filter((a) => myRacingTeams.includes(a.teamId))
      : all;
  }, [meet.athletes, isAdmin, myRacingTeams]);

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
    for (const [eventId, ids] of Object.entries(entriesByEvent)) {
      for (const id of ids) keys.add(`${eventId}|${id}`);
    }
    return keys;
  }, [entriesByEvent]);

  const perAthlete = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entries of Object.values(entriesByEvent)) {
      for (const entry of entries)
        counts.set(entry.athleteId, (counts.get(entry.athleteId) ?? 0) + 1);
    }
    return counts;
  }, [entriesByEvent]);

  // A meet can keep lineups to the teams they belong to. Before the racing, a
  // lineup is competitive information; a reader with no stake in the meet has
  // no claim on it, and the results are public either way.
  const mayLook =
    meet.details.entryVisibility === "everyone" ||
    canRecordTime({ meet: meetFacts, userId, coachedTeamIds });
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
      ? (entriesByEvent[event.id] ?? []).filter((event) =>
          rosterIds.has(event.athleteId),
        ).length
      : 0;

  /** What the limit checks read. Assembled once rather than per cell. */
  const entryContext = {
    events: meetEvents,
    entries: entriesByEvent,
    limits: meet.details.limits,
  };

  /** Whose entries this person may change — see `canEnter` on the server. */
  const mayEditFor = (athleteId: string): boolean => {
    const athlete = meet.athletes[athleteId];
    return canEnter({
      meet: meetFacts,
      userId,
      coachedTeamIds,
      athlete: {
        id: athleteId,
        userId: athlete?.userId ?? null,
        teamIds: athlete ? [athlete.teamId] : [],
      },
    });
  };

  /**
   * One tap, one row, submitted. The tick moves immediately —
   * `clientAction` above patches the cache before the request even leaves —
   * and `submit`'s `navigate: false` keeps this a background write rather
   * than a page transition, so tapping ten cells in a row doesn't queue ten
   * history entries.
   */
  const toggle = (
    eventId: string,
    athleteId: string,
    teamId: string,
    entering: boolean,
  ) => {
    const form = new FormData();
    form.set("eventId", eventId);
    form.set("athleteId", athleteId);
    form.set("teamId", teamId);
    form.set("entering", String(entering));
    form.set("enteredBy", userId ?? "");
    submit(form, { method: "post", navigate: false });
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
              to={`/teams/${myRacingTeams[0] ?? loaderData.meet?.hostTeamId ?? meetFacts.teamIds[0] ?? ""}`}
              className="font-semibold text-blue-600 underline"
            >
              Add swimmers
            </Link>
            .
          </>
        ) : races.length === 0 ? (
          <>This meet has no events yet.</>
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
                      {athlete.gender} · {perAthlete.get(athlete.id) ?? 0} ev
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
                            event &&
                            toggle(event.id, athlete.id, athlete.teamId, !isIn)
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
