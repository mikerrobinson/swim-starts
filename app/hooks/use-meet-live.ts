import { useEffect, useState } from "react";
import { joinMeetLive, type MeetLiveState } from "~/lib/meet-live";
import type { MeetSnapshot } from "~/types/meet";

/**
 * Subscribe a component to a meet's live connection.
 *
 * `initialSnapshot` only matters the first time any component asks for this
 * meet in this tab — pass the `getSnapshot` read a route's own loader already
 * made, so the very first render has real data instead of the cache or an
 * empty one. Once the connection exists, every subscriber (this one
 * included) shares it; see `joinMeetLive`.
 *
 * `meetId` may be `undefined` for the render or two before a loader has
 * resolved one (a "no such meet" screen, say) — this stays disconnected
 * rather than opening a socket to a malformed URL.
 */
export function useMeetLive(
  meetId: string | undefined,
  initialSnapshot?: MeetSnapshot,
): MeetLiveState {
  const [state, setState] = useState<MeetLiveState>(() => ({
    snapshot: initialSnapshot ?? { entries: {}, swims: [], watches: [], athletes: [] },
    connected: false,
  }));

  useEffect(() => {
    if (!meetId) return;
    return joinMeetLive(meetId, setState, initialSnapshot);
    // Deliberately not depending on `initialSnapshot`: it's a one-time seed
    // for the connection, not a value this effect should re-run for — a
    // loader re-read on every render would otherwise reopen the socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetId]);

  return state;
}
