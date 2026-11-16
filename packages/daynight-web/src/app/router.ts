import { ApiError, attachmentPageUrl } from "../api/client";
import { canonicalId, isAttachmentPath } from "../api/parse";
import { browserNavigation } from './navigation';
import { projectSettingsSelection, type ProjectSettingsSelection } from './project-settings-route';

export type TaskDetailTab = "description" | "overview" | "steps" | "attachments" | "discussion" | "session";
export type TaskDetailNavigation = { readonly tab: TaskDetailTab; readonly path: string | null };

export type WebhookRoute = {
  readonly kind: "webhooks";
  readonly owner: "personal" | "team";
  readonly teamId: string | null;
  readonly endpointId: string | null;
  readonly tab: "configuration" | "subscriptions" | "deliveries";
  readonly deliveryId?: string | null;
  readonly error: string | null;
};

const webhookRoute = (search: string): WebhookRoute => {
  const params = new URLSearchParams(search);
  const fallback = { kind: "webhooks", owner: "personal", teamId: null, endpointId: null, tab: "configuration" } as const;
  const allowed = ["owner", "teamId", "endpointId", "deliveryId", "tab", "authError"];
  if ([...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1)) return { ...fallback, error: "invalid_query" };
  const owner = params.get("owner") ?? "personal";
  const team = params.get("teamId");
  const endpoint = params.get("endpointId");
  const delivery = params.get("deliveryId");
  const tab = params.get("tab") ?? "configuration";
  const teamId = team === null ? null : canonicalId(team);
  const endpointId = endpoint === null ? null : canonicalId(endpoint);
  const deliveryId = delivery === null ? null : canonicalId(delivery);
  if ((owner !== "personal" && owner !== "team") || (tab !== "configuration" && tab !== "subscriptions" && tab !== "deliveries") ||
      (owner === "personal" && team !== null) || (team !== null && teamId === null) || (endpoint !== null && endpointId === null) ||
      (owner === "team" && teamId === null && endpointId !== null) ||
      (delivery !== null && (deliveryId === null || endpointId === null || tab !== "deliveries"))) return { ...fallback, error: "invalid_query" };
  return { kind: "webhooks", owner, teamId, endpointId, tab, ...(delivery === null ? {} : { deliveryId }), error: null };
};

export const webhookUrl = (selection: Pick<WebhookRoute, "owner" | "teamId" | "endpointId" | "deliveryId" | "tab">): string => {
  const params = new URLSearchParams({ owner: selection.owner });
  if (selection.teamId !== null) params.set("teamId", selection.teamId);
  if (selection.endpointId !== null) params.set("endpointId", selection.endpointId);
  if (selection.deliveryId !== undefined && selection.deliveryId !== null) params.set("deliveryId", selection.deliveryId);
  if (selection.tab !== "configuration") params.set("tab", selection.tab);
  const url = `/webhooks?${params}`;
  if (webhookRoute(`?${params}`).error !== null) throw new ApiError("protocol");
  return url;
};

export type Route =
  | { readonly kind: "projects" }
  | { readonly kind: "project"; readonly projectId: string }
  | ({ readonly kind: "task"; readonly projectId: string; readonly taskId: string } & TaskDetailNavigation)
  | ({ readonly kind: "attachment"; readonly projectId: string; readonly taskId: string; readonly path: string } & TaskDetailNavigation)
  | { readonly kind: "notFound" };

export type ProtectedRoute = Route
  | WebhookRoute
  | { readonly kind: "team" | "teamSettings" | "teamMembers"; readonly teamId: string }
  | { readonly kind: "sharedProjects" | "myTasks" }
  | { readonly kind: "bots" }
  | { readonly kind: "assistantTask"; readonly taskId: string; readonly tab: "manual" | "records" | "proposals"; readonly recordId?: string; readonly eventId?: string }
  | { readonly kind: "bot"; readonly botId: string }
  | { readonly kind: "workers" }
  | { readonly kind: "worker"; readonly workerId: string }
  | { readonly kind: "testSessions" }
  | { readonly kind: "testSession"; readonly sessionId: string }
  | { readonly kind: "account" | "invitations" | "teamInvitations" }
  | { readonly kind: "device"; readonly userCode: string | null }
  | { readonly kind: "oauthConsent"; readonly requestId: string | null }
  | { readonly kind: "settings"; readonly projectId: string; readonly selection: ProjectSettingsSelection };
export type AuthRoute = ProtectedRoute | { readonly kind: "login"; readonly returnPath: string | null };

