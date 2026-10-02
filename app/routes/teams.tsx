import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/teams";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  SectionTitle,
  TextInput,
} from "~/components/ui";
import { Modal } from "~/components/Modal";
import { listPublicTeams } from "~/lib/public.server";
import { useSession } from "~/state/session";
import { currentUser } from "~/lib/api.server";
import { findOrCreateTeam } from "~/lib/new-team.server";
import { normalizeTeamCode } from "~/types/team";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Teams · Swim Starts" }];
}

/**
 * Every team this server knows about.
 *
 * Read on the server rather than from the store, because the store only ever
 * holds *your* team — and the whole point of this page is the ones that
 * aren't yours. No account needed: a team's name and size are on every heat
 * sheet already.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  if (!db) return { teams: [], offline: true };
  try {
    return { teams: await listPublicTeams(db), offline: false };
  } catch {
    return { teams: [], offline: true };
  }
}

/**
 * Starting one.
 *
 * The same shape as creating a meet, and for the same reason: the list of
 * teams is where you are when you notice yours isn't on it. Whoever fills the
 * form coaches it from that moment — a team created with nobody coaching it
 * would be indistinguishable from the unclaimed ones, and the next person
 * along could take it.
 *
 * A name that's already here is answered with the team that has it rather than
 * a second copy — `findOrCreateTeam`, the same rule the meet screens follow
 * when an opponent is typed in. The difference is only what to do about it:
 * there it is picked up and raced, here you are told, because somebody on this
 * page meant to start a team and should find out that theirs already exists.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB;
  const user = await currentUser(request, db);
  if (!user) throw new Response("Sign in to start a team", { status: 403 });

  const form = await request.formData();
  const name = String(form.get("name") ?? "")
    .trim()
    .slice(0, 80);
  if (!name) return { error: "A team needs a name." };

  const { team, created } = await findOrCreateTeam(db, {
    name,
    code: String(form.get("code") ?? "") || undefined,
    by: user.id,
    coachId: user.id,
  });

  if (!created) {
    return {
      error: team.claimed
        ? `${team.name} is already here. A coach there can add you.`
        : `${team.name} is already here, and nobody coaches it yet. Open it and take it on.`,
      teamId: team.id,
    };
  }

  return redirect(`/teams/${team.id}`);
}

export default function Teams({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { teams, offline } = loaderData;
  // Which of these are yours is which ones you coach — the page is a directory
  // of everyone's teams, and "yours" is just a heading on it.
  const session = useSession();
  const [adding, setAdding] = useState(false);
  const mineIds = new Set(session.teams.map((team) => team.teamId));

  const ours = teams.filter((t) => mineIds.has(t.id));
  const others = teams.filter((t) => !mineIds.has(t.id));

  return (
    <div className="space-y-4">
      {/* Yours, once you're signed in — empty included, because that's where
          the button to start one lives and a coach with no team yet is
          exactly who needs it. */}
      {session.status === "in" && (
        <Card>
          <SectionTitle
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => setAdding(true)}
              >
                + Team
              </Button>
            }
          >
            {ours.length === 1 ? "Your team" : "Your teams"}
          </SectionTitle>

          {ours.length === 0 ? (
            <EmptyState title="You don't coach a team yet">
              Start one and it&rsquo;s yours. If yours is already in the list
              below with no coach, open it and take it on instead.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {ours.map((team) => (
                <TeamRow key={team.id} team={team} />
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card>
        <SectionTitle>
          {ours.length > 0
            ? `Other teams (${others.length})`
            : `Teams (${teams.length})`}
        </SectionTitle>

        {others.length === 0 ? (
          <EmptyState
            title={offline ? "Can't reach the server" : "No other teams yet"}
          >
            {offline
              ? "This list lives on the server. Your own team and meets keep working without it."
              : "A team appears here once someone races it — including opponents typed in while setting up a meet."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {others.map((team) => (
              <TeamRow key={team.id} team={team} />
            ))}
          </ul>
        )}
      </Card>

      {adding && (
        <NewTeamSheet
          error={actionData?.error}
          teamId={actionData?.teamId}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

/**
 * Setting one up.
 *
 * A plain form posting to this route's action, exactly as a new meet is — no
 * state beyond whether the sheet is open, because nothing here needs deciding
 * before it's submitted.
 */
function NewTeamSheet({
  error,
  teamId,
  onClose,
}: {
  error?: string;
  teamId?: string;
  onClose: () => void;
}) {
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const [name, setName] = useState("");

  return (
    <Modal title="New team" onClose={onClose}>
      <Form method="post" className="space-y-3">
        {error && (
          <Banner tone="error">
            {error}
            {teamId && (
              <>
                {" "}
                <Link
                  to={`/teams/${teamId}`}
                  className="font-semibold underline"
                >
                  Open it
                </Link>
              </>
            )}
          </Banner>
        )}

        <Field label="Name">
          <TextInput
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Cactus Shadows High School"
            autoCapitalize="words"
            autoFocus
          />
        </Field>

        <Field
          label="Code"
          hint="What it's called on a heat sheet. Left blank, it's made from the name."
        >
          <TextInput
            name="code"
            placeholder={normalizeTeamCode(name) || "CACTUS"}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
        </Field>

        <p className="text-xs text-slate-500 dark:text-slate-400">
          You&rsquo;ll be its coach. Add the roster, its seasons and the other
          coaches on the team&rsquo;s own page.
        </p>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          full
          disabled={saving || !name.trim()}
        >
          {saving ? "Creating…" : "Create team"}
        </Button>
      </Form>
    </Modal>
  );
}

function TeamRow({
  team,
}: {
  team: {
    id: string;
    name: string;
    code: string;
    claimed: boolean;
    athletes: number;
    meets: number;
  };
}) {
  return (
    <li>
      <Link
        to={`/teams/${team.id}`}
        className="flex items-center justify-between gap-3 py-3"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate font-semibold">{team.name}</span>
            {team.code && (
              <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {team.code}
              </span>
            )}
            {/* Worth saying plainly: an unclaimed team is one anybody may
                still claim, which is how a coach takes over the placeholder
                an opponent created for them. */}
            {!team.claimed && (
              <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                unclaimed
              </span>
            )}
          </span>
          <span className="block text-xs text-slate-500">
            {team.athletes} athlete{team.athletes === 1 ? "" : "s"} ·{" "}
            {team.meets} meet{team.meets === 1 ? "" : "s"}
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-slate-400">
          ›
        </span>
      </Link>
    </li>
  );
}
