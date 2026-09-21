# Data model rework: entries, swims, watches

Supersedes the "timer route migration plan" this file used to hold — that
plan (loader/action, one cookie per lane) is still the right shape for the
timer *route*, and most of what it produced (`seed-cookie.ts`,
`seed-cookie.server.ts`, `seed-queue.ts`, `timer-request.server.ts`,
`timer-cache.ts`) survives this rework close to unchanged. What changed is
the model underneath it: a rethink of `Seed`/`Watch`/`Result` into
`Entry`/`Swim`/`Watch`, plus a cleaner split between the live WebSocket
channel and the resilient cookie/POST channel. Nothing below is implemented
yet.

## The new shape

```ts
export interface Entry {
  meetId: string;
  eventId: string;
  athleteId: string;
  /** What the coach expects this swim to go, if they said. What seedEvent
   *  will eventually order entrants by, fastest first — today entrants are
   *  ordered by entry order only; this is what unblocks the real thing. */
  seedTimeMs?: number;
  /** Decided at entry time; copied onto the Swim seedEvent creates for this
   *  entry. The swim's own Swim.exhibition can still change independently
   *  afterwards — same reason it does today (known/changed by whoever's at
   *  the lane, not only the person who entered them). */
  exhibition?: boolean;
  enteredAt: number;
  enteredBy?: string;
}

export interface Swim {
  id: string;
  meetId: string;
  eventId: string;
  heat: number;
  lane: number;
  /** "" = nobody named yet — same convention Seed used. */
  athleteId: string;
  /** Denormalised at seat time so a screen — especially the timer's, which
   *  doesn't carry the whole roster — can render a name/team with no join. */
  athleteName: string;
  athleteTeam: string;
  exhibition?: boolean;
  /** Absent = not decided. Present = an administrator signed it off — same
   *  meaning Result used to carry in its own row; now it's just a field
   *  that's either set or it isn't. */
  status?: ResultStatus;
  officialTimeMs?: number;
  decidedAt?: number;
  decidedBy?: string;
}

export type WatchRole = "timer" | "coach" | "admin";

export interface Watch {
  id: string;
  swimId: string;
  /** Device id (anonymous timer) or user id (signed-in coach/admin) — the
   *  identity a slot's history is grouped under. */
  submittedBy: string;
  userId?: string;
  role: WatchRole;
  /** Which of a submitter's concurrent stopwatches this is: 1 unless
   *  clipboard mode. A real column now, not an id-string suffix. */
  slot: number;
  timeMs?: number;
  startedAt?: number;
  stoppedAt?: number;
  submittedAt: number;
}
```

`Result` is gone as a type — its fields moved onto `Swim`. `MeetSnapshot`
becomes `{ entries, swims, watches, athletes }`.

## Rules, confirmed in discussion

- Adding/updating/deleting an entry auto-reseeds its event, same as today,
  still refused once anything is recorded against the event.
- **Swims never backport to entries, in either direction, from any caller**
  — not just timer walk-ups. Seating someone (admin, coach, or timer) who
  isn't entered creates a swim only. This reverses today's `seat()`, which
  inserts an `entries` row as a side effect ("swimming a race is being in
  it"). Accepted consequence: an un-entered swim sharing an event with an
  entry that changes can be reflowed or replaced by the next reseed before
  it's ever timed. Rare, and the same shape as the existing
  reseed-vs-pending-cookie race — a known edge case, not solved for.
- Timers never update entries (already true today; stays true).
- **Watches are append-only.** A correction is a new row, not an update to
  an old one — closer to "evidence, never overwritten" than today's upsert
  ever was. Resolution reads the *latest row per `(swimId, submittedBy,
  slot)`* as that slot's current state; every earlier row for the same slot
  is history, kept for free rather than computed. `dropWatch` remains a real
  delete, but now deletes a slot's whole history — for "this clock claim
  shouldn't exist," which is a different thing from "this clock's reading
  was wrong."
- `role` stays on `Watch` — `laneTime()`'s tiering (admin's own reading >
  timers by hand-timing rules > coaches averaged) is unchanged.

## WS and the resilient cookie: one write path, two ingresses

