/**
 * Who runs a meet.
 *
 * Every other role in this app belongs to a *team* — you coach Chaparral, you
 * swim for Horizon. Running a meet isn't like that. A meet belongs to no team,
 * so the person deciding between three watches on lane 4, or ruling a DQ,
 * can't be defined by which school they're from. Often it's the host's head
 * coach; at a bigger meet it's a referee who coaches nobody.
 *
 * So administration is scoped to the meet, and this is the whole of it.
 *
 * The bootstrap matters as much as the rule: whoever first puts a meet on the
 * server administrates it. That keeps the ordinary case — your own inter-squad
 * meet, which you set up and run yourself — behaving exactly as it always has.
 * The limits only start to bite once somebody else's coach is in the same
 * meet, which is precisely when you want them.
 */

import { NEVER_SEEN } from "./identity";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meet_admins (
     meet_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     added_at INTEGER NOT NULL,
     added_by TEXT,
     PRIMARY KEY (meet_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS admins_by_user ON meet_admins (user_id)`,
];

let ready = false;

export async function ensureAdminStore(db: D1Database): Promise<void> {
  if (ready) return;
  for (const statement of SCHEMA) await db.prepare(statement).run();
  ready = true;
}

/** Every user id running this meet — what `Meet.adminIds` is, so
 *  `access.ts`'s `canEditMeet`/`canDecideMeet` need no D1 read of their own. */
export async function meetAdminIds(
  db: D1Database,
  meetId: string,
): Promise<string[]> {
  await ensureAdminStore(db);
  const { results } = await db
    .prepare("SELECT user_id FROM meet_admins WHERE meet_id = ?")
    .bind(meetId)
    .all<{ user_id: string }>();
  return results.map((row) => row.user_id);
}

export interface MeetAdmin {
  userId: string;
  contact: string;
  name: string | null;
  addedAt: number;
  /** Invited, but has never signed in — so the contact is still unproven. */
  pending: boolean;
}

/**
 * The people running a meet, with the contact each is shown by.
 *
 * That subquery is `auth.server`'s `primaryContact` rule written out rather
 * than imported: accounts must not depend on meets, and importing it here
 * would close that loop. Three lines of SQL is the cheaper of the two.
 */
export async function meetAdmins(
  db: D1Database,
  meetId: string,
): Promise<MeetAdmin[]> {
  await ensureAdminStore(db);
  const { results } = await db
    .prepare(
      `SELECT a.user_id, a.added_at, u.name, u.last_seen_at,
              (SELECT i.contact FROM identities i WHERE i.user_id = u.id
                ORDER BY i.added_at, i.contact LIMIT 1) AS contact
       FROM meet_admins a JOIN users u ON u.id = a.user_id
       WHERE a.meet_id = ? ORDER BY a.added_at`,
    )
    .bind(meetId)
    .all<{
      user_id: string;
      added_at: number;
      contact: string;
      name: string | null;
      last_seen_at: number;
    }>();

  return results.map((row) => ({
    userId: row.user_id,
    contact: row.contact,
    name: row.name,
    addedAt: row.added_at,
    pending: row.last_seen_at === NEVER_SEEN,
  }));
}

export async function addMeetAdmin(
  db: D1Database,
  meetId: string,
  userId: string,
  addedBy: string | null,
  now = Date.now(),
): Promise<void> {
  await ensureAdminStore(db);
  await db
    .prepare(
      `INSERT INTO meet_admins (meet_id, user_id, added_at, added_by)
       VALUES (?, ?, ?, ?) ON CONFLICT(meet_id, user_id) DO NOTHING`,
    )
    .bind(meetId, userId, now, addedBy)
    .run();
}

/**
 * Step down, or remove someone else.
 *
 * Refuses to remove the last one. A meet with no administrator has nobody who
 * can seed it, rule on it, or hand the job to anyone else — it would need a
 * database edit to rescue, so it simply isn't reachable from here.
 */
export async function removeMeetAdmin(
  db: D1Database,
  meetId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  await ensureAdminStore(db);
  const current = await meetAdmins(db, meetId);
  if (!current.some((admin) => admin.userId === userId)) {
    return { ok: false, reason: "They don't run this meet." };
  }
  if (current.length <= 1) {
    return {
      ok: false,
      reason: "A meet needs somebody running it. Add another admin first.",
    };
  }
  await db
    .prepare("DELETE FROM meet_admins WHERE meet_id = ? AND user_id = ?")
    .bind(meetId, userId)
    .run();
  return { ok: true };
}
