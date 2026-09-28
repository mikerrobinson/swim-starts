import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/meets";
import {
  Button,
  Card,
  EmptyState,
  Field,
  SectionTitle,
  Segmented,
  Select,
  Sheet,
  TextInput,
} from "~/components/ui";
import { currentUser } from "~/lib/api.server";
import { findOrCreateTeam } from "~/lib/new-team.server";
import { coachedTeamsFor } from "~/lib/auth.server";
import { createMeet, listMeets } from "~/lib/meets.server";
import { defaultEvents } from "~/lib/events";
import { addMeetAdmin } from "~/lib/admins.server";
import { teamsCoachedBy } from "~/lib/coaches.server";
import {
  getTeam,
  listSeasons,
  roster as teamRoster,
  seasonForDate,
} from "~/lib/teams.server";
import { useSession } from "~/state/session";
import { TeamPicker } from "~/components/TeamPicker";
import {
  courseLabel,
  isLaneCount,
  isMeetCourse,
  LANE_COUNTS,
  meetDetailsFrom,
  MEET_COURSES,
  MEET_TYPES,
  meetTypeLabel,
  type LaneCount,
  type MeetCourse,
  type MeetType,
} from "~/types/meet";
import { todayIso } from "~/types/athlete";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Meets · Swim Starts" }];
}

type Filter = "upcoming" | "complete" | "all";

/**
 * Every meet, from one place.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;

  // The teams this person coaches, so the new-meet sheet can start with their
  // own school already racing. `coachedTeamsFor` carries the name and code
  // along, so naming them costs no second query.
  const user = await currentUser(request, db);
  const myTeams = user
    ? (await coachedTeamsFor(db, user.id)).map((team) => ({
        id: team.teamId,
        name: team.name,
        code: team.code,
      }))
    : [];

  return { meets: await listMeets(db), myTeams };
}

export async function action({ request, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB;
  const user = await currentUser(request, db);
  if (!user) throw new Response("Sign in to create a meet", { status: 403 });

  const form = await request.formData();

  /**
   * A school typed into the picker that isn't on the app yet.
   *
   * Minted unclaimed, and handed straight back so the picker can put it in the
   * list it is showing. `findOrCreateTeam` answers with the existing team if
   * that name is already one, so racing somebody twice can't produce a second
   * copy of them even from here.
   */
  if (String(form.get("intent")) === "new-team") {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return { ok: false, error: "A team needs a name." };
    const { team } = await findOrCreateTeam(db, {
      name,
      code: String(form.get("code") ?? "") || undefined,
      by: user.id,
    });
    return { ok: true, team };
  }

  const type = String(form.get("type") ?? "dual") as MeetType;
  const course = form.get("course");
  const lanes = Number(form.get("laneCount"));
  const name = String(form.get("name") ?? "").trim();
  // What the form offered to call it. The suggestion is built on the client
  // from the teams picked there, so the server cannot re-derive it — and a
  // hint reading 'Leave blank for "vs Horizon"' that produces "Dual" is worse
  // than no hint at all.
  const suggested = String(form.get("suggestedName") ?? "").trim();

  /**
   * Who's racing, as chosen on the form.
   *
   * The sheet starts with the teams this person coaches — a meet belongs to
   * none of them, this just saves picking your own school from a list —
   * and they can drop it, so what comes back is the answer rather than a
   * suggestion. The fallback is for a form posted without the field at all:
   * a meet with nobody racing can hold no entries, and silently creating one
   * is worse than assuming the obvious.
   */
  const chosen = form.getAll("teamId").map(String).filter(Boolean);
  const mine = await teamsCoachedBy(db, user.id);
  const teamIds = chosen.length ? [...new Set(chosen)] : mine;

  // The pool it's swum in, defaulting to the creator's own team when they're
  // racing. Changed on the meet's own page afterwards.
  const host = String(form.get("hostTeamId") ?? "");
  const hostTeamId = teamIds.includes(host)
    ? host
    : (teamIds.find((id) => mine.includes(id)) ?? teamIds[0]);

  const meet = await createMeet(db, {
    name: name || suggested || meetTypeLabel(type),
    date: String(form.get("date") ?? todayIso()),
    type,
    course: isMeetCourse(course) ? course : "SCY",
    location: String(form.get("location") ?? "").trim() || undefined,
    teamIds,
    hostTeamId,
    createdBy: user.id,
    laneCount: isLaneCount(lanes) ? lanes : 6,
    includeDiving: true,
    limits: { maxIndividual: 2, maxRelays: 2, maxTotal: 4 },
  });

  // Whoever sets a meet up runs it. Recorded here, at the moment of creation,
  // rather than inferred later from who happened to push it first.
  await addMeetAdmin(db, meet.id, user.id, user.id);

  // Seed the meet's Durable Object with its starting settings — from here
  // on, `meet-info.tsx`'s `setDetails` is what keeps them current, not this
  // D1 row (see `meetDetailsFrom`'s doc comment in `types/meet.ts`).
  const stub = context.cloudflare.env.MEET_DO.getByName(meet.id);
  await stub.setDetails(meet.id, meetDetailsFrom(meet));

  // A standard dual-meet order, girls/boys split, so there's something to
  // seat swimmers into right away — `meet-info.tsx`'s lineup editor is what
  // changes it from here.
  await stub.setEvents(
    meet.id,
    defaultEvents(meet.id, {
      course: meet.course,
      leadGender: meet.leadGender,
      includeDiving: meet.includeDiving,
    }),
  );

  // Copy each racing team's roster in — same call `meet-info.tsx`'s "teams"
  // intent makes for a team added later. Without this, the DO's own
  // `athletes`/`teams` tables stay empty and the first entry for anyone on
  // the initial roster fails: `entries.athlete_id` is a foreign key against
  // this DO's local `athletes`, not D1's.
  await Promise.all(
    teamIds.map(async (teamId) => {
      const [team, seasons] = await Promise.all([
        getTeam(db, teamId),
        listSeasons(db, teamId),
      ]);
      if (!team) return;
      const season = seasonForDate(seasons, team.currentSeasonId, meet.date);
      const rosterEntries = await teamRoster(db, teamId, season?.id);
      await stub.addTeam(
        team,
        rosterEntries.map((e) => e.athlete),
      );
    }),
  );

  return redirect(`/meets/${meet.id}`);
}

