import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import type { Route } from "./+types/profile";
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
import { currentUser } from "~/lib/api.server";
import {
  addIdentity,
  consumeLoginCode,
  identitiesFor,
  removeIdentity,
  setName as setAccountName,
  startChallenge,
} from "~/lib/auth.server";
import { maskContact, parseContact } from "~/lib/identity";
import { revealsCodes, sendLoginCode } from "~/lib/notify.server";
import { useSession } from "~/state/session";
import { useViewPrefs } from "~/state/view-prefs";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Profile · Swim Starts" }];
}

/** Your name and your contacts, or null when nobody is signed in. */
export async function loader({ request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  const user = await currentUser(request, db);
  // Signed out is the ordinary state of a fresh device, not an error — so it
  // is an empty page rather than a 401 the screen has to catch.
  if (!user) return { profile: null };

  return {
    profile: {
      name: user.name,
      identities: await identitiesFor(db, user.id),
    },
  };
}

/**
 * Your name, and attaching or detaching a way to sign in.
 *
 * Adding a contact goes through the same challenge as signing in, and that
 * isn't ceremony: an address you can't read isn't yours, and without the proof
 * anyone could attach someone else's email to their own account and then use
 * it to sign in as them.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB;
  const user = await currentUser(request, db);
  if (!user) throw new Response("Sign in first.", { status: 401 });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "rename") {
    await setAccountName(
      db,
      user.id,
      String(form.get("name") ?? "")
        .trim()
        .slice(0, 80),
    );
    return { ok: true, renamed: true };
  }

  if (intent === "contact-remove") {
    const result = await removeIdentity(
      db,
      user.id,
      String(form.get("contact") ?? ""),
    );
    return result.ok ? { ok: true } : { ok: false, error: result.reason };
  }

  const parsed = parseContact(String(form.get("contact") ?? ""));
  if (!parsed.ok) return { ok: false, error: parsed.error };

  /**
   * Send a code to an address that isn't yet yours.
   *
   * The same path as signing in, so the same rate limit and the same expiry
   * apply — but with no sign-in link attached, because this code attaches a
   * contact to an account you are already inside and a link to the sign-in
   * screen would be the wrong door.
   */
  if (intent === "contact-start") {
    const start = await startChallenge(db, parsed.contact);
    if (!start.ok) {
      return {
        ok: false,
        error: `A code has just been sent. Try again in ${Math.ceil(start.retryInMs / 1000)}s.`,
      };
    }
    const delivery = await sendLoginCode(
      context.cloudflare.env,
      parsed.contact,
      start.code,
      "",
    );
    return {
      ok: true,
      contact: parsed.contact.value,
      masked: maskContact(parsed.contact),
      detail: delivery.detail,
      // Only ever in development, where no provider is configured.
      ...(revealsCodes(context.cloudflare.env) ? { code: start.code } : {}),
    };
  }

  if (intent === "contact-verify") {
    // `consumeLoginCode`, not `verifyChallenge`: the code proves you can read
    // the contact, and nothing more. Verifying here would mint an account for
    // the new contact, which would then own it and refuse the attach below.
    const spent = await consumeLoginCode(
      db,
      parsed.contact,
      String(form.get("code") ?? ""),
    );
    if (!spent.ok) {
      return { ok: false, error: "That code didn't work. Ask for a new one." };
    }
    const result = await addIdentity(db, user.id, parsed.contact);
    return result.ok
      ? { ok: true, added: true }
      : { ok: false, error: result.reason };
  }

  return { ok: false };
}

/**
 * Your name, and the ways you can sign in.
 *
 * The contacts are the interesting half. A person isn't one email address — a
 * coach has a school address and a mobile, and either should open the same
 * account rather than minting a second one that owns none of their teams.
 */
/** Whatever the action last answered, whichever intent was used. */
interface ProfileResult {
  ok?: boolean;
  error?: string;
  renamed?: boolean;
  added?: boolean;
  /** Echoed back by `contact-start`, so the code form knows what it is for. */
  contact?: string;
  masked?: string;
  detail?: string;
  /** Local builds only, where no provider is configured to send it. */
  code?: string;
}

