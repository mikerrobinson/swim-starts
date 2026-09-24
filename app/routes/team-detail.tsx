import { useMemo, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/team-detail";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  SectionTitle,
  Segmented,
  TextInput,
} from "~/components/ui";
import { TeamMembers } from "~/components/TeamMembers";
import { AthleteSheet } from "~/components/AthleteSheet";
import {
  appBaseUrl,
  currentUser,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import type { TeamAccess } from "~/lib/access";
import { publicTeamDetail } from "~/lib/public.server";
import {
  addTeamCoach,
  claimTeam,
  isTeamCoach,
  removeTeamCoach,
  teamCoaches,
} from "~/lib/coaches.server";
import { createInvite, inviteUser, supersedeInvites } from "~/lib/auth.server";
import { parseContact } from "~/lib/identity";
import { revealsCodes, sendTeamInvite } from "~/lib/notify.server";
import { createSeason, enrol, getTeam, updateTeam } from "~/lib/teams.server";
import { putAthlete } from "~/lib/athletes.server";
import { downloadFile, parseRosterCsv, toCsv } from "~/lib/csv";
import type { RosterEntry } from "~/lib/csv";
import { dayBefore, nextSeasonName, seasonForDate } from "~/lib/roster";
import { useViewPrefs } from "~/state/view-prefs";
import { meetTypeLabel } from "~/types/meet";
import { todayIso } from "~/types/athlete";

export function meta({ data }: Route.MetaArgs) {
  return [{ title: `${data?.team?.name ?? "Team"} · Swim Starts` }];
}

const TEMPLATE = toCsv([
  ["First Name", "Last Name", "Gender", "Year", "Birth Date", "Squad"],
  ["Avery", "Nguyen", "F", "10", "2009-03-14", "Blue"],
  ["Marcus", "Hill", "M", "12", "2007-11-02", "Gold"],
]);

/**
 * A team: its roster season by season, and its meets.
 *
 * One page, whether you coach here or are following a link to look. The
 * editing appears for whoever the server says may edit, exactly as it does on
 * a meet — there used to be a second screen at `/team` showing the same
 * roster, reachable only by the one coach whose team it was, and the two
 * drifted apart in the way two screens over one thing always do.
 *
 * The read half is the public projection, so what a coach sees of their own
 * roster is what everyone else sees of it, plus the controls.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  if (!env.DB) {
    return {
      team: null,
      access: null,
      coaches: [],
      currentSeasonId: null,
      swimCounts: {},
    };
  }

  try {
    const [rawUser, team, roll] = await Promise.all([
      currentUser(request, env),
      publicTeamDetail(env.DB, params.teamId),
      teamCoaches(env.DB, params.teamId),
    ]);
    const userId = rawUser?.id ?? null;
    const access: TeamAccess = {
      signedIn: userId != null,
      userId,
      coach: await isTeamCoach(env.DB, userId, params.teamId!),
    };

    /**
     * Who coaches this team is as public as the team is — it's on the heat
     * sheet. How to reach them isn't, so the contact goes only to the people
     * who already have it. That is the one difference from a meet's
     * administrators: a meet is an event you turn up to, a team is a school
     * full of children.
     */
    const coaches = roll.map((coach) => ({
      ...coach,
      contact: access.coach ? coach.contact : null,
    }));

    // Which season the team treats as current is a fact about running the
    // team, not about reading it, so the public projection leaves it out.
    // A coach needs it to say which one is current and to move it.
    const record = access.coach ? await getTeam(env.DB, params.teamId) : null;

    // How many meets each swimmer has a time in. One aggregate rather than
    // deriving every result on the client just to count them — and only for
    // somebody who can act on it, since a visitor is reading, not managing.
    const swims = access.coach
      ? await env.DB.prepare(
          `SELECT s.athlete_id AS id, COUNT(DISTINCT w.meet_id) AS n
           FROM seeds s JOIN watches w ON w.seed_id = s.id
           WHERE w.time_ms IS NOT NULL
           GROUP BY s.athlete_id`,
        ).all<{ id: string; n: number }>()
      : null;

    return {
      team,
      access,
      coaches,
      currentSeasonId: record?.currentSeasonId ?? null,
      swimCounts: Object.fromEntries(
        (swims?.results ?? []).map((row) => [row.id, row.n]),
      ),
    };
  } catch {
    return {
      team: null,
      access: null,
      coaches: [],
      currentSeasonId: null,
      swimCounts: {},
    };
  }
}