function isUpcoming(date: string, today: string): boolean {
  return date >= today;
}

export default function Meets({ loaderData }: Route.ComponentProps) {
  const session = useSession();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<Filter>("upcoming");
  const today = todayIso();

  const counts = {
    upcoming: loaderData.meets.filter((r) => isUpcoming(r.meet.date, today))
      .length,
    complete: loaderData.meets.filter((r) => !isUpcoming(r.meet.date, today))
      .length,
    all: loaderData.meets.length,
  };

  const visible = loaderData.meets
    .filter((row) =>
      filter === "all"
        ? true
        : filter === "upcoming"
          ? isUpcoming(row.meet.date, today)
          : !isUpcoming(row.meet.date, today),
    )
    // The next meet first when looking forward; the last one first when
    // looking back. Both are "nearest to now", which is what you came for.
    .sort((a, b) =>
      filter === "upcoming"
        ? a.meet.date.localeCompare(b.meet.date)
        : b.meet.date.localeCompare(a.meet.date),
    );

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          action={
            session.status === "in" ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setAdding(true)}
              >
                + Meet
              </Button>
            ) : undefined
          }
        >
          Meets
        </SectionTitle>

        <div className="mb-3">
          <Segmented
            value={filter}
            onChange={(next) => setFilter(next as Filter)}
            options={[
              { value: "upcoming", label: `Upcoming (${counts.upcoming})` },
              { value: "complete", label: `Complete (${counts.complete})` },
              { value: "all", label: `All (${counts.all})` },
            ]}
          />
        </div>

        {visible.length === 0 ? (
          <EmptyState
            title={
              filter === "upcoming"
                ? "Nothing coming up"
                : filter === "complete"
                  ? "Nothing swum yet"
                  : "No meets yet"
            }
          >
            {session.status === "in"
              ? "Add one to set up events, register swimmers, and run it."
              : "Sign in to set one up."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {visible.map((row) => (
              <li key={row.meet.id}>
                <Link
                  to={`/meets/${row.meet.id}`}
                  className="flex min-h-16 touch-manipulation items-center justify-between gap-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="truncate font-semibold">
                      {row.meet.name}
                    </span>
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                      {[
                        row.meet.date,
                        meetTypeLabel(row.meet.type),
                        row.meet.course,
                        row.teams.map((t) => t.code || t.name).join(" v "),
                        row.meet.location,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span aria-hidden className="text-xl text-slate-400">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {adding && (
        <NewMeetSheet
          myTeams={loaderData.myTeams}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

/**
 * Setting one up.
 *
 * A plain form posting to this route's action. The fields that were React
 * state are inputs with names now; the only state left is the one thing the
 * form itself needs to know, which is what to suggest as a name.
 */
interface PickedTeam {
  id: string;
  name: string;
  code: string;
}

function NewMeetSheet({
  myTeams,
  onClose,
}: {
  myTeams: PickedTeam[];
  onClose: () => void;
}) {
  const [type, setType] = useState<MeetType>("dual");
  const [course, setCourse] = useState<MeetCourse>("SCY");
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  /**
   * Who's racing.
   *
   * Starts with this person's own school, because in a season of dual meets
   * the home team is on every single one and picking it from a list twenty
   * times is twenty chances to pick wrong. It's a default and not a rule —
   * a referee who coaches nobody starts empty, and anyone can drop it.
   */
  const [teams, setTeams] = useState<PickedTeam[]>(myTeams);
  const [adding, setAdding] = useState(false);

  const mine = new Set(myTeams.map((team) => team.id));
  const opponents = teams.filter((team) => !mine.has(team.id));

  /**
   * What to call it, now that there are teams to name it after.
   *
   * "vs Horizon" is what a coach writes on the whiteboard, so it's what the
   * field offers once an opponent is on the meet. Still only a placeholder —
   * typing over it is the point of it being one.
   */
  const suggested =
    opponents.length > 0
      ? `vs ${opponents.map((team) => team.name).join(" & ")}`
      : meetTypeLabel(type);

  return (
    <Sheet open title="New meet" onClose={onClose}>
      <Form method="post" className="space-y-3">
        <input type="hidden" name="suggestedName" value={suggested} />
        <Field label="Name" hint={`Leave blank for "${suggested}".`}>
          <TextInput
            name="name"
            placeholder={suggested}
            autoCapitalize="words"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput type="date" name="date" defaultValue={todayIso()} />
          </Field>
          <Field label="Type">
            <Select
              name="type"
              value={type}
              onChange={(e) => setType(e.target.value as MeetType)}
            >
              {MEET_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Course">
            <Select
              name="course"
              value={course}
              onChange={(e) => setCourse(e.target.value as MeetCourse)}
            >
              {MEET_COURSES.map((c) => (
                <option key={c.value} value={c.value}>
                  {courseLabel(c.value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Lanes">
            <Select name="laneCount" defaultValue={6}>
              {LANE_COUNTS.map((n: LaneCount) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {/* Not a `Field`: that renders a <label>, and a label wrapping a
            search box and several buttons sends a stray click to whichever
            control happens to be first. Same styling, honest markup. */}
        <div className="block">
          <span className="mb-1 block text-sm font-semibold text-slate-600 dark:text-slate-300">
            Teams racing
          </span>
          <div className="space-y-2">
            {teams.length === 0 && !adding && (
              <p className="text-sm text-slate-500">
                Nobody yet — add the schools that are swimming.
              </p>
            )}

            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {teams.map((team) => (
                <li key={team.id} className="flex items-center gap-2 py-1.5">
                  {/* The field the action reads. Repeated rather than joined,
                      so `getAll` needs no separator nobody can type. */}
                  <input type="hidden" name="teamId" value={team.id} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {team.name}
                    {team.code && (
                      <span className="ml-2 text-xs font-normal text-slate-500">
                        {team.code}
                      </span>
                    )}
                    {mine.has(team.id) && (
                      <span className="ml-2 text-xs font-normal text-slate-500">
                        yours
                      </span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setTeams((current) =>
                        current.filter((t) => t.id !== team.id),
                      )
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>

            {adding ? (
              <TeamPicker
                exclude={teams.map((team) => team.id)}
                onPick={(team) => {
                  setTeams((current) =>
                    current.some((t) => t.id === team.id)
                      ? current
                      : [
                          ...current,
                          { id: team.id, name: team.name, code: team.code },
                        ],
                  );
                  setAdding(false);
                }}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <Button full onClick={() => setAdding(true)}>
                + Team
              </Button>
            )}
          </div>
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            Whoever&rsquo;s swimming. You can change this later.
          </span>
        </div>

        <Field label="Location">
          <TextInput
            name="location"
            placeholder="Cactus Aquatic Center"
            autoCapitalize="words"
          />
        </Field>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          full
          disabled={saving}
        >
          {saving ? "Creating…" : "Create meet"}
        </Button>
      </Form>
    </Sheet>
  );
}
