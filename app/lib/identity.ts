/**
 * Who someone is, and what they're allowed to do — the parts with no I/O in
 * them.
 *
 * Identity is a contact: an email address or a mobile number. There's no
 * separate sign-up, because there's nothing to sign up *with* — proving you
 * can read a code sent to a contact is the whole account. A contact nobody has
 * used before becomes a new person on first successful verification.
 *
 * Everything here is pure so the rules that matter — what counts as the same
 * contact, when a code has expired, which team to open — can be tested without
 * a database. The storage lives in `auth.server.ts`.
 */

/* --------------------------------------------------------------- contacts */

export type ContactKind = "email" | "phone";

export interface Contact {
  kind: ContactKind;
  /** The stored, canonical form. Two people typing the same contact different
   *  ways must land on the same string, or they'd become two accounts. */
  value: string;
}

/**
 * Read what someone typed into a contact, or explain why it isn't one.
 *
 * A single field takes both kinds, because asking someone to pick "email or
 * phone" before typing is a question the input itself already answers: an `@`
 * means email, digits mean phone.
 */
export function parseContact(
  raw: string,
): { ok: true; contact: Contact } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed)
    return { ok: false, error: "Enter an email address or mobile number." };

  if (trimmed.includes("@")) {
    const value = trimmed.toLowerCase();
    // Deliberately loose. The only test that means anything is whether the
    // code arrives, and every stricter pattern eventually rejects a real
    // address that would have worked.
    if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) {
      return { ok: false, error: "That doesn't look like an email address." };
    }
    return { ok: true, contact: { kind: "email", value } };
  }

  const phone = normalizePhone(trimmed);
  if (!phone) {
    return {
      ok: false,
      error:
        "That doesn't look like a mobile number. Include the country code if it isn't a US number.",
    };
  }
  return { ok: true, contact: { kind: "phone", value: phone } };
}

/**
 * A phone number in E.164, or null.
 *
 * Ten digits is assumed to be North American, since that's who's standing on
 * this pool deck; anything else has to say its country code with a `+`.
 * Guessing a country for an arbitrary digit string is how a code gets sent
 * somewhere it can't be read.
 */
function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (trimmed.startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** The contact as a person would want to see it written back to them. */
function formatContact(contact: Contact): string {
  if (contact.kind === "email") return contact.value;
  const digits = contact.value.replace(/\D/g, "");
  if (contact.value.startsWith("+1") && digits.length === 11) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return contact.value;
}

/**
 * A stored contact written back out for display.
 *
 * The kind is optional because not everything that carries a contact carries
 * the kind alongside it, and a stored contact says which it is anyway: they
 * are canonical by the time they're stored, so an `@` is the whole test.
 */
export function describeContact(who: {
  contact: string;
  contactKind?: string;
}): string {
  const kind: ContactKind =
    who.contactKind === "phone" || who.contactKind === "email"
      ? who.contactKind
      : who.contact.includes("@")
        ? "email"
        : "phone";
  return formatContact({ kind, value: who.contact });
}

/**
 * Enough of a contact to confirm which one a code went to, without printing it
 * in full on a screen someone else might be looking at.
 */
export function maskContact(contact: Contact): string {
  if (contact.kind === "phone") {
    const digits = contact.value.replace(/\D/g, "");
    return `•••••${digits.slice(-4)}`;
  }
  const [name, domain] = contact.value.split("@");
  const shown = name.length <= 2 ? name[0] : name.slice(0, 2);
  return `${shown}${"•".repeat(Math.max(1, name.length - shown.length))}@${domain}`;
}

/* ------------------------------------------------------------------ codes */

/** Digits in a login code. Six is the number people expect and can hold in
 *  their head from the notification to the field. */
export const CODE_LENGTH = 6;

/** How long a code is good for. Long enough to find the phone, short enough
 *  that a screenshot in a group chat goes stale. */
export const CODE_TTL_MS = 10 * 60 * 1000;

/** Wrong guesses before a code is burnt. Six digits is a million
 *  possibilities, so this is about stopping a script, not a person. */
const MAX_ATTEMPTS = 5;

/** Quiet period between codes to one contact, so the endpoint can't be used
 *  to text someone repeatedly. */
export const RESEND_INTERVAL_MS = 30 * 1000;

/**
 * A fresh login code.
 *
 * Uniform over the whole range including leading zeros, which is why this
 * rejects and redraws rather than taking a modulus — a modulus over 2^32 is
 * very slightly biased toward low codes, and the fix costs nothing.
 */
export function newCode(): string {
  const limit = 10 ** CODE_LENGTH;
  const ceiling = Math.floor(0xffffffff / limit) * limit;
  const buffer = new Uint32Array(1);
  let draw: number;
  do {
    crypto.getRandomValues(buffer);
    draw = buffer[0];
  } while (draw >= ceiling);
  return String(draw % limit).padStart(CODE_LENGTH, "0");
}

/** Digits only, so "123 456" and "123-456" from a paste both work. */
export function normalizeCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, CODE_LENGTH);
}

