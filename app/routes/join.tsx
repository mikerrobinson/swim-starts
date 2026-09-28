import { useEffect, useState } from "react";
import { useFetcher, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/join";
import {
  Banner,
  Button,
  Card,
  Field,
  SectionTitle,
  TextInput,
} from "~/components/ui";
import { currentUser } from "~/lib/api.server";
import { findOrCreateTeam } from "~/lib/new-team.server";
import { APP_HOME } from "./home";
import { describeContact } from "~/lib/identity";
import { useSession } from "~/state/session";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Find your team · Swim Starts" }];
}

/**
 * Starting a team from the one screen where you have none.
 *
 * The same rule as everywhere else — a name already here means the team that
 * has it — which on this screen is a happy answer rather than a refusal: the
 * person is looking for their school, and being handed it is what they came
 * for. If nobody coaches it they can take it on from the list above.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB;
  const user = await currentUser(request, db);
  if (!user) throw new Response("Sign in to start a team", { status: 403 });

  const name = String((await request.formData()).get("name") ?? "").trim();
  if (!name) return { ok: false as const, error: "A team needs a name." };

  const { created } = await findOrCreateTeam(db, {
    name,
    by: user.id,
    coachId: user.id,
  });
  return created
    ? { ok: true as const }
    : {
        ok: false as const,
        error: `${name} is already here. If nobody coaches it, take it on above; otherwise a coach there can add you.`,
      };
}

/**
 * Where a signed-in person with no team lands.
 *
 * Two ways out: a team nobody coaches yet — the ones that predate accounts,
 * and every school somebody typed in as an opponent — or nothing that fits, in
 * which case you're starting one.
 *
 * There is no third way, and there used to be: asking to join a team somebody
 * already coaches, and waiting to be approved. Getting onto a team that has a
 * coach is now the coach's move, exactly as it is for a meet — they add you by
 * name, or send you a link. Nobody waits on a screen for a decision that has
 * nowhere to be made.
 */
export default function Join() {
  const session = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const carried = params.get("notice");

  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [starting, setStarting] = useState(false);

  /**
   * Claiming, asked of the team's own page.
   *
   * The same `claim` intent its Coaches card submits, so there is one place
   * that decides whether a team is anybody's for the asking — reached from
   * here by naming the team in the action's URL rather than in a body.
   */
  const claiming = useFetcher<{ ok?: boolean; error?: string }>();
  const claimError = claiming.data?.ok === false ? claiming.data.error : null;

  /** Starting one, answered by this screen's own action. */
  const newTeam = useFetcher<typeof action>();
  const startError =
    newTeam.data && !newTeam.data.ok ? newTeam.data.error : null;

  /**
   * Leaving, in either direction.
   *
   * Signed out, there's nothing on this screen addressed to you — which is
   * also what happens right after signing out from it.
   *
   * Having a team to open is the other way out, and it's an effect rather than
   * something the buttons do for themselves: it can become true from
   * elsewhere. Tapping "Check again" after a coach has added you has to leave
   * this screen, and so does following an invite in another tab.
   */
  useEffect(() => {
    if (session.status === "out") navigate("/sign-in", { replace: true });
    else if (session.openTeamId) navigate(APP_HOME, { replace: true });
  }, [session.status, session.openTeamId, navigate]);

  // A claim that landed changes which teams this account coaches, which is
  // what the effect above is waiting on. Goes away with the provider, once the
  // session is served by a loader like everything else.
  useEffect(() => {
    if (claiming.state === "idle" && claiming.data?.ok) void session.refresh();
    // The session object is rebuilt each render; the answer is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claiming.state, claiming.data]);

  useEffect(() => {
    if (newTeam.state === "idle" && newTeam.data?.ok) void session.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newTeam.state, newTeam.data]);

  if (!session.user) {
    return (
      <main className="flex min-h-screen items-center justify-center text-slate-400">
        Loading…
      </main>
    );
  }

  /** Take on a team nobody coaches. The effect above decides where it leaves
   *  you, because it's the same answer as arriving already coaching one. */
  const claim = (teamId: string) => {
    setError(null);
    claiming.submit(
      { intent: "claim" },
      { method: "post", action: `/teams/${teamId}` },
    );
  };

  /** The server writes the team, its first season and the coach together. */
  const start = () => {
    setError(null);
    newTeam.submit({ name: name.trim() || "My Team" }, { method: "post" });
  };

  return (
    <main className="mx-auto max-w-md space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold">Find your team</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Signed in as {describeContact(session.user)}.
        </p>
      </div>

      {carried && <Banner tone="warn">{carried}</Banner>}
      {(error ?? claimError ?? startError) && (
        <Banner tone="error">{error ?? claimError ?? startError}</Banner>
      )}

      <Card>
        <SectionTitle>Start a new team</SectionTitle>
        {starting ? (
          <div className="space-y-3">
            <Field label="Team name">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Cactus Shadows High School"
                autoFocus
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="primary"
                disabled={newTeam.state !== "idle"}
                onClick={start}
              >
                Create
              </Button>
              <Button
                disabled={newTeam.state !== "idle"}
                onClick={() => setStarting(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              You&rsquo;ll be its coach, and can add others.
            </p>
            <div className="mt-3">
              <Button onClick={() => setStarting(true)}>New team</Button>
            </div>
          </>
        )}
      </Card>

      <div className="text-center">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void session.signOut()}
        >
          Sign out
        </Button>
      </div>
    </main>
  );
}
