async function ensureGrantStore(db: D1Database): Promise<void> {
  if (ready) return;
  for (const statement of SCHEMA) await db.prepare(statement).run();
  ready = true;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meet_grants (
     token_hash TEXT PRIMARY KEY,
     meet_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     revoked_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS grants_by_meet ON meet_grants (meet_id)`,
];

let ready = false;
export interface Grant {
  meetId: string;
  expiresAt: number;
}

export async function grantFor(
  db: D1Database,
  token: string | null | undefined,
  now = Date.now(),
): Promise<Grant | null> {
  if (!token) return null;
  await ensureGrantStore(db);
  const row = await db
    .prepare(
      `SELECT meet_id, expires_at FROM meet_grants
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(await hash(token), now)
    .first<{ meet_id: string; expires_at: number }>();

  return row ? { meetId: row.meet_id, expiresAt: row.expires_at } : null;
}

export async function revokeGrants(
  db: D1Database,
  meetId: string,
  now = Date.now(),
): Promise<void> {
  await ensureGrantStore(db);
  await db
    .prepare(
      "UPDATE meet_grants SET revoked_at = ? WHERE meet_id = ? AND revoked_at IS NULL",
    )
    .bind(now, meetId)
    .run();
}

export function grantCookie(
  token: string | null,
  request: Request,
  options: { meetId?: string; expiresAt?: number },
): string {
  const now = Date.now();
  const https = new URL(request.url).protocol === "https:";
  const maxAge =
    token && options.expiresAt
      ? Math.max(0, Math.floor((options.expiresAt - now) / 1000))
      : 0;

  return [
    `${GRANT_COOKIE}=${token ? encodeURIComponent(token) : ""}`,
    `Path=/meets/${options.meetId}/timer`,
    "HttpOnly",
    "SameSite=Lax",
    ...(https ? ["Secure"] : []),
    `Max-Age=${maxAge}`,
  ].join("; ");
}

/**
 * Our timer bearer token, granted via the URL of the scanned meet QR code, and `/t/:token` trades
 * it for this cookie before anything else happens.  This becomes our timer's credential for the session.
 */
export function grantToken(request: Request): string | null {
  const jar = request.headers.get("cookie");
  if (!jar) return null;
  for (const part of jar.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === GRANT_COOKIE && rest.length) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

const GRANT_COOKIE = "ss_timer";

export async function issueGrant(
  db: D1Database,
  meet: { id: string; date: string },
  now = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  await ensureGrantStore(db);
  await db
    .prepare(
      "UPDATE meet_grants SET revoked_at = ? WHERE meet_id = ? AND revoked_at IS NULL",
    )
    .bind(now, meet.id)
    .run();

  const token = newToken();
  const expiresAt = grantExpiry(meet.date, now);
  await db
    .prepare(
      `INSERT INTO meet_grants (token_hash, meet_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(await hash(token), meet.id, now, expiresAt)
    .run();

  return { token, expiresAt };
}

function grantExpiry(meetDate: string, now = Date.now()): number {
  const midnight = Date.parse(`${meetDate}T00:00:00Z`);
  const base = Number.isFinite(midnight) ? midnight : now;
  return Math.max(base + 2 * 24 * 60 * 60 * 1000, now + MINIMUM_LIFE_MS);
}

const MINIMUM_LIFE_MS = 12 * 60 * 60 * 1000;
function newToken(): string {
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`grant:${token}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
