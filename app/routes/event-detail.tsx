import type { Route } from "./+types/event-detail";
import { Card, EmptyState, SectionTitle } from "~/components/ui";
import { requireDb, type SyncEnv } from "~/lib/api.server";
import { meetDetail } from "~/lib/meets.server";
import { enrollmentIndex } from "~/lib/roster";
import { useMeetLive } from "~/hooks/use-meet-live";
import { heatsOf, swimsForHeat, swimTime } from "~/lib/timing";
import { formatTime } from "~/lib/time";
import { useMeet } from "./meet-layout";
import { displayName, eventName, findAthlete, withLiveTables } from "~/types/meet";

export function meta({ data }: Route.MetaArgs) {
  const event = data?.detail?.events.find((e) => e.id === data.eventId);
  return [{ title: `${event ? eventName(event) : "Event"} · Swim Starts` }];
}

/**
 * One event, public and read-only — declared entries, heat seeds, and
 * current results. Doesn't replace `entries.tsx`'s whole-meet grid, which
 * keeps its own URL and scope.
 *
 * Same whole-meet read as `entries.tsx` for the same reason: nothing here is
 * secret at the row level, so the visibility rule is applied at render time
 * rather than by filtering the query. The four live tables come from the
 * meet's Durable Object rather than D1, same reasoning as admin/splits.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  const db = requireDb(env as SyncEnv);
  const detail = await meetDetail(db, params.meetId);
  if (!detail) return { detail: null, eventId: params.eventId };

  const live = await env.MEET_DO.getByName(params.meetId).getSnapshot(params.meetId);
  return { detail: withLiveTables(detail, live), eventId: params.eventId };
}

export default function EventDetail({ loaderData }: Route.ComponentProps) {
  const loaded = loaderData.detail!;
  const { access } = useMeet();
  // Kept live the same way results-view.tsx is — see its doc comment.
  const live = useMeetLive(loaded.meet.id, loaded);
  const detail = withLiveTables(loaded, live.snapshot);

  const event = detail.events.find((e) => e.id === loaderData.eventId);
  if (!event) {
    return <EmptyState title="No such event">It may have been removed.</EmptyState>;
  }

  const enrollments = enrollmentIndex(detail.enrollments);
  const teamsById = new Map(detail.teams.map((t) => [t.id, t] as const));

  // Same rule as entries.tsx: a lineup is competitive information before the
  // racing, and results are public once they exist regardless of it.
  const mayLook =
    detail.meet.entryVisibility === "everyone" ||
    access.admin ||
    access.coachOf.length > 0;

  const entered = (detail.entries[event.id] ?? [])
    .map((id) => findAthlete(detail.athletes, id))
    .filter((a): a is NonNullable<typeof a> => !!a);

  const heats = heatsOf(detail, event.id);

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>{eventName(event)}</SectionTitle>
      </Card>

      {!mayLook ? (
        <EmptyState title="Entries aren't public for this meet">
          The coaches involved can see their own. Results appear here as they
          happen, whatever this is set to.
        </EmptyState>
      ) : heats.length === 0 ? (
        <Card>
          <SectionTitle>Declared entries ({entered.length})</SectionTitle>
          {entered.length === 0 ? (
            <p className="text-sm text-slate-500">Nobody entered yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {entered.map((athlete) => (
                <li key={athlete.id} className="py-1.5 text-sm">
                  {displayName(athlete)}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        heats.map((heat) => (
          <Card key={heat}>
            <SectionTitle>Heat {heat}</SectionTitle>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-1 pr-2 font-semibold">Lane</th>
                  <th className="py-1 pr-2 font-semibold">Swimmer</th>
                  <th className="py-1 pr-2 font-semibold">Time</th>
                </tr>
              </thead>
              <tbody>
                {swimsForHeat(detail, event.id, heat).map((seed) => {
                  const athlete = findAthlete(detail.athletes, seed.athleteId);
                  const enrollment = enrollments.get(seed.athleteId);
                  const team = enrollment ? teamsById.get(enrollment.teamId) : undefined;
                  const time = swimTime(detail, seed.id);
                  return (
                    <tr key={seed.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-1.5 pr-2 font-bold tabular-nums">{seed.lane}</td>
                      <td className="py-1.5 pr-2">
                        {athlete ? (
                          <>
                            <span className="block font-medium">
                              {displayName(athlete)}
                            </span>
                            {team && (
                              <span className="block text-xs text-slate-500 dark:text-slate-400">
                                {team.code || team.name}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
                        {time
                          ? time.status === "OK"
                            ? formatTime(time.timeMs)
                            : time.status
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        ))
      )}
    </div>
  );
}