/**
 * Everything that changes a team, behind one check.
 *
 * The roster, the team's own name and code, and its seasons — all of it asked
 * of the same request that loaded the page, so the controls and the endpoint
 * cannot disagree about who may use them. These used to live under Settings,
 * which picked *which* team implicitly from the signed-in coach's first
 * coached team; here the team is the URL, so a coach of two can reach both.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const rawUser = await currentUser(request, env);
  const userId = rawUser?.id ?? null;

  const access: TeamAccess = {
    signedIn: userId != null,
    userId,
    coach: await isTeamCoach(db, userId, params.teamId!),
  };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "roster");

  /**
   * Taking on a team nobody coaches — the one move made from outside.
   *
   * Answered above the check everything else goes through, because passing
   * that check is exactly what it's asking for. `claimTeam` refuses the moment
   * anybody is already there, so the opening closes behind whoever walks
   * through it; being signed in is the only other requirement.
   */
  if (intent === "claim") {
    if (!access.userId) {
      return { ok: false, error: "Sign in first." };
    }
    const claimed = await claimTeam(db, params.teamId, access.userId);
    return claimed.ok
      ? { ok: true, standingChanged: true }
      : { ok: false, error: claimed.reason };
  }

  if (!access.coach || !access.userId) {
    throw new Response("Only a coach of this team can change that.", {
      status: 403,
    });
  }
  // Who is doing it, for the rows that remember who let somebody in. Past the
  // check above there is always somebody to name.
  const actor = access.userId;

  if (intent === "team") {
    await updateTeam(db, params.teamId, {
      name: String(form.get("name") ?? ""),
      code: String(form.get("code") ?? ""),
    });
    return { ok: true };
  }

  if (intent === "current-season") {
    await updateTeam(db, params.teamId, {
      currentSeasonId: String(form.get("seasonId") ?? ""),
    });
    return { ok: true };
  }

  if (intent === "new-season") {
    const name = String(form.get("name") ?? "").trim() || "New season";
    const startDate = String(form.get("startDate") ?? "") || todayIso();
    // The season that was current ends the day before this one starts, so the
    // two never both claim a date — which is what `seasonForDate` reads.
    const previousId = String(form.get("previousId") ?? "");
    if (previousId) {
      await db
        .prepare(
          "UPDATE seasons SET end_date = COALESCE(end_date, ?) WHERE id = ?",
        )
        .bind(dayBefore(startDate), previousId)
        .run();
    }
    const season = await createSeason(db, {
      teamId: params.teamId,
      name,
      startDate,
    });
    await updateTeam(db, params.teamId, { currentSeasonId: season.id });
    return { ok: true };
  }

  /**
   * Who coaches here.
   *
   * The same four moves the meet's administrator list has, behind the same one
   * check — being in `team_coaches` is the permission, so the guard above is
   * the whole of it. Stepping down passes it for the same reason removing
   * somebody else does: you are only in the list if you coach here.
   */
  if (intent === "coach-add") {
    const userId = String(form.get("userId") ?? "");
    if (!userId) return { ok: false, error: "Which person?" };
    await addTeamCoach(db, params.teamId, userId, actor);
    return { ok: true };
  }

  if (intent === "coach-remove") {
    const userId = String(form.get("userId") ?? "");
    const result = await removeTeamCoach(db, params.teamId, userId);
    // Refusing to remove the last coach is an ordinary answer the card shows,
    // not a failure — so it comes back as data rather than being thrown.
    // Stepping down is the only removal that changes the caller's own standing.
    return result.ok
      ? { ok: true, standingChanged: userId === actor }
      : { ok: false, error: result.reason };
  }

  /**
   * Somebody who may not have an account yet.
   *
   * `inviteUser` returns the existing account when the contact already has
   * one, so typing an address that turns out to belong to a member makes them
   * a coach rather than minting a second account for the same person.
   */
  if (intent === "coach-invite") {
    const parsed = parseContact(String(form.get("contact") ?? ""));
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const name = String(form.get("name") ?? "").trim() || null;
    const { user: invitee } = await inviteUser(db, parsed.contact, name);
    await addTeamCoach(db, params.teamId, invitee.id, actor);

    // Resending replaces the outstanding link rather than adding a second.
    await supersedeInvites(db, {
      teamId: params.teamId,
      contact: parsed.contact.value,
    });
    const token = await createInvite(
      db,
      { teamId: params.teamId, contact: parsed.contact.value },
      actor,
    );
    const link = `${appBaseUrl(request)}sign-in?invite=${encodeURIComponent(token)}`;
    const team = await getTeam(db, params.teamId);
    const delivery = await sendTeamInvite(
      env,
      parsed.contact,
      team?.name ?? "a team",
      link,
    );

    return {
      ok: true,
      sent: delivery.sent,
      detail: delivery.detail,
      // Local builds only, exactly as with login codes: without a provider
      // configured there is otherwise no way to follow your own invite.
      ...(revealsCodes(env) ? { link } : {}),
    };
  }

  /**
   * A link a coach sends themselves.
   *
   * The addressed version is `coach-invite`, where the server does the
   * sending; this is the one you paste into a group chat. Either way the link
   * is the credential, so it comes back exactly once — a coach who loses it
   * makes another rather than looking the old one up.
   */
  if (intent === "invite-link") {
    const token = await createInvite(db, { teamId: params.teamId }, actor);
    return {
      ok: true,
      url: `${appBaseUrl(request)}sign-in?invite=${encodeURIComponent(token)}`,
    };
  }

  const seasonId = String(form.get("seasonId") ?? "");
  const entries = JSON.parse(
    String(form.get("entries") ?? "[]"),
  ) as RosterEntry[];
  const mode = String(form.get("mode") ?? "append");

  // "Replace" clears this season's roster and nobody's history: the athletes
  // themselves stay, so past meets keep their names and times. Re-importing
  // used to mint new ids, which left every old entry pointing at somebody who
  // no longer appeared anywhere.
  if (mode === "replace") {
    await db
      .prepare("DELETE FROM enrollments WHERE team_id = ? AND season_id = ?")
      .bind(params.teamId, seasonId)
      .run();
  }

  for (const entry of entries) {
    const athlete = await putAthlete(db, entry.athlete);
    await enrol(db, {
      teamId: params.teamId,
      seasonId,
      athleteId: athlete.id,
      year: entry.year,
      squad: entry.squad,
    });
  }

  return { ok: true, added: entries.length };
}

