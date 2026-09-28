import { Link, useSearchParams } from "react-router";
import type { Route } from "./+types/athletes";
import { Card, EmptyState, SectionTitle, TextInput } from "~/components/ui";
import { listPublicAthletes } from "~/lib/public.server";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Athletes · Swim Starts" }];
}

/**
 * Everyone, not one team's roster.
 *
 * An athlete belongs to no team, so this is the list you search when you need
 * to know whether the swimmer in front of you already exists somewhere —
 * which is what stops the same person being typed in twice under two ids.
 *
 * Filtering happens on the server so the whole set never has to come down.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (!db) return { athletes: [], q, offline: true };
  try {
    return {
      athletes: await listPublicAthletes(db, { q, limit: 200 }),
      q,
      offline: false,
    };
  } catch {
    return { athletes: [], q, offline: true };
  }
}

export default function Athletes({ loaderData }: Route.ComponentProps) {
  const { athletes, offline } = loaderData;
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Athletes ({athletes.length})</SectionTitle>

        <TextInput
          value={q}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            if (e.target.value) next.set("q", e.target.value);
            else next.delete("q");
            // Replace rather than push: typing a name shouldn't fill the back
            // button with one entry per keystroke.
            setParams(next, { replace: true });
          }}
          placeholder="Search by name…"
          autoCapitalize="off"
          autoCorrect="off"
        />

        <div className="mt-3">
          {athletes.length === 0 ? (
            <EmptyState
              title={
                offline
                  ? "Can't reach the server"
                  : q
                    ? `Nobody matches “${q}”`
                    : "No athletes yet"
              }
            >
              {offline
                ? "This list lives on the server. Your own roster keeps working without it."
                : "Swimmers appear here once a coach enrols them, or a timer adds one on a deck."}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {athletes.map((athlete) => (
                <li key={athlete.id}>
                  <Link
                    to={`/athletes/${athlete.id}`}
                    className="flex items-center justify-between gap-3 py-2.5"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {athlete.lastName}, {athlete.firstName}
                      </span>
                      <span className="block truncate text-xs text-slate-500">
                        {athlete.teams.map((t) => t.name).join(" · ") ||
                          "No team"}
                      </span>
                    </span>
                    <span aria-hidden className="shrink-0 text-slate-400">
                      ›
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
