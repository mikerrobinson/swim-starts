/**
 * Consuming the seed cookie: resolve-or-create the swim it's addressed to,
 * apply whatever in it doesn't already match the meet's current state, and
 * say which cookies are now safe to clear.
 *
 * Safe to call from a `loader` or an `action` alike — every underlying RPC
 * (`seat`, `setExhibition`, `recordWatch`, `dropWatch`, `addWalkupAthlete`)
 * is an upsert (or, for `recordWatch`, an append the caller has already
 * deduplicated against current state), so applying the same cookie twice
 * converges rather than duplicates. Diffing against `detail`'s current state
 * isn't needed for that safety; it's here so a cookie that's already fully
 * reflected server-side doesn't re-fire a write and a broadcast on every
 * navigation that revisits this path.
 */

import { splitTypedName } from "./names";
import { putAthlete } from "./athletes.server";
import type { MeetDurableObject } from "./meet-do.server";
import { currentWatches } from "./timing";
import {
  decodeSeedRecord,
  parseSeedCookieName,
  seedCookieName,
  type SeedRecord,
  type WatchSlot,
} from "./seed-cookie";
import {
  TIMERS_PER_LANE,
  type LaneRef,
  type MeetDetail,
  type Swim,
  type Watch,
} from "~/types/meet";

function readSeedCookies(
  request: Request,
): Array<{ at: LaneRef; record: SeedRecord }> {
  const jar = request.headers.get("cookie");
  if (!jar) return [];

  const found: Array<{ at: LaneRef; record: SeedRecord }> = [];
  for (const part of jar.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    const at = name ? parseSeedCookieName(name) : null;
    if (!at || rest.length === 0) continue;
    try {
      const record = decodeSeedRecord(decodeURIComponent(rest.join("=")));
      if (record) found.push({ at, record });
    } catch {
      // Undecodable is the same as absent.
    }
  }
  return found;
}

export interface ApplySeedCookiesResult {
  /** How many lanes actually changed, as opposed to being reapplied as-is. */
  applied: number;
  /** Cookie names fully accounted for — safe to clear via `Set-Cookie`. */
  cleared: string[];
}

export async function applySeedCookies(
  db: D1Database,
  stub: DurableObjectStub<MeetDurableObject>,
  detail: MeetDetail,
  timerId: string,
  request: Request,
  receivedAt = Date.now(),
): Promise<ApplySeedCookiesResult> {
  const pending = readSeedCookies(request);
  let applied = 0;
  const cleared: string[] = [];

  for (const { at, record } of pending) {
    const event = detail.events.find((e) => e.position === at.event - 1);
    // A lane that no longer resolves — the meet was reconfigured while this
    // device was offline — is left pending rather than silently dropped;
    // there's nowhere honest to file its evidence yet.
    if (!event || at.lane > detail.meet.laneCount) continue;

    const existing = detail.swims.find(
      (s) => s.eventId === event.id && s.heat === at.heat && s.lane === at.lane,
    );
    const swim =
      existing ??
      (await stub.ensureLane({
        meetId: detail.meet.id,
        eventId: event.id,
        heat: at.heat,
        lane: at.lane,
      }));

    let changed = false;

    if (record.athleteId && record.athleteId !== swim.athleteId) {
      if (record.team) await createWalkup(db, stub, detail, record);
      await stub.seat({
        meetId: detail.meet.id,
        eventId: event.id,
        heat: at.heat,
        lane: at.lane,
        athleteId: record.athleteId,
        swimId: swim.id,
      });
      changed = true;
    }

    if (record.exhibition !== Boolean(swim.exhibition)) {
      await stub.setExhibition({
        meetId: detail.meet.id,
        swimId: swim.id,
        exhibition: record.exhibition,
      });
      changed = true;
    }

    if (
      await applyWatches(
        stub,
        detail,
        swim,
        timerId,
        record.watches,
        receivedAt,
      )
    ) {
      changed = true;
    }

    if (changed) applied += 1;
    cleared.push(seedCookieName(at));
  }

  return { applied, cleared };
}

