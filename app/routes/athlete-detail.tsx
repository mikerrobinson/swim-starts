import { useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/athlete-detail";
import { AthleteSheet } from "~/components/AthleteSheet";
import { AthleteAccount } from "~/components/AthleteAccount";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  SectionTitle,
} from "~/components/ui";
import { formatTime } from "~/lib/time";
import { currentUser } from "~/lib/api.server";
import { isTeamCoach } from "~/lib/coaches.server";
import {
  athleteForUser,
  getAthlete,
  linkAthleteToUser,
  putAthlete,
} from "~/lib/athletes.server";
import { enrol, listSeasons, getTeam } from "~/lib/teams.server";
import { publicAthleteDetail } from "~/lib/public.server";
import { describeUser } from "~/lib/auth.server";
import { seasonForDate } from "~/lib/roster";
import { ensureSchema } from "~/lib/schema.server";
import { athleteName } from "~/types/meet";
import { ageOn, todayIso } from "~/types/athlete";
import type { Gender } from "~/types/athlete";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Athlete · Swim Starts" }];
}

/**
 * One swimmer: who they are, who they swim for, and everything they've swum.
 *
 * A loader rather than a walk through a client store, which is what the rest
 * of the browse screens already did — this was the odd one out, deriving a
 * career from whatever meets happened to be on the device.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  await ensureSchema(db);

  const detail = await publicAthleteDetail(db, params.athleteId);
  if (!detail)
    return {
      detail: null,
      access: null,
      enrollment: null,
      season: null,
      teamId: null,
    };

  const rawUser = await currentUser(request, db);
  const userId = rawUser?.id ?? null;

  // Editing is a coach's job, and the team that matters is one this swimmer is
  // actually on — a coach of some other school has no say here.
  let teamId: string | null = null;
  let coach = false;
  for (const team of detail.teams) {
    if (await isTeamCoach(db, userId, team.id)) {
      teamId = team.id;
      coach = true;
      break;
    }
  }

  const athlete = await getAthlete(db, params.athleteId);
  let enrollment = null;
  let season = null;
  if (teamId) {
    const team = await getTeam(db, teamId);
    const seasons = await listSeasons(db, teamId);
    season = seasonForDate(seasons, team?.currentSeasonId, todayIso()) ?? null;
    if (season) {
      enrollment = await db
        .prepare(
          "SELECT year, squad, status FROM enrollments WHERE season_id = ? AND athlete_id = ?",
        )
        .bind(season.id, params.athleteId)
        .first<{ year: string; squad: string | null; status: string }>();
    }
  }

  return {
    detail,
    // Birth date is a coach's to see, so it travels only when one is asking.
    birthDate: coach ? (athlete?.birthDate ?? null) : null,
    // Who the linked account is. A contact, so only for the coach who linked
    // it — and read here rather than by the card, because the card would need
    // an endpoint that names any account from its id.
    linked:
      coach && athlete?.userId ? await describeUser(db, athlete.userId) : null,
    access: { coach },
    enrollment,
    season,
    teamId,
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB;
  const rawUser = await currentUser(request, db);
  const userId = rawUser?.id ?? null;

  const form = await request.formData();
  const teamId = String(form.get("teamId") ?? "");
  if (!(await isTeamCoach(db, userId, teamId))) {
    throw new Response("Only a coach of this team can change that.", {
      status: 403,
    });
  }

  const intent = String(form.get("intent") ?? "");
  const seasonId = String(form.get("seasonId") ?? "");

  if (intent === "roster" && seasonId) {
    await enrol(db, {
      teamId,
      seasonId,
      athleteId: params.athleteId,
      year: String(form.get("year") ?? ""),
      squad: String(form.get("squad") ?? "") || undefined,
      status: form.get("status") === "inactive" ? "inactive" : "active",
    });
    return { ok: true };
  }

  /**
   * Which account is this swimmer, or none.
   *
   * A coach does this, never the person themselves. A roster record is an
   * assertion about who somebody is, and letting anyone claim any swimmer
   * would make it worthless — the coach is the one who knows which address
   * belongs to which kid. The check is the guard above: a coach of a team this
   * swimmer is actually on, which is what the form's `teamId` names.
   *
   * The account is whichever one the coach picked out of the whole directory.
   * It used to have to be on the team first — back when a swimmer held a
   * membership row of their own — which put a join-and-approve dance in front
   * of the only fact being asserted. The contact proves itself when they sign
   * in; nothing in between is needed.
   */
  if (intent === "link-account") {
    const userId = String(form.get("userId") ?? "");

    // One account, one swimmer. Two roster rows claiming the same person is a
    // mistake worth refusing rather than quietly allowing.
    if (userId) {
      const held = await athleteForUser(db, userId);
      if (held && held.id !== params.athleteId) {
        return {
          ok: false,
          error:
            `That account is already ${held.firstName} ${held.lastName}.`.trim(),
        };
      }
    }

    await linkAthleteToUser(db, params.athleteId, userId || null);
    return { ok: true };
  }

  if (intent === "details") {
    await putAthlete(db, {
      id: params.athleteId,
      firstName: String(form.get("firstName") ?? "").trim(),
      lastName: String(form.get("lastName") ?? "").trim(),
      gender: (form.get("gender") === "M" ? "M" : "F") as Gender,
      birthDate: String(form.get("birthDate") ?? "") || undefined,
    });
    if (seasonId) {
      await enrol(db, {
        teamId,
        seasonId,
        athleteId: params.athleteId,
        year: String(form.get("year") ?? ""),
        squad: String(form.get("squad") ?? "") || undefined,
      });
    }
    return { ok: true };
  }

  return { ok: false };
}

