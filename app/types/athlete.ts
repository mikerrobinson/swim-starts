export type AthleteKey = string;

export type Gender = "M" | "F";

export interface AthleteIdentity {
  id: string;
}

export interface Athlete extends AthleteIdentity {
  firstName: string;
  lastName: string;
  gender: Gender;
  birthDate?: string;
  userId?: string; // optional, if the athlete is linked to a user account
}

export function toAthleteKey(athlete: AthleteIdentity): AthleteKey {
  return athlete.id;
}

export type AthleteUpsertMutation = {
  entity: "athlete";
  op: "upsert";
  key: AthleteIdentity;
  patch: Partial<Omit<Athlete, keyof AthleteIdentity>>;
};

export type AthleteDeleteMutation = {
  entity: "athlete";
  op: "delete";
  key: AthleteIdentity;
};

/**
 * Age on a given date — what age-group entries are seeded by, and what an
 * export has to state. Returns null when the birth date is missing or
 * unparseable rather than guessing at one.
 */
export function ageOn(
  athlete: Pick<Athlete, "birthDate">,
  isoDate: string,
): number | null {
  const born = parseIsoDate(athlete.birthDate);
  const on = parseIsoDate(isoDate);
  if (!born || !on) return null;

  let age = on.year - born.year;
  // Not yet had this year's birthday.
  if (on.month < born.month || (on.month === born.month && on.day < born.day)) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}
function parseIsoDate(
  value: string | undefined,
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const [, year, month, day] = match;
  return { year: Number(year), month: Number(month), day: Number(day) };
} /** Today, as the plain ISO day the rest of the model speaks in. */

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
