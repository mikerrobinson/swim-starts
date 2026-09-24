import { useMemo, useState } from "react";
import type { Route } from "./+types/results-view";
import { Button, Card, EmptyState, SectionTitle } from "~/components/ui";
import { downloadFile, resultsToCsv } from "~/lib/csv";
import { formatTime } from "~/lib/time";
import { enrollmentIndex } from "~/lib/roster";
import { recordedCount, swimTime } from "~/lib/timing";
import {
  eventPoints,
  pointsTable,
  scoreGroupLabel,
  teamTotals,
  type RankedSwim,
  type ScoreGroup,
} from "~/lib/scoring";
import { useMeetLive } from "~/hooks/use-meet-live";
import {
  eventName,
  athleteName,
  withLiveTables,
  type MeetDetail,
} from "~/types/meet";
import type { Athlete } from "~/types/athlete";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Results · Swim Starts" }];
}

/**
 * One results view, addressed by path segment rather than `?view=`.
 * `by-event` and `team-scores` are what this screen already did (as
 * `results.tsx`, under `?view=` and `?view=scores`); moved here verbatim
 * except for how the view is chosen. `by-swimmer` is a third view
 * `route-design.md`/`gemini-design.md` call for and isn't built yet, so it
 * renders a plain "not built yet" rather than fabricating one nobody has
 * designed.
 */
export async function loader() {
  // Used to assemble a `MeetDetail` from D1's events/entries/swims/watches
  // tables (`meetDetail`) folded with the meet's Durable Object live tables.
  // D1 no longer holds a meet's programme/entries/swims/watches at all —
  // see `meets2.tsx` — and this old-model results view hasn't been ported
  // to read the DO's `MeetManifest` shape instead, so `detail` stays `null`
  // (the component's already-handled "no such meet" state) until it is.
  return { detail: null as MeetDetail | null };
}

/** Girls, then boys, then whatever an Open event's points fell under. */
const GROUP_ORDER: ScoreGroup[] = ["F", "M", "Open", "all"];

/**
 * Four groups, in the order a results sheet reads them: swims that count,
 * fastest first; exhibition swims — real times, but never a place — also
 * fastest first, below every swim that counts; then DQs and no-shows, which
 * have no time to rank by, so sorted by name instead. Not for lack of an
 * order to put them in — it's so the page doesn't reshuffle two of them on
 * every reload.
 */
function rankGroup(row: RankedSwim): 0 | 1 | 2 | 3 {
  if (row.time.status === "DQ") return 2;
  if (row.time.status !== "OK") return 3;
  return row.seed.exhibition ? 1 : 0;
}

function compareSwims(
  a: RankedSwim,
  b: RankedSwim,
  byId: Map<string, Athlete>,
): number {
  const ga = rankGroup(a);
  const gb = rankGroup(b);
  if (ga !== gb) return ga - gb;
  if (ga <= 1) return a.time.timeMs - b.time.timeMs;

  const nameOf = (row: RankedSwim) => {
    const athlete = byId.get(row.seed.athleteId);
    return athlete ? athleteName(athlete) : "";
  };
  return nameOf(a).localeCompare(nameOf(b));
}

