import { useMemo, useState } from "react";
import type { Route } from "./+types/results-view";
import { Button, Card, EmptyState, SectionTitle } from "~/components/ui";
import { downloadFile, resultsToCsv } from "~/lib/csv";
import { formatTime } from "~/lib/time";
import { requireDb, type SyncEnv } from "~/lib/api.server";
import { getMeet } from "~/lib/meets.server";
import {
  getTeam,
  listSeasons,
  roster as teamRoster,
  seasonForDate,
  type RosterEntry,
} from "~/lib/teams.server";
import { recordedCount, swimTime } from "~/lib/timing";
import {
  eventPoints,
  pointsTable,
  scoreGroupLabel,
  teamTotals,
  type RankedSwim,
  type ScoreGroup,
} from "~/lib/scoring";
import { useMeet } from "./meet-layout";
import { eventName, getSortedEvents } from "~/types/meet";
import type { Meet } from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Results · Swim Starts" }];
}

/** Every racing team's roster, for the season the meet's date falls in —
 *  what the CSV export's "Gender" column and the scoring's team totals
 *  read from. Same shape `entries.tsx`/`splits-heat.tsx` build. */
async function meetRoster(db: D1Database, meet: Meet): Promise<RosterEntry[]> {
  const perTeam = await Promise.all(
    meet.teamIds.map(async (teamId) => {
      const [team, seasons] = await Promise.all([
        getTeam(db, teamId),
        listSeasons(db, teamId),
      ]);
      const season = seasonForDate(seasons, team?.currentSeasonId, meet.date);
      return teamRoster(db, teamId, season?.id);
    }),
  );
  return perTeam.flat();
}

/**
 * `roster`/`enrollments` — D1's, for the one thing `useMeet()`'s
 * `MeetManifest` can't answer once a meet's `results` are archived:
 * `readResultsManifest` empties `athletes`/`teams` on a completed meet on
 * purpose (its own doc comment), so gender, year and squad have to come
 * from D1's season roster instead — the same read regardless of whether
 * the meet is still live or long since closed. Everything else this
 * screen shows — events, swims, the meet's own scoring rules — comes from
 * `useMeet()` in the component below.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const meetId = params.meetId!;
  const meet = await getMeet(db, meetId);
  const rosterEntries = meet ? await meetRoster(db, meet) : [];

  return {
    roster: rosterEntries.map((r) => r.athlete),
    enrollments: rosterEntries.map((r) => r.enrollment),
  };
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
  return row.swim.exhibition ? 1 : 0;
}

/**
 * `seed.athleteName` rather than a roster lookup — it's the name the swim
 * itself was recorded under, which is what a results sheet must never
 * disagree with itself about, and it's the only name a completed meet's
 * archived swims carry at all.
 */
function compareSwims(a: RankedSwim, b: RankedSwim): number {
  const ga = rankGroup(a);
  const gb = rankGroup(b);
  if (ga !== gb) return ga - gb;
  if (ga <= 1) return a.time.timeMs - b.time.timeMs;
  return (a.swim.athleteName ?? "").localeCompare(b.swim.athleteName ?? "");
}

