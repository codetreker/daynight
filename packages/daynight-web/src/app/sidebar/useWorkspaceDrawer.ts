import { useLayoutEffect, useRef, useState } from "react";

// Keep the media query identical to sidebar.css so layout and modal ownership change together.
export const SIDEBAR_NARROW_QUERY = "(max-width: 740px)";

type DrawerCloseReason = "dismiss" | "navigate" | "create-team" | "breakpoint";

export const useWorkspaceDrawer = (routeKey: string, blocked: boolean) => {
  const [media] = useState(() => window.matchMedia(SIDEBAR_NARROW_QUERY));
  const [narrow, setNarrow] = useState(media.matches);
  const [openedRoute, setOpenedRoute] = useState<string | null>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const closeReason = useRef<DrawerCloseReason | null>(null);
  const active = narrow && openedRoute === routeKey && !blocked;

  useLayoutEffect(() => {
    const changed = () => {
      closeReason.current = "breakpoint";
      setNarrow(media.matches);
      setOpenedRoute(null);
    };
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, [media]);

  useLayoutEffect(() => {
    if (openedRoute !== null && (!narrow || blocked || openedRoute !== routeKey)) setOpenedRoute(null);
  }, [openedRoute, narrow, blocked, routeKey]);

  return {
    narrow, active, openerRef, closeReason, routeChanged: openedRoute !== null && openedRoute !== routeKey,
    open: () => { if (narrow && !blocked) { closeReason.current = null; setOpenedRoute(routeKey); } },
    close: (reason: DrawerCloseReason) => { closeReason.current = reason; setOpenedRoute(null); },
  };
};

export type WorkspaceDrawer = ReturnType<typeof useWorkspaceDrawer>;
