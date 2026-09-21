/**
 * What a timer's phone is allowed to know.
 *
 * Deliberately not the season. A device that scanned a QR code taped to a
 * timing table gets one meet's running order, its lanes, the names needed to
 * fill the picker, and its own times — and nothing else. No birth dates, no
 * other meets, no other timers' watches.
 *
 * It's a projection of `meetDetail` rather than a second assembly of the same
 * rows. There used to be a hand-written copy of the heat/seat join in here,
 * and a second copy of the seating rule; both have gone, which is most of the
 * point of moving the timer onto the same tables as everything else.
 */

import { meetDetail } from "./meets.server";
import { fromDevice } from "./timing";
import type { Grant } from "./grants.server";
import {
  withLiveTables,
  type Event,
  type MeetSnapshot,
  type Seed,
  type Watch,
} from "~/types/meet";

/** A team as a timer needs it: something to tap, and an id to send back. */
export interface TimerTeam {
  id: string;
  name: string;
}

/** A person as a timer needs them: a name, and who they swim for. */
export interface TimerAthlete {
  id: string;
  firstName: string;
  lastName: string;
  team?: string;
}

export interface TimerSnapshot {
  /** The server's clock, so six phones can be compared to one another later. */
  serverTime: number;
  expiresAt: number;
  meet: {
    id: string;
    name: string;
    date: string;
    laneCount: number;
    /**
     * How many watches a lane is timed by, so a phone can offer to be the
     * clipboard for them. One — the default — is a phone per timer, which is
     * what this screen has always been.
     */
    timersPerLane: number;
    /** The teams racing, for the "add a swimmer" buttons. */
    teams: TimerTeam[];
  };
  /**
   * What to call athletes with no team of their own at this meet. The host
   * where there is one, so a timer at a home meet sees the home team named
   * rather than the word "Home".
   */
  ownTeam: string;
  /** In running order. */
  events: Event[];
  seeds: Seed[];
  /** eventId -> athleteIds registered in it. */
  entries: Record<string, string[]>;
  athletes: TimerAthlete[];
  /**
   * Only this device's own times — every watch it is holding, which is three
   * of them when it is the clipboard for a lane. Another timer's is not a
   * hint.
   */
  mine: Watch[];
}

export async function timerSnapshot(
  db: D1Database,
  grant: Grant,
  timerId: string,
  live: MeetSnapshot,
  now = Date.now(),
): Promise<TimerSnapshot | null> {
  const loaded = await meetDetail(db, grant.meetId);
  if (!loaded) return null;
  // The DO is the source of truth for entries/seeds/watches/results the
  // moment anything has touched the meet — a plain D1 read here would show
  // whatever the last checkpoint happened to catch, up to
  // `CHECKPOINT_INTERVAL_MS` stale, which is exactly what left a timer phone
  // staring at "the coach hasn't set the heats" right after seeding ran.
  const detail = withLiveTables(loaded, live);

  // Short labels to group the picker under, from the teams actually racing.
  const label = new Map(
    detail.teams.map((t) => [t.id, t.code || t.name] as const),
  );
  const teamOf = new Map<string, string>();
  for (const enrolled of detail.enrollments) {
    if (!teamOf.has(enrolled.athleteId)) {
      teamOf.set(enrolled.athleteId, label.get(enrolled.teamId) ?? "");
    }
  }

  const host = detail.meet.hostTeamId
    ? label.get(detail.meet.hostTeamId)
    : undefined;

  return {
    serverTime: now,
    expiresAt: grant.expiresAt,
    meet: {
      id: detail.meet.id,
      name: detail.meet.name,
      date: detail.meet.date,
      laneCount: detail.meet.laneCount,
      timersPerLane: detail.meet.timersPerLane,
      teams: detail.teams.map((t) => ({ id: t.id, name: t.name })),
    },
    ownTeam: host || label.get(detail.meet.teamIds[0] ?? "") || "Home",
    events: detail.events,
    seeds: detail.seeds,
    entries: detail.entries,
    // Selected fields only — a timer never receives a birth date, which is the
    // one thing on an athlete record worth guarding.
    athletes: detail.athletes.map((a) => ({
      id: a.id,
      firstName: a.firstName,
      lastName: a.lastName,
      team: teamOf.get(a.id) || undefined,
    })),
    // A clipboard's watches are keyed to this same device with a column
    // number after them, so "mine" is the device and everything in its hand.
    mine: detail.watches.filter((w) => fromDevice(w.timerId, timerId)),
  };
}
