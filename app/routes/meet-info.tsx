import { useState } from "react";
import { Form, redirect, useFetcher, useLoaderData } from "react-router";
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
import { downloadFile, resultsToCsv } from "~/lib/csv";
import { eventClosed, recordedCount } from "~/lib/timing";
import {
  appBaseUrl,
  currentUser,
  requireDb,
  type SyncEnv,
} from "~/lib/api.server";
import { addMeetAdmin, meetAdmins, removeMeetAdmin } from "~/lib/admins.server";
import { findOrCreateTeam } from "~/lib/new-team.server";
import { activeGrant, issueGrant, revokeGrants } from "~/lib/grants.server";
import { createInvite, inviteUser, supersedeInvites } from "~/lib/auth.server";
import { parseContact } from "~/lib/identity";
import { revealsCodes, sendMeetInvite } from "~/lib/notify.server";
import { mayEditMeet } from "~/lib/access";
import { meetAccess } from "~/lib/access.server";
import {
  addEvent,
  addEventsToMeet,
  deleteMeet,
  getMeet,
  meetDetail,
  removeEvent,
  setEventOrder,
  updateMeet,
} from "~/lib/meets.server";
import { renumber, withDiving, withoutDiving } from "~/lib/events";
import { useMeet } from "./meet-layout";
import {
  courseLabel,
  eventName,
  formatNumberList,
  isLaneCount,
  isMeetCourse,
  isTimersPerLane,
  LANE_COUNTS,
  MEET_COURSES,
  MEET_TYPES,
  meetSubtitle,
  parseNumberList,
  STROKES,
  TIMERS_PER_LANE,
  type EventGender,
  type LaneAssignments,
  type LaneCount,
  type MeetType,
  type ScoringRules,
  type TimersPerLane,
  type Stroke,
} from "~/types/meet";

/**
 * The two things on this page that aren't in the meet document: who runs it,
 * and whether a timing code is live.
 *
 * Loaded here rather than fetched by the cards that show them. Each used to
 * hold its own list behind a `useEffect`, which cost two round trips after the
 * page had already rendered and left two more copies of "loading / working /
 * that didn't work" to keep honest.
 *
 * The full `MeetDetail` is read here too, now that `meet-layout`'s own loader
 * is metadata + access only (see its doc comment) — this screen is exactly
 * the "still simplest as a plain D1 read" case: the programme, the entry
 * count, the export buttons, none of it live or high-frequency.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const user = await currentUser(request, env);

  const [detail, admins, grant] = await Promise.all([
    meetDetail(db, params.meetId),
    meetAdmins(db, params.meetId),
    // Whether a sheet is live and when it dies — never the token itself.
    // That is handed over exactly once, by the action that mints it.
    user ? activeGrant(db, params.meetId) : null,
  ]);

  return { detail, admins, grant };
}

/** This screen's own `meetDetail` read — see the loader's doc comment. Not
 *  `useMeet()`, which only carries the meet's metadata now. */
function useDetail() {
  return useLoaderData<typeof loader>().detail!;
}

