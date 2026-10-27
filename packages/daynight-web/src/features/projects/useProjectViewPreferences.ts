import { useCallback, useLayoutEffect, useRef, useState } from "react";

type PreferenceIssue = { readonly kind: "read" | "invalid" | "write"; readonly cause: unknown };
type InitialPreference<Value> = {
  readonly value: Value | undefined;
  readonly saved: string | null;
  readonly issue: PreferenceIssue | null;
};

const readPreference = <Value,>(key: string, decode: (value: unknown) => Value): InitialPreference<Value> => {
  let saved: string | null;
  try {
    saved = window.localStorage.getItem(key);
  } catch (cause) {
    return { value: undefined, saved: null, issue: { kind: "read", cause } };
  }
  if (saved === null) return { value: undefined, saved, issue: null };
  try {
    return { value: decode(JSON.parse(saved)), saved, issue: null };
  } catch (cause) {
    return { value: undefined, saved: null, issue: { kind: "invalid", cause } };
  }
};

const showAllPreference = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new Error("Invalid task visibility preference.");
  return value;
};

export type ProjectSection = "overview" | "tasks";
export type TaskView = "standalone" | "chains";
type ScrollPositions = Readonly<Record<TaskView, number>>;

const projectSectionPreference = (value: unknown): ProjectSection => {
  if (value !== "overview" && value !== "tasks") throw new Error("Invalid project section preference.");
  return value;
};

const taskViewPreference = (value: unknown): TaskView => {
  if (value !== "standalone" && value !== "chains") throw new Error("Invalid project task view preference.");
  return value;
};

const scrollPreference = (value: unknown): ScrollPositions => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 2 ||
    !("chains" in value) || !("standalone" in value) || typeof value.chains !== "number" || typeof value.standalone !== "number" ||
    !Number.isFinite(value.chains) || !Number.isFinite(value.standalone) || value.chains < 0 || value.standalone < 0) {
    throw new Error("Invalid project task view scroll positions.");
  }
  return { chains: value.chains, standalone: value.standalone };
};

const useNamedPreference = <Value,>(key: string, decode: (value: unknown) => Value, defaultValue: Value) => {
  const [initial] = useState(() => readPreference(key, decode));
  const [value, setValue] = useState(initial.value === undefined ? defaultValue : initial.value);
  const [writeIssue, setWriteIssue] = useState<PreferenceIssue | null>(null);
  const save = useCallback((next: Value) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
      setWriteIssue(null);
    } catch (cause) {
      setWriteIssue({ kind: "write", cause });
    }
  }, [key]);
  return { value, save, issue: writeIssue ?? initial.issue };
};

export const useChainVisibility = (projectId: string) => {
  const { value, save, issue } = useNamedPreference(`daynight:completed-chains:${projectId}`, showAllPreference, false);
  return { showAll: value, onShowAllChange: save, issue };
};

export const useStandaloneVisibility = (projectId: string) => {
  const { value, save, issue } = useNamedPreference(`daynight:completed-standalone-tasks:${projectId}`, showAllPreference, false);
  return { showAll: value, onShowAllChange: save, issue };
};

export const useProjectSection = (projectId: string) => {
  const { value, save, issue } = useNamedPreference(`daynight:project-section:${projectId}`, projectSectionPreference, "overview");
  return { section: value, onSectionChange: save, issue };
};

export const useTaskView = (projectId: string) => {
  const { value, save, issue } = useNamedPreference(`daynight:task-view:${projectId}`, taskViewPreference, "chains");
  return { activeView: value, onViewChange: save, issue };
};

export const useTaskViewScroll = (projectId: string, activeView: TaskView, active: boolean) => {
  const key = `daynight:task-view-scroll:${projectId}`;
  const [initial] = useState(() => readPreference(key, scrollPreference));
  const positions = useRef<ScrollPositions>(initial.value === undefined ? { chains: 0, standalone: 0 } : initial.value);
  const [writeIssue, setWriteIssue] = useState<PreferenceIssue | null>(null);
  const savePosition = useCallback(() => {
    if (!active) return;
    const next = { ...positions.current, [activeView]: window.scrollY };
    if (next[activeView] === positions.current[activeView]) return;
    positions.current = next;
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
      setWriteIssue(null);
    } catch (cause) {
      setWriteIssue({ kind: "write", cause });
    }
  }, [key, activeView, active]);

  useLayoutEffect(() => {
    if (!active) return;
    window.scrollTo({ top: positions.current[activeView], behavior: "instant" });
    window.addEventListener("scroll", savePosition, { passive: true });
    window.addEventListener("pagehide", savePosition);
    return () => {
      window.removeEventListener("scroll", savePosition);
      window.removeEventListener("pagehide", savePosition);
    };
  }, [active, activeView, savePosition]);

  return { savePosition, issue: writeIssue ?? initial.issue };
};