/**
 * A walk-up's `athleteId` is minted by the client, so this is create-if-missing.
 * `gender` comes from the timer's own toggle, not guessed from the event — see
 * `seed-cookie.ts`'s `SeedRecord.gender`.
 */
async function createWalkup(
  db: D1Database,
  stub: DurableObjectStub<MeetDurableObject>,
  detail: MeetDetail,
  record: SeedRecord,
): Promise<void> {
  const { firstName, lastName } = splitTypedName(record.name);
  // A client running before the toggle existed sends none — fall back rather
  // than refuse the walk-up over a field it didn't know to send.
  const gender = record.gender ?? "F";
  const team = detail.teams.find((t) => t.code === record.team);
  if (team) {
    await stub.addWalkupAthlete({
      meetId: detail.meet.id,
      teamId: team.id,
      firstName,
      lastName,
      gender,
      id: record.athleteId,
    });
  } else {
    // No team to enrol into — mint the person anyway, unenrolled.
    await putAthlete(db, { id: record.athleteId, firstName, lastName, gender });
  }
}

/**
 * One watch per slot, capped the same way the old raw-cookie endpoint always
 * did — a mangled cookie can't ask for a hundred rows on one swim.
 *
 * A slot beyond what `watches` now claims is retired: the cookie's array
 * length is the device's whole claim about how many clocks it's holding on
 * this lane, the same way a submitted sheet's column count was the claim
 * before. A slot whose new `startedAt` comes after its *old* `stoppedAt`
 * is a re-time rather than a continuation — the previous reading belongs to
 * an attempt that's being redone, so it's retired before the new one lands,
 * rather than merged with it the way an in-progress start/stop update is.
 *
 * `slot` is a real field now (`Watch.slot`), not a suffix baked into an id —
 * so unlike the old `slotTimerId`/`watchSlot`/`fromDevice` trio this needs
 * only a plain equality check against `timerId`, and `recordWatch`/
 * `dropWatch` take the slot as its own argument.
 */
async function applyWatches(
  stub: DurableObjectStub<MeetDurableObject>,
  detail: MeetDetail,
  swim: Swim,
  timerId: string,
  watches: WatchSlot[],
  receivedAt: number,
): Promise<boolean> {
  const persisted = new Map<number, Watch>();
  for (const w of currentWatches(detail, swim.id)) {
    if (w.submittedBy === timerId) persisted.set(w.slot, w);
  }

  let changed = false;
  const cap = Math.max(...TIMERS_PER_LANE);

  for (let slot = 1; slot <= cap; slot++) {
    const wanted = slot <= watches.length ? watches[slot - 1] : null;
    const current = persisted.get(slot);

    if (!wanted) {
      if (current) {
        await stub.dropWatch({
          meetId: detail.meet.id,
          swimId: swim.id,
          timerId,
          slot,
        });
        changed = true;
      }
      continue;
    }

    const retimed =
      wanted.startedAt !== null &&
      current?.stoppedAt != null &&
      wanted.startedAt > current.stoppedAt;
    if (retimed) {
      await stub.dropWatch({
        meetId: detail.meet.id,
        swimId: swim.id,
        timerId,
        slot,
      });
    }

    const against = retimed ? undefined : current;
    const unchanged =
      wanted.startedAt === (against?.startedAt ?? null) &&
      wanted.stoppedAt === (against?.stoppedAt ?? null) &&
      wanted.timeMs === (against?.timeMs ?? null);
    if (unchanged) continue;

    await stub.recordWatch({
      meetId: detail.meet.id,
      swimId: swim.id,
      timerId,
      role: "timer",
      slot,
      timeMs: wanted.timeMs ?? undefined,
      submittedAt: receivedAt,
      startedAt: wanted.startedAt ?? undefined,
      stoppedAt: wanted.stoppedAt ?? undefined,
    });
    changed = true;
  }

  return changed;
}