The framing in the original discussion ("WS is informational, POST is the
real submission") turned out not to need a new reliability tier once we'd
talked through it. What it actually needs is a second, faster *ingress* to
the same effects:

- **The cookie (`seed-cookie.ts`'s `SeedRecord`) stays exactly what it is**
  — the durable, replay-safe restatement of a lane's whole state
  (athlete/team/name, exhibition, every watch slot's start/stop/time),
  consumed by `applySeedCookies` on the next loader hit or action, resilient
  to a dropped connection because it doesn't depend on one.
- **The WebSocket becomes a second way to reach `seat`/`setExhibition`/
  `recordWatch`**, sent the moment a stopwatch is armed or stopped, for
  immediate cross-device visibility (the desk seeing lane 4 arm without
  waiting for a cookie to sync). `MeetDurableObject.webSocketMessage()` is a
  no-op today ("writes arrive over RPC, not this socket") — this is genuinely
  new plumbing, not a reshuffle.
- Because the DO persists a WS-delivered signal exactly the way it persists
  one arriving through the cookie path (your call above), there's no separate
  "informational write" vocabulary to design. The client sends a small
  subset of `Write` — `swim` (seat), `exhibition`, and `watch` with no
  `timeMs` (armed/stopped, not yet submitted) — over the open socket; the DO
  validates it against the connection's attached role
  (`server.deserializeAttachment()`, set at handshake in `fetch()`) and
  dispatches to the same methods the HTTP path already calls, broadcasting
  the same way.
- **Kept off the WS fast-path on purpose**: `entry` (reseeds, wants a stable
  request) and `result`/decide (an irreversible ruling — stays POST/RPC-only,
  never "fire and hope"). A final watch submission with `timeMs` also still
  goes through the cookie/action path as today's WIP already does — the
  socket carries the *arm/stop* signal, not the settled time.
- Net effect: three tiers exactly as you framed them, but the middle and
  bottom tiers share one set of server-side effects instead of two. WS
  dropping a message costs nothing — the cookie already has the full state
  and catches it up on the next request.

## What changes where

- **`schema.server.ts`**: `seeds` → `swims` (add `athlete_name`,
  `athlete_team`, `status`, `official_time_ms`, `decided_at`, `decided_by`;
  drop the separate `results` table); `entries` gains `seed_time_ms`,
  `exhibition`; `watches` gains `id` (PK) and `slot`, loses its
  `(seed_id, timer_id)` primary key — appends only, no `ON CONFLICT`.
- **`meet-do.server.ts`**: mirror the schema changes into the DO's SQLite;
  `seat()` drops its `INSERT OR IGNORE INTO entries`; `recordWatch` becomes a
  plain `INSERT` (dedup-before-write already exists in `seed-cookie.server.ts`'s
  `applyWatches` and stays the guard against duplicate rows); `decideResult`/
  `undecideResult` write straight onto the `swims` row instead of a separate
  table; new `webSocketMessage()` body for the fast-path subset above.
- **`timing.ts`**: new `currentWatches()` collapsing append-only history to
  one row per `(submittedBy, slot)`, used everywhere `watchesOn`/
  `timedWatches` are today; `slotTimerId`/`watchSlot`/`fromDevice` go away —
  `slot` is a real column now; `resultFor`/`swimTime`/`eventTouched`/
  `heatClosed` read `Swim.status`/`officialTimeMs` directly instead of
  scanning a `results` array.
- **`writes.ts`**: `seed`/`unseed` kinds rename to `swim`/`unswim`; `watch`
  gains `slot`; `result`/`unresult` keep their shape but now mean "set/clear
  these fields on the swim row," not "write/delete a row in another table."
- **`pending.ts`**: `applyWrite`'s `watch` case can stay upsert-shaped for the
  *optimistic overlay* even though the server is append-only underneath —
  the overlay only needs "current view," not history, so folding a pending
  watch write over the cached snapshot by `(swimId, submittedBy, slot)` is
  enough.
- **`app/lib/heats.ts`, `app/lib/events.ts`**: types follow (`Seed` →
  `Swim`); `buildSeeds`/`seedEvent`/`reseedEvent` stamp `athleteName`/
  `athleteTeam` onto each swim they create, and copy `Entry.exhibition`
  through as the swim's starting exhibition flag.
- **Timer client (`seed-cookie.ts` etc.)**: closer to unchanged than
  anything else here — `SeedRecord.watches[]`'s array index already *is* the
  slot. New: a `send()` on the live connection (`meet-live.ts`) for the WS
  fast-path, called alongside (not instead of) writing the cookie on
  arm/stop.

## Implementation steps

1. `types/meet.ts`: new `Entry`/`Swim`/`Watch`, drop `Result`, update
   `MeetSnapshot`/`MeetDetail`/`withLiveTables`.
2. `schema.server.ts` + `meet-do.server.ts`: new table shapes (old
   `seeds`/`watches`/`results` dropped outright — nothing in production,
   nothing to carry over), rewritten RPC bodies (`seat`, `recordWatch`,
   `dropWatch`, `decideResult`, `undecideResult`, `ensureLane`),
   `webSocketMessage()` built out for the fast-path subset with role
   validation.
3. `timing.ts`: `currentWatches()`, drop the slot-suffix helpers, repoint
   every reader at `Swim`'s own decided fields.
4. `writes.ts` + `pending.ts`: rename kinds, add `slot`, keep the optimistic
   overlay upsert-shaped.
5. `heats.ts`/`events.ts`: rename `Seed` → `Swim`, stamp denormalised
   name/team and carried-through exhibition on creation.
6. `seed-cookie.server.ts`: repoint at the new RPC method signatures (mostly
   field renames); confirm the existing dedup check is still sufficient
   against append-only inserts.
7. Wire the WS fast-path: client `send()` in `meet-live.ts`, DO-side handler,
   timer screen calls it on arm/stop alongside the existing cookie write.
8. Cut over: replace the four old tables' worth of code in one pass (no
   shim, no dual-read period, per the standing "throwaway prototype" rule);
   delete anything left over that only existed for the old shape.
9. Re-verify the resilience story end to end: kill connectivity mid-heat
   (cookie still catches up), simulate WS never delivering a single arm/stop
   (desk finds out only when the cookie syncs — acceptable, matches "WS is
   the fast one, not the only one"), clipboard mode with 3 slots and a
   correction on slot 2 (history preserved, `currentWatches` picks the new
   one), a reseed mid-way through an un-entered walk-up's heat (accepted
   edge case — confirm it degrades the way we expect, doesn't corrupt).

## Open questions to resume with

- Exact wire shape for the WS fast-path messages: literally a subset of
  `Write` serialized the same way, or a distinct smaller type? Leaning
  toward reusing `Write` (one vocabulary, `writes.ts`'s whole reason to
  exist) with the DO refusing kinds outside the allowed subset.
- Whether `result`/`unresult` get renamed to `decide`/`undecide` now that
  they mean "set fields on a swim" rather than "write a row" — naming only,
  no behavior change either way.