const detailTab = (search: string, defaultTab: TaskDetailTab): TaskDetailTab | null => {
  const values = new URLSearchParams(search).getAll("tab");
  if (values.length === 0) return defaultTab;
  return values.length === 1 && (values[0] === "description" || values[0] === "overview" || values[0] === "steps" || values[0] === "attachments" || values[0] === "discussion" || values[0] === "session") ? values[0] : null;
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
  if (pathname === "/webhooks") return webhookRoute(search);
  if (pathname === "/my-tasks") return { kind: "myTasks" };
  if (pathname === "/shared-projects") return { kind: "sharedProjects" };
  const team = /^\/teams\/([^/]+)(\/(?:settings|members))?$/.exec(pathname);
  if (team !== null) {
    try { const teamId = canonicalId(decodeURIComponent(team[1]!)); return teamId === null ? { kind: "notFound" } : { kind: team[2] === undefined ? "team" : team[2] === "/settings" ? "teamSettings" : "teamMembers", teamId }; }
    catch { return { kind: "notFound" }; }
  }
  if (pathname === "/bots") return { kind: "bots" };
  const assistantTask = /^\/bots\/tasks\/([^/]+)$/.exec(pathname);
  if (assistantTask) {
    try {
      const taskId = canonicalId(decodeURIComponent(assistantTask[1]!)), query = new URLSearchParams(search), tab = query.get('tab') ?? 'manual', rawRecord = query.get('recordId'), recordId = rawRecord === null ? null : canonicalId(rawRecord), rawEvent = query.get('eventId'), eventId = rawEvent === null ? null : canonicalId(rawEvent);
      if (!taskId || !['manual','records','proposals'].includes(tab) || rawRecord !== null && !recordId || rawEvent !== null && !eventId || [...query.keys()].some(key => !['tab','recordId','eventId'].includes(key) || query.getAll(key).length !== 1)) return {kind:'notFound'};
      return {kind:'assistantTask',taskId,tab:tab as 'manual'|'records'|'proposals',...(recordId ? {recordId} : {}),...(eventId ? {eventId} : {})};
    } catch { return {kind:'notFound'}; }
  }
  const bot = /^\/bots\/([^/]+)$/.exec(pathname);
  if (bot !== null) {
    try { const botId = canonicalId(decodeURIComponent(bot[1]!)); return botId === null ? { kind: "notFound" } : { kind: "bot", botId }; }
    catch { return { kind: "notFound" }; }
  }
  if (pathname === "/workers") return { kind: "workers" };
  const worker = /^\/workers\/([^/]+)$/.exec(pathname);
  if (worker !== null) {
    try { const workerId = canonicalId(decodeURIComponent(worker[1]!)); return workerId === null ? { kind: "notFound" } : { kind: "worker", workerId }; }
    catch { return { kind: "notFound" }; }
  }
  if (pathname === "/test-sessions") return { kind: "testSessions" };
  const test = /^\/test-sessions\/([^/]+)$/.exec(pathname);
  if (test !== null) {
    try { const sessionId = canonicalId(decodeURIComponent(test[1]!)); return sessionId === null ? { kind: "notFound" } : { kind: "testSession", sessionId }; }
    catch { return { kind: "notFound" }; }
  }
  if (pathname === "/account") return { kind: "account" };
  if (pathname === "/invitations") return { kind: "invitations" };
  if (pathname === "/team-invitations") return { kind: "teamInvitations" };
  if (pathname === "/oauth/consent") {
    const params = new URLSearchParams(search);
    const ids = params.getAll("request");
    return { kind: "oauthConsent", requestId: ids.length === 1 && [...params.keys()].every((key) => key === "request") ? canonicalId(ids[0]!) : null };
  }
  if (pathname === "/device") {
    const codes = new URLSearchParams(search).getAll("user_code");
    return { kind: "device", userCode: codes.length === 0 ? null : codes.length === 1 ? codes[0]! : "" };
  }
  const management = /^(\/projects\/[^/]+)\/(members|settings)$/.exec(pathname);
  if (management !== null) {
    const project = parseRoute(management[1]!);
    if (project.kind !== "project") return { kind: "notFound" };
    return management[2] === "members" ? { kind: "settings", projectId: project.projectId, selection: { kind: "tab", tab: "members" } }
      : { kind: "settings", projectId: project.projectId, selection: projectSettingsSelection(search) };
  }
  return parseRoute(pathname, search);
};

export const isLoginReturnPath = (value: string): boolean => {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("#") || /[\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    if (/[\\\u0000-\u001f\u007f]/.test(decodeURIComponent(value))) return false;
    const target = new URL(value, "https://daynight.invalid");
    if (target.origin !== "https://daynight.invalid") return false;
    if (target.pathname === "/oauth/consent") return parseProtectedRoute(target.pathname, target.search).kind === "oauthConsent" && (parseProtectedRoute(target.pathname, target.search) as { requestId: string | null }).requestId !== null;
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
  if (pathname === "/invitations" || pathname === "/team-invitations") return true;
  if (pathname !== "/login") return false;
  const target = parseLoginReturnPath(search);
  return target !== null && ["/invitations", "/team-invitations"].includes(new URL(target, "https://daynight.invalid").pathname);
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
  browserNavigation().navigate(to);
};

export const replaceRoute = (to: string): void => {
  browserNavigation().navigate(to, true);
};

export const navigateTaskDetail = (projectId: string, taskId: string, selection: TaskDetailNavigation): void => {
  const current = parseRoute(window.location.pathname, window.location.search);
  if ((current.kind === 'task' || current.kind === 'attachment') && current.projectId === projectId && current.taskId === taskId && current.tab === selection.tab && current.path === selection.path) return;
  navigate(taskDetailUrl(projectId, taskId, selection));
};
