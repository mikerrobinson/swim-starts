import { useEffect, useRef } from "react";
import { formatSeconds } from "~/lib/time";

export function StopwatchDisplay({
  running,
  startedAt,
  frozenMs = 0,
  className,
}: {
  running: boolean;
  startedAt: number;
  frozenMs?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!running || !startedAt) return;

    let frameId: number;
    const tick = () => {
      if (ref.current) {
        ref.current.textContent = formatSeconds(Date.now() - startedAt);
      }
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [running, startedAt]);

  const initialMs =
    running && startedAt > 0 ? Date.now() - startedAt : frozenMs;

  return (
    <span ref={ref} className={className}>
      {formatSeconds(initialMs)}
    </span>
  );
}
