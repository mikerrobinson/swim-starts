/**
 * Consuming the seed cookie: resolve-or-create the swim it's addressed to,
 * apply whatever in it doesn't already match the meet's current state, and
 * say which cookies are now safe to clear.
 *
 * Safe to call from a `loader` or an `action` alike — every underlying RPC
 * (`upsertSwim`, `upsertWatch`, `deleteWatch`, `addWalkupAthlete`) is an
 * upsert, so applying the same cookie twice converges rather than
 * duplicates. Diffing against the manifest's current state isn't needed for
 * that safety; it's here so a cookie that's already fully reflected
 * server-side doesn't re-fire a write and a broadcast on every navigation
 * that revisits this path.
 */

import { splitTypedName } from "./names";
import type { MeetDurableObject } from "./meet-do.server";
import { currentWatches } from "./timing";
import {
  decodeSeedRecord,
  parseSeedCookieName,
  seedCookieName,
  type LaneRef,
  type SeedRecord,
  type WatchSlot,
} from "./seed-cookie";
import { TIMERS_PER_LANE, type MeetManifest } from "~/types/meet";
import { toSwimKey } from "~/types/swim";
import { type Swim } from "~/types/swim";

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
  stub: DurableObjectStub<MeetDurableObject>,
  manifest: MeetManifest,
  deviceId: string,
  request: Request,
  receivedAt = Date.now(),
): Promise<ApplySeedCookiesResult> {
  const pending = readSeedCookies(request);
  let applied = 0;
  const cleared: string[] = [];

  for (const { at, record } of pending) {
    const event = Object.values(manifest.events).find(
      (e) => e.position === at.event - 1,
    );
    // A lane that no longer resolves — the meet was reconfigured while this
    // device was offline — is left pending rather than silently dropped;
    // there's nowhere honest to file its evidence yet.
    if (!event || at.lane > manifest.details.laneCount) continue;

    const slot = { eventId: event.id, heat: at.heat, lane: at.lane };
    const existing: Swim | undefined = manifest.swims[toSwimKey(slot)];
    let swim: Swim = existing ?? { ...slot, exhibition: false };
    let changed = false;

    if (record.athleteId && record.athleteId !== (swim.athleteId ?? "")) {
      if (record.team) await createWalkup(stub, manifest, record);
      const display = await stub.resolveAthleteDisplay(record.athleteId);
      swim = {
        ...swim,
        athleteId: record.athleteId,
        athleteName: display.name,
        athleteTeam: display.team,
      };
      changed = true;
    }

    if (record.exhibition !== Boolean(swim.exhibition)) {
      swim = { ...swim, exhibition: record.exhibition };
      changed = true;
    }

    if (changed) await stub.upsertSwim(manifest.id, swim);

    if (
      await applyWatches(
        stub,
        manifest,
        slot,
        deviceId,
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
  stub: DurableObjectStub<MeetDurableObject>,
  manifest: MeetManifest,
  record: SeedRecord,
): Promise<void> {
  const { firstName, lastName } = splitTypedName(record.name);
  // A client running before the toggle existed sends none — fall back rather
  // than refuse the walk-up over a field it didn't know to send.
  const gender = record.gender ?? "F";
  const team = Object.values(manifest.teams).find(
    (t) => t.code === record.team,
  );
  if (!team) return; // No team named — nothing to enrol this walk-up into.
  await stub.addWalkupAthlete({
    teamId: team.id,
    firstName,
    lastName,
    gender,
    id: record.athleteId,
  });
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
 */
async function applyWatches(
  stub: DurableObjectStub<MeetDurableObject>,
  manifest: MeetManifest,
  slot: { eventId: string; heat: number; lane: number },
  deviceId: string,
  watches: WatchSlot[],
  receivedAt: number,
): Promise<boolean> {
  const persisted = new Map(
    currentWatches({ watches: Object.values(manifest.watches) }, slot)
      .filter((w) => w.deviceId === deviceId)
      .map((w) => [w.slot, w] as const),
  );

  let changed = false;
  const cap = Math.max(...TIMERS_PER_LANE);

  for (let s = 1; s <= cap; s++) {
    const wanted = s <= watches.length ? watches[s - 1] : null;
    const current = persisted.get(s);
    const key = { ...slot, deviceId, slot: s };

    if (!wanted) {
      if (current) {
        await stub.deleteWatch(manifest.id, key);
        changed = true;
      }
      continue;
    }

    const retimed =
      wanted.startedAt !== null &&
      current?.stoppedAt != null &&
      wanted.startedAt > current.stoppedAt;
    if (retimed) {
      await stub.deleteWatch(manifest.id, key);
    }

    const against = retimed ? undefined : current;
    const unchanged =
      wanted.startedAt === (against?.startedAt ?? null) &&
      wanted.stoppedAt === (against?.stoppedAt ?? null) &&
      wanted.timeMs === (against?.timeMs ?? null);
    if (unchanged) continue;

    await stub.upsertWatch(manifest.id, {
      ...slot,
      deviceId,
      slot: s,
      role: "timer",
      timeMs: wanted.timeMs ?? undefined,
      startedAt: wanted.startedAt ?? undefined,
      stoppedAt: wanted.stoppedAt ?? undefined,
      recordedAt: receivedAt,
    });
    changed = true;
  }

  return changed;
}
