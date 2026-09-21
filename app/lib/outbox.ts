/**
 * Writes that survive a bad moment on pool wifi.
 *
 * Every change a deck screen makes goes in here first: a tick on the
 * registration grid, a swimmer moved into a lane, a time off a stopwatch, a
 * lane signed off at the desk. The queue is drained in order, and it is held
 * in localStorage, so the tab can be reloaded — or the phone locked and picked
 * up again — without losing a time somebody actually took.
 *
 * This is the whole of what's left of "offline". The server is the source of
 * truth and screens read from loaders; the only thing the device keeps is what
 * it has said and not yet been acknowledged for.
 *
 * **A failure that can't be fixed by waiting is not retried.** The engine this
 * replaced backed off and tried again on every error including a 400, so one
 * write the server would never accept sat in front of everything else,
 * forever, behind a chip that said "Retrying…". Here, a 4xx that isn't a
 * timeout or a rate limit is dropped and reported; only network failures and
 * 5xx are worth another go.
 */

import { apiUrl } from "./http";
import { generateId } from "./id";
import { local } from "./local";
import type { Write } from "./writes";

export type { Write } from "./writes";

export interface Queued {
  id: string;
  write: Write;
  queuedAt: number;
  /** How many times sending has failed for a reason worth retrying. */
  tries: number;
  /** Set once the server has accepted the write — see `settled` below. */
  settledAt?: number;
}

export interface OutboxState {
  pending: Queued[];
  /**
   * Writes the server has already accepted but that loader data hasn't
   * caught up to yet.
   *
   * A write leaves `pending` the moment its POST succeeds, which is well
   * before the revalidation that follows fetches a loader read reflecting
   * it — on real network latency that gap is wide enough to see. Keeping the
   * write here too means the optimistic overlay still applies it until a
   * revalidation actually lands, instead of the screen flashing back to the
   * pre-write state for the moment in between.
   */
  settled: Queued[];
  /** Set when a write was refused for good. Cleared by the next success. */
  error: string | null;
  sending: boolean;
}

const KEY = "swim-starts:outbox";

/* ----------------------------------------------------------------- storage */

function read(): Queued[] {
  try {
    const raw = JSON.parse(local.get(KEY) ?? "[]");
    return Array.isArray(raw) ? (raw as Queued[]) : [];
  } catch {
    return [];
  }
}

function write(queue: Queued[]): void {
  if (queue.length === 0) local.remove(KEY);
  else local.set(KEY, JSON.stringify(queue));
}

/* --------------------------------------------------------------- the queue */

let state: OutboxState = {
  pending: read(),
  settled: [],
  error: null,
  sending: false,
};
const listeners = new Set<(state: OutboxState) => void>();

function publish(next: Partial<OutboxState>): void {
  state = { ...state, ...next };
  write(state.pending);
  for (const listener of listeners) listener(state);
}