export default function ResultsView({
  loaderData,
  params,
}: Route.ComponentProps) {
  const meet = useMeet();
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const view = params.view === "team-scores" ? "team-scores" : params.view;

  const swims = useMemo(() => Object.values(meet.swims), [meet.swims]);
  const watches = useMemo(() => Object.values(meet.watches), [meet.watches]);
  const events = useMemo(() => getSortedEvents(meet), [meet]);

  // Squad and team-of-record as of this meet's season, not as of today.
  const enrollments = useMemo(
    () => new Map(loaderData.enrollments.map((e) => [e.athleteId, e] as const)),
    [loaderData.enrollments],
  );

  /**
   * A team's display name, for `TeamScores` — grouped by team id, which
   * needs a name from *somewhere* regardless of whether the meet is live
   * (`meet.teams`, this DO's own copy) or long archived (derived from
   * whichever swim last named that team — `Swim.athleteTeam` is exactly
   * the display string a heat sheet already shows, and it's the one thing
   * that survives into `results` forever). `meet.teams` wins when both
   * exist — a full name over a heat-sheet code.
   */
  const teamNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const seed of swims) {
      if (!seed.athleteId || !seed.athleteTeam) continue;
      const teamId = enrollments.get(seed.athleteId)?.teamId;
      if (teamId) map.set(teamId, seed.athleteTeam);
    }
    for (const team of Object.values(meet.teams)) map.set(team.id, team.name);
    return map;
  }, [swims, enrollments, meet.teams]);

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
    for (const seed of swims) {
      const time = swimTime({ swims, watches }, seed);
      if (!time) continue;
      const list = map.get(seed.eventId) ?? [];
      list.push({ swim: seed, time });
      map.set(seed.eventId, list);
    }
    for (const list of map.values()) {
      list.sort(compareSwims);
    }
    return map;
  }, [swims, watches]);

  // Points earned by each ranked swim, aligned index-for-index with `byEvent`
  // so a place and its points can never come from different orderings.
  const pointsByEvent = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const event of events) {
      const ranked = byEvent.get(event.id);
      if (!ranked) continue;
      map.set(
        event.id,
        eventPoints(ranked, pointsTable(event, meet.details.scoring)),
      );
    }
    return map;
  }, [events, byEvent, meet.details.scoring]);

  // Team running totals — grouped by gender only when the scoring rules say
  // the meet is two contests rather than one.
  const totals = useMemo(
    () =>
      teamTotals(
        events,
        byEvent,
        meet.details.scoring,
        (athleteId) => enrollments.get(athleteId)?.teamId,
      ),
    [events, byEvent, meet.details.scoring, enrollments],
  );

  const slug = `${meet.name.replace(/[^\w-]+/g, "-").toLowerCase()}-${meet.details.date}`;

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

  if (recordedCount({ swims, watches }) === 0) {
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
                resultsToCsv(meet, loaderData.roster, enrollments),
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
          {recordedCount({ swims, watches })} time
          {recordedCount({ swims, watches }) === 1 ? "" : "s"} across{" "}
          {byEvent.size} event{byEvent.size === 1 ? "" : "s"}.
        </p>
      </Card>

      {view === "team-scores" ? (
        <TeamScores totals={totals} teamNameById={teamNameById} />
      ) : (
        events.map((event, index) => {
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
                    return results.map(({ swim: seed, time }, index) => {
                      const enrollment = seed.athleteId
                        ? enrollments.get(seed.athleteId)
                        : undefined;
                      const ranked = time.status === "OK" && !seed.exhibition;
                      const shownPlace = ranked ? ++place : null;
                      const pts = points[index] ?? 0;
                      return (
                        <li
                          key={`${seed.heat}:${seed.lane}`}
                          className="flex items-center gap-3 py-2"
                        >
                          <span className="w-6 text-center text-sm font-bold text-slate-400">
                            {shownPlace ?? (seed.exhibition ? "X" : "—")}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold">
                              {seed.athleteName ||
                                (seed.athleteId
                                  ? "(removed)"
                                  : "(no name — lane " + seed.lane + ")")}
                            </span>
                            {/* Team first: in a dual meet the question this
                                screen answers is which school scored, and the lane
                                is only how to find somebody on the deck. */}
                            <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                              {seed.athleteTeam && `${seed.athleteTeam} · `}
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
  totals,
  teamNameById,
}: {
  totals: Map<ScoreGroup, Map<string, number>>;
  teamNameById: Map<string, string>;
}) {
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
              {ranked.map(([teamId, points], place) => (
                <li key={teamId} className="flex items-center gap-3 py-2">
                  <span className="w-6 text-center text-sm font-bold text-slate-400">
                    {place + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-semibold">
                    {teamNameById.get(teamId) ?? "(unknown team)"}
                  </span>
                  <span className="text-lg font-bold tabular-nums">
                    {points}
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        );
      })}
    </>
  );
}
