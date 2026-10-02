import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { Banner, Button, Field, TextInput } from "./ui";
import { Modal } from "./Modal";
import { exactTeam, rankTeams } from "~/lib/team-search";
import type { PublicTeam } from "~/lib/public";

/**
 * Picking the school you're racing, and minting it if it isn't there yet.
 *
 * One box does both, because from the coach's side they are one question —
 * "who are we swimming?" — and which of the two it turns out to be is the
 * app's problem, not theirs. What's typed searches first and only offers to
 * create once nothing matches it, so the path of least effort leads to the
 * team that already exists. That ordering is the whole design: two rows for
 * the same school is the failure the reference model was built to prevent,
 * and a picker that made creating easier than finding would reintroduce it
 * one meet at a time.
 *
 * Used by both the new-meet sheet and the meet's own page, which ask the same
 * question at different moments and should not answer it two different ways.
 */
export function TeamPicker({
  exclude,
  onPick,
  onCancel,
}: {
  /** Teams already racing. Listed above this box, so not offered again. */
  exclude: string[];
  onPick: (team: PublicTeam) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  /** Teams minted here, so the list needn't be re-fetched to show them. */
  const [minted, setMinted] = useState<PublicTeam[]>([]);

  /**
   * The list, which is one of the two things left with a URL of its own.
   *
   * A search box against every team on the server has to be able to ask
   * without a page behind it — and this sheet renders inside three different
   * screens, none of which is about teams.
   */
  const list = useFetcher<{ teams: PublicTeam[] }>();
  useEffect(() => {
    list.load("/api/teams");
    // Loading once on mount is the whole body; the fetcher is rebuilt each
    // render and is not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loaded = list.data?.teams ?? null;
  const known = loaded && [
    ...loaded,
    ...minted.filter((t) => !loaded.some((k) => k.id === t.id)),
  ];
  const teams = known ?? [];
  const candidates = useMemo(
    () => rankTeams(teams, query, exclude),
    [teams, query, exclude],
  );
  // Against every known team, not just the ones on offer: a name already
  // racing isn't a team that needs creating either.
  const already = exactTeam(teams, query);
  const typed = query.trim();

  /** Adopt what the server handed back, so the list needn't be re-fetched. */
  const adopt = (team: PublicTeam) => {
    setMinted((current) =>
      current.some((t) => t.id === team.id) ? current : [...current, team],
    );
    setCreating(false);
    onPick(team);
  };

  return (
    <div className="space-y-2">
      {list.state === "idle" && !loaded && (
        <Banner tone="warn">
          Couldn&rsquo;t load the list of teams. You can still create one.
        </Banner>
      )}

      <TextInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search for a school…"
        aria-label="Search for a team"
        autoCapitalize="words"
        autoFocus
      />

      {known === null && list.state !== "idle" ? (
        <p className="py-2 text-sm text-slate-500">Loading teams…</p>
      ) : (
        <ul className="max-h-56 overflow-y-auto">
          {candidates.map((team) => (
            <li key={team.id}>
              <button
                type="button"
                onClick={() => onPick(team)}
                className="flex min-h-12 w-full touch-manipulation items-center justify-between gap-2 border-b border-slate-100 py-2 text-left dark:border-slate-800"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {team.name}
                    {team.code && (
                      <span className="ml-2 text-xs font-normal text-slate-500">
                        {team.code}
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {team.athletes} athlete{team.athletes === 1 ? "" : "s"}
                    {!team.claimed && " · unclaimed"}
                  </span>
                </span>
                <span aria-hidden className="text-lg text-slate-400">
                  +
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The way out when the school genuinely isn't in there.
          
          Never offered when what was typed already *is* a team, and demoted to
          a quiet link whenever anything matched at all. Somebody three letters
          into "Horizon" is looking at the row they want; a full-width button
          under it reading Create "hor" competes with that row, and the whole
          cost of losing is a second Horizon nobody notices until two schools
          are pointing at different rosters. It stays reachable because a
          genuinely new school can share a prefix with an old one — it just
          stops being the loudest thing on screen. */}
      {typed !== "" &&
        !already &&
        (candidates.length === 0 ? (
          <Button full onClick={() => setCreating(true)}>
            Create “{typed}”
          </Button>
        ) : (
          <p className="pt-1 text-xs text-slate-500">
            Not one of these?{" "}
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="font-semibold text-blue-600 underline"
            >
              Create “{typed}”
            </button>
          </p>
        ))}

      {typed !== "" && already && !exclude.includes(already.id) && (
        <p className="text-xs text-slate-500">
          {already.name} is already on the app — tap it above.
        </p>
      )}
      {typed !== "" && already && exclude.includes(already.id) && (
        <p className="text-xs text-slate-500">
          {already.name} is already racing this meet.
        </p>
      )}

      {candidates.length === 0 && typed === "" && known !== null && (
        <p className="py-2 text-sm text-slate-500">
          No other teams yet. Type a school's name to add one.
        </p>
      )}

      <Button variant="ghost" full onClick={onCancel}>
        Cancel
      </Button>

      {creating && (
        <NewTeamSheet
          name={typed}
          onCreated={adopt}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

/**
 * Minting a school that has never used the app.
 *
 * A name, and an abbreviation if you have one. Nothing else is asked for
 * because nothing else is needed to race them: the team is created
 * *unclaimed*, and a coach from that school fills in the rest when they sign
 * in and claim it. Demanding a roster here would make setting up Tuesday's
 * meet wait on a school that hasn't heard of the app.
 */
function NewTeamSheet({
  name,
  onCreated,
  onClose,
}: {
  name: string;
  onCreated: (team: PublicTeam) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(name);
  const [code, setCode] = useState("");

  /**
   * Submitted to whichever screen this is open on.
   *
   * The new-meet sheet and a meet's own page both host the picker, and both
   * already have an action guarding who may change that meet — so the check
   * that matters is the one already there, and creating a team needs no
   * endpoint of its own to re-derive it.
   */
  const fetcher = useFetcher<{
    ok?: boolean;
    error?: string;
    team?: PublicTeam;
  }>();
  const busy = fetcher.state !== "idle";
  const error = fetcher.data?.error ?? null;

  // The answer carries the team, whether it was just made or already existed —
  // so racing somebody twice can't mint a duplicate even from here.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.team) {
      onCreated(fetcher.data.team);
    }
    // The callback is rebuilt each render; the answer is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const save = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    fetcher.submit(
      { intent: "new-team", name: trimmed, code: code.trim() },
      { method: "post" },
    );
  };

  return (
    <Modal title="New team" onClose={onClose}>
      <div className="space-y-3">
        {error && <Banner tone="error">{error}</Banner>}

        {/* No `name` attributes anywhere in here: this sheet can render
            inside the new-meet form, and a named input would be posted along
            with it. Everything goes to the API through `save` instead. */}
        <Field label="School or club">
          <TextInput
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Horizon"
            autoCapitalize="words"
            autoFocus
          />
        </Field>

        <Field label="Abbreviation" hint="Optional. Shown on meet listings.">
          <TextInput
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="HRZN"
            maxLength={8}
          />
        </Field>

        <Banner tone="info">
          Created unclaimed — a coach from {value.trim() || "that school"} can
          claim it later, and this meet is unaffected when they do.
        </Banner>

        <Button
          variant="primary"
          size="lg"
          full
          disabled={!value.trim() || busy}
          onClick={save}
        >
          {busy ? "Creating…" : "Create team"}
        </Button>
      </div>
    </Modal>
  );
}
