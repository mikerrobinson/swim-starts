/**
 * Who's asking, and what they may do — as pure predicates over data the
 * caller already has, rather than a resolved capability object fetched
 * separately (`meetAccess`/`teamAccess`, both gone).
 *
 * A permission is a comparison between a plain `userId: string | null` and
 * whatever relation actually decides it — `meet.adminIds`, this meet's
 * racing teams intersected with every team the caller coaches, an athlete's
 * own linked account. Nothing here is resolved once into a bag on "the
 * user" and carried around: "who coaches team X" is a fact about
 * `team_coaches`, not about a person, and answering it always goes through
 * the id, never through how that person happened to sign in. That's also
 * why there's no `canEditTeam` here — its two callers (`team-detail.tsx`,
 * `athlete-detail.tsx`) only ever ask about one team at a time, so they
 * call `isTeamCoach` (`coaches.server.ts`) directly instead of routing a
 * single indexed lookup through a predicate that would have to fetch the
 * same thing to be pure.
 */

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
  userId,
}: {
  meet: Pick<MeetFacts, "adminIds">;
  userId: string | null;
}): boolean {
  return userId != null && meet.adminIds.includes(userId);
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
  userId: string | null;
}): boolean {
  return canEditMeet(args);
}

/**
 * Recording a time.
 *
 * Deliberately wider than deciding one. A watch is evidence, there is one row
 * per timer, and an extra one never overwrites anybody — so every coach of a
 * team racing this meet keeps their stopwatch.
 *
 * `coachedTeamIds` is the caller's own `teamsCoachedBy(db, userId)`
 * (`coaches.server.ts`) — resolved locally, once, only by whichever route
 * actually needs this check, never as a standing fact about the user.
 */
export function canRecordTime({
  meet,
  userId,
  coachedTeamIds,
}: {
  meet: Pick<MeetFacts, "adminIds" | "teamIds">;
  userId: string | null;
  coachedTeamIds: string[];
}): boolean {
  return (
    canEditMeet({ meet, userId }) ||
    meet.teamIds.some((teamId) => coachedTeamIds.includes(teamId))
  );
}

/**
 * Entering or scratching one swimmer.
 *
 * A coach may do it for their own team's swimmers. A linked swimmer may do it
 * for themselves, if the meet says so — off by default, because most coaches
 * pick the lineup and the ones who hand it over want to say so deliberately.
 *
 * `athlete.teamIds` is that swimmer's own enrollment and `athlete.userId` is
 * the account they're linked to, if any — both facts about the athlete, not
 * about the meet, so they're the caller's to supply (mirrors the `teamsOf`
 * callback the old `mayEnter` took).
 */
export function canEnter({
  meet,
  userId,
  athlete,
  coachedTeamIds,
}: {
  meet: MeetFacts;
  userId: string | null;
  athlete: { id: string; userId: string | null; teamIds: string[] };
  coachedTeamIds: string[];
}): boolean {
  if (canEditMeet({ meet, userId })) return true;
  if (athlete.teamIds.some((teamId) => coachedTeamIds.includes(teamId))) {
    return true;
  }
  return meet.athletesMayEnter && userId != null && athlete.userId === userId;
}

/** What `TeamMembers.tsx` reads: enough to gate editing and reveal contact
 *  info, assembled inline by the caller (`team-detail.tsx`/
 *  `athlete-detail.tsx`) from a direct `isTeamCoach` lookup rather than
 *  resolved by a predicate here. */
export interface TeamAccess {
  signedIn: boolean;
  userId: string | null;
  coach: boolean;
}
