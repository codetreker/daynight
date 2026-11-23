import { useEffect, useRef } from "react";
import { authRequestsPaused } from "../../api/client";

/** Refresh Team resources after a real foreground return without gating identity. */
export function useTeamForeground(enabled: boolean, refresh: () => void): void {
  const latest = useRef({ enabled, refresh });
  latest.current = { enabled, refresh };
  useEffect(() => {
    let away = document.visibilityState === "hidden" || !document.hasFocus();
    let disposed = false;
    const leave = () => { if (!document.hasFocus() || document.visibilityState === "hidden") away = true; };
    const enter = () => {
      if (!away || document.visibilityState === "hidden" || !document.hasFocus()) return;
      away = false;
      // Account-signal listeners finish checking storage before any Team read starts.
      queueMicrotask(() => { if (!disposed && latest.current.enabled && !authRequestsPaused()) latest.current.refresh(); });
    };
    const visibility = () => { if (document.visibilityState === "hidden") leave(); else enter(); };
    window.addEventListener("blur", leave);
    window.addEventListener("focus", enter);
    document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; window.removeEventListener("blur", leave); window.removeEventListener("focus", enter); document.removeEventListener("visibilitychange", visibility); };
  }, []);
}
