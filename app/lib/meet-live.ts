/**
 * The meet's live connection: one WebSocket per meet per tab, fed by the
 * Meet Durable Object's broadcasts (see `api.meet.live.ts`).
 *
 * Shaped like `outbox.ts` on purpose — a module-level map of state, a
 * `subscribe`, a `snapshot` — rather than a React context, so a screen that
 * only wants the current snapshot for a `clientLoader` doesn't need to render
 * anything to get it. `useMeetLive` is the thin React wrapper around it.
 *
 * One connection per meet, ref-counted across however many components on
 * screen want it (a workspace shell and a leaf route reading the same meet,
 * say): the first subscriber opens the socket, the last one closing drops it.
 *
 * Every incoming message is folded over the cached snapshot with `applyWrite`
 * — the same reducer the outbox uses for its own optimistic overlay. One
 * reducer, two callers.
 */

import { apiUrl } from "./http";
import { local } from "./local";
import { applyWrite } from "./pending";
import type { MeetBroadcast } from "./writes";
import type { MeetSnapshot } from "~/types/meet";

export interface MeetLiveState {
  snapshot: MeetSnapshot;
  /** Whether the socket is open right now. False during an initial connect
   *  or a reconnect — `snapshot` is still whatever was last known, cached
   *  or live, so a screen never has nothing to render while this is false. */
  connected: boolean;
}

const EMPTY_SNAPSHOT: MeetSnapshot = {
  entries: {},
  swims: [],
  watches: [],
  athletes: [],
};

interface Connection {
  ws: WebSocket | null;
  state: MeetLiveState;
  listeners: Set<(state: MeetLiveState) => void>;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  /** Set once the last subscriber has left. Stops the reconnect loop from
   *  resurrecting a connection nobody wants any more. */
  closed: boolean;
}

const connections = new Map<string, Connection>();
const RECONNECT_MS = [1000, 3000, 8000, 20_000];

function cacheKey(meetId: string): string {
  return `swim-starts:meet-live:${meetId}`;
}

function readCache(meetId: string): MeetSnapshot | null {
  const raw = local.get(cacheKey(meetId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MeetSnapshot;
  } catch {
    return null;
  }
}

function writeCache(meetId: string, snapshot: MeetSnapshot): void {
  local.set(cacheKey(meetId), JSON.stringify(snapshot));
}

function publish(conn: Connection): void {
  for (const listener of conn.listeners) listener(conn.state);
}

function wsUrl(meetId: string): string {
  const url = new URL(apiUrl(`/api/meets/${encodeURIComponent(meetId)}/live`), location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function open(meetId: string, conn: Connection): void {
  if (conn.closed) return;

  const ws = new WebSocket(wsUrl(meetId));
  conn.ws = ws;

  ws.addEventListener("open", () => {
    conn.reconnectAttempt = 0;
    conn.state = { ...conn.state, connected: true };
    publish(conn);
  });

  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message: MeetBroadcast;
    try {
      message = JSON.parse(event.data) as MeetBroadcast;
    } catch {
      return; // Not something we sent; not something we can apply.
    }
    const snapshot = applyWrite(conn.state.snapshot, message);
    conn.state = { ...conn.state, snapshot };
    writeCache(meetId, snapshot);
    publish(conn);
  });

  const reconnect = () => {
    if (conn.closed || conn.ws !== ws) return;
    conn.state = { ...conn.state, connected: false };
    publish(conn);
    const delay = RECONNECT_MS[Math.min(conn.reconnectAttempt, RECONNECT_MS.length - 1)];
    conn.reconnectAttempt += 1;
    conn.reconnectTimer = setTimeout(() => open(meetId, conn), delay);
  };

  ws.addEventListener("close", reconnect);
  // A socket that errors also closes; the "close" handler above is what
  // actually schedules the retry, so this only needs to hurry that along.
  ws.addEventListener("error", () => ws.close());
}

/**
 * Join a meet's live connection.
 *
 * `initialSnapshot` seeds state the first time this meet is opened in this
 * tab — normally a fresh `getSnapshot` read from whichever loader called
 * this. Later calls for the same meet (a second component mounting) ignore
 * it and share the connection already open: re-seeding from a now-stale
 * loader read would roll back whatever the socket has since delivered.
 *
 * Returns the unsubscribe function; the socket itself closes once the last
 * subscriber for a meet leaves.
 */
export function joinMeetLive(
  meetId: string,
  listener: (state: MeetLiveState) => void,
  initialSnapshot?: MeetSnapshot,
): () => void {
  let conn = connections.get(meetId);
  if (!conn) {
    conn = {
      ws: null,
      state: {
        snapshot: initialSnapshot ?? readCache(meetId) ?? EMPTY_SNAPSHOT,
        connected: false,
      },
      listeners: new Set(),
      reconnectTimer: null,
      reconnectAttempt: 0,
      closed: false,
    };
    connections.set(meetId, conn);
    open(meetId, conn);
  }

  conn.listeners.add(listener);
  listener(conn.state);

  return () => {
    const current = connections.get(meetId);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size > 0) return;

    current.closed = true;
    current.ws?.close();
    if (current.reconnectTimer) clearTimeout(current.reconnectTimer);
    connections.delete(meetId);
  };
}

/** The meet's current live state, without subscribing to it. */
export function meetLiveSnapshot(meetId: string): MeetLiveState {
  return (
    connections.get(meetId)?.state ?? {
      snapshot: readCache(meetId) ?? EMPTY_SNAPSHOT,
      connected: false,
    }
  );
}
