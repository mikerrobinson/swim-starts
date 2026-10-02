import type { ReactNode } from "react";

/**
 * Shared controls, sized for wet hands on a phone or iPad deck-side.
 * `touch-manipulation` kills the 300ms double-tap-zoom delay without
 * disabling pinch zoom.
 */

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "success";
type ButtonSize = "sm" | "md" | "lg" | "xl";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-blue-600 text-white hover:bg-blue-500 active:bg-blue-700 disabled:bg-blue-600/40",
  success:
    "bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700 disabled:bg-emerald-600/40",
  secondary:
    "bg-slate-200 text-slate-900 hover:bg-slate-300 active:bg-slate-400 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600 disabled:opacity-40",
  danger:
    "bg-red-600 text-white hover:bg-red-500 active:bg-red-700 disabled:bg-red-600/40",
  ghost:
    "bg-transparent text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 disabled:opacity-40",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-9 px-3 text-sm rounded-lg",
  md: "min-h-11 px-4 text-base rounded-xl",
  lg: "min-h-14 px-5 text-lg rounded-xl",
  xl: "min-h-20 px-6 text-2xl rounded-2xl",
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  full?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  full = false,
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 font-semibold touch-manipulation select-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]} ${full ? "w-full" : ""} ${className}`}
      {...props}
    />
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900 ${className}`}
    >
      {children}
    </section>
  );
}

export function SectionTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-lg font-bold text-slate-900 dark:text-white">
        {children}
      </h2>
      {action}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-slate-600 dark:text-slate-300">
        {label}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </span>
      )}
    </label>
  );
}

/** Shape and size, which no caller overrides. */
const CONTROL_SHAPE =
  "w-full min-h-11 rounded-xl border px-3 text-base placeholder:text-slate-400 focus:outline-none";

/** Colour, which a caller may replace outright. */
const CONTROL_SKIN =
  "border-slate-300 bg-white text-slate-900 focus:border-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white";

const CONTROL_CLASS = `${CONTROL_SHAPE} ${CONTROL_SKIN}`;

/**
 * `tone` replaces the default colour rather than layering over it.
 *
 * Appending would not work: two Tailwind utilities setting the same property
 * are equally specific, so which one wins is the order they happen to sit in
 * the generated stylesheet, not the order of the class list. A caller that
 * wanted an amber box got a slate one and no error — so the default simply
 * isn't emitted when a tone is given.
 */
export function TextInput({
  tone,
  className = "",
  ref,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & {
  tone?: string;
  ref?: React.Ref<HTMLInputElement>;
}) {
  return (
    <input
      ref={ref}
      className={`${CONTROL_SHAPE} ${tone ?? CONTROL_SKIN} ${className}`}
      {...rest}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", ...rest } = props;
  return <select className={`${CONTROL_CLASS} ${className}`} {...rest} />;
}

/** Big radio-style picker — used for lane count and similar short choices. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-2">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          onClick={() => onChange(option.value)}
          className={`min-h-12 flex-1 touch-manipulation rounded-xl border-2 text-lg font-bold transition-colors ${
            option.value === value
              ? "border-blue-600 bg-blue-600 text-white"
              : "border-slate-300 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
      <p className="text-lg font-semibold text-slate-700 dark:text-slate-200">
        {title}
      </p>
      {children && (
        <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          {children}
        </div>
      )}
    </div>
  );
}

export function Banner({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "error" | "success";
  children: ReactNode;
}) {
  const tones = {
    info: "border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100",
    warn: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100",
    error:
      "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100",
    success:
      "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  };
  return (
    <div className={`rounded-xl border p-3 text-sm ${tones[tone]}`}>
      {children}
    </div>
  );
}
