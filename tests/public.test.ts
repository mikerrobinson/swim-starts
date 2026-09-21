import { done, eq } from "./harness.ts";
import {
  athleteSwims,
  meetResults,
  meetSummary,
  publicAthlete,
  publicAthletes,
  teamRef,
} from "../app/lib/public.ts";
import { defaultEvents } from "../app/lib/events.ts";
import { buildSeeds } from "../app/lib/heats.ts";
import { makeEnrollment } from "../app/lib/roster.ts";
import { DUAL_MEET_SCORING } from "../app/types/meet.ts";
import type { Athlete } from "../app/types/athlete.ts";
import type {
  Result,
  Meet,
  MeetDetail,
  Seed,
  Watch,
} from "../app/types/meet.ts";
import type { Team } from "~/types/team.ts";

/* ------------------------------------------------------------- redaction */

// The whole point of the module: a birth date must not be able to get out,
// and the test says so by listing what may travel rather than what may not.
{
  const avery: Athlete = {
    id: "a1",
    firstName: "Avery",
    lastName: "Nguyen",
    gender: "F",
    birthDate: "2009-03-14",
    userId: "u1",
  };

  const shown = publicAthlete(avery);
  eq(
    Object.keys(shown).sort(),
    ["firstName", "gender", "id", "lastName"],
    "only a name and a gender travel",
  );
  eq(
    JSON.stringify(publicAthletes([avery])).includes("2009-03-14"),
    false,
    "and it isn't hiding in the serialised form either",
  );
  eq(
    JSON.stringify(publicAthletes([avery])).includes("u1"),
    false,
    "nor is the account behind them",
  );
}

/* ------------------------------------------------------- a meet, publicly */

const home: Team = { id: "t1", name: "Cactus Shadows", code: "CHAP" };
const away: Team = { id: "t2", name: "Horizon", code: "HRZN" };

const athletes: Athlete[] = [
  {
    id: "a1",
    firstName: "Avery",
    lastName: "Nguyen",
    gender: "F",
    birthDate: "2009-03-14",
  },
  { id: "a2", firstName: "Marcus", lastName: "Hill", gender: "M" },
  { id: "a9", firstName: "Dana", lastName: "Reyes", gender: "F" },
];

const events = defaultEvents("m1", { course: "SCY" });
const free50 = events.find((e) => e.distance === 50 && e.stroke === "Free")!;
const seeds = buildSeeds("m1", free50.id, ["a1", "a9", "a2"], 6);
const seedOf = (id: string) => seeds.find((s) => s.athleteId === id)!;

const meetRow: Meet = {
  id: "m1",
  name: "vs Horizon",
  date: "2026-11-14",
  type: "dual",
  course: "SCY",
  teamIds: [home.id, away.id],
  hostTeamId: home.id,
  laneCount: 6,
  timersPerLane: 1,
  leadGender: "F",
  includeDiving: true,
  limits: {},
  entryVisibility: "everyone",
  athletesMayEnter: false,
  laneAssignments: {},
  scoring: DUAL_MEET_SCORING,
};

const watch = (athleteId: string, timeMs: number, at: number): Watch => ({
  seedId: seedOf(athleteId).id,
  timerId: "t1",
  role: "timer" as const,
  timeMs,
  recordedAt: at,
});

const detail: MeetDetail = {
  meet: meetRow,
  teams: [home, away],
  events,
  entries: { [free50.id]: ["a1", "a9", "a2"] },
  seeds,
  // Dana is fastest, Avery second, Marcus is disqualified.
  watches: [
    watch("a9", 25_400, 1),
    watch("a1", 26_100, 2),
    watch("a2", 24_900, 3),
  ],
  results: [
    {
      seedId: seedOf("a2").id,
      eventId: free50.id,
      athleteId: "a2",
      status: "DQ",
      timeMs: 24_900,
      decidedAt: 4,
    },
  ] as Result[],
  athletes,
  enrollments: [
    makeEnrollment(home.id, "s1", "a1", { year: "10" }),
    makeEnrollment(home.id, "s1", "a2", { year: "11" }),
    makeEnrollment(away.id, "s2", "a9", { year: "12" }),
  ],
};

