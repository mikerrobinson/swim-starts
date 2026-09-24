import { useState } from "react";
import { Form, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/meet-info";
import {
  Banner,
  Button,
  Card,
  Field,
  SectionTitle,
  Select,
  TextInput,
} from "~/components/ui";
import { TimerAccess } from "~/components/TimerAccess";
import { MeetTeams } from "~/components/MeetTeams";
import { MeetAdmins } from "~/components/MeetAdmins";
import {
  appBaseUrl,
  currentUser,
  requireDb,
  resolveUser,
  type SyncEnv,
} from "~/lib/api.server";
import { addMeetAdmin, meetAdmins, removeMeetAdmin } from "~/lib/admins.server";
import { findOrCreateTeam } from "~/lib/new-team.server";
import { issueGrant, revokeGrants, grantFor } from "~/lib/grants.server";
import { createInvite, inviteUser, supersedeInvites } from "~/lib/auth.server";
import { parseContact } from "~/lib/identity";
import { revealsCodes, sendMeetInvite } from "~/lib/notify.server";
import { canEditMeet, type MeetFacts } from "~/lib/access";
import { deleteMeet, getMeet, updateMeet } from "~/lib/meets.server";
import { getTeam } from "~/lib/teams.server";
import { meetCache } from "~/lib/meetCache";
import { useMeet } from "./meets2";
import {
  courseLabel,
  formatNumberList,
  isLaneCount,
  isMeetCourse,
  isTimersPerLane,
  LANE_COUNTS,
  MEET_COURSES,
  MEET_TYPES,
  meetSubtitle,
  parseNumberList,
  TIMERS_PER_LANE,
  type LaneAssignments,
  type LaneCount,
  type MeetDetails,
  type MeetType,
  type ScoringRules,
  type TimersPerLane,
} from "~/types/meet";
import type { Team } from "~/types/team";

/**
 * The two things this page needs that aren't a meet's `details`: who runs
 * it, whether a timing code is live, and who's racing. None of those three
 * are `MeetManifest`-owned — admins/grants are D1 (`admins.server.ts`/
 * `grants.server.ts`), and "who's racing" is a `meet_teams` join, not a
 * setting to broadcast — so this loader reads exactly those and nothing
 * else. Everything the Details/Seeding forms show comes from `useMeet()`'s
 * `MeetManifest.details` instead (see the action's doc comment).
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const rawUser = await currentUser(request, env);
  const meetId = params.meetId!;

  const [user, admins, grant, meet] = await Promise.all([
    resolveUser(db, rawUser, request),
    meetAdmins(db, meetId),
    // Whether a sheet is live and when it dies — never the token itself.
    // That is handed over exactly once, by the action that mints it.
    rawUser ? grantFor(db, meetId) : null,
    getMeet(db, meetId),
  ]);

  const teams = meet
    ? (await Promise.all(meet.teamIds.map((id) => getTeam(db, id)))).filter(
        (t): t is Team => t !== null,
      )
    : [];

  return {
    user,
    meet,
    admins,
    grant,
    teams,
    hostTeamId: meet?.hostTeamId ?? "",
  };
}

/** What `canEditMeet` falls back to when the meet's own D1 row is somehow
 *  missing — nobody may edit a meet that isn't there. */
const EMPTY_MEET_FACTS: MeetFacts = {
  adminIds: [],
  teamIds: [],
  athletesMayEnter: false,
};

/**
 * Merge a settings form's fields onto the meet's current `details` —
 * `intent: "details"` for name/date/type/course/location/lanes/timers,
 * `intent: "seeding"` for lane assignments and scoring. Pure, so both the
 * server `action` (merging onto the DO's own copy) and `clientAction`
 * (merging onto whatever's cached, for the optimistic update) compute
 * exactly the same next object from exactly the same form.
 */
function nextDetails(
  current: MeetDetails,
  intent: string,
  form: FormData,
): MeetDetails {
  if (intent === "seeding") {
    const laneAssignments: LaneAssignments = {};
    for (const [key, value] of form.entries()) {
      if (!key.startsWith("lanes-")) continue;
      const lanes = parseNumberList(String(value));
      if (lanes.length) laneAssignments[key.slice("lanes-".length)] = lanes;
    }
    const scoring: ScoringRules = {
      individual: parseNumberList(String(form.get("individualPoints") ?? "")),
      relay: parseNumberList(String(form.get("relayPoints") ?? "")),
      separateByGender: form.get("separateByGender") === "on",
    };
    return { ...current, laneAssignments, scoring };
  }

  const lanes = Number(form.get("laneCount"));
  const timers = Number(form.get("timersPerLane"));
  const course = form.get("course");
  return {
    ...current,
    name: String(form.get("name") ?? "").trim() || "Meet",
    date: String(form.get("date") ?? ""),
    type: String(form.get("type") ?? "dual") as MeetType,
    course: isMeetCourse(course) ? course : "SCY",
    location: String(form.get("location") ?? "").trim() || undefined,
    laneCount: isLaneCount(lanes) ? lanes : current.laneCount,
    timersPerLane: isTimersPerLane(timers) ? timers : current.timersPerLane,
    leadGender: form.get("leadGender") === "M" ? "M" : "F",
    includeDiving: form.get("includeDiving") === "on",
    entryVisibility:
      form.get("entryVisibility") === "own-team" ? "own-team" : "everyone",
    athletesMayEnter: form.get("athletesMayEnter") === "on",
  };
}

/**
 * Everything that changes a meet, behind one check.
 *
 * `canEditMeet` is asked here, against the same request that loaded the rows —
 * so the screen and the server cannot disagree about whether you run this
 * meet.
 *
 * `details`/`seeding` write through the meet's Durable Object
 * (`setDetails`) now, not D1's `updateMeet` — see `MeetDetails`' doc comment
 * in `types/meet.ts`. Everything else here (teams, admins, invites, the
 * timing code, deleting the meet) is still a plain D1 write; none of it was
 * ever part of the `MeetDetail` read this page used to also do.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const meetId = params.meetId!;
  const [rawUser, meet] = await Promise.all([
    currentUser(request, env),
    getMeet(db, meetId),
  ]);
  const user = await resolveUser(db, rawUser, request);
  if (!meet || !canEditMeet({ meet, user }) || !user.userId) {
    throw new Response("Whoever is running this meet decides that.", {
      status: 403,
    });
  }
  // Who is doing it, recorded against the rows that remember who let somebody
  // in. Pulled out here because `canEditMeet` is admin-only, which nobody
  // signed out can be — so past this line there is always somebody to name.
  const actor = user.userId;

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "details" || intent === "seeding") {
    const stub = context.cloudflare.env.MEET_DO.getByName(meetId);
    const current = await stub.getDetails(meetId);
    await stub.setDetails(meetId, nextDetails(current, intent, form));
    return { ok: true };
  }

  /**
   * Who's racing.
   *
   * The whole list every time, because that is what `updateMeet` writes: it
   * replaces `meet_teams` rather than diffing it, so a patch describing only
   * the change would need a second place that knew how to apply one.
   */
  if (intent === "teams") {
    const teamIds = form.getAll("teamId").map(String).filter(Boolean);
    const host = String(form.get("hostTeamId") ?? "");
    await updateMeet(db, meetId, {
      teamIds,
      // A host that isn't racing isn't the host, whatever the form said.
      hostTeamId: teamIds.includes(host) ? host : "",
    });
    return { ok: true };
  }

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
      by: actor,
    });
    return { ok: true, team };
  }

  /**
   * Who runs this meet, and the timing code — both behind the check above and
   * no other.
   *
   * `canEditMeet` is a row in `meet_admins` — the same one this whole action
   * is already gated on. Stepping down passes it for the same reason it
   * always did: you are only ever in that list if you are an administrator.
   */
  if (intent === "admin-add") {
    const userId = String(form.get("userId") ?? "");
    if (!userId) return { ok: false, error: "Which person?" };
    await addMeetAdmin(db, meetId, userId, actor);
    return { ok: true };
  }

  if (intent === "admin-remove") {
    const userId = String(form.get("userId") ?? "");
    const result = await removeMeetAdmin(db, meetId, userId);
    // Refusing to remove the last one is an ordinary answer the card shows,
    // not a failure — so it comes back as data rather than being thrown.
    return result.ok ? { ok: true } : { ok: false, error: result.reason };
  }

  /**
   * Somebody who may not have an account yet.
   *
   * `inviteUser` returns the existing account when the contact already has
   * one, so typing an address that turns out to belong to a member appoints
   * them rather than minting a second account for the same person.
   */
  if (intent === "admin-invite") {
    const parsed = parseContact(String(form.get("contact") ?? ""));
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const name = String(form.get("name") ?? "").trim() || null;
    const { user: invitee } = await inviteUser(db, parsed.contact, name);
    await addMeetAdmin(db, meetId, invitee.id, actor);

    // Resending replaces the outstanding link rather than adding a second.
    await supersedeInvites(db, { meetId, contact: parsed.contact.value });
    const token = await createInvite(
      db,
      { meetId, contact: parsed.contact.value },
      actor,
    );
    const link = `${appBaseUrl(request)}sign-in?invite=${encodeURIComponent(token)}`;
    const delivery = await sendMeetInvite(env, parsed.contact, link);

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
   * The QR code a timer scans.
   *
   * Issuing is also how you revoke — a coach who thinks a sheet has gone
   * walkabout taps the same button and prints a new one — which is why there
   * is no separate rotate. The link comes back exactly once.
   */
  if (intent === "grant-create") {
    const meet = await getMeet(db, meetId);
    if (!meet) return { ok: false, error: "No such meet" };
    const { token, expiresAt } = await issueGrant(db, {
      id: meet.id,
      date: meet.date,
    });
    return { ok: true, url: `${appBaseUrl(request)}t/${token}`, expiresAt };
  }

  if (intent === "grant-revoke") {
    await revokeGrants(db, meetId);
    return { ok: true };
  }

  if (intent === "delete") {
    await deleteMeet(db, meetId);
    return redirect("/meets");
  }

  return { ok: false };
}

