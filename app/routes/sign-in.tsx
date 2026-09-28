import { useEffect, useRef, useState } from "react";
import { redirect, useFetcher, useSearchParams } from "react-router";
import type { Route } from "./+types/sign-in";
import { Banner, Button, Card, Field, TextInput } from "~/components/ui";
import { appBaseUrl, currentUser } from "~/lib/api.server";
import {
  createSession,
  inspectInvite,
  redeemInvite,
  sessionCookie,
  sessionPayload,
  startChallenge,
  verifyChallenge,
} from "~/lib/auth.server";
import {
  CODE_LENGTH,
  maskContact,
  messageFor,
  normalizeCode,
  parseContact,
} from "~/lib/identity";
import { revealsCodes, sendLoginCode } from "~/lib/notify.server";
import { APP_HOME } from "./home";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Sign in · Swim Starts" }];
}

/**
 * What the link in the address bar is for, and whether you need this screen.
 *
 * Somebody already signed in has nothing to do here, so they are sent on
 * before the page renders rather than by an effect once it has — unless they
 * are holding an invitation, which is redeemed by signing in and so has to
 * wait for them to do it.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  const token = new URL(request.url).searchParams.get("invite");

  if (!token) {
    const user = await currentUser(request, db);
    if (user) {
      const { openTeamId } = await sessionPayload(db, user);
      return redirect(openTeamId ? APP_HOME : "/join");
    }
    return { invited: null, inviteError: null };
  }

  // Tagged, so the heading can say "coach Horizon" or "help run Tuesday's
  // meet" rather than guessing from which fields are present. Holding the
  // token is the whole credential, and it says nothing beyond the name.
  const invited = await inspectInvite(db, token);
  return invited
    ? { invited, inviteError: null }
    : {
        invited: null,
        inviteError: "That invitation has expired or been used.",
      };
}

/**
 * Signing in, in the two steps it takes.
 *
 * Both halves are here rather than behind endpoints of their own, so the
 * screen and the rules it obeys are one file. The second step ends in a
 * redirect: where somebody lands depends on what the server just learned —
 * whether an invitation named a meet, and whether they coach anything yet —
 * and that is known here and nowhere earlier.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB;

  const form = await request.formData();
  const parsed = parseContact(String(form.get("contact") ?? ""));
  if (!parsed.ok) return { ok: false as const, error: parsed.error };

  if (String(form.get("intent")) === "send-code") {
    const started = await startChallenge(db, parsed.contact);
    if (!started.ok) {
      return {
        ok: false as const,
        error: `A code has just been sent. Try again in ${Math.ceil(started.retryInMs / 1000)}s.`,
      };
    }

    // The message carries a link back here with both halves already in it,
    // which is what lets this screen arrive part-way through and finish on
    // its own.
    const link = `${appBaseUrl(request)}sign-in?contact=${encodeURIComponent(
      parsed.contact.value,
    )}&code=${started.code}`;
    const delivery = await sendLoginCode(
      context.cloudflare.env,
      parsed.contact,
      started.code,
      link,
    );

    return {
      ok: true as const,
      sent: delivery.sent,
      // The canonical contact, which is what the second step must be given.
      contact: parsed.contact.value,
      masked: maskContact(parsed.contact),
      detail: delivery.detail,
      // Only when the server is explicitly running in local mode. Everywhere
      // else the code exists solely in the message that was sent.
      ...(revealsCodes(context.cloudflare.env) ? { code: started.code } : {}),
    };
  }

  const result = await verifyChallenge(
    db,
    parsed.contact,
    String(form.get("code") ?? ""),
  );
  if (!result.ok)
    return { ok: false as const, error: messageFor(result.check) };

  /**
   * An invitation is redeemed in the same request rather than after it.
   *
   * Following a link, signing in, and finding you still aren't on the team is
   * the failure this avoids — and doing both together means there is no window
   * where the account exists but the membership doesn't. A spent link doesn't
   * fail the sign-in: they are signed in either way, and being told so while
   * also being told the link is stale beats being bounced back to a screen
   * that says nothing.
   */
  const token = String(form.get("invite") ?? "");
  let invitedTeamId: string | null = null;
  let invitedMeetId: string | null = null;
  let inviteError: string | null = null;
  if (token) {
    const redeemed = await redeemInvite(db, token, result.user.id);
    if (!redeemed.ok) inviteError = redeemed.error;
    else if (redeemed.kind === "meet") invitedMeetId = redeemed.meetId;
    else invitedTeamId = redeemed.teamId;
  }

  const session = await createSession(db, result.user.id);
  const { openTeamId } = await sessionPayload(db, result.user, invitedTeamId);

  // Where to land. A meet invitation names its own destination — that is the
  // whole point of one — and anything else falls back to the ordinary "do you
  // have a team yet" question.
  const to = invitedMeetId
    ? `/meets/${encodeURIComponent(invitedMeetId)}`
    : openTeamId
      ? APP_HOME
      : "/join";

  // Carried in the URL so it can be said wherever they land, rather than
  // dropping them there unexplained.
  const notice = inviteError
    ? `?notice=${encodeURIComponent(inviteError)}`
    : "";

  return redirect(`${to}${notice}`, {
    headers: { "set-cookie": sessionCookie(session, request) },
  });
}

