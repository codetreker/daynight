import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { canonicalId } from "../../api/validation";
import type { AssigneeFilter } from "../task-assignment/TaskAssigneeFilter";

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

export type ProjectSection = "overview" | "tasks" | "prs" | "tags";
export type TaskView = "standalone" | "chains" | "goals";
export type GraphDirection = "horizontal" | "vertical";

const projectSectionPreference = (value: unknown): ProjectSection => {
  if (value !== "overview" && value !== "tasks" && value !== "prs" && value !== "tags") throw new Error("Invalid project section preference.");
  return value;
};

const taskViewPreference = (value: unknown): TaskView => {
  if (value !== "standalone" && value !== "chains" && value !== "goals") throw new Error("Invalid project task view preference.");
  return value;
};

const graphDirectionPreference = (value: unknown): GraphDirection => {
  if (value !== "horizontal" && value !== "vertical") throw new Error("Invalid graph direction preference.");
  return value;
};

const scrollPreference = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Invalid project task list scroll position.");
  }
  return value;
};

const assigneePreference = (value: unknown): AssigneeFilter => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid assignee filter preference.");
  const entry = value as Record<string, unknown>;
  if ((entry.kind === "all" || entry.kind === "me" || entry.kind === "unassigned") && Object.keys(entry).length === 1) return { kind: entry.kind };
  if (entry.kind === "user" && Object.keys(entry).length === 2 && typeof entry.userId === "string") {
    const userId = canonicalId(entry.userId);
    if (userId !== null) return { kind: "user", userId };
  }
  throw new Error("Invalid assignee filter preference.");
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

export const useProjectSection = (projectId: string) => {
  const { value, save, issue } = useNamedPreference(`daynight:project-section:${projectId}`, projectSectionPreference, "overview");
  return { section: value, onSectionChange: save, issue };
};

export const useTaskView = (projectId: string) => {
  const { value, save, issue } = useNamedPreference(`daynight:task-view:${projectId}`, taskViewPreference, "chains");
  return { activeView: value, onViewChange: save, issue };
};

export const useProjectAssigneeFilter = (projectId: string, userId: string) => {
  const key = `daynight:task-assignee-filter:${JSON.stringify([projectId, userId])}`;
  const load = () => {
    const initial = readPreference(key, assigneePreference);
    return { key, filter: initial.value ?? { kind: "all" } as AssigneeFilter, initialIssue: initial.issue, writeIssue: null as PreferenceIssue | null };
  };
  const [stored, setStored] = useState(load);
  let current = stored;
  if (stored.key !== key) {
    current = load();
    setStored(current);
  }
  const onFilterChange = useCallback((filter: AssigneeFilter) => {
    let writeIssue: PreferenceIssue | null = null;
    try {
      window.localStorage.setItem(key, JSON.stringify(filter));
    } catch (cause) {
      writeIssue = { kind: "write", cause };
    }
    setStored((previous) => previous.key === key ? { ...previous, filter, initialIssue: writeIssue === null ? null : previous.initialIssue, writeIssue } : previous);
  }, [key]);
  return { filter: current.filter, onFilterChange, issue: current.writeIssue ?? current.initialIssue };
};

export const useGraphDirection = (projectId: string, rootId: string) => {
  const key = `daynight:graph-direction:${JSON.stringify([projectId, rootId])}`;
  const load = () => {
    const initial = readPreference(key, graphDirectionPreference);
    return { key, direction: initial.value ?? "horizontal" as GraphDirection, initialIssue: initial.issue, writeIssue: null as PreferenceIssue | null };
  };
  const [stored, setStored] = useState(load);
  // A graph can acquire another root while its dialog remains mounted. Never
  // display the previous root's preference while waiting for an effect.
  let current = stored;
  if (stored.key !== key) {
    current = load();
    setStored(current);
  }
  const onDirectionChange = useCallback((direction: GraphDirection) => {
    let writeIssue: PreferenceIssue | null = null;
    try {
      window.localStorage.setItem(key, JSON.stringify(direction));
    } catch (cause) {
      writeIssue = { kind: "write", cause };
    }
    setStored((previous) => previous.key === key ? { ...previous, direction, writeIssue } : previous);
  }, [key]);
  return { direction: current.direction, onDirectionChange, issue: current.writeIssue ?? current.initialIssue };
};

export const useTaskListScroll = (projectId: string, active: boolean) => {
  const key = `daynight:task-list-scroll:${projectId}`;
  const [initial] = useState(() => readPreference(key, scrollPreference));
  const position = useRef(initial.value === undefined ? 0 : initial.value);
  const [writeIssue, setWriteIssue] = useState<PreferenceIssue | null>(null);
  const savePosition = useCallback(() => {
    if (!active || window.scrollY === position.current) return;
    position.current = window.scrollY;
    try {
      window.localStorage.setItem(key, JSON.stringify(position.current));
      setWriteIssue(null);
    } catch (cause) {
      setWriteIssue({ kind: "write", cause });
    }
  }, [key, active]);

  useLayoutEffect(() => {
    if (!active) return;
    window.scrollTo({ top: position.current, behavior: "instant" });
    window.addEventListener("scroll", savePosition, { passive: true });
    window.addEventListener("pagehide", savePosition);
    return () => {
      window.removeEventListener("scroll", savePosition);
      window.removeEventListener("pagehide", savePosition);
    };
  }, [active, savePosition]);

  return { savePosition, issue: writeIssue ?? initial.issue };
};