/* ---- summary ---- */
{
  const summary = meetSummary(detail.meet, detail.teams, {
    events: events.length,
    entries: 3,
    times: 3,
  });
  eq(
    summary.teams.map((t) => t.code),
    ["CHAP", "HRZN"],
    "both teams are named",
  );
  eq(summary.hostTeamId, home.id, "and the host is known");
  eq(summary.entries, 3, "three entries");
  eq(summary.times, 3, "three lanes with something recorded");
  eq(summary.events, events.length, "the whole lineup is counted");
}

/* ---- results ---- */
{
  const teamOf = (id: string) => {
    const enrolled = detail.enrollments.find((e) => e.athleteId === id);
    if (!enrolled) return null;
    return enrolled.teamId === home.id ? teamRef(home) : teamRef(away);
  };

  const byEvent = meetResults(detail, teamOf);
  const race = byEvent.find((e) => e.id === free50.id)!;

  eq(
    race.placings.map((p) => p.athlete?.firstName),
    ["Dana", "Avery", "Marcus"],
    "ranked by time across the heat, with the DQ last",
  );
  eq(
    race.placings.map((p) => p.place),
    [1, 2, null],
    "a disqualified swim keeps its line and loses its place",
  );
  eq(
    race.placings[0].team?.code,
    "HRZN",
    "each swim is credited to the right team",
  );
  eq(race.placings[1].team?.code, "CHAP", "on both sides of the meet");
  eq(
    race.official,
    false,
    "one swim signed off doesn't make the event official",
  );
  eq(
    race.placings.map((p) => p.final),
    [false, false, true],
    "only the signed-off swim claims to be official",
  );
  eq(
    JSON.stringify(byEvent).includes("2009-03-14"),
    false,
    "no birth date reaches a results page",
  );

  // Diving holds its place in the running order and carries no times.
  const diving = byEvent.find((e) => e.stroke === "Diving");
  if (diving) eq(diving.placings, [], "diving is listed but never scored here");
}

/* ---- exhibition ---- */
{
  // Avery's swim doesn't count towards scoring or placing, but the time
  // still stands — same detail as above, with her seed flagged.
  const exhibitionSeeds = seeds.map((s) =>
    s.athleteId === "a1" ? { ...s, exhibition: true } : s,
  );
  const exhibitionDetail: MeetDetail = { ...detail, seeds: exhibitionSeeds };

  const teamOf = (id: string) => {
    const enrolled = exhibitionDetail.enrollments.find(
      (e) => e.athleteId === id,
    );
    if (!enrolled) return null;
    return enrolled.teamId === home.id ? teamRef(home) : teamRef(away);
  };

  const byEvent = meetResults(exhibitionDetail, teamOf);
  const race = byEvent.find((e) => e.id === free50.id)!;

  eq(
    race.placings.map((p) => p.athlete?.firstName),
    ["Dana", "Avery", "Marcus"],
    "an exhibition swim keeps its line, below what counts, ranked by time within its own group",
  );
  eq(
    race.placings.map((p) => p.place),
    [1, null, null],
    "but it takes no place of its own",
  );
  eq(
    race.placings.map((p) => p.exhibition),
    [false, true, false],
    "only her swim is flagged exhibition",
  );
  eq(race.placings[1].timeMs, 26_100, "her time still shows, same as anyone's");
}

