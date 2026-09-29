# Ideas & loose ends

Things suggested along the way that we didn't build, plus known rough edges.
Nothing here is committed to — it's a parking lot. Add your own freely.

---

## Next up

Rewritten 2026-09-13, after the rebuild onto a server-authoritative model. The
old list below this section is still a parking lot; this part isn't.

### 1. ~~Live updates while a meet is running~~ — polling built

`useLiveData()` in `app/hooks/use-live-data.ts` revalidates the run, entries
and results screens every 3s while the tab is visible, the previous read has
come back, and this device owes the outbox nothing. Verified on a real meet:
a watch written straight into D1 appeared on the deck screen five seconds
later with nothing touching the page.

What's still open is the push version. Talked through 2026-09-16, and the
conclusion was that **a Durable Object per meet is the right end state and the
wrong next step**. Staged below, cheapest first.

**What it costs today.** `useLiveData` revalidates the whole matched loader
chain, and `entries`, `results` and `run` all nest under `meet-layout.tsx`
(`routes.ts:56-61`), whose loader runs `meetDetail` + `meetAccess` — about nine
whole-table selects returning the entire meet document. Twelve phones is
roughly 4 req/s and ~36 D1 queries/sec. Nobody has measured a real meet yet,
and that measurement is what should decide whether any of this is worth doing.

**Step one — a monotonic `version` (or `updated_at`) on `meets`**, bumped by
every write in `api.meet.writes.ts`. There is no such column today, and it is
the prerequisite for every other step. Then `GET /api/meets/:meetId/version`,
one indexed single-row read, polled every 3s, with `revalidate()` called only
when it moves. Roughly thirty lines and no new infrastructure, and it keeps the
property the whole app leans on: loaders stay the only read path. Between heats
a poll costs one row; during a heat it costs what it costs now.

**Step two, if sub-second is ever actually wanted — the DO as a doorbell, not a
store.** The write endpoint pokes the meet's object, the object broadcasts
`version: N`, clients revalidate. That is the _same client contract as step
one_, push instead of pull, so building step one builds the client half of
this. D1 stays the source of truth and there is no delta reducer — which is the
point: `writes.ts` already names three places the `Write` union has to mean the
same thing, and a socket carrying row deltas would make it four, the fourth
having to agree with both `meetDetail`'s shaping and `applyPending`'s overlay.

