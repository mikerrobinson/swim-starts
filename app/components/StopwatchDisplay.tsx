import { useEffect, useRef } from "react";

/**
 * A ticking clock's digits, written straight to the DOM on every animation
 * frame instead of through React state — so a stopwatch running at 60fps
 * doesn't force the route around it to re-render 60 times a second too.
 * Shared by the single-lane timer and the deck's multi-lane stopwatch, which
 * both just need digits that tick while running and freeze when stopped.
 */
export function StopwatchDisplay({
  running,
  startedAt,
  frozenMs = 0,
  format,
  className,
}: {
  /** Ticks up from `startedAt` while true; otherwise shows `frozenMs`. */
  running: boolean;
  startedAt: number;
  /** What to show while not running — a stopped time, or 0 before any run. */
  frozenMs?: number;
  format: (ms: number) => string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<number>(0);

  useEffect(() => {
    if (!running) return;
    const tick = () => {
      if (ref.current) {
        ref.current.textContent = format(Date.now() - startedAt);
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [running, startedAt, format]);

  return (
    <span ref={ref} className={className}>
      {format(running ? Date.now() - startedAt : frozenMs)}
    </span>
  );
}
