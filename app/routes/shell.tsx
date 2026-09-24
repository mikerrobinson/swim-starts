import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigation,
  useParams,
  useRouteLoaderData,
} from "react-router";
import { AccountMenu } from "~/components/AccountMenu";
import { useViewPrefs } from "~/state/view-prefs";
import { useSession } from "~/state/session";
import { meetSubtitle } from "~/types/meet";
import type { loader as meetLoader } from "./meet-layout";
import { LANE_LAYOUTS, type LaneLayout } from "~/types/meet";

interface Tab {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

/** Where you are when you're not inside a meet. */
const TOP_TABS: Tab[] = [
  { to: "/teams", label: "Teams", icon: "👥" },
  { to: "/meets", label: "Meets", icon: "🏊" },
  { to: "/athletes", label: "Athletes", icon: "🏅" },
];

/**
 * Inside a meet the bar becomes that meet's modes, with a way back out. Admin
 * and Splits are the screens used under pressure, so they stay on the bottom
 * bar within thumb reach rather than moving to a tab across the top.
 */
function meetTabs(meetId: string): Tab[] {
  // Every tab now lives under meets2.tsx's route tree — see
  // meet-info.tsx/entries.tsx/admin.tsx/splits-heat.tsx/results-view.tsx's
  // own doc comments. `/meets/:meetId` itself (meet-layout.tsx) is nothing
  // left but the redirect off it.
  const base = `/meets2/${meetId}`;
  return [
    { to: "/meets", label: "Meets", icon: "‹" },
    { to: `${base}/info`, label: "Info", icon: "📄" },
    { to: `${base}/entries`, label: "Entries", icon: "📋" },
    { to: `${base}/admin`, label: "Admin", icon: "🖥️" },
    { to: `${base}/splits`, label: "Splits", icon: "⏱️" },
    { to: `${base}/results`, label: "Results", icon: "🏅" },
  ];
}

/**
 * The header's view switcher, centred between the title and the sync chip.
 *
 * One control for every screen that has a way of looking at itself: the
 * registration grid filters by gender, the stopwatch picks its button layout.
 * Living in the header costs no vertical space on the screens that want every
 * pixel, and keeps the same control in the same place everywhere.
 *
 * An option is a `Link` when the state belongs in the URL and a button when it
 * belongs to the device; either way they look and behave identically.
 */
interface ToggleOption {
  value: string;
  label: string;
  title?: string;
  active: boolean;
  to?: string;
  onSelect?: () => void;
}

function HeaderToggles({
  label,
  options,
  disabled,
}: {
  label: string;
  options: ToggleOption[];
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex shrink-0 overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700"
    >
      {options.map((option, index) => {
        const className = `flex h-8 touch-manipulation items-center justify-center px-3 text-xs font-bold transition-colors ${
          index > 0 ? "border-l border-slate-300 dark:border-slate-700" : ""
        } ${
          option.active
            ? "bg-blue-600 text-white"
            : "text-slate-600 dark:text-slate-300"
        } ${disabled ? "opacity-50" : ""}`;

        return option.to !== undefined && !disabled ? (
          <Link
            key={option.value}
            to={option.to}
            replace
            title={option.title ?? option.label}
            aria-label={option.title ?? option.label}
            aria-current={option.active ? "true" : undefined}
            className={className}
          >
            {option.label}
          </Link>
        ) : (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={option.onSelect}
            title={option.title ?? option.label}
            aria-label={option.title ?? option.label}
            aria-pressed={option.active}
            className={className}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Girls / Boys for the registration grid. Rides on a search param so the grid
 * needn't share state with the chrome.
 *
 * There's no "All" button: showing everyone is the default, and tapping the
 * active filter is the way back to it.
 */
function genderOptions(pathname: string, current: string): ToggleOption[] {
  return [
    { value: "f", label: "Girls" },
    { value: "m", label: "Boys" },
  ].map((option) => {
    const active = current === option.value;
    return {
      ...option,
      active,
      title: active
        ? `${option.label} only — tap to show everyone`
        : `${option.label} only`,
      // Tapping the active one clears the filter; tapping the other swaps to
      // it. Either way only one can be on.
      to: active ? pathname : `${pathname}?g=${option.value}`,
    };
  });
}

/**
 * By event / Team Scores for the results screen. Rides on a search param, the
 * same way the registration grid's gender filter does, so the screen needn't
 * share state with the chrome.
 */
function resultsViewOptions(pathname: string, current: string): ToggleOption[] {
  return [
    { value: "event", label: "By event", param: null },
    { value: "scores", label: "Team Scores", param: "scores" },
  ].map((option) => ({
    value: option.value,
    label: option.label,
    active: current === option.value,
    to: option.param ? `${pathname}?view=${option.param}` : pathname,
  }));
}

/**
 * How the stopwatch arranges its lane buttons. A single column in pool order
 * suits watching from the side; the grid suits standing at the end. It's a
 * device preference, so it carries to the next meet.
 */
function layoutOptions(
  laneCount: number,
  current: LaneLayout,
  choose: (layout: LaneLayout) => void,
): ToggleOption[] {
  const labels: Record<LaneLayout, string> = {
    grid: "Grid",
    "list-asc": `1→${laneCount}`,
    "list-desc": `${laneCount}→1`,
  };

  return LANE_LAYOUTS.map((layout) => ({
    value: layout,
    label: labels[layout],
    title:
      layout === "grid"
        ? "Lane buttons in a grid"
        : `Lane buttons in one column, ${labels[layout]}`,
    active: current === layout,
    onSelect: () => choose(layout),
  }));
}

/**
 * The chrome, and what it needs to draw itself.
 *
 * No loader of its own. The one thing it wanted — whose name sits in the
 * header — is the team the session already says is open, worked out once on
 * the root route instead of a second time here. The screens under this load
 * their own data.
 */
export default function Shell() {
  const location = useLocation();
  const navigation = useNavigation();
  const { laneLayout, setLaneLayout } = useViewPrefs();
  const params = useParams();
  const session = useSession();
  const meetData = useRouteLoaderData<typeof meetLoader>("routes/meet-layout");
  const openMeet = meetData?.meet ?? null;
  const team =
    session.teams.find((t) => t.teamId === session.openTeamId) ?? null;

  const tabs = params.meetId ? meetTabs(params.meetId) : TOP_TABS;

  const status: { text: string; tone: string } | null =
    navigation.state !== "idle"
      ? {
          text: "Loading…",
          tone: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
        }
      : null;

  const onRegistration = location.pathname.endsWith("/entries");
  const onAdmin = location.pathname.endsWith("/admin");
  const onSplits = location.pathname.endsWith("/splits");
  // Three screens want the whole window rather than a reading column: the
  // entries grid, whose event columns spread sideways, the admin desk, where
  // an administrator works from a landscape tablet with the running order
  // beside the heat, and the splits stopwatch, which wants every pixel for
  // its lane grid.
  const fullWidth = onRegistration || onAdmin || onSplits;
  const onResults = location.pathname.endsWith("/results");
  const rawGender = new URLSearchParams(location.search).get("g");
  const genderParam =
    rawGender === "f" || rawGender === "m" ? rawGender : "all";
  const resultsView =
    new URLSearchParams(location.search).get("view") === "scores"
      ? "scores"
      : "event";

  const toggles = onRegistration ? (
    <HeaderToggles
      label="Filter roster by gender"
      options={genderOptions(location.pathname, genderParam)}
    />
  ) : onSplits && openMeet ? (
    <HeaderToggles
      label="Stopwatch button layout"
      options={layoutOptions(openMeet.laneCount, laneLayout, setLaneLayout)}
    />
  ) : onResults ? (
    <HeaderToggles
      label="Results view"
      options={resultsViewOptions(location.pathname, resultsView)}
    />
  ) : null;

  const title = openMeet?.name ?? team?.name ?? "Swim Starts";
  const subtitle = onRegistration
    ? undefined
    : openMeet
      ? meetSubtitle(openMeet)
      : undefined;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="sticky top-0 z-30 h-[var(--app-chrome-top)] border-b border-slate-200 bg-white/95 pt-[env(safe-area-inset-top)] backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
        {/* Three columns so the filter is centred on the header itself rather
            than wherever the title and chip happen to leave it — equal `1fr`
            sides keep it put at every width. Without the filter there's
            nothing to centre, so the title takes the whole leftover instead of
            being needlessly capped at half. Width tracks `main` so "left" and
            "right" mean the window edges on the full-bleed grid. */}
        <div
          className={`mx-auto grid h-full items-center gap-3 px-4 ${
            toggles
              ? "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
              : "grid-cols-[minmax(0,1fr)_auto]"
          } ${fullWidth ? "max-w-none" : "max-w-3xl"}`}
        >
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold leading-tight">
              {title}
            </h1>
            {subtitle && (
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                {subtitle}
              </p>
            )}
          </div>

          {toggles && <div className="justify-self-center">{toggles}</div>}

          {/* Status and the account control share the right-hand cell. The
              chip is about what the app is doing; the circle is about the
              person. */}
          <div className="flex items-center gap-2 justify-self-end">
            {status && (
              <span
                className={`rounded-full px-2 py-1 text-xs font-semibold ${status.tone}`}
              >
                {status.text}
              </span>
            )}
            <AccountMenu />
          </div>
        </div>
      </header>

      {/* Bottom padding clears the fixed tab bar, including the iOS home bar.
          The registration grid opts out of the centered column so its event
          columns can spread across the full window. */}
      <main
        className={`mx-auto px-4 pt-4 pb-[calc(var(--app-chrome-bottom)+1rem)] ${
          fullWidth ? "max-w-none" : "max-w-3xl"
        }`}
      >
        <Outlet />
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex h-[var(--app-nav-h)] max-w-3xl">
          {tabs.map((tab) => {
            // The back arrow points at the meet list, which would otherwise
            // light up as the active tab while you're inside a meet.
            const isBackLink =
              params.meetId !== undefined && tab.to === "/meets";
            return (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.end}
                className={({ isActive }) =>
                  `flex flex-1 touch-manipulation flex-col items-center justify-center gap-0.5 text-xs font-semibold transition-colors ${
                    isActive && !isBackLink
                      ? "text-blue-600 dark:text-blue-400"
                      : "text-slate-500 dark:text-slate-400"
                  }`
                }
              >
                <span aria-hidden className="text-xl leading-none">
                  {tab.icon}
                </span>
                {tab.label}
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