/* ---- ordering: what counts, then exhibition, then DQ, then NS ---- */
{
  // A faster exhibition swim doesn't outrank a slower one that counts, and a
  // DQ or an NS — with no time to sort by — settle alphabetically rather than
  // reshuffling between reloads. Two DQs prove the name tie-break; the NS
  // named "Aaron" proves group beats name, since it would sort first by name
  // alone.
  const orderAthletes: Athlete[] = [
    { id: "x1", firstName: "Xena", lastName: "Adams", gender: "F" },
    { id: "y1", firstName: "Yolanda", lastName: "Brooks", gender: "F" },
    { id: "z1", firstName: "Zoe", lastName: "Chen", gender: "F" },
    { id: "z2", firstName: "Amber", lastName: "Diaz", gender: "F" },
    { id: "w1", firstName: "Aaron", lastName: "Young", gender: "F" },
  ];
  const orderSeeds: Seed[] = [
    {
      id: "sx",
      eventId: free50.id,
      heat: 1,
      lane: 1,
      athleteId: "x1",
    },
    {
      id: "sy",
      eventId: free50.id,
      heat: 1,
      lane: 2,
      athleteId: "y1",
      exhibition: true,
    },
    {
      id: "sz1",
      eventId: free50.id,
      heat: 1,
      lane: 3,
      athleteId: "z1",
    },
    {
      id: "sz2",
      eventId: free50.id,
      heat: 1,
      lane: 4,
      athleteId: "z2",
    },
    {
      id: "sw",
      eventId: free50.id,
      heat: 1,
      lane: 5,
      athleteId: "w1",
    },
  ];
  const orderResults: Result[] = [
    {
      seedId: "sz1",
      eventId: free50.id,
      athleteId: "z1",
      status: "DQ",
      timeMs: 0,
      decidedAt: 1,
    },
    {
      seedId: "sz2",
      eventId: free50.id,
      athleteId: "z2",
      status: "DQ",
      timeMs: 0,
      decidedAt: 1,
    },
    {
      seedId: "sw",
      eventId: free50.id,
      athleteId: "w1",
      status: "NS",
      timeMs: 0,
      decidedAt: 1,
    },
  ];
  const orderDetail: MeetDetail = {
    ...detail,
    meet: { ...meetRow, id: "m9" },
    seeds: orderSeeds,
    entries: { [free50.id]: ["x1", "y1", "z1", "z2", "w1"] },
    watches: [
      // Yolanda's exhibition swim is the fastest time in the pool.
      {
        seedId: "sx",
        timerId: "t1",
        role: "timer",
        timeMs: 30_000,
        recordedAt: 1,
      },
      {
        seedId: "sy",
        timerId: "t1",
        role: "timer",
        timeMs: 20_000,
        recordedAt: 1,
      },
    ],
    results: orderResults,
    athletes: orderAthletes,
    enrollments: [],
  };

  const byEvent = meetResults(orderDetail, () => null);
  const race = byEvent.find((e) => e.id === free50.id)!;

  eq(
    race.placings.map((p) => p.athlete?.firstName),
    ["Xena", "Yolanda", "Amber", "Zoe", "Aaron"],
    "counts first (by time), then exhibition (by time), then DQ (by name), then NS (by name)",
  );
  eq(
    race.placings.map((p) => p.place),
    [1, null, null, null, null],
    "only the swim that counts gets a place",
  );
}

/* ---- one athlete's history ---- */
{
  const secondSeeds = buildSeeds("m2", free50.id, ["a1"], 6);
  const faster: MeetDetail = {
    ...detail,
    meet: { ...meetRow, id: "m2", name: "vs Central", date: "2027-01-10" },
    seeds: secondSeeds,
    entries: { [free50.id]: ["a1"] },
    results: [],
    watches: [
      {
        seedId: secondSeeds[0].id,
        timerId: "t1",
        role: "timer" as const,
        timeMs: 25_800,
        recordedAt: 5,
      },
    ],
  };

  const swims = athleteSwims("a1", [detail, faster]);
  eq(swims.length, 2, "both of Avery's swims");
  eq(swims[0].date, "2027-01-10", "newest first");
  eq(
    swims.map((s) => s.best),
    [true, false],
    "the faster one is the best",
  );
  eq(swims[0].timeMs, 25_800, "and it's the one that actually was faster");
  eq(swims[0].place, 1, "with the place it earned in that event");

  // A time in another pool length is a different record entirely.
  const metric: MeetDetail = {
    ...faster,
    meet: { ...faster.meet, id: "m3", course: "LCM", date: "2027-02-01" },
  };
  const mixed = athleteSwims("a1", [detail, faster, metric]);
  eq(
    mixed.filter((s) => s.best).length,
    2,
    "a best per course, since a yard time and a metre time aren't comparable",
  );

  eq(
    athleteSwims("nobody", [detail]),
    [],
    "someone who never swam has no history",
  );
}

done();