export default function ProfileScreen({ loaderData }: Route.ComponentProps) {
  const { profile } = loaderData;
  const session = useSession();
  const {
    viewPrefs: { nameOrder },
    updateViewPrefs,
  } = useViewPrefs();
  const fetcher = useFetcher<ProfileResult>();

  const [name, setName] = useState(profile?.name ?? "");
  // Adding a contact is two steps: send a code, then prove it.
  const [adding, setAdding] = useState("");
  const [code, setCode] = useState("");
  const [awaiting, setAwaiting] = useState<string | null>(null);

  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const error =
    result?.ok === false ? (result.error ?? "That didn't work.") : null;

  /**
   * What just happened, said in a banner.
   *
   * Composed here rather than returned as a sentence: the action reports what
   * it did, and the wording is the screen's business.
   */
  const note = result?.renamed
    ? "Name saved."
    : result?.added
      ? "Contact added."
      : result?.masked
        ? result.code
          ? `No mail provider configured here — your code is ${result.code}.`
          : `Code sent to ${result.masked}.`
        : null;

  useEffect(() => {
    if (fetcher.state !== "idle" || !result?.ok) return;
    // A code went out: move to the form that asks for it back.
    if (result.contact) setAwaiting(result.contact);
    // It came back good: the contact is attached, so the two-step is over.
    if (result.added) {
      setAwaiting(null);
      setAdding("");
      setCode("");
    }
    // The header carries the name, and reads it from the session.
    if (result.renamed) void session.refresh();
    // The session object is rebuilt each render; the answer is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, result]);

  const submit = (fields: Record<string, string>) =>
    fetcher.submit(fields, { method: "post" });

  if (!profile) {
    return (
      <Card>
        <EmptyState title="Not signed in">
          Sign in to see your profile.
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {error && <Banner tone="error">{error}</Banner>}
      {note && <Banner tone="info">{note}</Banner>}

      <Card>
        <SectionTitle>Your name</SectionTitle>
        <Field
          label="Name"
          hint="Shown to coaches on your team, and next to a meet you run."
        >
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Mike Robinson"
            autoCapitalize="words"
          />
        </Field>
        <div className="mt-3">
          <Button
            variant="primary"
            disabled={busy || name === (profile.name ?? "")}
            onClick={() => submit({ intent: "rename", name })}
          >
            Save
          </Button>
        </div>
      </Card>

      {/* A display preference, and deliberately a *device* one. It belongs to
          whoever is looking rather than to the team — a visiting coach
          shouldn't change how the host reads its own roster — and putting it
          on the account instead would make it follow somebody onto the shared
          iPad in the swim bag. So it sits on this page for want of anywhere
          better, and says plainly which it is. */}
      <Card>
        <SectionTitle>Preferences</SectionTitle>
        <Field
          label="Names"
          hint="How names are written and sorted on this device."
        >
          <Segmented
            value={nameOrder}
            onChange={(next) => updateViewPrefs({ nameOrder: next })}
            options={[
              { value: "last", label: "Aaronson, Avery" },
              { value: "first", label: "Avery Aaronson" },
            ]}
          />
        </Field>
      </Card>

      <Card>
        <SectionTitle>Ways to sign in</SectionTitle>
        <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">
          Any of these opens this account. There&rsquo;s no password — a code
          goes to whichever one you use.
        </p>

        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {profile.identities.map((identity) => (
            <li
              key={identity.contact}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {identity.contact}
                </span>
                <span className="block text-xs text-slate-500">
                  {identity.kind === "email" ? "Email" : "Mobile"}
                </span>
              </span>
              {profile.identities.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    submit({
                      intent: "contact-remove",
                      contact: identity.contact,
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>

        <div className="mt-4 space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          {awaiting ? (
            <>
              <Field
                label="Code"
                hint={`Sent to ${awaiting}. Enter it to add this contact.`}
              >
                <TextInput
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="primary"
                  disabled={busy || !code.trim()}
                  onClick={() =>
                    submit({
                      intent: "contact-verify",
                      contact: awaiting,
                      code,
                    })
                  }
                >
                  Add it
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setAwaiting(null);
                    setCode("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <Field label="Add an email or mobile">
                <TextInput
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                  placeholder="you@example.com"
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </Field>
              <Button
                disabled={busy || !adding.trim()}
                onClick={() =>
                  submit({ intent: "contact-start", contact: adding.trim() })
                }
              >
                Send a code
              </Button>
            </>
          )}
        </div>
      </Card>

      <Card>
        <SectionTitle>Signing out</SectionTitle>
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
          Signing out leaves this device&rsquo;s season where it is — it keeps
          working offline. It only stops the server knowing whose it is.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => void session.signOut()}>Sign out</Button>
          <Button variant="danger" onClick={() => void session.signOut(true)}>
            Sign out everywhere
          </Button>
        </div>
      </Card>
    </div>
  );
}