/**
 * Everything that changes a meet, behind one check.
 *
 * `mayEditMeet` is asked here, against the same request that loaded the rows —
 * so the screen and the server cannot disagree about whether you run this
 * meet. The old split, where the page rendered from a local copy and asked a
 * separate endpoint about permissions, is what hid the Edit button on meets
 * their own creator had made.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as SyncEnv;
  const db = requireDb(env);
  const user = await currentUser(request, env);
  const access = await meetAccess(db, params.meetId, user);
  if (!mayEditMeet(access) || !access.userId) {
    throw new Response("Whoever is running this meet decides that.", { status: 403 });
  }
  // Who is doing it, recorded against the rows that remember who let somebody
  // in. Pulled out here because `mayEditMeet` is `access.admin`, which nobody
  // signed out can be — so past this line there is always somebody to name.
  const actor = access.userId;

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "details") {
    const lanes = Number(form.get("laneCount"));
    const timers = Number(form.get("timersPerLane"));
    const course = form.get("course");
    await updateMeet(db, params.meetId, {
      name: String(form.get("name") ?? "").trim() || "Meet",
      date: String(form.get("date") ?? ""),
      type: String(form.get("type") ?? "dual") as MeetType,
      course: isMeetCourse(course) ? course : "SCY",
      location: String(form.get("location") ?? "").trim(),
      laneCount: isLaneCount(lanes) ? lanes : 6,
      timersPerLane: isTimersPerLane(timers) ? timers : 1,
    });
    return { ok: true };
  }

  /**
   * How the deck is laid out and how it's scored — not derived from anything
   * else, since a coach setting up the meet is the only one who knows either.
   *
   * Lane fields arrive one per racing team, named `lanes-<teamId>`; a team the
   * form doesn't mention (dropped from the meet since the page loaded, say)
   * just doesn't end up in the map rather than erroring.
   */
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
    await updateMeet(db, params.meetId, { laneAssignments, scoring });
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
    await updateMeet(db, params.meetId, {
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

  if (intent === "add-event") {
    await addEvent(db, params.meetId, {
      distance: Number(form.get("distance")) || 50,
      stroke: String(form.get("stroke") ?? "Free") as Stroke,
      gender: String(form.get("gender") ?? "Open") as EventGender,
    });
    return { ok: true };
  }

  if (intent === "remove-event") {
    await removeEvent(db, String(form.get("eventId")));
    return { ok: true };
  }

  if (intent === "reorder") {
    await setEventOrder(db, form.getAll("eventId").map(String));
    return { ok: true };
  }

  if (intent === "diving") {
    // The lineup is the truth about diving; the option just reports it.
    const on = form.get("includeDiving") === "on";
    const events = JSON.parse(String(form.get("events"))) as Parameters<
      typeof addEventsToMeet
    >[2];
    const next = on
      ? withDiving(params.meetId, events, form.get("leadGender") === "M" ? "M" : "F")
      : withoutDiving(events);
    await updateMeet(db, params.meetId, { includeDiving: on });
    // Only the diving rows change; everything else keeps its id and position.
    const added = next.filter((e) => !events.some((o) => o.id === e.id));
    const gone = events.filter((e) => !next.some((o) => o.id === e.id));
    for (const event of gone) await removeEvent(db, event.id);
    if (added.length) await addEventsToMeet(db, params.meetId, added);
    await setEventOrder(db, renumber(next).map((e) => e.id));
    return { ok: true };
  }

  /**
   * Who runs this meet, and the timing code — both behind the check above and
   * no other.
   *
   * `mayEditMeet` is `access.admin`, which is the row in `meet_admins` that
   * the two endpoints this replaced each looked up a second time for
   * themselves. Stepping down passes it for the same reason it always did:
   * you are only ever in that list if you are an administrator.
   */
  if (intent === "admin-add") {
    const userId = String(form.get("userId") ?? "");
    if (!userId) return { ok: false, error: "Which person?" };
    await addMeetAdmin(db, params.meetId, userId, actor);
    return { ok: true };
  }

  if (intent === "admin-remove") {
    const userId = String(form.get("userId") ?? "");
    const result = await removeMeetAdmin(db, params.meetId, userId);
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
    await addMeetAdmin(db, params.meetId, invitee.id, actor);

    // Resending replaces the outstanding link rather than adding a second.
    await supersedeInvites(db, {
      meetId: params.meetId,
      contact: parsed.contact.value,
    });
    const token = await createInvite(
      db,
      { meetId: params.meetId, contact: parsed.contact.value },
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
   * The meet's own date is read here rather than accepted from the form: a
   * screen may ask for a code, it doesn't get to say when the code expires.
   * Issuing is also how you revoke — a coach who thinks a sheet has gone
   * walkabout taps the same button and prints a new one — which is why there
   * is no separate rotate. The link comes back exactly once.
   */
  if (intent === "grant-create") {
    const meet = await getMeet(db, params.meetId);
    if (!meet) return { ok: false, error: "No such meet" };
    const { token, expiresAt } = await issueGrant(db, {
      id: meet.id,
      date: meet.date,
    });
    return { ok: true, url: `${appBaseUrl(request)}t/${token}`, expiresAt };
  }

  if (intent === "grant-revoke") {
    await revokeGrants(db, params.meetId);
    return { ok: true };
  }

  if (intent === "delete") {
    await deleteMeet(db, params.meetId);
    return redirect("/meets");
  }

  return { ok: false };
}

export default function MeetInfo({ loaderData }: Route.ComponentProps) {
  const { admins, grant } = loaderData;
  const detail = loaderData.detail!;
  const { access } = useMeet();
  const { meet, events, entries, swims } = detail;
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mayEdit = mayEditMeet(access);

  const entryCount = Object.values(entries).reduce((n, ids) => n + ids.length, 0);
  const times = recordedCount(detail);
  const stats = [
    { label: "Events", value: events.length },
    { label: "Entries", value: entryCount },
    { label: "Swims", value: swims.length },
    { label: "Times", value: times },
  ];

  const slug = `${meet.name.replace(/[^\w-]+/g, "-").toLowerCase()}-${meet.date}`;

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
          {meet.name}
        </SectionTitle>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {[
            meetSubtitle(meet),
            meet.date,
            courseLabel(meet.course),
            `${meet.laneCount} lanes`,
            meet.timersPerLane > 1 ? `${meet.timersPerLane} timers a lane` : "",
            meet.location,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>

        <dl className="mt-4 grid grid-cols-4 gap-2">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-xl bg-slate-100 p-2 text-center dark:bg-slate-800"
            >
              <dd className="text-xl font-bold">{stat.value}</dd>
              <dt className="text-xs text-slate-500 dark:text-slate-400">
                {stat.label}
              </dt>
            </div>
          ))}
        </dl>
      </Card>

      {/* Editing is the same page with controls, not a different screen. A
          reader sees the lineup; whoever runs the meet sees the lineup and can
          change it. */}
      {editing && <DetailsEditor />}

      {/* Above the lineup on purpose: who is racing decides whose roster the
          entries grid can draw from, so it is the first thing to get right
          and the first thing to notice is wrong. */}
      <MeetTeamsCard />

      {/* Below who's racing, on purpose: assigning lanes needs to know which
          teams there are to assign them to. */}
      {editing && <SeedingScoringEditor />}

      {/* Directly under who's racing, because they answer adjacent questions —
          which teams are in this, and who among everyone here decides it. */}
      <MeetAdmins admins={admins} youRunThis={access.admin} />

      <EventList editing={editing} />

      {mayEdit && <TimerAccess grant={grant} />}

      <Card>
        <SectionTitle>Export</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Button
            disabled={times === 0}
            onClick={() =>
              downloadFile(`${slug}-results.csv`, resultsToCsv(detail), "text/csv")
            }
          >
            Results CSV
          </Button>
          <Button
            onClick={() =>
              downloadFile(
                `${slug}.json`,
                JSON.stringify(detail, null, 2),
                "application/json",
              )
            }
          >
            Meet JSON
          </Button>
        </div>

        {mayEdit && (
          <>
            <hr className="my-4 border-slate-200 dark:border-slate-800" />
            {confirmDelete ? (
              <div className="space-y-2">
                <Banner tone="error">
                  Deleting <strong>{meet.name}</strong> removes its events,
                  entries and {times} recorded time{times === 1 ? "" : "s"}. The
                  team roster isn&rsquo;t touched. This can&rsquo;t be undone.
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
          </>
        )}
      </Card>
    </div>
  );
}

/** Name, date, type, course, lanes, location — one form, one write. */
/**
 * Who's racing, wired to the action.
 *
 * The picker hands back the complete resulting list and this submits it. A
 * `fetcher` rather than a navigation so adding an opponent doesn't scroll the
 * page back to the top mid-setup, and so the card can say it's working
 * without the whole screen going into a loading state.
 */
function MeetTeamsCard() {
  const detail = useDetail();
  const { access } = useMeet();
  const fetcher = useFetcher();

  return (
    <MeetTeams
      detail={detail}
      canEdit={mayEditMeet(access)}
      coachOf={access.coachOf}
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

/**
 * The rules the meet runs by: which lanes each team swims, and how places
 * turn into points.
 *
 * Both are configuration only — nothing downstream reads either yet. They're
 * asked for here anyway because a coach setting a meet up knows both answers
 * at setup time, and the alternative is asking again later when nobody
 * remembers what was agreed on deck.
 */
function SeedingScoringEditor() {
  const detail = useDetail();
  const { meet, teams } = detail;
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
                  defaultValue={formatNumberList(meet.laneAssignments[team.id] ?? [])}
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
              defaultValue={formatNumberList(meet.scoring.individual)}
              placeholder="6, 4, 3, 2, 1"
            />
          </Field>
          <Field label="Relay points" hint="Best place first">
            <TextInput
              name="relayPoints"
              defaultValue={formatNumberList(meet.scoring.relay)}
              placeholder="8, 4"
            />
          </Field>
        </div>

        <label className="flex min-h-12 touch-manipulation items-center gap-3">
          <input
            type="checkbox"
            name="separateByGender"
            defaultChecked={meet.scoring.separateByGender}
            className="h-6 w-6 rounded border-slate-300"
          />
          <span className="text-sm font-semibold">
            Score girls and boys as separate contests
          </span>
        </label>

        <Button type="submit" variant="primary" full>
          {fetcher.state === "submitting" ? "Saving…" : "Save seeding & scoring"}
        </Button>
      </fetcher.Form>
    </Card>
  );
}

function DetailsEditor() {
  const detail = useDetail();
  const { meet } = detail;
  const fetcher = useFetcher();

  return (
    <Card>
      <SectionTitle>Details</SectionTitle>
      <fetcher.Form method="post" className="space-y-3">
        <input type="hidden" name="intent" value="details" />
        <Field label="Name">
          <TextInput name="name" defaultValue={meet.name} autoCapitalize="words" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput type="date" name="date" defaultValue={meet.date} />
          </Field>
          <Field label="Type">
            <Select name="type" defaultValue={meet.type}>
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
            <Select name="course" defaultValue={meet.course}>
              {MEET_COURSES.map((c) => (
                <option key={c.value} value={c.value}>
                  {courseLabel(c.value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Lanes">
            <Select name="laneCount" defaultValue={meet.laneCount}>
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
            meet.timersPerLane > 1
              ? "A timing phone can hold the sheet for all of them, or be one timer\u2019s own watch."
              : "One watch a lane. Raise it and a phone can record every timer\u2019s time on the lane."
          }
        >
          <Select name="timersPerLane" defaultValue={meet.timersPerLane}>
            {TIMERS_PER_LANE.map((n: TimersPerLane) => (
              <option key={n} value={n}>
                {n === 1 ? "1 \u2014 one watch a lane" : `${n} watches a lane`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Location">
          <TextInput
            name="location"
            defaultValue={meet.location ?? ""}
            autoCapitalize="words"
          />
        </Field>
        <Button type="submit" variant="primary" full>
          {fetcher.state === "submitting" ? "Saving…" : "Save details"}
        </Button>
      </fetcher.Form>
    </Card>
  );
}

/**
 * The running order.
 *
 * Read-only it shows how far along the meet is, marking events official —
 * derived from every lane having been signed off, so it can't claim more than
 * the calls underneath it. Editing adds the controls in place.
 */
function EventList({ editing }: { editing: boolean }) {
  const detail = useDetail();
  const { events, entries } = detail;
  const fetcher = useFetcher();

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= events.length) return;
    const order = events.map((e) => e.id);
    [order[index], order[target]] = [order[target], order[index]];
    const data = new FormData();
    data.set("intent", "reorder");
    for (const id of order) data.append("eventId", id);
    fetcher.submit(data, { method: "post" });
  };

  return (
    <Card>
      <SectionTitle>Events ({events.length})</SectionTitle>
      {events.length === 0 ? (
        <p className="text-sm text-slate-500">No events yet.</p>
      ) : (
        <ol className="divide-y divide-slate-100 dark:divide-slate-800">
          {events.map((event, index) => {
            const entered = (entries[event.id] ?? []).length;
            const official = eventClosed(detail, event.id);
            return (
              <li key={event.id} className="flex items-center gap-2 py-2 text-sm">
                <span className="w-6 text-right tabular-nums text-slate-400">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {eventName(event)}
                </span>
                {official && (
                  <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                    official
                  </span>
                )}
                <span className="shrink-0 text-xs text-slate-500">
                  {entered} entered
                </span>
                {editing && (
                  <span className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" onClick={() => move(index, -1)}>
                      ↑
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => move(index, 1)}>
                      ↓
                    </Button>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="remove-event" />
                      <input type="hidden" name="eventId" value={event.id} />
                      <Button
                        type="submit"
                        size="sm"
                        variant="ghost"
                        title={
                          official
                            ? "This event has official results — removing it discards them."
                            : "Remove this event"
                        }
                      >
                        ✕
                      </Button>
                    </fetcher.Form>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {editing && (
        <fetcher.Form method="post" className="mt-3 flex items-end gap-2">
          <input type="hidden" name="intent" value="add-event" />
          <Field label="Distance">
            <TextInput
              name="distance"
              type="number"
              defaultValue={50}
              inputMode="numeric"
              className="w-20"
            />
          </Field>
          <Field label="Stroke">
            <Select name="stroke" defaultValue="Free">
              {STROKES.map((stroke) => (
                <option key={stroke} value={stroke}>
                  {stroke}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Gender">
            <Select name="gender" defaultValue="F">
              <option value="F">Girls</option>
              <option value="M">Boys</option>
              <option value="Open">Open</option>
            </Select>
          </Field>
          <Button type="submit" variant="primary">
            Add
          </Button>
        </fetcher.Form>
      )}
    </Card>
  );
}
