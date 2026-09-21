/**
 * People.
 *
 * Global and durable: an athlete belongs to no team, and is never deleted,
 * because results reference them by id forever. Who they swim for is an
 * enrollment — see `teams.server.ts`.
 */

import { ensureSchema } from "./schema.server";
import { generateId } from "./id";
import type { Athlete, Gender } from "~/types/athlete";

export interface AthleteRow {
  id: string;
  first_name: string;
  last_name: string;
  gender: string;
  birth_date: string | null;
  user_id: string | null;
}

export function athleteRow(row: AthleteRow): Athlete {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    gender: row.gender === "M" ? "M" : "F",
    birthDate: row.birth_date ?? undefined,
    userId: row.user_id ?? undefined,
  };
}

export async function getAthlete(
  db: D1Database,
  id: string,
): Promise<Athlete | null> {
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT * FROM athletes WHERE id = ?")
    .bind(id)
    .first<AthleteRow>();
  return row ? athleteRow(row) : null;
}

export async function listAthletes(
  db: D1Database,
  options: { search?: string; limit?: number } = {},
): Promise<Athlete[]> {
  await ensureSchema(db);
  const limit = Math.min(options.limit ?? 200, 500);
  const search = options.search?.trim();

  const { results } = search
    ? await db
        .prepare(
          `SELECT * FROM athletes
           WHERE last_name LIKE ?1 OR first_name LIKE ?1
           ORDER BY last_name, first_name LIMIT ?2`,
        )
        .bind(`%${search}%`, limit)
        .all<AthleteRow>()
    : await db
        .prepare(
          "SELECT * FROM athletes ORDER BY last_name, first_name LIMIT ?",
        )
        .bind(limit)
        .all<AthleteRow>();

  return results.map(athleteRow);
}

/** The roster entry an account is, if a coach has linked one. */
export async function athleteForUser(
  db: D1Database,
  userId: string,
): Promise<Athlete | null> {
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT * FROM athletes WHERE user_id = ?")
    .bind(userId)
    .first<AthleteRow>();
  return row ? athleteRow(row) : null;
}

export interface AthleteInput {
  id?: string;
  firstName: string;
  lastName: string;
  gender: Gender;
  birthDate?: string;
  userId?: string;
}

/**
 * Add or update a person.
 *
 * Takes an optional id so a device with no signal can mint one and send the
 * person and whatever they did together — the timer's "add a swimmer" path.
 */
export async function putAthlete(
  db: D1Database,
  input: AthleteInput,
): Promise<Athlete> {
  await ensureSchema(db);
  const id = input.id ?? generateId();
  await db
    .prepare(
      `INSERT INTO athletes (id, first_name, last_name, gender, birth_date, user_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         gender = excluded.gender,
         birth_date = COALESCE(excluded.birth_date, athletes.birth_date),
         user_id = COALESCE(excluded.user_id, athletes.user_id)`,
    )
    .bind(
      id,
      input.firstName.trim().slice(0, 60),
      input.lastName.trim().slice(0, 60),
      input.gender,
      input.birthDate ?? null,
      input.userId ?? null,
    )
    .run();
  return (await getAthlete(db, id))!;
}

/** Say which account a swimmer is. A claim only a coach gets to make. */
export async function linkAthleteToUser(
  db: D1Database,
  athleteId: string,
  userId: string | null,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare("UPDATE athletes SET user_id = ? WHERE id = ?")
    .bind(userId, athleteId)
    .run();
}