/**
 * Details/seeding submit here first, on the client: merge the form onto
 * whatever's cached, broadcast-shaped as a `MEET_DETAILS` patch so
 * `meetCache` updates the same way a socket message would, then hand off to
 * the real request. Every other intent (teams, admins, invites, the timing
 * code, delete) has nothing cached to update optimistically, so it's just a
 * pass-through.
 */
export async function clientAction({
  params,
  request,
  serverAction,
}: Route.ClientActionArgs) {
  const meetId = params.meetId!;
  const form = await request.clone().formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "details" || intent === "seeding") {
    const cached = meetCache.getMeet(meetId);
    if (cached) {
      const details = nextDetails(cached.details, intent, form);
      meetCache.applyPatch(meetId, { type: "MEET_DETAILS", details }, () => {});
    }
  }

  return serverAction();
}

export default function MeetInfo({ loaderData }: Route.ComponentProps) {
  const { user, meet, admins, grant, teams, hostTeamId } = loaderData;
  const { details } = useMeet();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mayEdit = canEditMeet({ meet: meet ?? EMPTY_MEET_FACTS, user });

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          action={
            mayEdit ? (
              <Button size="sm" onClick={() => setEditing((v) => !v)}>
                {editing ? "Done" : "Edit"}
              </Button>
            ) : undefined
          }
        >
          {details.name}
        </SectionTitle>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {[
            meetSubtitle(details),
            details.date,
            courseLabel(details.course),
            `${details.laneCount} lanes`,
            details.timersPerLane > 1
              ? `${details.timersPerLane} timers a lane`
              : "",
            details.location,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </Card>

      {/* Editing is the same page with controls, not a different screen. A
          reader sees the settings; whoever runs the meet sees them and can
          change them. */}
      {editing && <DetailsEditor details={details} />}

      {/* Above seeding on purpose: assigning lanes needs to know which teams
          there are to assign them to. */}
      <TeamsCard
        teams={teams}
        hostTeamId={hostTeamId}
        canEdit={mayEdit}
        coachOf={user.coachOf}
      />

      {editing && <SeedingScoringEditor details={details} teams={teams} />}

      {/* Directly under who's racing, because they answer adjacent questions —
          which teams are in this, and who among everyone here decides it. */}
      <MeetAdmins admins={admins} youRunThis={mayEdit} />

      {mayEdit && <TimerAccess grant={grant} />}

      {mayEdit && (
        <Card>
          <SectionTitle>Delete</SectionTitle>
          {confirmDelete ? (
            <div className="space-y-2">
              <Banner tone="error">
                Deleting <strong>{details.name}</strong> can&rsquo;t be
                undone. The team rosters aren&rsquo;t touched.
              </Banner>
              <div className="grid grid-cols-2 gap-2">
                <Form method="post">
                  <input type="hidden" name="intent" value="delete" />
                  <Button type="submit" variant="danger" full>
                    Delete meet
                  </Button>
                </Form>
                <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" full onClick={() => setConfirmDelete(true)}>
              Delete this meet
            </Button>
          )}
        </Card>
      )}
    </div>
  );
}

/**
 * Who's racing, wired to the action.
 *
 * The picker hands back the complete resulting list and this submits it. A
 * `fetcher` rather than a navigation so adding an opponent doesn't scroll the
 * page back to the top mid-setup, and so the card can say it's working
 * without the whole screen going into a loading state.
 */
function TeamsCard({
  teams,
  hostTeamId,
  canEdit,
  coachOf,
}: {
  teams: Team[];
  hostTeamId: string;
  canEdit: boolean;
  coachOf: string[];
}) {
  const fetcher = useFetcher();

  return (
    <MeetTeams
      teams={teams}
      hostTeamId={hostTeamId}
      canEdit={canEdit}
      coachOf={coachOf}
      saving={fetcher.state !== "idle"}
      onChange={({ teamIds, hostTeamId }) => {
        const form = new FormData();
        form.set("intent", "teams");
        form.set("hostTeamId", hostTeamId);
        // Repeated rather than joined: `getAll` on the other side needs no
        // separator nobody can put in a team id.
        for (const id of teamIds) form.append("teamId", id);
        fetcher.submit(form, { method: "post" });
      }}
    />
  );
}

function DetailsEditor({ details }: { details: MeetDetails }) {
  const fetcher = useFetcher();

  return (
    <Card>
      <SectionTitle>Details</SectionTitle>
      <fetcher.Form method="post" className="space-y-3">
        <input type="hidden" name="intent" value="details" />
        <Field label="Name">
          <TextInput
            name="name"
            defaultValue={details.name}
            autoCapitalize="words"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput type="date" name="date" defaultValue={details.date} />
          </Field>
          <Field label="Type">
            <Select name="type" defaultValue={details.type}>
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
            <Select name="course" defaultValue={details.course}>
              {MEET_COURSES.map((c) => (
                <option key={c.value} value={c.value}>
                  {courseLabel(c.value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Lanes">
            <Select name="laneCount" defaultValue={details.laneCount}>
              {LANE_COUNTS.map((n: LaneCount) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {/* How many stopwatches stand behind a lane, which is a fact about
            the deck rather than a way of working: whether those watches
            report themselves from three phones or get read onto one sheet is
            answered on each phone, at the lane picker. */}
        <Field
          label="Timers per lane"
          hint={
            details.timersPerLane > 1
              ? "A timing phone can hold the sheet for all of them, or be one timer’s own watch."
              : "One watch a lane. Raise it and a phone can record every timer’s time on the lane."
          }
        >
          <Select name="timersPerLane" defaultValue={details.timersPerLane}>
            {TIMERS_PER_LANE.map((n: TimersPerLane) => (
              <option key={n} value={n}>
                {n === 1 ? "1 — one watch a lane" : `${n} watches a lane`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Location">
          <TextInput
            name="location"
            defaultValue={details.location ?? ""}
            autoCapitalize="words"
          />
        </Field>
        <label className="flex min-h-12 touch-manipulation items-center gap-3">
          <input
            type="checkbox"
            name="includeDiving"
            defaultChecked={details.includeDiving}
            className="h-6 w-6 rounded border-slate-300"
          />
          <span className="text-sm font-semibold">Include diving</span>
        </label>
        <label className="flex min-h-12 touch-manipulation items-center gap-3">
          <input
            type="checkbox"
            name="athletesMayEnter"
            defaultChecked={details.athletesMayEnter}
            className="h-6 w-6 rounded border-slate-300"
          />
          <span className="text-sm font-semibold">
            Swimmers may enter themselves
          </span>
        </label>
        <Field label="Who can see entries before the meet">
          <Select name="entryVisibility" defaultValue={details.entryVisibility}>
            <option value="everyone">Everyone</option>
            <option value="own-team">Coaches, their own team only</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" full>
          {fetcher.state === "submitting" ? "Saving…" : "Save details"}
        </Button>
      </fetcher.Form>
    </Card>
  );
}

/**
 * The rules the meet runs by: which lanes each team swims, and how places
 * turn into points.
 */
function SeedingScoringEditor({
  details,
  teams,
}: {
  details: MeetDetails;
  teams: Team[];
}) {
  const fetcher = useFetcher();

  return (
    <Card>
      <SectionTitle>Seeding &amp; scoring</SectionTitle>
      <fetcher.Form method="post" className="space-y-4">
        <input type="hidden" name="intent" value="seeding" />

        <div className="space-y-3">
          <span className="block text-sm font-semibold text-slate-600 dark:text-slate-300">
            Lanes
          </span>
          {teams.length === 0 ? (
            <p className="text-sm text-slate-500">
              Add the teams racing before assigning lanes.
            </p>
          ) : (
            teams.map((team) => (
              <Field key={team.id} label={team.name}>
                <TextInput
                  name={`lanes-${team.id}`}
                  defaultValue={formatNumberList(
                    details.laneAssignments[team.id] ?? [],
                  )}
                  placeholder="1, 3, 5"
                  inputMode="numeric"
                />
              </Field>
            ))
          )}
          <span className="block text-xs text-slate-500 dark:text-slate-400">
            Comma-separated lane numbers. In a dual meet the home team usually
            takes the odd lanes, the visitors the even ones.
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Individual points" hint="Best place first">
            <TextInput
              name="individualPoints"
              defaultValue={formatNumberList(details.scoring.individual)}
              placeholder="6, 4, 3, 2, 1"
            />
          </Field>
          <Field label="Relay points" hint="Best place first">
            <TextInput
              name="relayPoints"
              defaultValue={formatNumberList(details.scoring.relay)}
              placeholder="8, 4"
            />
          </Field>
        </div>

        <label className="flex min-h-12 touch-manipulation items-center gap-3">
          <input
            type="checkbox"
            name="separateByGender"
            defaultChecked={details.scoring.separateByGender}
            className="h-6 w-6 rounded border-slate-300"
          />
          <span className="text-sm font-semibold">
            Score girls and boys as separate contests
          </span>
        </label>

        <Button type="submit" variant="primary" full>
          {fetcher.state === "submitting"
            ? "Saving…"
            : "Save seeding & scoring"}
        </Button>
      </fetcher.Form>
    </Card>
  );
}
