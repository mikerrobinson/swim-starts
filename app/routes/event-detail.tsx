import { useMemo } from "react";
import type { Route } from "./+types/event-detail";
import { Card, EmptyState, SectionTitle } from "~/components/ui";
import { currentUser, requireDb, type SyncEnv } from "~/lib/api.server";
import { canRecordTime, type MeetFacts } from "~/lib/access";
import { teamsCoachedBy } from "~/lib/coaches.server";
import { getMeet } from "~/lib/meets.server";
import { heatsOf, swimsForHeat } from "~/lib/timing";
import { formatTime } from "~/lib/time";
import { useMeet } from "./meet-layout";
import { useViewPrefs } from "~/state/view-prefs";
import { displayName, eventName } from "~/types/meet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Event · Swim Starts" }];
}

/** What `canRecordTime` falls back to when the meet's own D1 row is
 *  somehow missing — nobody may see a lineup for a meet that isn't there. */
const EMPTY_MEET_FACTS: MeetFacts = {
  adminIds: [],
  teamIds: [],
  athletesMayEnter: false,
};

/**
 * `userId`/`coachedTeamIds` and the meet's own D1 facts — the same shape
 * `entries.tsx` resolves, for the same reason: `canRecordTime` needs a
 * `userId` plus every team this person coaches to decide whether a lineup
 * that isn't public yet is theirs to see. Everything else this screen
 * shows — events, entries, swims — comes from `useMeet()`'s `MeetManifest`
 * in the component below, kept live by `meet-layout.tsx`'s one shared socket
 * rather than this route's own `useMeetLive` the way it used to be.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const meetId = params.meetId!;
  const rawUser = await currentUser(request, env);
  const userId = rawUser?.id ?? null;

  const [meet, coachedTeamIds] = await Promise.all([
    getMeet(db, meetId),
    userId ? teamsCoachedBy(db, userId) : Promise.resolve([]),
  ]);

  return { meet, userId, coachedTeamIds, eventId: params.eventId! };
}

/**
 * One event, public and read-only — declared entries, heat seeds, and the
 * time each lane has been decided at. Doesn't replace `entries.tsx`'s
 * whole-meet grid, which keeps its own URL and scope.
 *
 * Only the decided time shows, never a proposed one still waiting on a
 * watch to be accepted — `laneTime`/`currentWatches` (`timing.ts`) answer
 * that question by a swim's old synthetic id, which doesn't exist any
 * more, and a public results page showing a number nobody's signed off on
 * yet would be the wrong thing to fix that towards anyway.
 */
export default function EventDetail({ loaderData }: Route.ComponentProps) {
  const meet = useMeet();
  const {
    viewPrefs: { nameOrder },
  } = useViewPrefs();
  const meetFacts = loaderData.meet ?? EMPTY_MEET_FACTS;

  const event = meet.events[loaderData.eventId];

  const entered = useMemo(
    () =>
      Object.values(meet.entries)
        .filter((e) => e.eventId === loaderData.eventId)
        .map((e) => meet.athletes[e.athleteId])
        .filter((a): a is NonNullable<typeof a> => !!a),
    [meet.entries, meet.athletes, loaderData.eventId],
  );

  if (!event) {
    return (
      <EmptyState title="No such event">It may have been removed.</EmptyState>
    );
  }

  // Same rule as entries.tsx: a lineup is competitive information before the
  // racing, and results are public once they exist regardless of it.
  const mayLook =
    meet.details.entryVisibility === "everyone" ||
    canRecordTime({
      meet: meetFacts,
      userId: loaderData.userId,
      coachedTeamIds: loaderData.coachedTeamIds,
    });

  const swims = Object.values(meet.swims);
  const heats = heatsOf({ swims }, event.id);

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
                  {displayName(athlete, nameOrder)}
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
                {swimsForHeat({ swims }, event.id, heat).map((seed) => {
                  const athlete = seed.athleteId
                    ? meet.athletes[seed.athleteId]
                    : undefined;
                  return (
                    <tr
                      key={`${seed.heat}:${seed.lane}`}
                      className="border-t border-slate-100 dark:border-slate-800"
                    >
                      <td className="py-1.5 pr-2 font-bold tabular-nums">
                        {seed.lane}
                      </td>
                      <td className="py-1.5 pr-2">
                        {athlete ? (
                          <>
                            <span className="block font-medium">
                              {displayName(athlete, nameOrder)}
                            </span>
                            {seed.athleteTeam && (
                              <span className="block text-xs text-slate-500 dark:text-slate-400">
                                {seed.athleteTeam}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
                        {seed.status
                          ? seed.status === "OK"
                            ? formatTime(seed.officialTimeMs ?? 0)
                            : seed.status
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
