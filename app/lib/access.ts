/**
 * Who's asking, and what they may do — as pure predicates over data the
 * caller already has, rather than a resolved capability object fetched
 * separately (`meetAccess`/`teamAccess`, both gone). One definition, so a
 * server loader/action and a component call exactly the same function: the
 * button and the endpoint can't disagree about who may press it, and there
 * is nowhere left for the two to be resolved two different ways.
 *
 * `UserIdentity` is resolved once per request — server-side by
 * `resolveUser` (`api.server.ts`), client-side by `useUser()`
 * (`state/user.tsx`) reading what the root loader already resolved — and is
 * meet-agnostic on purpose: whether someone may edit meet X still asks
 * about meet X specifically, via `MeetFacts` below, which is why these
 * predicates take both a `user` and a `meet`/`team` rather than the
 * identity alone.
 */

/** Facts about the person asking, independent of any one meet or team. */
export interface UserIdentity {
  /** Null when signed out. */
  userId: string | null;
  /** The athlete record this account is linked to, if a coach has claimed
   *  one. */
  athleteId: string | null;
  /** Every team this person coaches, globally — not narrowed to any one
   *  meet's racing teams. A predicate below does that narrowing itself. */
  coachOf: string[];
  /** Set on first visit and carried in a cookie from then on — the identity
   *  a phone with nobody signed into it still has. */
  deviceId: string;
  signedIn: boolean;
}

export const ANONYMOUS_USER: UserIdentity = {
  userId: null,
  athleteId: null,
  coachOf: [],
  deviceId: "",
  signedIn: false,
};

/**
 * The facts about a meet a permission check needs. `Meet` (`types/meet.ts`)
 * carries all three directly, so a caller that already fetched one passes
 * it straight in rather than resolving anything of its own.
 */
export interface MeetFacts {
  adminIds: string[];
  teamIds: string[];
  athletesMayEnter: boolean;
}

/**
 * The meet's own details, its lineup and its seeding.
 *
 * Running a meet is scoped to the meet rather than to a team, because a meet
 * belongs to no team — often it's the host's coach, sometimes a referee who
 * coaches nobody.
 */
export function canEditMeet({
  meet,
  user,
}: {
  meet: Pick<MeetFacts, "adminIds">;
  user: Pick<UserIdentity, "userId">;
}): boolean {
  return user.userId != null && meet.adminIds.includes(user.userId);
}

/**
 * Deciding a lane: a DQ, a time entered by hand, a sign-off.
 *
 * Administrators only. With two schools in the water it isn't one school's
 * call to make. Same rule as `canEditMeet` today — kept as its own name so
 * the two can diverge later without hunting down every call site that
 * actually means "may decide".
 */
export function canDecideMeet(args: {
  meet: Pick<MeetFacts, "adminIds">;
  user: Pick<UserIdentity, "userId">;
}): boolean {
  return canEditMeet(args);
}

/**
 * Recording a time.
 *
 * Deliberately wider than deciding one. A watch is evidence, there is one row
 * per timer, and an extra one never overwrites anybody — so every coach of a
 * team racing this meet keeps their stopwatch.
 */
export function canRecordTime({
  meet,
  user,
}: {
  meet: Pick<MeetFacts, "adminIds" | "teamIds">;
  user: Pick<UserIdentity, "userId" | "coachOf">;
}): boolean {
  return (
    canEditMeet({ meet, user }) ||
    meet.teamIds.some((teamId) => user.coachOf.includes(teamId))
  );
}

/**
 * Entering or scratching one swimmer.
 *
 * A coach may do it for their own team's swimmers. A linked swimmer may do it
 * for themselves, if the meet says so — off by default, because most coaches
 * pick the lineup and the ones who hand it over want to say so deliberately.
 *
 * `athlete.teamIds` is that swimmer's own enrollment — a fact about them,
 * not about the meet, so it's the caller's to supply (it mirrors the
 * `teamsOf` callback the old `mayEnter` took).
 */
export function canEnter({
  meet,
  user,
  athlete,
}: {
  meet: MeetFacts;
  user: UserIdentity;
  athlete: { id: string; teamIds: string[] };
}): boolean {
  if (canEditMeet({ meet, user })) return true;
  if (athlete.teamIds.some((teamId) => user.coachOf.includes(teamId))) {
    return true;
  }
  return meet.athletesMayEnter && user.athleteId === athlete.id;
}

/** Anything at all beyond looking. Drives whether editing chrome renders. */
export function canEditAnything({
  meet,
  user,
}: {
  meet: Pick<MeetFacts, "adminIds" | "teamIds">;
  user: UserIdentity;
}): boolean {
  return canRecordTime({ meet, user }) || user.athleteId !== null;
}

/** Who coaches a team — the only standing there is to have. Needs no D1
 *  read of its own: `user.coachOf` (resolved once, globally) already
 *  answers it. */
export function canEditTeam({
  team,
  user,
}: {
  team: { id: string };
  user: Pick<UserIdentity, "coachOf">;
}): boolean {
  return user.coachOf.includes(team.id);
}

/** What `TeamMembers.tsx` reads: enough to gate editing and reveal contact
 *  info, assembled inline by the caller (`team-detail.tsx`/
 *  `athlete-detail.tsx`) rather than resolved by a query of its own. */
export interface TeamAccess {
  signedIn: boolean;
  userId: string | null;
  coach: boolean;
}