export interface Challenge {
  createdAt: number;
  attempts: number;
}

export type ChallengeCheck =
  | { ok: true }
  | { ok: false; reason: "expired" | "exhausted" | "wrong" };

/**
 * Whether a submitted code opens this challenge.
 *
 * Takes `matches` already decided rather than the code itself: what's stored
 * is a hash, so comparing is the server's job. What's worth pinning down here
 * is the *order* — expiry and attempts are checked first, so a burnt challenge
 * says so plainly instead of reporting "wrong code" at someone typing the
 * right one.
 */
export function checkChallenge(
  challenge: Challenge,
  matches: boolean,
  now: number,
): ChallengeCheck {
  if (now - challenge.createdAt > CODE_TTL_MS)
    return { ok: false, reason: "expired" };
  if (challenge.attempts >= MAX_ATTEMPTS)
    return { ok: false, reason: "exhausted" };
  if (!matches) return { ok: false, reason: "wrong" };
  return { ok: true };
}

/**
 * Compare without leaking where the strings diverge through how long it took.
 *
 * Over the internet the timing signal here is almost certainly unmeasurable,
 * but a constant-time compare of two six-character strings costs nothing and
 * means nobody has to reason about whether it's measurable.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function messageFor(check: ChallengeCheck): string {
  if (check.ok) return "";
  if (check.reason === "expired")
    return "That code has expired. Ask for a new one.";
  if (check.reason === "exhausted")
    return "Too many tries. Ask for a new code.";
  return "That code isn't right.";
}

/* ------------------------------------------------------------------ teams */

/**
 * Which team to open, given everything we know.
 *
 * The order is what a person would expect: an invite they just followed beats
 * where they were last time, and where they were last time beats an arbitrary
 * pick. Returns null when there's nothing to open — a coach with no team yet —
 * which is the signal to send them off to find one.
 *
 * Takes the teams this person coaches, in the order they took them on. There
 * used to be a role and a standing to filter by first; coaching a team is now
 * a row in `team_coaches` and nothing else, so the list *is* the answer.
 */
export function teamToOpen(
  coached: string[],
  options: { invitedTeamId?: string | null; lastTeamId?: string | null },
): string | null {
  const has = (id: string | null | undefined) =>
    id != null && coached.includes(id);

  if (has(options.invitedTeamId)) return options.invitedTeamId!;
  if (has(options.lastTeamId)) return options.lastTeamId!;
  return coached[0] ?? null;
}

/**
 * `last_seen_at` for somebody who has never signed in.
 *
 * A sentinel rather than a nullable column, because every other account has a
 * real timestamp here and a second "but is it null" case in every read is a
 * worse trade than one reserved value. An invited person's contact is
 * unproven until they sign in, and this is how the screens say so.
 *
 * Lives here, with the other rules, so the stores that read it don't have to
 * import each other to agree on what it means.
 */
export const NEVER_SEEN = 0;
