import type { MeetManifest } from "~/types/meet";

/**
 * The header's view switcher, centred between the title and the account
 * menu — one control for every screen that has a way of looking at itself
 * (the registration grid filters by gender, and whatever comes next). An
 * option is a `Link` when the state belongs in the URL and a button when
 * it belongs to the device; either way they look and behave identically
 * (`HeaderToggles`, `app/components/HeaderToggles.tsx`).
 */
export interface ToggleOption {
  value: string;
  label: string;
  title?: string;
  active: boolean;
  to?: string;
  onSelect?: () => void;
}

export interface ToggleGroup {
  label: string;
  options: ToggleOption[];
}

/**
 * What a route's `handle.headerToggle` gets to build its options from — a
 * generic bag rather than per-toggle-kind parameters, since which slice of
 * it a given toggle needs varies (a search param here, something off the
 * meet there).
 */
export interface ToggleContext {
  pathname: string;
  searchParams: URLSearchParams;
  meet: MeetManifest;
}

/**
 * What a route exports to describe itself to `meet-layout.tsx`'s chrome.
 * Read via `useMatches()` off whichever child route is actually on screen,
 * rather than the layout knowing every screen's business by its pathname —
 * a route that wants the header's centred toggle exports one of these
 * instead of the layout special-casing it.
 */
export interface MeetRouteHandle {
  headerToggle?: (ctx: ToggleContext) => ToggleGroup | null;
}
