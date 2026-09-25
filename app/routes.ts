import {
  type RouteConfig,
  index,
  route,
  layout,
} from "@react-router/dev/routes";

export default [
  // Signing in and finding a team sit outside the shell: there's no team to
  // put in its header and nowhere for its tabs to go.
  route("sign-in", "routes/sign-in.tsx"),
  route("join", "routes/join.tsx"),

  // Ending a session, which is the one account move reachable from every page
  // rather than from a screen of its own.
  route("session", "routes/session.ts"),

  /**
   * The timer's whole world: a scanned link, a lane, and the stopwatch.
   *
   * Outside the shell — no team header, no tab bar, nothing to wander into.
   *
   * Addressed the same way the endpoint behind them is, because where a timer
   * is standing is not device state: it is which page they are on. Changing
   * heats is a link, going back a heat is the back button, and a phone that
   * reloads comes back exactly where it was without having remembered
   * anything. It is also what a volunteer can be read down the pool — "you're
   * on event seven, heat one, lane three" — when something has gone wrong.
   *
   * Which phone it is has no segment of its own. It is a cookie, set when the
   * code was scanned and attached to every request after that, and the server
   * reads it there rather than from the URL — where it would only ever be
   * whatever the URL claimed.
   */
  route("t/:token", "routes/timer-claim.tsx"),

  layout("routes/shell.tsx", [
    index("routes/home.tsx"),

    // Every team and everyone. One page per team, whether you coach there or
    // are following a link to look — the editing appears for whoever the
    // server says may edit, so there is no second copy of a roster to drift.
    route("teams", "routes/teams.tsx"),
    route("teams/:teamId", "routes/team-detail.tsx"),
    route("athletes", "routes/athletes.tsx"),
    route("athletes/:athleteId", "routes/athlete-detail.tsx"),

    // Somebody's own page: their teams, their meets, their times.
    route("users/:userId", "routes/user-detail.tsx"),
    route("profile", "routes/profile.tsx"),

    route("meets", "routes/meets.tsx"),
    // Everything under a meet id runs against that one meet. One loader
    // (`meet-layout.tsx`) hands back the whole `MeetManifest`, cached
    // client-side and kept live by its one shared socket; every child below
    // reads it via `useMeet()` rather than holding a subscription of its
    // own. Read-only for everyone; the editing appears for whoever the
    // server says may edit.
    route("meets/:meetId", "routes/meet-layout.tsx", [
      index("routes/meet-info.tsx"),
      route("entries", "routes/entries.tsx"),
      // One grant check for the whole timer workspace, then the lane picker
      // and the per-lane stopwatch — both reading the meet's live state via
      // `useMeet()` like everything else here. See timer-shell.tsx.
      route("timer", "routes/timer-shell.tsx", [
        index("routes/timer-lanes.tsx"),
        route(":event/:heat/:lane", "routes/timer.tsx"),
        route("alt/:event/:heat/:lane", "routes/timer2.tsx"),
      ]),
      route("admin", "routes/admin.tsx", [
        index("routes/admin-index.tsx"),
        // The heat desk: one heat's lane matrix, addressed the same way the
        // timer already addresses a lane — event position, then heat
        // number, both 1-based, neither a row id.
        route(":event/:heat", "routes/admin-heat.tsx"),
      ]),
      route("splits", "routes/splits.tsx", [
        index("routes/splits-index.tsx"),
        // Same addressing as admin's heat desk.
        route(":event/:heat", "routes/splits-heat.tsx"),
      ]),
      route("results", "routes/results.tsx", [
        index("routes/results-index.tsx"),
        // by-event / by-swimmer / team-scores, as a path segment rather
        // than `?view=`. `by-swimmer` isn't built yet — see results-view.tsx.
        route(":view", "routes/results-view.tsx"),
      ]),
      // Public, read-only: one event's declared entries, heat seeds and
      // decided times. Ordered after the literal children above; React
      // Router ranks a static segment over a dynamic one at the same depth
      // regardless of declaration order, but the ordering still reads
      // truer this way.
      route(":eventId", "routes/event-detail.tsx"),
    ]),
  ]),

  // Lists of people, and searching for one. The screens that show a team or a
  // meet load it from their own loader; these are what the cards on those
  // screens ask for as somebody types.
  route("api/teams", "routes/api.teams.ts"),
  route("api/users", "routes/api.users.ts"),

  // The meet's live connection: a WebSocket upgrade onto the meet's Durable
  // Object, which broadcasts every accepted write. See api.meet.live.ts.
  route("api/meets/:meetId/live", "routes/api.meet.live.ts"),
] satisfies RouteConfig;