/**
 * Signing in, which is also signing up.
 *
 * Type a contact, read the code that arrives, and you're in — a contact nobody
 * has used before becomes an account on the way through. There's no password
 * to choose or forget, and nothing else to fill in: the only fact the app
 * needs about a coach is somewhere it can reach them.
 *
 * The email also carries a link back here with the contact and code already
 * in it, which is why this screen can arrive part-way through and finish on
 * its own.
 */
export default function SignIn({ loaderData }: Route.ComponentProps) {
  const { invited, inviteError } = loaderData;
  const [params] = useSearchParams();
  const fetcher = useFetcher<typeof action>();

  const invite = params.get("invite");
  const [step, setStep] = useState<"contact" | "code">("contact");
  // A meet invitation was sent to a particular address, and that address is
  // the one that redeems it. Filling it in saves them typing it, and saves the
  // "code went to the wrong place" failure when they don't.
  const [contact, setContact] = useState(
    invited?.kind === "meet" ? (invited.contact ?? "") : "",
  );
  const [code, setCode] = useState("");

  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const error = result && !result.ok ? result.error : null;
  const sent = result && result.ok ? result : null;
  const notice =
    sent && !sent.sent
      ? `${sent.detail ?? "Nothing was sent."} The code is in the server log.`
      : null;

  // A code went out, so ask for it back. In dev it is handed straight over,
  // which is the whole reason `AUTH_DEV_CODES` exists.
  useEffect(() => {
    if (!sent) return;
    setStep("code");
    if (sent.code) setCode(sent.code);
  }, [sent]);

  const send = (forContact: string) =>
    fetcher.submit(
      { intent: "send-code", contact: forContact },
      { method: "post" },
    );

  const verify = (forContact: string, submitted: string) =>
    fetcher.submit(
      {
        intent: "verify-code",
        contact: forContact,
        code: submitted,
        ...(invite ? { invite } : {}),
      },
      { method: "post" },
    );

  /**
   * The emailed link lands here with both halves already filled in.
   *
   * Done once and guarded, because a re-render must not spend the code a
   * second time — and a code is good for exactly one attempt.
   */
  const autoTried = useRef(false);
  useEffect(() => {
    const linkContact = params.get("contact");
    const linkCode = params.get("code");
    if (!linkContact || !linkCode || autoTried.current) return;
    autoTried.current = true;
    setContact(linkContact);
    setCode(normalizeCode(linkCode));
    setStep("code");
    verify(linkContact, linkCode);
    // Submitting is the effect; what to submit comes from the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const ready = normalizeCode(code).length === CODE_LENGTH;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold">Swim Starts</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {invited === null
            ? "Sign in with your email or mobile number."
            : invited.kind === "meet"
              ? `Sign in to help run ${invited.name}.`
              : `Sign in to coach ${invited.name}.`}
        </p>
      </div>

      {inviteError && (
        <div className="mb-4">
          <Banner tone="warn">
            {inviteError} You can still sign in — you&rsquo;ll just need whoever
            sent it to invite you again.
          </Banner>
        </div>
      )}

      <Card>
        {step === "contact" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(contact);
            }}
          >
            <Field
              label="Email or mobile"
              hint="We'll send a six-digit code. No password to remember."
            >
              <TextInput
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                // A single field for both, so nobody has to pick a kind before
                // typing the thing that already says which kind it is.
                inputMode="email"
                autoComplete="username"
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="you@school.org or (480) 555-0134"
                autoFocus
              />
            </Field>
            <div className="mt-4">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                full
                disabled={busy || !contact.trim()}
              >
                {busy ? "Sending…" : "Send code"}
              </Button>
            </div>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              verify(sent?.contact ?? contact, code);
            }}
          >
            <Field
              label="Code"
              hint={
                sent
                  ? `Sent to ${sent.masked}. It's good for ten minutes.`
                  : "Enter the code you were sent."
              }
            >
              <TextInput
                value={code}
                onChange={(e) => setCode(normalizeCode(e.target.value))}
                // `one-time-code` is what lets iOS and Android offer the code
                // from the notification instead of making anyone retype it.
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                className="text-center text-2xl tracking-[0.4em]"
                autoFocus
              />
            </Field>
            <div className="mt-4">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                full
                disabled={busy || !ready}
              >
                {busy ? "Checking…" : "Sign in"}
              </Button>
            </div>
            <div className="mt-3 flex justify-between">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setStep("contact");
                  setCode("");
                }}
              >
                Use a different one
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => send(sent?.contact ?? contact)}
              >
                Send again
              </Button>
            </div>
          </form>
        )}

        {error && (
          <div className="mt-3">
            <Banner tone="error">{error}</Banner>
          </div>
        )}
        {notice && (
          <div className="mt-3">
            <Banner tone="warn">{notice}</Banner>
          </div>
        )}
      </Card>

      <p className="mt-6 text-center text-xs text-slate-500 dark:text-slate-400">
        Timing a lane? You don&rsquo;t need an account — use the link or QR code
        your coach gives you on the day.
      </p>
    </main>
  );
}
