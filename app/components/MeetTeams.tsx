import { useState } from "react";
import { Banner, Button, Card, SectionTitle } from "./ui";
import { TeamPicker } from "./TeamPicker";
import type { Team } from "~/types/team";

/**
 * Who's racing.
 *
 * This is the field that replaced a comma-separated list of team names, and
 * the difference is the whole point of the model change: a team here is a
 * reference, so both schools open the same meet, a visiting swimmer belongs to
 * a real roster, and "Horizon", "horizon" and "Horzion" can't become three
 * different opponents.
 *
 * `teams` and `hostTeamId` come from the loader's own D1 read
 * (`meet-info.tsx`) rather than the meet's `MeetManifest` — "who's racing" is
 * a `meet_teams` join, not a Durable-Object-owned setting.
 */
export function MeetTeams({
  teams,
  hostTeamId,
  canEdit,
  coachOf,
  saving,
  onChange,
}: {
  teams: Team[];
  hostTeamId: string;
  /** Whether to draw the editing controls at all. The server re-checks. */
  canEdit: boolean;
  /** Racing teams this person coaches — labelled, so their own is obvious. */
  coachOf: string[];
  saving: boolean;
  /** The complete resulting list, which is what `updateMeet` writes. */
  onChange: (next: { teamIds: string[]; hostTeamId: string }) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const teamIds = teams.map((team) => team.id);

  const add = (teamId: string) => {
    if (teamIds.includes(teamId)) return;
    onChange({
      teamIds: [...teamIds, teamId],
      // The first team on a meet is very likely the pool it's swum in.
      hostTeamId: hostTeamId || teamId,
    });
    setAdding(false);
  };

  const remove = (teamId: string) => {
    onChange({
      teamIds: teamIds.filter((id) => id !== teamId),
      // A team that isn't racing isn't the host.
      hostTeamId: hostTeamId === teamId ? "" : hostTeamId,
    });
    setConfirming(null);
  };

  const setHost = (teamId: string) => {
    onChange({
      teamIds,
      hostTeamId: hostTeamId === teamId ? "" : teamId,
    });
  };

  return (
    <Card>
      <SectionTitle
        action={
          canEdit && !adding ? (
            <Button size="sm" onClick={() => setAdding(true)} disabled={saving}>
              + Team
            </Button>
          ) : undefined
        }
      >
        Teams racing
      </SectionTitle>

      {teams.length === 0 ? (
        <p className="py-2 text-sm text-slate-500">
          Nobody yet.{" "}
          {canEdit
            ? "A meet needs at least one team before anybody can be entered."
            : "Whoever runs this meet hasn't said who's racing."}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {teams.map((team) => {
            const host = hostTeamId === team.id;
            return (
              <li key={team.id} className="py-2.5">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {team.name}&nbsp;({team.code})
                      {canEdit ? (
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => setHost(team.id)}
                          className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200"
                        >
                          {host ? "Host" : "Set as host"}
                        </button>
                      ) : (
                        host && (
                          <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                            Host pool
                          </span>
                        )
                      )}
                    </span>
                  </span>

                  {canEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={saving}
                      onClick={() => setConfirming(team.id)}
                    >
                      Remove
                    </Button>
                  )}
                </div>

                {confirming === team.id && (
                  <div className="mt-2 space-y-2">
                    <Banner tone="warn">
                      Remove {team.name} from this meet? Anyone already
                      entered for them stays in the meet with nobody to show
                      them against.
                    </Banner>
                    <div className="grid grid-cols-2 gap-2">
                      <Button onClick={() => setConfirming(null)}>Keep</Button>
                      <Button variant="danger" onClick={() => remove(team.id)}>
                        Remove anyway
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {adding && (
        <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-800">
          <TeamPicker
            exclude={teamIds}
            onPick={(team) => add(team.id)}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}
    </Card>
  );
}