export default function TeamDetail({ loaderData }: Route.ComponentProps) {
  const { team, access, coaches, currentSeasonId } = loaderData;
  const swimCounts = new Map(Object.entries(loaderData.swimCounts));
  const fetcher = useFetcher();
  const { nameOrder } = useViewPrefs();

  const [seasonId, setSeasonId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [addingSeason, setAddingSeason] = useState(false);
  const [incoming, setIncoming] = useState<RosterEntry[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const mayEdit = access?.coach === true;

  if (!team) {
    return (
      <Card>
        <EmptyState title="Team not found">
          It may have been removed, or the server may be unreachable.
        </EmptyState>
      </Card>
    );
  }

  /**
   * Which season is on screen.
   *
   * Defaults to the one covering today rather than the first in the list — a
   * coach opening their own team wants this year, and the list is ordered
   * oldest first. `seasonForDate` falls through to the most recent when no
   * season claims today, which is the right answer out of season too.
   */
  const season =
    team.seasons.find((s) => s.id === seasonId) ??
    seasonForDate(team.seasons, undefined, todayIso()) ??
    null;

  const roster = season?.roster ?? [];
  const active = roster.filter((entry) => entry.active);
  const inactive = roster.filter((entry) => !entry.active);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (showArchived ? roster : active)
      .filter(
        (entry) =>
          !query ||
          `${entry.firstName} ${entry.lastName}`.toLowerCase().includes(query),
      )
      .sort((a, b) =>
        nameOrder === "first"
          ? a.firstName.localeCompare(b.firstName) ||
            a.lastName.localeCompare(b.lastName)
          : a.lastName.localeCompare(b.lastName) ||
            a.firstName.localeCompare(b.firstName),
      );
  }, [roster, active, showArchived, search, nameOrder]);

  const save = (entries: RosterEntry[], mode: "append" | "replace") => {
    if (!season) return;
    fetcher.submit(
      {
        intent: "roster",
        seasonId: season.id,
        mode,
        entries: JSON.stringify(entries),
      },
      { method: "post" },
    );
  };

  const handleFile = async (file: File) => {
    const { entries, warnings: issues } = parseRosterCsv(await file.text());
    setWarnings(issues);
    if (entries.length === 0) return;
    // Nothing to lose yet, so no need to ask what to do about it.
    if (roster.length === 0) save(entries, "replace");
    else setIncoming(entries);
  };

  return (
    <div className="space-y-4">
      <Card>
        <div className="min-w-0">
          <h2 className="text-xl font-bold">{team.name}</h2>
          <p className="text-sm text-slate-500">
            {team.code && <span className="font-mono">{team.code}</span>}
            {team.code && " · "}
            {team.athletes} athlete{team.athletes === 1 ? "" : "s"} ·{" "}
            {team.meets.length} meet{team.meets.length === 1 ? "" : "s"}
          </p>
        </div>
      </Card>

      <Card>
        <SectionTitle
          action={
            mayEdit && season ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setAdding(true)}
              >
                + Swimmer
              </Button>
            ) : undefined
          }
        >
          Roster{mayEdit && ` (${active.length})`}
          {season && (
            <span className="ml-2 text-sm font-normal text-slate-500 dark:text-slate-400">
              {season.name}
            </span>
          )}
        </SectionTitle>

        {team.seasons.length === 0 ? (
          <EmptyState title="No seasons yet">
            A roster appears once a season is set up.
          </EmptyState>
        ) : (
          <>
            {team.seasons.length > 1 && (
              <div className="mb-3">
                <Segmented
                  value={season?.id ?? ""}
                  onChange={setSeasonId}
                  options={team.seasons.map((s) => ({
                    value: s.id,
                    label: s.name,
                  }))}
                />
              </div>
            )}

            {roster.length === 0 ? (
              <EmptyState title="Nobody on this roster">
                {mayEdit
                  ? "Import a CSV below, or add them one at a time. The roster carries across every meet this season."
                  : "Swimmers appear once a coach enrols them."}
              </EmptyState>
            ) : (
              <>
                {mayEdit && roster.length > 8 && (
                  <TextInput
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search swimmers"
                    className="mb-2"
                  />
                )}

                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {visible.map((entry) => {
                    const swims = swimCounts.get(entry.id) ?? 0;
                    return (
                      <li key={entry.id}>
                        <Link
                          to={`/athletes/${entry.id}`}
                          className="flex min-h-14 touch-manipulation items-center justify-between gap-3 py-2.5"
                        >
                          <span className="min-w-0">
                            <span
                              className={`block truncate ${
                                entry.active
                                  ? "font-medium"
                                  : "text-slate-400 line-through"
                              }`}
                            >
                              {nameOrder === "first"
                                ? `${entry.firstName} ${entry.lastName}`
                                : `${entry.lastName}, ${entry.firstName}`}
                            </span>
                            <span className="block text-xs text-slate-500">
                              {[
                                mayEdit ? entry.gender : null,
                                entry.year,
                                entry.squad,
                                swims > 0
                                  ? `${swims} meet${swims === 1 ? "" : "s"}`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ") || "—"}
                            </span>
                          </span>
                          <span aria-hidden className="shrink-0 text-slate-400">
                            ›
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>

                {mayEdit && inactive.length > 0 && (
                  <Button
                    className="mt-2"
                    size="sm"
                    variant="ghost"
                    full
                    onClick={() => setShowArchived((v) => !v)}
                  >
                    {showArchived
                      ? "Hide those off the roster"
                      : `Show ${inactive.length} off the roster`}
                  </Button>
                )}
              </>
            )}
          </>
        )}
      </Card>

      {mayEdit && season && (
        <Card>
          <SectionTitle>Import roster</SectionTitle>
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
            CSV with a header row. Columns can be{" "}
            <strong>First Name, Last Name, Gender, Year</strong> — plus optional{" "}
            <strong>Birth Date</strong> and <strong>Squad</strong>. A single{" "}
            <strong>Name</strong> column works too.
          </p>

          {/* The prompt renders here, above the picker, rather than under the
              whole card: on a long roster it used to land below the fold and
              an import looked like it had done nothing. */}
          {incoming && (
            <div className="mb-3 space-y-2">
              <Banner tone="warn">
                {season.name} already has {roster.length} swimmers. Add the{" "}
                {incoming.length} in this file, or replace the roster? Replacing
                only clears this season&rsquo;s roster — the swimmers themselves
                stay, so past meets keep their names and times.
              </Banner>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  variant="primary"
                  onClick={() => {
                    save(incoming, "append");
                    setIncoming(null);
                  }}
                >
                  Add
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    save(incoming, "replace");
                    setIncoming(null);
                  }}
                >
                  Replace
                </Button>
                <Button onClick={() => setIncoming(null)}>Cancel</Button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="primary"
              onClick={() => fileInput.current?.click()}
            >
              Choose CSV
            </Button>
            <Button
              onClick={() =>
                downloadFile("roster-template.csv", TEMPLATE, "text/csv")
              }
            >
              Template
            </Button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = "";
            }}
          />

          {warnings.length > 0 && (
            <div className="mt-3">
              <Banner tone="warn">
                <p className="font-semibold">Import notes</p>
                <ul className="mt-1 list-disc pl-4">
                  {warnings.slice(0, 8).map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                  {warnings.length > 8 && (
                    <li>…and {warnings.length - 8} more.</li>
                  )}
                </ul>
              </Banner>
            </div>
          )}
        </Card>
      )}

      {mayEdit && (
        <Card>
          <SectionTitle
            action={
              <Button size="sm" onClick={() => setAddingSeason((v) => !v)}>
                {addingSeason ? "Cancel" : "+ Season"}
              </Button>
            }
          >
            Seasons
          </SectionTitle>

          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {team.seasons.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">
                    {row.name}
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    {[row.startDate, row.endDate].filter(Boolean).join(" → ") ||
                      "no dates — covers everything"}
                  </span>
                </span>
                {row.id === currentSeasonId ? (
                  <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                    current
                  </span>
                ) : (
                  <fetcher.Form method="post" className="shrink-0">
                    <input type="hidden" name="intent" value="current-season" />
                    <input type="hidden" name="seasonId" value={row.id} />
                    <Button type="submit" size="sm" variant="ghost">
                      Make current
                    </Button>
                  </fetcher.Form>
                )}
              </li>
            ))}
          </ul>

          {addingSeason && (
            <fetcher.Form method="post" className="mt-3 space-y-3">
              <input type="hidden" name="intent" value="new-season" />
              <input type="hidden" name="previousId" value={season?.id ?? ""} />
              <Banner tone="info">
                A new season starts an empty roster. Everyone stays on the old
                one, so last year&rsquo;s meets keep their names and times.
              </Banner>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name">
                  <TextInput
                    name="name"
                    defaultValue={nextSeasonName(season?.name ?? "")}
                  />
                </Field>
                <Field label="Starts">
                  <TextInput
                    type="date"
                    name="startDate"
                    defaultValue={todayIso()}
                  />
                </Field>
              </div>
              <Button type="submit" variant="primary" full>
                Start season
              </Button>
            </fetcher.Form>
          )}
        </Card>
      )}

      {/* Not gated on being a coach: who coaches a team is on every heat
          sheet, and the card shows its own controls to whoever may use them —
          the same way a meet's administrators are listed to everybody. */}
      <TeamMembers teamId={team.id} coaches={coaches} access={access} />

      {mayEdit && (
        <Card>
          <SectionTitle>Team details</SectionTitle>
          <fetcher.Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="team" />
            <Field label="Name">
              <TextInput
                name="name"
                defaultValue={team.name}
                autoCapitalize="words"
              />
            </Field>
            <Field
              label="Code"
              hint="Short, as it appears on a heat sheet — CHAP."
            >
              <TextInput
                name="code"
                defaultValue={team.code}
                autoCapitalize="characters"
              />
            </Field>
            <Button type="submit" variant="primary" full>
              Save team
            </Button>
          </fetcher.Form>
        </Card>
      )}

      {mayEdit && (
        <Card>
          <SectionTitle>Export</SectionTitle>
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
            The team, its seasons and their rosters, as JSON.
          </p>
          <Button
            full
            onClick={() =>
              downloadFile(
                `${team.code || team.name}-${todayIso()}.json`,
                JSON.stringify(
                  {
                    team: { id: team.id, name: team.name, code: team.code },
                    seasons: team.seasons,
                  },
                  null,
                  2,
                ),
                "application/json",
              )
            }
          >
            Download team JSON
          </Button>
        </Card>
      )}

      <Card>
        <SectionTitle>Meets</SectionTitle>
        {team.meets.length === 0 ? (
          <EmptyState title="No meets yet">
            Meets appear here once this team races.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {team.meets.map((meet) => (
              <li key={meet.id}>
                <Link
                  to={`/meets/${meet.id}`}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">
                      {meet.name}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {meet.date} · {meetTypeLabel(meet.type)} · {meet.times}{" "}
                      time{meet.times === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span aria-hidden className="shrink-0 text-slate-400">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {adding && season && (
        <AthleteSheet
          title="Add swimmer"
          onClose={() => setAdding(false)}
          onSave={(athlete, facts) => {
            save([{ athlete, ...facts }], "append");
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}
