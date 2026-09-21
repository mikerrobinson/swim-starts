import { useMemo, useState } from "react";
import { Button, TextInput } from "./ui";
import type { Athlete, Gender } from "~/types/athlete";
import {
  newVisitingAthlete,
  type QueuedAthlete,
  type TimerAthlete,
  type TimerTeam,
} from "~/lib/timer";

/**
 * "Who's actually in this lane?", answered by someone who is cold, distracted,
 * and holding a stopwatch.
 *
 * Full screen, big rows, one job. The ordering does the work so that the right
 * answer is usually the first thing on the list and nobody has to scroll:
 *
 *   1. The same team as whoever is meant to be here, swimming this event.
 *      This is the common case by a distance — two kids in the wrong lanes.
 *   2. The rest of that team. Covers a coach's last-minute entry, and at a
 *      dual meet lanes are usually split by team, so the team is the strong
 *      signal about who's in front of you.
 *   3. Everyone else at the meet.
 *
 * Filtering searches all three at once, because a timer who knows the name
 * shouldn't have to care which group it's in.
 */

interface Group {
  label: string;
  athletes: TimerAthlete[];
}

function fullName(athlete: TimerAthlete): string {
  return `${athlete.firstName} ${athlete.lastName}`.trim();
}

function byName(a: TimerAthlete, b: TimerAthlete): number {
  return (
    a.lastName.localeCompare(b.lastName) ||
    a.firstName.localeCompare(b.firstName)
  );
}

export function SwimmerPicker({
  athletes,
  /** Athlete ids entered in the event being timed. */
  inEvent,
  /** Who the lineup says is here — the team we lead with. */
  current,
  ownTeam,
  meetTeams,
  eventGender,
  onPick,
  onAdd,
  onClose,
}: {
  athletes: TimerAthlete[];
  inEvent: Set<string>;
  current?: TimerAthlete;
  /** Label used for athletes with no team of their own. */
  ownTeam: string;
  meetTeams: TimerTeam[];
  eventGender: Gender;
  onPick: (athlete: TimerAthlete) => void;
  onAdd: (athlete: QueuedAthlete) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTeam, setNewTeam] = useState(meetTeams[0]?.id ?? "");

  const teamOf = (athlete: TimerAthlete) => athlete.team ?? ownTeam;
  const homeTeam = current ? teamOf(current) : ownTeam;

  const groups = useMemo<Group[]>(() => {
    const needle = filter.trim().toLowerCase();
    const matches = (athlete: TimerAthlete) =>
      !needle || fullName(athlete).toLowerCase().includes(needle);

    const sameTeam = athletes.filter(
      (a) => teamOf(a) === homeTeam && matches(a),
    );
    const here = sameTeam.filter((a) => inEvent.has(a.id)).sort(byName);
    const rest = sameTeam.filter((a) => !inEvent.has(a.id)).sort(byName);

    const others = new Map<string, TimerAthlete[]>();
    for (const athlete of athletes) {
      const team = teamOf(athlete);
      if (team === homeTeam || !matches(athlete)) continue;
      const list = others.get(team);
      if (list) list.push(athlete);
      else others.set(team, [athlete]);
    }

    return [
      { label: `${homeTeam} · in this event`, athletes: here },
      { label: `${homeTeam} · rest of the roster`, athletes: rest },
      ...[...others.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([team, list]) => ({ label: team, athletes: list.sort(byName) })),
    ].filter((group) => group.athletes.length > 0);
  }, [athletes, filter, homeTeam, inEvent]);

  const confirmAdd = () => {
    if (!newName.trim()) return;
    // Gender comes from the event, never from a question. A timer being asked
    // to classify a stranger mid-heat is a timer not watching the water.
    onAdd(newVisitingAthlete(newName, newTeam, eventGender));
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
              Team
            </span>
            {/* Only the teams actually racing. A team that isn't in this
                meet can't be given a roster entry by a timer's grant, so
                offering one would quietly produce a swimmer on nobody's
                roster — the exact outcome the free-text field used to have. */}
            <div className="grid grid-cols-2 gap-2">
              {meetTeams.map((team) => (
                <TeamButton
                  key={team.id}
                  label={team.name}
                  active={newTeam === team.id}
                  onClick={() => setNewTeam(team.id)}
                />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="primary"
              size="lg"
              disabled={!newName.trim() || !newTeam}
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
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            {groups.map((group) => (
              <div key={group.label} className="mb-4">
                <h3 className="sticky top-0 bg-white py-1 text-xs font-bold uppercase tracking-wide text-slate-500 dark:bg-slate-950 dark:text-slate-400">
                  {group.label}
                </h3>
                <ul>
                  {group.athletes.map((athlete) => (
                    <li key={athlete.id}>
                      <button
                        type="button"
                        onClick={() => onPick(athlete)}
                        className={`flex min-h-14 w-full touch-manipulation items-center justify-between gap-3 border-b border-slate-100 px-1 text-left text-lg dark:border-slate-900 ${
                          athlete.id === current?.id
                            ? "font-bold text-blue-600"
                            : ""
                        }`}
                      >
                        <span className="truncate">{fullName(athlete)}</span>
                        {athlete.id === current?.id && (
                          <span aria-hidden>✓</span>
                        )}
                      </button>
                    </li>
                  ))}
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

function TeamButton({
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
