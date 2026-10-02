import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { Banner, Button, Field, TextInput } from "./ui";
import { Modal } from "./Modal";

export interface DirectoryUser {
  userId: string;
  name: string | null;
  contact: string;
  pending: boolean;
}

/**
 * Finding the person, or inviting them.
 *
 * Search first, invite only once nothing matches — the same ordering as
 * `TeamPicker`, and for the same reason: two accounts for one referee is the
 * failure worth designing against, and a sheet that made inviting easier than
 * finding would cause it one meet at a time.
 *
 * Nothing is listed until something is typed. The directory spans every
 * account on the server rather than one team's members, because the jobs this
 * hands out — running a meet, coaching a team — are given to whoever is doing
 * them, so the list has to be searched rather than browsed.
 *
 * Shared by the people running a meet and the people coaching a team. The two
 * differ in what they say, not in how they work, so the wording is a prop and
 * the behaviour is here once.
 */
export function PersonPicker({
  title,
  inviteTitle,
  inviteHint,
  exclude,
  onAppoint,
  onInvite,
  busy = false,
  error = null,
  onClose,
}: {
  title: string;
  inviteTitle?: string;
  /** What the link will do for them, said on the invite form. */
  inviteHint?: string;
  exclude: string[];
  /**
   * The whole person is handed over rather than an id, so a caller that wants
   * to show who was picked doesn't have to read back what the list already
   * said.
   */
  onAppoint: (user: DirectoryUser) => void;
  /**
   * Left off when this picker can't make an account. Linking a swimmer is the
   * case: inviting somebody is how you hand out a job, and the only job a team
   * has to hand out is coaching it — which is not what naming a roster row's
   * account means.
   */
  onInvite?: (contact: string, name?: string) => void;
  /** Whoever owns the submission says whether it is in flight and how it went. */
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [inviting, setInviting] = useState(false);

  /**
   * The directory search, which is the one thing here that really is a fetch.
   *
   * A fetcher rather than a bare request: it carries its own `state`, so the
   * "Searching…" line is the router's answer rather than a third boolean kept
   * in step by hand.
   */
  const search = useFetcher<{ users: DirectoryUser[] }>();
  const typed = query.trim();

  // Debounced, because this fires per keystroke against a table that will
  // outgrow whatever it's being searched from.
  useEffect(() => {
    if (typed.length < 2) return;
    const timer = setTimeout(() => {
      search.load(`/api/users?q=${encodeURIComponent(typed)}`);
    }, 250);
    return () => clearTimeout(timer);
    // The loader identity changes every render; what should re-run a search
    // is what was typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  const searching = search.state !== "idle";
  const candidates = (
    typed.length < 2 ? [] : (search.data?.users ?? [])
  ).filter((u) => !exclude.includes(u.userId));

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">
        {error && <Banner tone="error">{error}</Banner>}

        <Field
          label="Find someone"
          hint="Search by name, email or mobile number."
        >
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name or contact"
            autoFocus
          />
        </Field>

        {typed.length < 2 ? (
          <p className="text-sm text-slate-500">
            Type at least two characters.
          </p>
        ) : searching ? (
          <p className="text-sm text-slate-500">Searching…</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nobody here matches “{typed}”.
          </p>
        ) : (
          <ul className="max-h-56 overflow-y-auto">
            {candidates.map((user) => (
              <li key={user.userId}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onAppoint(user)}
                  className="flex w-full items-center justify-between gap-2 border-b border-slate-100 py-2 text-left dark:border-slate-900"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {user.name ?? user.contact}
                    </span>
                    {user.name && (
                      <span className="block truncate text-xs text-slate-500">
                        {user.contact}
                      </span>
                    )}
                  </span>
                  {user.pending && (
                    <span className="shrink-0 text-xs text-slate-500">
                      Invited
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        {onInvite && (
          <Button full onClick={() => setInviting(true)} disabled={busy}>
            Invite someone new
          </Button>
        )}
        <Button full variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>

      {inviting && onInvite && (
        <InviteSheet
          title={inviteTitle ?? "Invite someone"}
          hint={inviteHint ?? "We'll send a link that signs them in."}
          // What was typed is very often the address they were about to send
          // to, so it carries over rather than being typed twice.
          initial={typed}
          onInvite={onInvite}
          busy={busy}
          error={error}
          onClose={() => setInviting(false)}
        />
      )}
    </Modal>
  );
}

/**
 * Somebody who has never used the app.
 *
 * A name and one way to reach them, which is exactly what an account is made
 * of — so the caller creates one, gives it the job, and sends the link that
 * proves the contact. They hold the job from that moment; signing in is how
 * they take it up, not how they are granted it.
 *
 * Typing an address that turns out to belong to an existing account uses that
 * account rather than minting a second, so getting this wrong is cheap.
 */
function InviteSheet({
  title,
  hint,
  initial,
  onInvite,
  busy,
  error,
  onClose,
}: {
  title: string;
  hint: string;
  initial: string;
  onInvite: (contact: string, name?: string) => void;
  busy: boolean;
  error: string | null;
  onClose: () => void;
}) {
  // Whatever was being searched for is a contact if it looks like one, and a
  // name otherwise.
  const looksLikeContact = /[@\d]/.test(initial);
  const [name, setName] = useState(looksLikeContact ? "" : initial);
  const [contact, setContact] = useState(looksLikeContact ? initial : "");

  const save = () => {
    if (!contact.trim()) return;
    onInvite(contact.trim(), name.trim() || undefined);
  };

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">
        {error && <Banner tone="error">{error}</Banner>}

        <Field label="Name">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Dana Kerr"
            autoCapitalize="words"
            autoFocus={!name}
          />
        </Field>

        <Field label="Email or mobile" hint={hint}>
          <TextInput
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder="dana@example.com"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </Field>

        <Button
          full
          variant="primary"
          disabled={busy || !contact.trim()}
          onClick={save}
        >
          {busy ? "Sending…" : "Send invitation"}
        </Button>
        <Button full variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
