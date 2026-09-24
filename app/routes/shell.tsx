import { NavLink, Outlet, useNavigation, useParams } from "react-router";
import { AccountMenu } from "~/components/AccountMenu";
import { useSession } from "~/state/session";

interface Tab {
  to: string;
  label: string;
  icon: string;
}

/** Where you are when you're not inside a meet. */
const TOP_TABS: Tab[] = [
  { to: "/teams", label: "Teams", icon: "👥" },
  { to: "/meets", label: "Meets", icon: "🏊" },
  { to: "/athletes", label: "Athletes", icon: "🏅" },
];

/**
 * The chrome for everything outside a meet.
 *
 * A meet's own header (its name, the active screen's centred toggle) and
 * footer nav (role-driven — admin, coach, or anyone else watching) are
 * `meet-layout.tsx`'s now, not this route's: once a meet is open this just
 * passes straight through to `<Outlet/>` rather than wrapping a second
 * header/footer around meet-layout's own. No loader of its own either way —
 * the one thing it wanted, whose name sits in the header, is the team the
 * session already says is open, worked out once on the root route instead
 * of a second time here. The screens under this load their own data.
 */
export default function Shell() {
  const navigation = useNavigation();
  const params = useParams();
  const session = useSession();

  if (params.meetId) return <Outlet />;

  const team =
    session.teams.find((t) => t.teamId === session.openTeamId) ?? null;

  const status: { text: string; tone: string } | null =
    navigation.state !== "idle"
      ? {
          text: "Loading…",
          tone: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
        }
      : null;

  const title = team?.name ?? "Swim Starts";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="sticky top-0 z-30 h-[var(--app-chrome-top)] border-b border-slate-200 bg-white/95 pt-[env(safe-area-inset-top)] backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
        <div className="mx-auto grid h-full max-w-3xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold leading-tight">
              {title}
            </h1>
          </div>

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

      {/* Bottom padding clears the fixed tab bar, including the iOS home bar. */}
      <main className="mx-auto max-w-3xl px-4 pt-4 pb-[calc(var(--app-chrome-bottom)+1rem)]">
        <Outlet />
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex h-[var(--app-nav-h)] max-w-3xl">
          {TOP_TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                `flex flex-1 touch-manipulation flex-col items-center justify-center gap-0.5 text-xs font-semibold transition-colors ${
                  isActive
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
          ))}
        </div>
      </nav>
    </div>
  );
}
