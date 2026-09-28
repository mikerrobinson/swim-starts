import { Link } from "react-router";
import type { Route } from "./+types/results-index";
import { Card, SectionTitle } from "~/components/ui";
import { useMeet } from "~/hooks/useMeet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Results · Swim Starts" }];
}

/**
 * The results selector — `/meets/:meetId/results`.
 *
 * No detail to load: this screen is nothing but a way into one of the views
 * below, each its own address rather than a `?view=` on this one.
 */
export default function ResultsIndex() {
  const meet = useMeet();

  const views = [
    { view: "by-event", label: "By event", hint: "Every event, fastest first" },
    { view: "team-scores", label: "Team scores", hint: "Running point totals" },
  ];

  return (
    <Card>
      <SectionTitle>Results</SectionTitle>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {views.map(({ view, label, hint }) => (
          <li key={view}>
            <Link
              to={`/meets/${meet.id}/results/${view}`}
              className="flex items-center justify-between gap-2 py-3 text-left"
            >
              <span>
                <span className="block font-semibold">{label}</span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  {hint}
                </span>
              </span>
              <span aria-hidden className="text-slate-400">
                ›
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
