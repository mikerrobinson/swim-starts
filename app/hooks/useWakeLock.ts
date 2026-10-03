import { useEffect } from "react";

/**
 * Hold a screen wake lock while `active`. Silently does nothing on browsers
 * without the API (notably iOS Safari before 16.4).
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request("screen");
      } catch {
        // Denied or unsupported — not worth interrupting the meet over.
      }
    };

    // The lock drops whenever the page is hidden; take it again on return.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && !released) acquire();
    };

    acquire();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      sentinel?.release().catch(() => {});
    };
  }, [active]);
}
