/**
 * One representation of a human being — the account, nothing else.
 *
 * How they authenticate (an email, a phone number) is `Identity`
 * (`auth.server.ts`), not a field here — a contact is how you reach an
 * account, not a fact about it. Which device asked is a cookie
 * (`device.server.ts`), orthogonal to whether anyone is signed in at all.
 * Who this account may act on (coaching a team, running a meet, owning an
 * athlete record) is never carried here either — that's the resource's own
 * relation (`meet.adminIds`, `team_coaches`, `athlete.userId`), read by this
 * id, at the point something needs to know.
 */
export interface User {
  id: string;
  name: string | null;
  createdAt: number;
  lastSeenAt: number;
  lastTeamId: string | null;
  lastSeasonId: string | null;
}
