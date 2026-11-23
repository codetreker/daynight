import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { parseRoute } from "../../app/router";
import { isBodyScrollLocked } from "../../app/useBodyScrollLock";
import { canonicalId } from "../../api/validation";
import type { AssigneeFilter } from "../task-assignment/TaskAssigneeFilter";
import type { TaskStatus } from "../../api/types";
import { ALL_TASK_STATUSES, decodeTaskStatuses, equalTaskStatuses, normalizeTaskStatuses } from "./task-status-filter";

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

export type ProjectSection = "overview" | "statistics" | "tasks" | "prs" | "tags";
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
    throw new Error("Invalid project scroll position.");
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

export const useProjectStatusFilter = (projectId: string, userId: string) => {
  const key = `daynight:task-status-filter:${JSON.stringify([projectId, userId])}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const load = () => {
    const initial = readPreference(key, decodeTaskStatuses);
    return { key, filter: initial.value ?? ALL_TASK_STATUSES, initialIssue: initial.issue, writeIssue: null as PreferenceIssue | null };
  };
  const [stored, setStored] = useState(load);
  let current = stored;
  if (stored.key !== key) {
    current = load();
    setStored(current);
  }
  const onFilterChange = useCallback((filter: readonly TaskStatus[]) => {
    if (currentKey.current !== key) return;
    const normalized = normalizeTaskStatuses(filter);
    let writeIssue: PreferenceIssue | null = null;
    try {
      window.localStorage.setItem(key, JSON.stringify(normalized));
    } catch (cause) {
      writeIssue = { kind: "write", cause };
    }
    setStored((previous) => previous.key === key ? {
      ...previous,
      filter: equalTaskStatuses(previous.filter, normalized) ? previous.filter : normalized,
      initialIssue: writeIssue === null ? null : previous.initialIssue,
      writeIssue,
    } : previous);
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

const scrollExtent = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

// A single position belongs to the project page, not to an individual panel.
export const useProjectScroll = (projectId: string, userId: string, section: ProjectSection, ready: boolean, explicitTarget: boolean, view: TaskView) => {
  const key = `daynight:project-scroll:${JSON.stringify([projectId, userId])}`;
  const load = () => {
    const initial = readPreference(key, scrollPreference);
    return { key, initial, initialSection: section, initialView: view, pending: initial.value !== undefined && !explicitTarget, position: initial.value, lastY: window.scrollY, extent: scrollExtent(), lockedScroll: false, layoutChanged: false };
  };
  const state = useRef<ReturnType<typeof load> | null>(null);
  if (state.current === null || state.current.key !== key) state.current = load();
  useLayoutEffect(() => {
    const current = state.current!;
    if (section !== current.initialSection || section === "tasks" && view !== current.initialView || explicitTarget) current.pending = false;
  }, [key, section, view, explicitTarget]);
  const context = useRef({ ready, projectId });
  context.current = { ready, projectId };
  const [write, setWrite] = useState<{ key: string; issue: PreferenceIssue | null }>({ key, issue: null });
  const savePosition = useCallback(() => {
    const current = state.current!;
    if (current.key !== key || current.pending || !context.current.ready || document.visibilityState === "hidden" || isBodyScrollLocked()) return;
    const route = parseRoute(window.location.pathname, window.location.search);
    if (route.kind !== "project" || route.projectId !== context.current.projectId) return;
    const y = window.scrollY;
    if (!Number.isFinite(y) || y < 0 || current.position === y) return;
    current.position = y;
    try {
      window.localStorage.setItem(key, JSON.stringify(y));
      setWrite({ key, issue: null });
    } catch (cause) {
      setWrite({ key, issue: { kind: "write", cause } });
    }
  }, [key]);
  const cancelRestore = useCallback(() => { state.current!.pending = false; }, []);
  useLayoutEffect(() => {
    window.history.scrollRestoration = "manual";
    const current = state.current!;
    const scroll = () => {
      const y = window.scrollY, extent = scrollExtent();
      const locked = isBodyScrollLocked();
      // A geometry change can clamp or anchor the viewport without user input.
      // A scroll with stable geometry also covers assistive technology and
      // overlay scrollbars, which need not deliver a pointer event to the page.
      if (current.pending && !locked && !current.lockedScroll && !current.layoutChanged && extent === current.extent && y !== current.lastY) current.pending = false;
      current.lockedScroll = locked;
      current.lastY = y;
      current.extent = extent;
      savePosition();
    };
    let resizeFrame: number | null = null;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      const extent = scrollExtent();
      if (extent === current.extent) return;
      current.extent = extent;
      current.layoutChanged = true;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => { current.layoutChanged = false; resizeFrame = null; });
    });
    resize?.observe(document.documentElement);
    resize?.observe(document.body);
    const lockObserver = new MutationObserver(() => {
      if (!current.lockedScroll || isBodyScrollLocked()) return;
      current.lockedScroll = false;
      current.lastY = window.scrollY;
      current.extent = scrollExtent();
    });
    lockObserver.observe(document.body, { attributes: true, attributeFilter: ["style"] });
    const intent = () => { if (!isBodyScrollLocked()) current.pending = false; };
    const keydown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) &&
          !(event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]"))) intent();
    };
    const pointer = (event: PointerEvent) => {
      if (event.clientX >= window.innerWidth - 20 && !(event.target instanceof Element && event.target.closest("a, button, input, select, textarea, [role=button]"))) intent();
    };
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("pagehide", savePosition);
    window.addEventListener("wheel", intent, { passive: true });
    window.addEventListener("touchmove", intent, { passive: true });
    window.addEventListener("keydown", keydown);
    window.addEventListener("pointerdown", pointer);
    return () => {
      window.removeEventListener("scroll", scroll);
      window.removeEventListener("pagehide", savePosition);
      window.removeEventListener("wheel", intent);
      window.removeEventListener("touchmove", intent);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("pointerdown", pointer);
      resize?.disconnect();
      lockObserver.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    };
  }, [key, savePosition]);
  useLayoutEffect(() => {
    const current = state.current!;
    if (!ready) return;
    const restore = () => {
      if (!current.pending || !context.current.ready || isBodyScrollLocked() || document.visibilityState === "hidden") return;
      current.pending = false;
      window.scrollTo({ top: current.position!, behavior: "instant" });
      current.lastY = window.scrollY;
      current.extent = scrollExtent();
      savePosition();
    };
    restore();
    // A fullscreen overlay can temporarily freeze the page. Wait for its release
    // rather than recording its synthetic offset or consuming the restore.
    const observer = new MutationObserver(restore);
    observer.observe(document.body, { attributes: true, attributeFilter: ["style"] });
    document.addEventListener("visibilitychange", restore);
    if (!current.pending) savePosition();
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", restore); };
  }, [key, ready, section, savePosition]);
  return { savePosition, cancelRestore, issue: (write.key === key ? write.issue : null) ?? state.current.initial.issue };
};
