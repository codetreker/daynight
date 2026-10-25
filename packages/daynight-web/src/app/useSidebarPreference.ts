import { useCallback, useRef, useState } from "react";

export const SIDEBAR_STORAGE_KEY = "daynight.web.sidebar.collapsed";
export type SidebarStorage = Pick<Storage, "getItem" | "setItem">;
export type SidebarPreferenceIssue = {
  readonly kind: "read" | "invalid" | "write";
  readonly cause: unknown;
};
export type InitialSidebarPreference = {
  readonly collapsed: boolean;
  readonly issue: SidebarPreferenceIssue | null;
};

export const getSidebarPreferenceStorage = (): SidebarStorage => window.localStorage;

export const resolveInitialSidebarPreference = (getStorage = getSidebarPreferenceStorage): InitialSidebarPreference => {
  let saved: string | null;
  try {
    saved = getStorage().getItem(SIDEBAR_STORAGE_KEY);
  } catch (cause) {
    return { collapsed: false, issue: { kind: "read", cause } };
  }
  if (saved === null) return { collapsed: false, issue: null };
  try {
    const collapsed: unknown = JSON.parse(saved);
    if (typeof collapsed !== "boolean") throw new TypeError("The saved sidebar preference must be a JSON boolean.");
    return { collapsed, issue: null };
  } catch (cause) {
    return { collapsed: false, issue: { kind: "invalid", cause } };
  }
};

export const useSidebarPreference = (getStorage = getSidebarPreferenceStorage) => {
  const [initial] = useState(() => resolveInitialSidebarPreference(getStorage));
  const [collapsed, setCollapsed] = useState(initial.collapsed);
  const [issue, setIssue] = useState(initial.issue);
  const current = useRef(collapsed);
  const save = useCallback((value: boolean) => {
    try {
      getStorage().setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(value));
      setIssue(null);
    } catch (cause) {
      setIssue({ kind: "write", cause });
    }
  }, [getStorage]);
  const toggle = useCallback(() => {
    current.current = !current.current;
    setCollapsed(current.current);
    save(current.current);
  }, [save]);
  const retrySave = useCallback(() => save(current.current), [save]);
  return { collapsed, issue, toggle, retrySave };
};
