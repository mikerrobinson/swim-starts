/**
 * The last snapshot a timer's `clientLoader` actually saw, kept purely so a
 * cold, offline load has something to render instead of a hard failure.
 *
 * Not stale-while-revalidate: the network is always tried first, and this is
 * read only when that attempt throws. A timer's own snapshot changes too
 * often (running order, other watches) to show stale data by default just to
 * save a round trip while online — the value here is entirely in the offline
 * case, where stale beats nothing.
 */

const KEY_PREFIX = "mr_timer_snapshot:";

export function loadCachedSnapshot<T>(meetId: string): T | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + meetId);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveCachedSnapshot<T>(meetId: string, snapshot: T): void {
  try {
    localStorage.setItem(KEY_PREFIX + meetId, JSON.stringify(snapshot));
  } catch {
    // Storage blocked or full — the cache is a nicety, not a requirement.
  }
}