export function subscribe(listener: (state: OutboxState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function snapshot(): OutboxState {
  return state;
}

/**
 * Add a write, replacing one it supersedes.
 *
 * Changing your mind twice before anything reaches the server is one answer,
 * not two: a lane seated and reseated, a tick toggled on and off, a time taken
 * and retaken. `supersedes` decides what counts as the same decision, and it
 * is deliberately per-kind — two timers' watches on one lane are different
 * writes, the same timer's two watches on one lane are not.
 */
export function enqueue(item: Write): void {
  const queued: Queued = {
    id: generateId(),
    write: item,
    queuedAt: Date.now(),
    tries: 0,
  };
  const pending = state.pending.filter((q) => !supersedes(item, q.write));
  publish({ pending: [...pending, queued] });
  void flush();
}

function supersedes(next: Write, old: Write): boolean {
  if (next.meetId !== old.meetId) return false;
  switch (next.kind) {
    case "entry":
      return (
        old.kind === "entry" &&
        old.eventId === next.eventId &&
        old.athleteId === next.athleteId
      );
    case "swim":
    case "unswim":
      // Two answers about the same lane are one answer. A swim write names
      // the lane; an unswim names the row, so both are compared on the id the
      // caller minted for it.
      return (
        (old.kind === "swim" || old.kind === "unswim") &&
        old.swimId === next.swimId
      );
    case "watch":
    case "drop-watch":
      return (
        (old.kind === "watch" || old.kind === "drop-watch") &&
        old.swimId === next.swimId &&
        old.timerId === next.timerId
      );
    case "exhibition":
      // Toggled twice before either reaches the server is one answer, not two.
      return old.kind === "exhibition" && old.swimId === next.swimId;
    case "result":
    case "unresult":
      return (
        (old.kind === "result" || old.kind === "unresult") &&
        old.swimId === next.swimId
      );
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ sending */

/**
 * Whether it is worth trying again.
 *
 * Nothing the server has already understood and refused gets a second go. A
 * 403 is not going to become a 200 because we waited, and a queue that retries
 * one anyway blocks every write behind it.
 */
function worthRetrying(status: number): boolean {
  if (status === 0) return true; // no network
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

let flushing = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const BACKOFF_MS = [1000, 3000, 8000, 20_000, 60_000];

/**
 * Send what's waiting, oldest first, stopping at the first thing that can't go
 * yet.
 *
 * In order and one at a time on purpose: a seat and the watch that follows it
 * describe the same lane, and letting the second overtake the first would put
 * a time against whoever used to be there.
 */
export async function flush(): Promise<void> {
  if (flushing) return;
  if (state.pending.length === 0) return;
  flushing = true;
  publish({ sending: true });

  try {
    while (state.pending.length > 0) {
      const head = state.pending[0];

      let status = 0;
      let message = "No signal";
      try {
        // The write goes as itself. There used to be a table here turning each
        // kind into a URL and a method and a body shaped for it, which meant
        // the queue's vocabulary and the server's had to be kept in step by
        // hand; the endpoint now takes the `Write`.
        //
        // Who is asking rides in the session cookie, which the browser
        // attaches by itself — there is nothing to read out of storage here,
        // and so nothing to be missing when storage is refused.
        const response = await fetch(
          apiUrl(`/api/meets/${encodeURIComponent(head.write.meetId)}/writes`),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(head.write),
          },
        );
        status = response.status;
        if (!response.ok) {
          const parsed = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          message = parsed?.error ?? `Failed (${status})`;
        }
      } catch {
        status = 0;
      }

      if (status !== 0 && status < 400) {
        publish({
          // By id, not position: a write for another seed can supersede one
          // still ahead of this one in the queue while this fetch is in
          // flight, and `head` is no longer necessarily at index 0 by the
          // time it resolves. Slicing off "whatever's first now" would drop
          // that other write on the floor without ever sending it.
          pending: state.pending.filter((q) => q.id !== head.id),
          settled: [...state.settled, { ...head, settledAt: Date.now() }],
          error: null,
        });
        continue;
      }

      if (worthRetrying(status)) {
        const tries = head.tries + 1;
        publish({
          pending: state.pending.map((q) =>
            q.id === head.id ? { ...q, tries } : q,
          ),
        });
        schedule(BACKOFF_MS[Math.min(tries - 1, BACKOFF_MS.length - 1)]);
        return;
      }

      // Refused for good. Drop it so the rest of the queue can move, and say
      // so — silently discarding somebody's time would be worse than either.
      publish({
        pending: state.pending.filter((q) => q.id !== head.id),
        error: message,
      });
    }
  } finally {
    flushing = false;
    publish({ sending: false });
  }
}

function schedule(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, delay);
}

/** Coming back into signal, or back to the tab, is the moment to try again. */
export function startOutbox(): () => void {
  const retry = () => void flush();
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", retry);
  const tick = setInterval(retry, 20_000);
  void flush();
  return () => {
    window.removeEventListener("online", retry);
    document.removeEventListener("visibilitychange", retry);
    clearInterval(tick);
    if (timer) clearTimeout(timer);
  };
}

export function dismissError(): void {
  publish({ error: null });
}

/**
 * Drop settled writes now accounted for by a revalidation that started after
 * `since`. Anything that settled *during* that revalidation's flight stays
 * behind for the next one — its effect wasn't in the loader read that just
 * landed.
 */
export function clearSettledBefore(since: number): void {
  const settled = state.settled.filter((q) => (q.settledAt ?? 0) > since);
  if (settled.length !== state.settled.length) publish({ settled });
}
