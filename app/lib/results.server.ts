/**
 * Reading a completed meet's archive.
 *
 * `results` (`schema.server.ts`) is D1's only record of a finished meet —
 * fully denormalized, so this never has to join anything or wake the meet's
 * Durable Object (which a completed meet doesn't spin back up at all). See
 * `MeetDurableObject.completeMeet` for the one place this table is written.
 */

import { ensureSchema } from "./schema.server";
import { getMeet } from "./meets.server";
import { DEFAULT_MEET_DETAILS, meetDetailsFrom, toSwimKey } from "~/types/meet";
import type {
  Event,
  MeetManifest,
  ResultStatus,
  Stroke,
  Swim,
  SwimKey,
} from "~/types/meet";

interface ResultRow {
  event_id: string;
  event_number: number;
  distance: number;
  stroke: string;
  gender: string;
  heat: number;
  lane: number;
  athlete_id: string | null;
  athlete_name: string;
  athlete_team: string;
  time_ms: number | null;
  status: string;
  exhibition: number;
  place: number | null;
  points: number | null;
}

function asResultStatus(value: string): ResultStatus | undefined {
  return value === "DQ" || value === "NS" || value === "OK"
    ? value
    : undefined;
}

/**
 * The `MeetManifest` shape for a completed meet, built entirely from
 * `results` plus the meet's own D1 row. `watches`/`entries`/`athletes`/
 * `teams` are empty — a finished meet has no evidence or plan left to show,
 * only the decision, and `Swim`'s own `athleteName`/`athleteTeam` fields
 * already carry what a results screen needs to display without a lookup.
 *
 * `details` comes from D1's `meets` row rather than the (never woken) DO —
 * accurate because `MeetDurableObject.setDetails` keeps that row current on
 * every edit, not just at completion, so there's nothing stale to worry
 * about here even for a meet that just archived.
 */
export async function readResultsManifest(
  meetId: string,
  db: D1Database,
): Promise<MeetManifest> {
  await ensureSchema(db);
  const meet = await getMeet(db, meetId);
  const details = meet ? meetDetailsFrom(meet) : DEFAULT_MEET_DETAILS;

  const { results: rows } = await db
    .prepare("SELECT * FROM results WHERE meet_id = ?")
    .bind(meetId)
    .all<ResultRow>();

  const events: Record<string, Event> = {};
  const swims: Record<SwimKey, Swim> = {};

  for (const row of rows) {
    if (!events[row.event_id]) {
      events[row.event_id] = {
        id: row.event_id,
        position: row.event_number,
        eventNumber: row.event_number,
        distance: row.distance,
        stroke: row.stroke as Stroke,
        gender: row.gender as Event["gender"],
      };
    }

    const swim: Swim = {
      eventId: row.event_id,
      heat: row.heat,
      lane: row.lane,
      athleteId: row.athlete_id ?? undefined,
      athleteName: row.athlete_name,
      athleteTeam: row.athlete_team,
      exhibition: row.exhibition === 1,
      status: asResultStatus(row.status),
      officialTimeMs: row.time_ms ?? undefined,
    };
    swims[toSwimKey(swim)] = swim;
  }

  return {
    id: meetId,
    name: details.name,
    details,
    isLive: false,
    events,
    entries: {},
    swims,
    watches: {},
    athletes: {},
    teams: {},
  };
}