export default function ResultsView({
  loaderData,
  params,
}: Route.ComponentProps) {
  if (!loaderData.detail) {
    return (
      <EmptyState title="Not available for this meet">
        Results for this meet haven't moved to the new data model yet.
      </EmptyState>
    );
  }
  const loaded = loaderData.detail;
  // The screen a parent in the stands leaves open. Nothing here is written by
  // this device, so everything on it shows up this way or not at all —
  // the meet's live connection now, rather than a poll.
  const live = useMeetLive(loaded.meet.id, loaded);
  const detail = useMemo(
    () => withLiveTables(loaded, live.snapshot),
    [loaded, live.snapshot],
  );
  const meet = detail.meet;
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const view = params.view === "team-scores" ? "team-scores" : params.view;

  // Names come from the roster, so a spelling fixed later shows up here too.
  const byId = useMemo(
    () => new Map(detail.athletes.map((a) => [a.id, a] as const)),
    [detail.athletes],
  );

  // Squad as it was that season, not as it is now.
  const enrollments = useMemo(
    () => enrollmentIndex(detail.enrollments),
    [detail.enrollments],
  );

  // The racing teams, to turn a swimmer's enrollment into a name. Read from
  // the enrollment rather than from the athlete, because a person belongs to
  // no team — they were enrolled by one, for this meet's season. A swimmer who
  // changes school in March still reads here as whoever they raced for.
  const teamsById = useMemo(
    () => new Map(detail.teams.map((team) => [team.id, team] as const)),
    [detail.teams],
  );

  /**
   * Every swim that has a time, grouped by event and ranked across all heats.
   *
   * Ranking ignores heat: a slower heat can hold the fastest swim, and the
   * printed sheet has always been ordered by time rather than by when it was
   * swum. A seed with nothing against it is somebody whose time never arrived,
   * which is a hole rather than a blank line to publish.
   */
  const byEvent = useMemo(() => {
    const map = new Map<string, RankedSwim[]>();
    for (const seed of detail.swims) {
      const time = swimTime(detail, seed.id);
      if (!time) continue;
      const list = map.get(seed.eventId) ?? [];
      list.push({ seed, time });
      map.set(seed.eventId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => compareSwims(a, b, byId));
    }
    return map;
  }, [detail, byId]);

  // Points earned by each ranked swim, aligned index-for-index with `byEvent`
  // so a place and its points can never come from different orderings.
  const pointsByEvent = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const event of detail.events) {
      const ranked = byEvent.get(event.id);
      if (!ranked) continue;
      map.set(event.id, eventPoints(ranked, pointsTable(event, meet.scoring)));
    }
    return map;
  }, [detail.events, byEvent, meet.scoring]);

  // Team running totals — grouped by gender only when the scoring rules say
  // the meet is two contests rather than one.
  const totals = useMemo(
    () =>
      teamTotals(
        detail.events,
        byEvent,
        meet.scoring,
        (athleteId) => enrollments.get(athleteId)?.teamId,
      ),
    [detail.events, byEvent, meet.scoring, enrollments],
  );

  const slug = `${meet.name.replace(/[^\w-]+/g, "-").toLowerCase()}-${meet.date}`;

  if (view !== "by-event" && view !== "team-scores") {
    return (
      <EmptyState title="Not built yet">
        This results view isn&rsquo;t ready. Try{" "}
        <a
          href={`/meets/${meet.id}/results/by-event`}
          className="font-semibold text-blue-600 underline"
        >
          by event
        </a>{" "}
        or{" "}
        <a
          href={`/meets/${meet.id}/results/team-scores`}
          className="font-semibold text-blue-600 underline"
        >
          team scores
        </a>
        .
      </EmptyState>
    );
  }

  if (recordedCount(detail) === 0) {
    return (
      <EmptyState title="No times recorded yet">
        Times show up here as you run heats.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Export</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="primary"
            size="lg"
            onClick={() =>
              downloadFile(
                `${slug}-results.csv`,
                resultsToCsv(detail, enrollments),
                "text/csv",
              )
            }
          >
            Results CSV
          </Button>
          <Button
            size="lg"
            onClick={() =>
              downloadFile(
                `${slug}.json`,
                JSON.stringify(meet, null, 2),
                "application/json",
              )
            }
          >
            Meet JSON
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {recordedCount(detail)} time{recordedCount(detail) === 1 ? "" : "s"}{" "}
          across {byEvent.size} event{byEvent.size === 1 ? "" : "s"}.
        </p>
      </Card>

      {view === "team-scores" ? (
        <TeamScores detail={detail} totals={totals} />
      ) : (
        detail.events.map((event, index) => {
          const results = byEvent.get(event.id) ?? [];
          if (results.length === 0) return null;
          const points = pointsByEvent.get(event.id) ?? [];
          const open = openEvent === event.id;

          return (
            <Card key={event.id}>
              <button
                type="button"
                className="flex w-full touch-manipulation items-center justify-between gap-2 text-left"
                onClick={() => setOpenEvent(open ? null : event.id)}
                aria-expanded={open}
              >
                <span>
                  <span className="block text-lg font-bold">
                    {index + 1}. {eventName(event)}
                  </span>
                  <span className="block text-sm text-slate-500 dark:text-slate-400">
                    {results.length} time{results.length === 1 ? "" : "s"}
                  </span>
                </span>
                <span aria-hidden className="text-xl text-slate-400">
                  {open ? "▾" : "▸"}
                </span>
              </button>

              {open && (
                <ol className="mt-3 divide-y divide-slate-200 dark:divide-slate-800">
                  {(() => {
                    // A running count of real places, separate from the row's
                    // index — an exhibition swim sits in the list at the time
                    // it earned, but it doesn't take a place from the swim
                    // behind it, the same rule `eventPoints` scores by.
                    let place = 0;
                    return results.map(({ seed, time }, index) => {
                      const athlete = byId.get(seed.athleteId);
                      const enrollment = enrollments.get(seed.athleteId);
                      const team = enrollment
                        ? teamsById.get(enrollment.teamId)
                        : undefined;
                      const ranked = time.status === "OK" && !seed.exhibition;
                      const shownPlace = ranked ? ++place : null;
                      const pts = points[index] ?? 0;
                      return (
                        <li
                          key={seed.id}
                          className="flex items-center gap-3 py-2"
                        >
                          <span className="w-6 text-center text-sm font-bold text-slate-400">
                            {shownPlace ?? (seed.exhibition ? "X" : "—")}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold">
                              {athlete
                                ? athleteName(athlete)
                                : seed.athleteId
                                  ? "(removed)"
                                  : "(no name — lane " + seed.lane + ")"}
                            </span>
                            {/* Team first: in a dual meet the question this
                                screen answers is which school scored, and the lane
                                is only how to find somebody on the deck. The code
                                where there is one — "CACTUS" scans down a column
                                in a way "Cactus Shadows" does not. */}
                            <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                              {team && `${team.code || team.name} · `}
                              Lane {seed.lane}
                              {enrollment?.squad && ` · ${enrollment.squad}`}
                              {seed.exhibition && " · exhibition"}
                            </span>
                          </span>
                          <span className="text-right">
                            <span className="block text-lg font-bold tabular-nums">
                              {time.status === "OK"
                                ? formatTime(time.timeMs)
                                : time.status}
                            </span>
                            {pts > 0 && (
                              <span className="block text-xs font-semibold text-blue-600 dark:text-blue-400">
                                {pts} pt{pts === 1 ? "" : "s"}
                              </span>
                            )}
                          </span>
                        </li>
                      );
                    });
                  })()}
                </ol>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}

/**
 * Point totals per team, grouped the way the meet's scoring rules say — one
 * contest, or girls and boys apart.
 */
function TeamScores({
  detail,
  totals,
}: {
  detail: MeetDetail;
  totals: Map<ScoreGroup, Map<string, number>>;
}) {
  const teamsById = new Map(
    detail.teams.map((team) => [team.id, team] as const),
  );
  const groups = GROUP_ORDER.filter(
    (group) => (totals.get(group)?.size ?? 0) > 0,
  );

  if (groups.length === 0) {
    return (
      <EmptyState title="No points scored yet">
        Points show up here as events go official.
      </EmptyState>
    );
  }

  return (
    <>
      {groups.map((group) => {
        const groupTotals = totals.get(group)!;
        const ranked = [...groupTotals.entries()].sort((a, b) => b[1] - a[1]);
        return (
          <Card key={group}>
            <SectionTitle>{scoreGroupLabel(group)}</SectionTitle>
            <ol className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">
              {ranked.map(([teamId, points], place) => {
                const team = teamsById.get(teamId);
                return (
                  <li key={teamId} className="flex items-center gap-3 py-2">
                    <span className="w-6 text-center text-sm font-bold text-slate-400">
                      {place + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-semibold">
                      {team ? team.name : "(unknown team)"}
                    </span>
                    <span className="text-lg font-bold tabular-nums">
                      {points}
                    </span>
                  </li>
                );
              })}
            </ol>
          </Card>
        );
      })}
    </>
  );
}
