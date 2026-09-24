import type { Route } from "./+types/api.meet.writes";
import {
  SyncError,
  currentUser,
  errorResponse,
  json,
  readJson,
  requireDb,
  resolveUser,
} from "~/lib/api.server";
import { canDecideMeet, canEditMeet, canRecordTime } from "~/lib/access";
import { getMeet } from "~/lib/meets.server";
import type { Write } from "~/lib/writes";

/**
 * Everything the deck writes.
 *
 *   POST /api/meets/:meetId/writes  <- one `Write`
 *
 * The outbox's transport, and deliberately shaped like the outbox rather than
 * like a REST API. It used to be four endpoints — entries, seeds, watches,
 * results — each re-deriving who was asking before doing one small thing, and
 * the queue kept a table translating its own vocabulary into their URLs and
 * methods. The queue already knows what a change *is*; this speaks the same
 * union back, so there is nothing in between to keep in step.
 *
 * One row per write. That is what lets two coaches fill in their own halves
 * of a dual meet at the same moment without either writing over the other,
 * and it is why the queue can retry a single write without replaying a batch.
 *
 * **Every kind goes to the meet's Durable Object, not D1** — the DO is
 * written to immediately for anything meet-scoped, and
 * seeds/watches/results/entries are exactly that. The DO serializes every
 * write itself and broadcasts it, which is what lets a connected admin/coach
 * screen see it land without polling.
 *
 * **Who may do what is asked once, and then per kind.** The meet and the
 * asker's identity are each resolved once for the whole request; the rule
 * that follows differs because the moves genuinely differ — entering a
 * swimmer is a coach's business for their own team, a watch is evidence any
 * racing coach may add, and deciding a lane is the administrator's alone.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env;
  try {
    if (request.method !== "POST") throw new SyncError("Use POST", 405);

    const db = requireDb(env);
    const meetId = params.meetId!;
    const [rawUser, meet] = await Promise.all([
      currentUser(request, env),
      getMeet(db, meetId),
    ]);
    if (!meet) throw new SyncError("No such meet.", 404);
    const user = await resolveUser(db, rawUser, request);
    const write = await readJson<Write>(request);
    const stub = env.MEET_DO.getByName(meetId);

    switch (write.kind) {
      /**
       * Entering and scratching.
       *
       * `canEnter`, the meet's own entry limits, and the auto-reseed that
       * follows are all decided inside the DO now (`declareEntry`) — entries
       * are DO-owned like the other three live tables, so the check reads
       * this device's own most current state rather than a D1 snapshot that
       * could be stale between checkpoints. See that method's doc comment.
       */
      case "entry": {
        const result = await stub.declareEntry(
          {
            meetId: meetId,
            eventId: write.eventId,
            athleteId: write.athleteId,
            entering: write.entering,
          },
          meet,
          user,
        );
        if (!result.ok) throw new SyncError(result.error, result.status);
        return json({ ok: true });
      }

      /**
       * Who is in a lane.
       *
       * The coach seeding an event, an administrator correcting the desk and a
       * timer fixing a name behind the blocks all write this same row, and the
       * last one wins — because it is one person deciding one thing, not a
       * vote. Addressed by where the lane is rather than by a row id, because
       * the swim may not exist yet: naming somebody behind the blocks is
       * creating it, not editing one. Never backports to an entry.
       */
      case "swim":
      case "unswim": {
        if (!canRecordTime({ meet, user })) {
          throw new SyncError("Only the teams racing can seed a lane.", 403);
        }
        if (write.kind === "unswim") {
          await stub.unseat({ meetId: meetId, swimId: write.swimId });
          return json({ ok: true });
        }
        if (!Number.isInteger(write.heat) || write.heat < 1) {
          throw new SyncError("Which heat?", 400);
        }
        if (!Number.isInteger(write.lane) || write.lane < 1) {
          throw new SyncError("Which lane?", 400);
        }
        // An empty athlete id is how a swim says "nobody has named this lane
        // yet", and only a time arriving for an unnamed lane may create one.
        // A seeding write means to put somebody somewhere, so a blank here is
        // a bug on the way in rather than a lane to be emptied.
        if (!write.athleteId) throw new SyncError("Which swimmer?", 400);
        const swim = await stub.seat({
          meetId: meetId,
          eventId: write.eventId,
          heat: write.heat,
          lane: write.lane,
          athleteId: write.athleteId,
          swimId: write.swimId,
        });
        return json({ swim });
      }

      /**
       * Whether a swim counts.
       *
       * Open to the same people who may record a time — a call worth making
       * from the lane, before there's anything for the desk to sign off —
       * rather than the administrator alone.
       */
      case "exhibition": {
        if (!canRecordTime({ meet, user })) {
          throw new SyncError(
            "Only the teams racing can mark a swim exhibition.",
            403,
          );
        }
        await stub.setExhibition({
          meetId: meetId,
          swimId: write.swimId,
          exhibition: write.exhibition,
        });
        return json({ ok: true });
      }

      /**
       * Times off a stopwatch.
       *
       * A watch is evidence, and there is one row per submitter per lane, so
       * recording one never overwrites anybody — which is why this is open to
       * every coach of a racing team rather than to the administrator alone.
       *
       * **Who submitted is decided here, not by the caller.** Anyone reaching
       * this has a session, so the watch is filed under their user id: a coach
       * keeps one watch per lane whichever iPad they pick up, and no client can
       * file evidence under somebody else's name. The `timerId` in the body is
       * only a fallback for callers with no account, and the timing phones do
       * not come through here at all.
       */
      case "watch":
      case "drop-watch": {
        if (!canRecordTime({ meet, user })) {
          throw new SyncError("Only the teams racing can record times.", 403);
        }
        const submitter = rawUser?.id ?? write.timerId;
        if (!submitter) throw new SyncError("Which watch?", 400);

        if (write.kind === "drop-watch") {
          // You may throw away your own evidence — a false start, a heat
          // started again. Throwing away somebody else's is a decision, and
          // belongs at the desk.
          const whose = write.timerId ?? submitter;
          if (whose !== submitter && !canDecideMeet({ meet, user })) {
            throw new SyncError(
              "Only whoever is running this meet can drop another timer's watch.",
              403,
            );
          }
          await stub.dropWatch({
            meetId: meetId,
            swimId: write.swimId,
            timerId: whose,
            slot: write.slot,
          });
          return json({ ok: true });
        }

        const timeMs = Number(write.timeMs);
        const hasTime = Number.isFinite(timeMs) && timeMs > 0;
        // A watch with neither a time nor a start is nothing at all. With a
        // start and no time it is a stopwatch that is running, which is a fact
        // worth keeping — it is how the desk sees a lane being covered.
        if (!hasTime && !write.startedAt) {
          throw new SyncError("That isn't a time.", 400);
        }

        await stub.recordWatch({
          meetId: meetId,
          swimId: write.swimId,
          timerId: submitter,
          userId: rawUser?.id,
          role: canEditMeet({ meet, user }) ? "admin" : rawUser ? "coach" : "timer",
          slot: write.slot,
          timeMs: hasTime ? Math.round(timeMs) : undefined,
          submittedAt: Number(write.submittedAt) || Date.now(),
          startedAt: Number(write.startedAt) || undefined,
          stoppedAt: Number(write.stoppedAt) || undefined,
        });
        return json({ ok: true });
      }

      /**
       * Signing a swim off, and taking it back.
       *
       * Administrators only, which is the other half of the line watches sit
       * on: an extra watch never overwrites anybody, but with two schools in
       * the water a DQ isn't one school's call to make.
       *
       * The number comes from the request rather than being worked out here,
       * because what is recorded is *what the administrator accepted* — the
       * figure on their screen when they pressed it. Re-deriving it would mean
       * a watch landing in the same second could sign off a different time
       * from the one they were looking at.
       */
      case "result":
      case "unresult": {
        if (!canDecideMeet({ meet, user })) {
          throw new SyncError("Whoever is running this meet decides a lane.", 403);
        }
        if (write.kind === "unresult") {
          await stub.undecideResult({ meetId: meetId, swimId: write.swimId });
          return json({ ok: true });
        }

        const timeMs = Number(write.timeMs);
        try {
          await stub.decideResult(
            {
              meetId: meetId,
              swimId: write.swimId,
              status:
                write.status === "DQ" || write.status === "NS" ? write.status : "OK",
              // A no-show or a disqualification with nothing on the clock is
              // zero, which is how every screen already reads "no time".
              timeMs: Number.isFinite(timeMs) && timeMs > 0 ? Math.round(timeMs) : 0,
              auto: write.auto,
            },
            // The app's own sentinel rather than nobody's id when `auto`, so a
            // later discrepancy can tell its own earlier call apart from a
            // person's and take only its own back — decided inside the DO.
            rawUser?.id,
          );
        } catch {
          throw new SyncError("That swim is no longer in the meet", 404);
        }
        return json({ ok: true });
      }

      default:
        throw new SyncError("That isn't something anyone can do.", 400);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
