import { Link } from "react-router";
import type { ToggleOption } from "~/lib/route-handle";

/**
 * The header's view switcher, rendered. Moved out of `shell.tsx` so
 * `meet-layout.tsx` can render it too — see `~/lib/route-handle.ts` for
 * what feeds it.
 */
export function HeaderToggles({
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