**Step three — moving meet rows into the DO — is a separate decision** and not
obviously ever worth it. Reach for it only for something polling cannot do at
all: an authoritative race clock shared across phones, presence ("lane 4's
timer is connected"), or single-writer ordering. None of those are requirements
today.

Writes stay POSTs through the outbox at every stage. A socket is a bad
transport for something that has to survive a locked phone.

**Why not plain HTTP caching and ETags?** Considered and set aside, for the
loader path at least. To emit an ETag you have to know whether anything
changed, so a body-hash ETag runs all nine queries and then throws the response
away — it saves bytes, which was never the cost. A _cheap_ ETag has to derive
from a version column, so it needs step one regardless and is then just the
version carried in a header. Three things make it the worse carrier here: RR7
single-fetch bundles parent and leaf loaders into one `.data` response, so one
ETag must span `meetDetail`, `meetAccess` and every loader later added to that
chain — the same drift `writes.ts` is written to prevent; returning 304 through
the turbo-stream encoding depends on React Router's internal fetch
participating in the browser HTTP cache, which is unverified and would want a
spike before anything rides on it; and a 304 still completes the revalidation
cycle, handing back fresh object identities, so every lane tile on `run.tsx`
re-renders every 3s anyway. The version check skips the render as well as the
request.

Where ETags _would_ fit cleanly is the plain fetch endpoints — `api.timer.meet.ts`,
`api.teams.ts` — which have no single-fetch encoding and no revalidation cycle.

One hazard either way: these responses are permission-scoped (`meetAccess`,
`entry_visibility`). Any caching headers here must be `private, no-cache`,
never `public`. Getting that wrong serves one coach's entry view to another,
and it hides well, because it only appears with a warm cache.

One thing to watch on a deck first: the deck stopwatch treats a lane as
stopped if _any_ time arrives on it after START (`run.tsx`, `allStopped`), so a
coach timing two of six lanes isn't left waiting on the four the phones cover.
That branch could never fire mid-race before, because the loader didn't
refresh. Now it can. It is what the code intends — but it has never actually
happened during a race, so watch the first heat it does. Version-gating the
poll changes _when_ a refresh lands, not whether one does, so it doesn't make
this any safer.

### 2. The stopwatch screen has had the least use

`run.tsx` compiles and renders, and the control desk has been exercised
properly against a real database — the deck stopwatch has not been driven
through a whole heat since the rewrite. Before a meet: START, stop several
lanes, Reset, Next heat, and the lane sheet's "Replace my time".

Known cosmetic thing: on a _re-swim_, lanes carrying times from the previous
swim render green with those times rather than a red STOP, so it's not obvious
which lanes still need taking here. Tapping them works.

### 3. Two things dropped in the rebuild, if you want them back

- **Whole-season JSON import**, under Settings. Export stays. Restoring a
  season into a shared server is a genuinely different operation from restoring
  a device, and it wasn't worth guessing at.
- **"Add swimmer" on the entries grid.** It wrote a roster row from the entries
  screen; that's the team screen's job now. Cheap to add back as a shortcut.

### 4. Scoring

`ScoringRules` and `DUAL_MEET_SCORING` (6-4-3-2-1 / 8-4, split by gender) are
defined in `types/meet.ts` and computed by nothing. The biggest genuinely
missing feature, and the entries/results shape is ready for it.

### ~~5. Settle the site navigation~~ — done

The bar is **Teams / Meets / Athletes**. `/team` and `/settings` are both gone:
the first duplicated `/teams/:id`, and the second was team administration that
belonged there plus one display preference that belonged on Profile. The
"Browse" tab and the Teams/Meets/Athletes button bar above those lists went too
— with three tabs they were the same control twice.

Worth knowing: `rememberPlace()` in `state/session.tsx` is still never called,
so `user.lastTeamId` is never written. Nothing depends on it now that team
screens take the team from the URL — the shell header still falls back to the
first active membership for its title, which is cosmetic. Either wire it up or
drop it.

### 6. An athlete's own screen

The permission is built and enforced (`athletesMayEnter` + `mayEnter`); the
screen is missing. A swimmer wants their own short list — the races in the next
meet, which ones they're in, and the limits counting down as they pick — not
the coach's grid. This is the use case the app was originally built for.

### ~~Defining who's racing~~ — restored

`MeetTeams` survived the rebuild but nothing imported it, so a meet's teams
could only ever be the ones `createMeet` inferred from the creator's
memberships — invisible and unchangeable afterwards. The server half was
intact the whole time (`meet_teams`, `updateMeet`'s `teamIds`/`hostTeamId`,
`POST /api/teams`); only the UI was missing.

Now: a "Teams racing" card on the meet's own page, and the same picker in the
new-meet sheet with the creator's own team already on it. `TeamPicker` is
shared by both, so the two places can't answer the question differently.

Left deliberately alone: removing a team whose swimmers are entered asks first
and then allows it, rather than cascading. The entries stay, pointing at
athletes no racing team enrols — which is the honest outcome, since sometimes
the wrong school really was added and its entries are the mistake too. If that
proves to be the wrong call on a deck, the fix is scratching them with the
team, not refusing the removal.

### ~~Timer link stuck on "Getting ready…"~~ — gone with the cookie

The claim screen kept the scanned token in localStorage from an effect, so the
whole timing path needed script to run _and_ the browser to agree to store
things — neither being a safe bet about a stranger's phone opening a link from
a camera app. `/t/:token` is now a loader with no component: it sets an
HttpOnly cookie and redirects. Verified with `curl` alone, no JS in the loop.

One loose end: `forgetLegacyGrant()` deletes the old localStorage token on any
phone that timed a meet on the previous build. It can go once none have, as can
the legacy read in `loadTimerId`.

Followed through the rest of the way: lane, position, meet and the device's
timer id are cookies too, and every remaining `localStorage` call goes through
`local.ts` and can no longer throw. Verified by making the whole storage API
throw at boot — the timer screen used to die with "Something went wrong ·
blocked", and now runs a heat start to finish, keeping its identity so it
replaces its own watch rather than filing a second one.

Then the queue followed. A timer's outbox is now cookies named for the action
and pathed to the lane, posting to
`/api/meets/:id/timers/:timerId/:event/:heat/:lane` with no body at all — see
the README. Coaches and admins keep the localStorage outbox; the two paths face
different problems and are allowed to differ.

The screens followed the endpoints: `/meets/:id/timers/:timerId` is the lane
picker and `/meets/:id/timers/:timerId/:event/:heat/:lane` is the stopwatch, so
heat changes are navigation and the lane/heat/event/meet cookies are gone.

Still open on that path:

- ~~**`timer_activity` is written and read by nothing else.**~~ It rides on
  `MeetDetail` now, and `laneProgress()` turns it into the colour of the desk's
  time box: grey for a lane nobody is covering, amber while watches are
  running, green once every one that armed has come in. That colour is the
  whole reason `start` is sent on its own.
- **The overflow state has never fired in anger.** The size check and the red
  header are written and unit-reasoned but not exercised; forcing it would mean
  filling a cookie jar on a real device.
- **`/api/timer/meet` is still the one read.** It could carry the activity rows
  so a timer sees that the lane next to them hasn't started either.

### `call.timeMs` is vestigial

Every typed time is a watch now, so nothing writes a time onto a call. Rows an
older build made still have one, and `resultForLane` still honours it — which is
right, because those are real decisions somebody made. Once production has none
left, the field and its branch can go, and `TimeMethod`'s `"official"` with it.

Check with:

```sql
SELECT COUNT(*) FROM calls WHERE time_ms IS NOT NULL;
```

## Features

### An athlete's own screen

Phase 3 linked accounts to roster entries and gave a linked swimmer permission
to enter and scratch _themselves_ through `/api/sync` — verified, and refused
for anyone else's entries. What's missing is the screen. `/users/{id}` shows
their teams, meets and times read-only; there's nothing to tap to sign up for
the 100 Free.

The registration grid is the coach's tool — a roster down the side, every race
across the top — and is the wrong shape for one person. What a swimmer wants is
their own short list: the races in the next meet, which ones they're in, and
the entry limits (4 events, max 2 individual) counting down as they pick.

This is the use case the app was originally built for: iPads handed round on
deck before a meet so swimmers sort out their own entries. It's the only part
of that still missing, and the permission work is already done.

### Entry limits

NFHS caps a swimmer at 4 events, max 2 individual (varies by state). The
registration row already shows "3 ev" — turn it amber at the cap and red past
it. Small, and catches an illegal lineup before an official does.

### Dual-meet scoring, scored separately by gender

6-4-3-2-1 individual, 8-4 relay, with a running team score. The obvious missing
piece for a real dual meet, and the split girls/boys lineup is already the
structure it needs. The biggest item on this list.

### Auto-pair when adding an event

In a split lineup, adding "100 Fly" nearly always means adding both girls' and
boys'. Right now you add one and repeat. Could add the pair in lead order from
one tap.

### SD3 import and export

The plan: read the standard `.sd3` files Hy-Tek, SwimTopia and Commit export, so
an opponent's lineup can be imported rather than typed, and write results back
out so a meet can be shared into whatever the other team runs. Needs teams as
first-class references first — an SD3 entry belongs to a team, not to "us".
Export is the easier half and the one that pays off immediately after a meet.

Swimmer birth dates are stored as of 2026-09-05, which SDIF needs on every
athlete record — though as of the 2026-09-07 production backup not one of the
96 athletes actually has one, so export needs them entered before it can work. Still missing for export: an LSC/club code for the team, and
whatever the exporter decides to do about athlete IDs — the legacy USS number
is derived from the birth date and name, but a real registration ID is not
something we can invent, so unregistered swimmers will need a fallback.

### ~~Teams as first-class references~~ — built

A meet now carries `teamIds` referencing real team documents, athletes are
global, and a team can exist unclaimed until a coach from that school signs in.
Two schools work the same meet rather than keeping half a copy each. This was
the prerequisite blocking SD3 and multi-team scoring; both are now unblocked.

### Copy the lineup from a previous meet

Cheaper than full reusable templates (which we passed on) and gets most of the
benefit — "same as last time" covers most of a season.

### Jump to the next unswum event

With 22+ events there's a lot of tapping past ones already done. A "next event
with entries and no times" jump would save it.

### Relay lane labels

A relay lane is currently held by a single swimmer standing in for the squad.
Letting a lane be labelled "Blue A" / "Gold B" instead would read better, at the
cost of a real relay model.

### Column striping on registration

Rows are striped now. Columns could be too, though doing both makes a
checkerboard — worth trying only if rows alone aren't enough on a wide grid.

---

## Safety / correctness

### ~~Roster "Replace" orphans entries~~ — gone with the rewrite

Enrollment ids are derived from season and athlete, so a re-import updates rows
rather than minting new people, and `meetDetail` fetches exactly the people its
rows name. There is nothing left to be orphaned from.

### False-start recovery

`Reset` is deliberately off-screen while a heat is live, so an early START
costs seven taps to unwind (stop every lane, then reset). Suggested fix:
long-press the running clock to reset — deliberate enough not to happen by
accident, one gesture instead of seven.

### "Next heat" is live mid-race

It sits bottom-right, big and blue, and ending a heat early drops times for any
lane that hadn't stopped. Could require a confirm while lanes are outstanding.

---

## Smaller polish

- **Import prompt below the fold.** The Add / Replace / Cancel prompt renders at
  the bottom of the Import card, under the whole roster — on a long roster it's
  off-screen and the import looks like it did nothing.
- **Lane tile truncation.** Full names ("Castellanos, Sofia") truncate more on a
  half-width grid tile than the old initials did. Fine in list layout.
- **Name order elsewhere.** Results, swimmer detail and the CSV export still use
  natural "First Last" rather than the Settings name order. Deliberate — those
  read as records rather than a scanned column — but worth revisiting. The
  preference itself now lives on the device rather than the team, since a
  visiting coach shouldn't change how the host reads its own roster; moving it
  on again to the user record would make it follow someone between devices.
- **Time entry keypad.** `inputMode` is still `decimal` though the "." is no
  longer needed; `numeric` would be a cleaner pad. Prefilling the field with
  bare digits would also make correcting a time a couple of taps instead of a
  retype.
- **Dead search box.** The registration search filter is still in the row
  expression but unreachable while `SHOW_ROSTER_CONTROLS` is `false`.
- **The old "Add / Replace" import prompt** on the team screen now posts to an
  action rather than a store, so the note above about it rendering below the
  fold is worth re-checking against the rewritten screen before acting on it.
- **Diving is display-only.** By design — it shows on registration and holds
  its place in the running order, but carries no scores, so it never appears on
  the Results screen or in the CSV export. If dual-meet scoring lands, diving
  points would have to be typed in from the diving sheet.
- **Header title on narrow phones.** True-centring the Girls/Boys toggle caps
  the meet name at half the width on registration. Could centre only above a
  breakpoint if that bites.

---

## Your ideas

<!-- add below -->

### Split the stopwatch tick out of `timer.tsx`

`elapsed` lives in the same component that also derives `swims`/`watches`/
`order` from the whole meet (`useMemo(() => Object.values(meet.swims), [meet.swims])`
and friends). A running stopwatch's `requestAnimationFrame` loop calls
`setElapsed` up to 60×/sec, re-rendering all of that along with the digits,
on a screen explicitly built for "storage-hostile phones."

Fix: pull `startedAt` → `elapsed` (and the RAF loop) into its own small leaf
component that owns just the ticking display. The parent then only
re-renders when `startedAt` itself changes — start/stop, a real event, not
every frame — and the `swims`/`watches`/`order` derivation only reruns then
too. Should happen regardless of anything else; also makes memoizing those
derivations in `admin-heat.tsx`/`splits-heat.tsx`/`timer.tsx` (same
`useMemo(() => Object.values(meet.X), [meet.X])` pattern in all three, none
of which use `useHeat()` yet) a much smaller concern once it's done, since
the parent stops re-rendering 60×/sec regardless of memoization.

### ~~`memberships` → `team_coaches`~~ — done

`memberships` carried a `role` of five values and a `status` of two so it could
describe a coach, an athlete, a parent, a viewer and somebody waiting to be let
in. Only the first ever changed what the code did — every check in the app was
`isCoach()` or `canAdmit()` — and the rest described relationships that already
lived somewhere truer: a swimmer is on a team because they're _enrolled_ in one
of its seasons, and their account is tied to them by `athletes.user_id`.

It's now `team_coaches (team_id, user_id, added_at, added_by)`, the same shape
as `meet_admins`, in `coaches.server.ts` beside `admins.server.ts`. "May I?" is
"am I in the list?" on both sides. `ensureCoachStore` carries the coach rows
across and drops the old table — one-shot, and the absence of the table is the
flag that it ran.

Gone with it: asking to join and being approved (getting onto a team that has a
coach is the coach's move now, as it is for a meet), the role on an invitation,
`GET /api/memberships`, `/api/members`, `ROLES`/`ROLE_LABELS`/`isCoach`/
`canAdmit`/`rank`, and the "must already be on this team" check in front of
linking a swimmer's account.

Asymmetry worth keeping straight: a meet is always created with an
administrator, a team may start with none. An empty coach list _is_ unclaimed,
and it's the only time somebody can add themselves — `POST
/api/teams/:id/coaches { claim: true }`. Falling back into that state from one
coach would mean a team anybody could take over, so removing the last coach is
refused.

Timer UI has a Confirm/Change Swimmer prompt to generate positive acknowledgement signal
