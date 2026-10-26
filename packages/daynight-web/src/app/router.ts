import { ApiError, attachmentPageUrl } from "../api/client";
import { canonicalId, isAttachmentPath } from "../api/parse";

export type TaskDetailTab = "overview" | "attachments";
export type TaskDetailNavigation = { readonly tab: TaskDetailTab; readonly path: string | null };

export type Route =
  | { readonly kind: "projects" }
  | { readonly kind: "project"; readonly projectId: string }
  | ({ readonly kind: "task"; readonly projectId: string; readonly taskId: string } & TaskDetailNavigation)
  | ({ readonly kind: "attachment"; readonly projectId: string; readonly taskId: string; readonly path: string } & TaskDetailNavigation)
  | { readonly kind: "notFound" };

export type ProtectedRoute = Route
  | { readonly kind: "account" | "invitations" }
  | { readonly kind: "device"; readonly userCode: string | null }
  | { readonly kind: "members" | "settings"; readonly projectId: string };
export type AuthRoute = ProtectedRoute | { readonly kind: "login"; readonly returnPath: string | null };

const detailTab = (search: string, defaultTab: TaskDetailTab): TaskDetailTab | null => {
  const values = new URLSearchParams(search).getAll("tab");
  if (values.length === 0) return defaultTab;
  return values.length === 1 && (values[0] === "overview" || values[0] === "attachments") ? values[0] : null;
};

export const parseRoute = (pathname: string, search = ""): Route => {
  if (pathname === "/projects") return { kind: "projects" };
  const task = /^\/projects\/([^/]+)\/tasks\/([^/]+)(?:\/attachments\/(.+))?$/.exec(pathname);
  if (task !== null) {
    try {
      const projectId = canonicalId(decodeURIComponent(task[1]!));
      const taskId = canonicalId(decodeURIComponent(task[2]!));
      const file = task[3];
      const tab = detailTab(search, file === undefined ? "overview" : "attachments");
      if (projectId === null || taskId === null || tab === null) return { kind: "notFound" };
      if (file === undefined) return { kind: "task", projectId, taskId, tab, path: null };
      const segments = file.split('/').map((segment) => decodeURIComponent(segment));
      const path = segments.join('/');
      if (segments.some((segment) => segment.includes('/')) || !isAttachmentPath(path)) return { kind: "notFound" };
      return { kind: "attachment", projectId, taskId, path, tab };
    } catch {
      return { kind: "notFound" };
    }
  }
  const match = /^\/projects\/([^/]+)$/.exec(pathname);
  if (match === null) return { kind: "notFound" };
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]!);
  } catch {
    return { kind: "notFound" };
  }
  const projectId = canonicalId(decoded);
  return projectId === null ? { kind: "notFound" } : { kind: "project", projectId };
};

const parseProtectedRoute = (pathname: string, search = ""): ProtectedRoute => {
  if (pathname === "/account") return { kind: "account" };
  if (pathname === "/invitations") return { kind: "invitations" };
  if (pathname === "/device") {
    const codes = new URLSearchParams(search).getAll("user_code");
    return { kind: "device", userCode: codes.length === 0 ? null : codes.length === 1 ? codes[0]! : "" };
  }
  const management = /^(\/projects\/[^/]+)\/(members|settings)$/.exec(pathname);
  if (management !== null) {
    const project = parseRoute(management[1]!);
    return project.kind === "project" ? { kind: management[2] as "members" | "settings", projectId: project.projectId } : { kind: "notFound" };
  }
  return parseRoute(pathname, search);
};

export const isLoginReturnPath = (value: string): boolean => {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("#") || /[\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    if (/[\\\u0000-\u001f\u007f]/.test(decodeURIComponent(value))) return false;
    const target = new URL(value, "https://daynight.invalid");
    if (target.origin !== "https://daynight.invalid") return false;
    return target.pathname === "/" || target.pathname === "/setup" || parseProtectedRoute(target.pathname, target.search).kind !== "notFound";
  } catch {
    return false;
  }
};

export const parseLoginReturnPath = (search: string): string | null => {
  const values = new URLSearchParams(search).getAll("returnPath");
  if (values.length === 0) return "/projects";
  return values.length === 1 && isLoginReturnPath(values[0]!) ? values[0]! : null;
};

export const parseAuthRoute = (pathname: string, search = ""): AuthRoute => pathname === "/login"
  ? { kind: "login", returnPath: parseLoginReturnPath(search) }
  : parseProtectedRoute(pathname, search);

export const invitationLocation = (pathname: string, search: string): boolean => {
  if (pathname === "/invitations") return true;
  if (pathname !== "/login") return false;
  const target = parseLoginReturnPath(search);
  return target !== null && new URL(target, "https://daynight.invalid").pathname === "/invitations";
};

export const loginUrl = (returnPath: string): string => {
  if (!isLoginReturnPath(returnPath)) throw new Error("The login destination is not a supported same-origin page.");
  return `/login?${new URLSearchParams({ returnPath })}`;
};

export const taskDetailUrl = (projectId: string, taskId: string, navigation: TaskDetailNavigation): string => {
  if (canonicalId(projectId) === null || canonicalId(taskId) === null) throw new ApiError("protocol");
  const base = navigation.path === null
    ? `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`
    : attachmentPageUrl(projectId, taskId, navigation.path);
  const defaultTab = navigation.path === null ? "overview" : "attachments";
  return navigation.tab === defaultTab ? base : `${base}?tab=${navigation.tab}`;
};

export const navigate = (to: string): void => {
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

export const replaceRoute = (to: string): void => {
  window.history.replaceState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

export const navigateTaskDetail = (projectId: string, taskId: string, selection: TaskDetailNavigation): void => {
  const current = parseRoute(window.location.pathname, window.location.search);
  if ((current.kind === 'task' || current.kind === 'attachment') && current.projectId === projectId && current.taskId === taskId && current.tab === selection.tab && current.path === selection.path) return;
  navigate(taskDetailUrl(projectId, taskId, selection));
};
