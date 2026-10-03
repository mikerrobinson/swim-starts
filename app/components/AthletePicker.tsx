import { useMemo, useState } from "react";
import { Button, TextInput } from "./ui";
import { splitTypedName } from "~/lib/names";
import { swimsForEvent, swimTime } from "~/lib/timing";
import { isEligible, type MeetAthlete, type MeetManifest } from "~/types/meet";
import type { Gender } from "~/types/athlete";

export function AthletePicker({
  meet,
  eventId,
  heat,
  lane,
  current,
  onPick,
  onAddWalkup,
  onClose,
}: {
  meet: MeetManifest;
  eventId: string;
  /** This lane's own heat number — so the swim already sitting here, if any,
   *  never shows up as "elsewhere" or "already swum" against itself. */
  heat: number;
  lane: number;
  current?: MeetAthlete;
  onPick: (athleteId: string) => void;
  onAddWalkup: (walkup: {
    firstName: string;
    lastName: string;
    gender: Gender;
    athleteTeam: string;
  }) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");

  const event = meet.events[eventId];
  const meetTeams = useMemo(() => Object.values(meet.teams), [meet.teams]);

  /** Whichever team the meet's lane split says this lane belongs to, for an
   *  empty lane with no swimmer of its own yet to take a home team from. */
  const laneTeamId = useMemo(() => {
    for (const [teamId, lanes] of Object.entries(
      meet.details.laneAssignments ?? {},
    )) {
      if (lanes.includes(lane)) return teamId;
    }
    return undefined;
  }, [meet.details.laneAssignments, lane]);

  const homeTeamId = current?.teamId ?? laneTeamId;

  const [newTeamId, setNewTeamId] = useState(
    homeTeamId ?? meetTeams[0]?.id ?? "",
  );
  const defaultGender: Gender = event?.gender === "M" ? "M" : "F";
  const [newGender, setNewGender] = useState<Gender>(defaultGender);

  const teamLabel = (teamId: string) =>
    meet.teams[teamId]?.code || meet.teams[teamId]?.name || "";

  /** Where everyone else in this event already sits, and who's already swum
   *  it — both excluding this exact lane, so the swimmer already here never
   *  shows up as a warning about themselves. */
  const { seatedAt, swum } = useMemo(() => {
    const swims = Object.values(meet.swims);
    const watches = Object.values(meet.watches);
    const elsewhere = swimsForEvent({ swims }, eventId).filter(
      (seed) => !(seed.heat === heat && seed.lane === lane),
    );
    const seatedAt = new Map<string, { heat: number; lane: number }>();
    for (const seed of elsewhere) {
      if (seed.athleteId) {
        seatedAt.set(seed.athleteId, { heat: seed.heat, lane: seed.lane });
      }
    }
    const swum = new Set(
      elsewhere
        .filter((seed) => swimTime({ swims, watches }, seed) !== null)
        .map((seed) => seed.athleteId)
        .filter((id): id is string => !!id),
    );
    return { seatedAt, swum };
  }, [meet.swims, meet.watches, eventId, heat, lane]);

  const inEvent = useMemo(
    () =>
      new Set(
        Object.values(meet.entries)
          .filter((e) => e.eventId === eventId)
          .map((e) => e.athleteId),
      ),
    [meet.entries, eventId],
  );

  const groups = useMemo(() => {
    const roster = Object.values(meet.athletes).filter(
      (a) => !event || isEligible(a, event),
    );
    const needle = filter.trim().toLowerCase();
    const matches = (athlete: MeetAthlete) =>
      !needle || fullName(athlete).toLowerCase().includes(needle);

    const sameTeam = roster.filter(
      (a) => a.teamId === homeTeamId && matches(a),
    );
    const here = sameTeam.filter((a) => inEvent.has(a.id)).sort(byName);
    const rest = sameTeam.filter((a) => !inEvent.has(a.id)).sort(byName);

    const others = new Map<string, MeetAthlete[]>();
    for (const athlete of roster) {
      if (athlete.teamId === homeTeamId || !matches(athlete)) continue;
      const list = others.get(athlete.teamId);
      if (list) list.push(athlete);
      else others.set(athlete.teamId, [athlete]);
    }

    const homeLabel = homeTeamId ? teamLabel(homeTeamId) : "";
    return [
      { label: homeLabel && `${homeLabel} · in this event`, athletes: here },
      {
        label: homeLabel && `${homeLabel} · rest of the roster`,
        athletes: rest,
      },
      ...[...others.entries()]
        .sort(([a], [b]) => teamLabel(a).localeCompare(teamLabel(b)))
        .map(([teamId, list]) => ({
          label: teamLabel(teamId),
          athletes: list.sort(byName),
        })),
    ].filter((group) => group.athletes.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meet.athletes, meet.teams, event, filter, homeTeamId, inEvent]);

  const confirmAdd = () => {
    if (!newName.trim() || !newTeamId) return;
    const { firstName, lastName } = splitTypedName(newName);
    onAddWalkup({
      firstName,
      lastName,
      gender: newGender,
      athleteTeam: teamLabel(newTeamId),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-slate-950">
      <div className="flex items-center gap-3 border-b border-slate-200 p-4 pt-[max(1rem,env(safe-area-inset-top))] dark:border-slate-800">
        <h2 className="flex-1 text-lg font-bold">Who&rsquo;s in this lane?</h2>
        <Button variant="ghost" onClick={onClose} aria-label="Close">
          ✕
        </Button>
      </div>

      {adding ? (
        <div className="space-y-4 p-4">
          <div>
            <span className="mb-1 block text-sm font-semibold text-slate-600 dark:text-slate-300">
              Name
            </span>
            <TextInput
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Dana Reyes"
              autoCapitalize="words"
              autoFocus
            />
          </div>
          <div>
            <span className="mb-1 block text-sm font-semibold text-slate-600 dark:text-slate-300">
              Sex
            </span>
            <div className="grid grid-cols-2 gap-2">
              {(["F", "M"] as Gender[]).map((value) => (
                <ChoiceButton
                  key={value}
                  label={value === "F" ? "Girls" : "Boys"}
                  active={newGender === value}
                  onClick={() => setNewGender(value)}
                />
              ))}
            </div>
          </div>
          <div>
            <span className="mb-1 block text-sm font-semibold text-slate-600 dark:text-slate-300">
              Team
            </span>
            {/* Only the teams actually racing — a swimmer from anyone else
                has nowhere real for this swim to say they're from. */}
            <div className="grid grid-cols-2 gap-2">
              {meetTeams.map((team) => (
                <ChoiceButton
                  key={team.id}
                  label={team.name}
                  active={newTeamId === team.id}
                  onClick={() => setNewTeamId(team.id)}
                />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="primary"
              size="lg"
              disabled={!newName.trim() || !newTeamId}
              onClick={confirmAdd}
            >
              Add
            </Button>
            <Button size="lg" onClick={() => setAdding(false)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="p-4 pb-2">
            <TextInput
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Type to filter…"
              autoCapitalize="off"
              autoCorrect="off"
              autoFocus
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            {groups.map((group) => (
              <div key={group.label} className="mb-4">
                <h3 className="sticky top-0 bg-white py-1 text-xs font-bold uppercase tracking-wide text-slate-500 dark:bg-slate-950 dark:text-slate-400">
                  {group.label}
                </h3>
                <ul>
                  {group.athletes.map((athlete) => {
                    const elsewhere = seatedAt.get(athlete.id);
                    const done = swum.has(athlete.id);
                    return (
                      <li key={athlete.id}>
                        <button
                          type="button"
                          disabled={done}
                          onClick={() => onPick(athlete.id)}
                          className={`flex min-h-14 w-full touch-manipulation items-center justify-between gap-3 border-b border-slate-100 px-1 text-left text-lg disabled:opacity-40 dark:border-slate-900 ${
                            athlete.id === current?.id
                              ? "font-bold text-blue-600"
                              : ""
                          }`}
                        >
                          <span className="truncate">{fullName(athlete)}</span>
                          {athlete.id === current?.id ? (
                            <span aria-hidden className="shrink-0">
                              ✓
                            </span>
                          ) : done ? (
                            <span className="shrink-0 rounded-full bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                              already swam
                            </span>
                          ) : elsewhere ? (
                            <span className="shrink-0 rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                              move from H{elsewhere.heat} L{elsewhere.lane}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {groups.length === 0 && (
              <p className="py-8 text-center text-slate-500">
                Nobody matches &ldquo;{filter}&rdquo;.
              </p>
            )}
          </div>

          <div className="border-t border-slate-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] dark:border-slate-800">
            <Button size="lg" full onClick={() => setAdding(true)}>
              + Someone not listed
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function fullName(athlete: MeetAthlete): string {
  return `${athlete.firstName} ${athlete.lastName}`.trim();
}

function byName(a: MeetAthlete, b: MeetAthlete): number {
  return (
    a.lastName.localeCompare(b.lastName) ||
    a.firstName.localeCompare(b.firstName)
  );
}

function ChoiceButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-14 touch-manipulation rounded-xl border-2 text-lg font-bold transition-colors ${
        active
          ? "border-blue-600 bg-blue-600 text-white"
          : "border-slate-300 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
      }`}
    >
      {label}
    </button>
  );
}