/** "3rd", for a place badge. */
function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export default function AthleteDetail({ loaderData }: Route.ComponentProps) {
  const { detail, access, enrollment, season, teamId } = loaderData;
  const fetcher = useFetcher();
  const [editing, setEditing] = useState(false);

  if (!detail) {
    return (
      <EmptyState title="No such swimmer">
        <Link to="/teams" className="font-semibold text-blue-600 underline">
          Back to the teams
        </Link>
      </EmptyState>
    );
  }

  const athlete = {
    id: detail.id,
    firstName: detail.firstName,
    lastName: detail.lastName,
    gender: detail.gender,
    birthDate: loaderData.birthDate ?? undefined,
  };
  const age = ageOn(athlete, todayIso());
  const onRoster = enrollment?.status === "active";
  const mayEdit = access?.coach === true && teamId !== null;

  // Grouped by race so the screen answers "how's their 100 Free going" rather
  // than just listing times.
  const groups = new Map<string, typeof detail.swims>();
  for (const swim of detail.swims) {
    const list = groups.get(swim.eventName) ?? [];
    list.push(swim);
    groups.set(swim.eventName, list);
  }
  const byEvent = [...groups.entries()]
    .map(([label, swims]) => {
      const legal = swims.filter((s) => s.status === "OK");
      return {
        label,
        swims: [...swims].sort((a, b) => b.date.localeCompare(a.date)),
        bestMs: legal.length ? Math.min(...legal.map((s) => s.timeMs)) : null,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const roster = (status: "active" | "inactive") => {
    if (!teamId || !season) return;
    fetcher.submit(
      {
        intent: "roster",
        teamId,
        seasonId: season.id,
        status,
        year: enrollment?.year ?? "",
        squad: enrollment?.squad ?? "",
      },
      { method: "post" },
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          action={
            mayEdit ? (
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : undefined
          }
        >
          {athleteName(athlete)}
        </SectionTitle>
        <dl className="grid grid-cols-4 gap-2">
          {[
            { label: "Gender", value: athlete.gender },
            { label: "Year", value: enrollment?.year || "—" },
            { label: "Age", value: age === null ? "—" : String(age) },
            { label: "Squad", value: enrollment?.squad || "—" },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-xl bg-slate-100 p-2 text-center dark:bg-slate-800"
            >
              <dd className="text-lg font-bold">{item.value}</dd>
              <dt className="text-xs text-slate-500 dark:text-slate-400">
                {item.label}
              </dt>
            </div>
          ))}
        </dl>

        <p className="mt-2 flex flex-wrap justify-center gap-1.5">
          {detail.teams.map((team) => (
            <Link
              key={team.id}
              to={`/teams/${team.id}`}
              className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              {team.name}
            </Link>
          ))}
        </p>

        {athlete.birthDate && (
          <p className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">
            Born {athlete.birthDate}
          </p>
        )}

        {mayEdit && !onRoster && (
          <div className="mt-3">
            <Banner tone="warn">
              Not on the {season?.name ?? "current"} roster — hidden from
              registration and lane pickers, but their past results still show
              their name.
            </Banner>
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>Times ({detail.swims.length})</SectionTitle>
        {byEvent.length === 0 ? (
          <EmptyState title="No times yet">
            Their swims will appear here as meets are run.
          </EmptyState>
        ) : (
          <div className="space-y-4">
            {byEvent.map((group) => (
              <div key={group.label}>
                <div className="mb-1 flex items-baseline justify-between">
                  <h3 className="font-bold">{group.label}</h3>
                  {group.bestMs !== null && (
                    <span className="text-sm text-slate-500 dark:text-slate-400">
                      best{" "}
                      <strong className="tabular-nums text-slate-900 dark:text-white">
                        {formatTime(group.bestMs)}
                      </strong>
                    </span>
                  )}
                </div>
                <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                  {group.swims.map((swim, index) => (
                    <li
                      key={`${swim.meetId}:${index}`}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <span className="min-w-0">
                        <Link
                          to={`/meets/${swim.meetId}/results`}
                          className="block truncate font-semibold text-blue-600 dark:text-blue-400"
                        >
                          {swim.meetName}
                        </Link>
                        <span className="block text-xs text-slate-500 dark:text-slate-400">
                          {swim.date} · {swim.course}
                          {swim.place && ` · ${ordinal(swim.place)}`}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {swim.exhibition && (
                          <span
                            title="Exhibition — swum outside the competition"
                            className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-200"
                          >
                            X
                          </span>
                        )}
                        {swim.best && group.swims.length > 1 && (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                            best
                          </span>
                        )}
                        <span className="text-lg font-bold tabular-nums">
                          {swim.status === "OK"
                            ? formatTime(swim.timeMs)
                            : swim.status}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      {mayEdit && teamId && (
        <>
          <AthleteAccount teamId={teamId} linked={loaderData.linked ?? null} />

          <Card>
            <SectionTitle>Roster</SectionTitle>
            {!onRoster ? (
              <Button full onClick={() => roster("active")}>
                Add to the {season?.name ?? "current"} roster
              </Button>
            ) : (
              <>
                <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">
                  Takes them off the {season?.name ?? "current"} roster for new
                  meets. Their past results keep working, which is why
                  there&rsquo;s no delete.
                </p>
                <Button variant="ghost" full onClick={() => roster("inactive")}>
                  Take {athleteName(athlete)} off the roster
                </Button>
              </>
            )}
          </Card>
        </>
      )}

      {editing && teamId && (
        <AthleteSheet
          title="Edit swimmer"
          athlete={athlete}
          enrollment={
            enrollment
              ? { year: enrollment.year, squad: enrollment.squad ?? undefined }
              : undefined
          }
          onClose={() => setEditing(false)}
          onSave={(next, facts) => {
            fetcher.submit(
              {
                intent: "details",
                teamId,
                seasonId: season?.id ?? "",
                firstName: next.firstName,
                lastName: next.lastName,
                gender: next.gender,
                birthDate: next.birthDate ?? "",
                year: facts.year,
                squad: facts.squad ?? "",
              },
              { method: "post" },
            );
            setEditing(false);
          }}
          onDelete={() => {
            roster("inactive");
            setEditing(false);
          }}
          deleteLabel="Take off the roster"
        />
      )}
    </div>
  );
}
