import mime from "mime";
import { parseTaskSync } from "./task-sync";
import { timestamp } from "./parse";
import { isTaskVersion, parseApiJson, stringifyApiJson } from "./json";
import { canonicalId, isAttachmentPath, parseAttachment, parseAttachmentPage, parseProjectPage, parseServerError, parseTaskDetail, parseTaskGraph } from "./parse";
import type { ExecutionPlatform, Attachment, AttachmentPage, GraphLimitDetails, ProjectPage, TaskDetail, TaskGraph, TaskStatus, TaskSync } from "./types";
import { decodeProjectPageJson, decodeTaskGraphJson } from "./project-json";

const serverMessages: Readonly<Record<string, string>> = {
  not_found: "The requested resource was not found.",
  task_deleted: "This task has been deleted.",
  unauthenticated: "Your session has expired. Please sign in again.",
  forbidden: "You do not have permission to perform this action.",
  version_conflict: "The resource changed. Refresh it before trying again.",
  last_admin: "The project must retain at least one administrator.",
  invitation_unavailable: "This invitation is no longer available.",
  graph_limit_exceeded: "This project's task graph exceeds the supported size.",
};

export class ApiError extends Error {
  readonly kind: "network" | "protocol" | "server";
  readonly status: number | null;
  readonly code: string;
  readonly requestId: string | null;
  readonly graphLimit: GraphLimitDetails | undefined;

  constructor(
    kind: ApiError["kind"],
    status: number | null = null,
    code: string = kind,
    requestId: string | null = null,
    graphLimit?: GraphLimitDetails,
    cause?: unknown,
  ) {
    const message = kind === "network"
      ? "Unable to connect to the server. Please try again."
      : kind === "protocol"
        ? "The server returned an invalid response. Please try again."
        : Object.hasOwn(serverMessages, code) ? serverMessages[code]! : "Unable to load the requested data. Please try again.";
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.graphLimit = graphLimit;
  }
}

export const isAbortError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";

let authGeneration = 0;
const unauthorizedListeners = new Set<() => void>();
type AuthPause = { readonly waiters: Set<() => void>; owner: symbol };
let authPause: AuthPause | null = null;

const releaseAuthRequests = (): void => {
  const pause = authPause;
  authPause = null;
  if (pause !== null) for (const resume of pause.waiters) resume();
};

export const invalidateAuthRequests = (): void => { authGeneration += 1; releaseAuthRequests(); };
export const pauseAuthRequests = (): (() => void) => {
  const owner = Symbol();
  if (authPause === null) authPause = { waiters: new Set(), owner };
  else authPause.owner = owner;
  const pause = authPause;
  return () => { if (authPause === pause && pause.owner === owner) releaseAuthRequests(); };
};

export const authRequestsPaused = (): boolean => authPause !== null;

const waitForIdentity = (pause: AuthPause, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const cleanup = () => { pause.waiters.delete(resume); signal.removeEventListener("abort", abort); };
  const resume = () => { cleanup(); resolve(); };
  const abort = () => { cleanup(); reject(signal.reason); };
  pause.waiters.add(resume);
  signal.addEventListener("abort", abort, { once: true });
});

export const subscribeUnauthorized = (listener: () => void): (() => void) => {
  unauthorizedListeners.add(listener);
  return () => { unauthorizedListeners.delete(listener); };
};

export const waitForAuthRequests = async (signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  const generation = authGeneration;
  while (authPause !== null) {
    await waitForIdentity(authPause, signal);
    signal.throwIfAborted();
    if (generation !== authGeneration) throw new DOMException("The authenticated account changed.", "AbortError");
  }
};

export const assertResponsePrincipal = (response: Response, expectedUserId: string, onMismatch?: () => void): void => {
  const expected = requestId(expectedUserId);
  // Unauthenticated responses use the existing session-expiry lifecycle.
  if (response.status === 401) return;
  const principal = response.headers.get("Daynight-User-ID");
  if (principal === null || canonicalId(principal) === null) throw new ApiError("protocol", response.status);
  if (canonicalId(principal) !== expected) {
    onMismatch?.();
    throw new ApiError("protocol", response.status, "principal_mismatch");
  }
};

export const request = async (url: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> => {
  signal.throwIfAborted();
  const generation = authGeneration;
  if (url !== "/api/v1/me" && url !== "/api/v1/auth/logout") {
    while (authPause !== null) {
      await waitForIdentity(authPause, signal);
      signal.throwIfAborted();
      if (generation !== authGeneration) throw new DOMException("The authenticated account changed.", "AbortError");
    }
  }
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal, cache: "no-store", credentials: "same-origin", redirect: "error" });
  } catch (error) {
    signal.throwIfAborted();
    if (isAbortError(error)) throw error;
    throw new ApiError("network", null, "network", null, undefined, error);
  }
  signal.throwIfAborted();
  if (response.status === 401 && generation === authGeneration) {
    for (const listener of unauthorizedListeners) listener();
  }
  return response;
};

export const json = async <T>(response: Response, signal: AbortSignal, parse: (data: unknown) => T, decode: (response: Response) => Promise<unknown> = async (value) => parseApiJson(await value.text())): Promise<T> => {
  let body: unknown;
  try {
    const contentType = response.headers.get("Content-Type");
    if (contentType === null || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) throw new Error("Invalid media type");
    body = await decode(response);
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    if (isAbortError(error)) throw error;
    throw new ApiError("protocol", response.status, "protocol", null, undefined, error);
  }
  try {
    if (response.ok) return parse(body);
    const serverError = parseServerError(body);
    throw new ApiError("server", response.status, serverError.code, serverError.requestId, serverError.graphLimit);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("protocol", response.status, "protocol", null, undefined, error);
  }
};

export const read = async <T>(url: string, signal: AbortSignal, parse: (data: unknown) => T, decode?: (response: Response) => Promise<unknown>): Promise<T> =>
  json(await request(url, signal, { headers: { Accept: "application/json" } }), signal, parse, decode);

export const requestId = (value: string): string => {
  const id = canonicalId(value);
  if (id === null) throw new ApiError("protocol");
  return id;
};

export const listProjects = (query: { readonly limit?: number; readonly cursor?: string }, signal: AbortSignal): Promise<ProjectPage> => {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new ApiError("protocol");
    parameters.set("limit", String(query.limit));
  }
  if (query.cursor !== undefined) {
    if (query.cursor === "") throw new ApiError("protocol");
    parameters.set("cursor", query.cursor);
  }
  const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
  return read(`/api/v1/projects${suffix}`, signal, parseProjectPage, decodeProjectPageJson);
};

export const getTaskGraph = (projectId: string, signal: AbortSignal): Promise<TaskGraph> => {
  const project = requestId(projectId);
  return read(`/api/v1/projects/${project}/task-graph`, signal, (data) => parseTaskGraph(data, project), decodeTaskGraphJson);
};

export const getTaskSync = async (
  projectId: string, query: { readonly epoch?: string; readonly since?: string },
  expectedUserId: string, signal: AbortSignal, onPrincipalMismatch?: () => void,
): Promise<TaskSync> => {
  const project = requestId(projectId);
  requestId(expectedUserId);
  const parameters = new URLSearchParams();
  if (query.epoch !== undefined) parameters.set("epoch", requestId(query.epoch));
  if (query.since !== undefined) {
    if (query.epoch === undefined) throw new ApiError("protocol");
    try { parameters.set("since", timestamp(query.since)); }
    catch (error) { throw new ApiError("protocol", null, "protocol", null, undefined, error); }
  }
  const suffix = parameters.size === 0 ? "" : `?${parameters}`;
  const response = await request(`/api/v1/projects/${project}/task-sync${suffix}`, signal, { headers: { Accept: "application/json" } });
  assertResponsePrincipal(response, expectedUserId, onPrincipalMismatch);
  return json(response, signal, (value) => parseTaskSync(value, project), decodeTaskGraphJson);
};

export type TaskResponseAdmission = {
  readonly userId: string;
  readonly onPrincipalMismatch: () => void;
  readonly onWriteConfirmed?: () => void;
};

export const getTask = async (projectId: string, taskId: string, signal: AbortSignal, admission: TaskResponseAdmission): Promise<TaskDetail> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  const response = await request(`/api/v1/projects/${project}/tasks/${task}`, signal, { headers: { Accept: "application/json" } });
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  return json(response, signal, (data) => parseTaskDetail(data, project, task));
};

export const deleteTask = async (
  projectId: string, taskId: string, exactVersion: bigint, removeDepends: boolean | undefined, signal: AbortSignal, admission: TaskResponseAdmission,
): Promise<void> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  if (!isTaskVersion(exactVersion) || removeDepends !== undefined && typeof removeDepends !== "boolean") throw new ApiError("protocol");
  const response = await request(`/api/v1/projects/${project}/tasks/${task}`, signal, {
    method: "DELETE", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: stringifyApiJson({ version: exactVersion, removeDepends }),
  });
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 204) { admission.onWriteConfirmed?.(); return; }
  if (response.ok) throw new ApiError("protocol", response.status);
  await json(response, signal, () => { throw new ApiError("protocol", response.status); });
};

export const setTaskStatus = async (
  projectId: string, taskId: string, status: TaskStatus, exactVersion: bigint, signal: AbortSignal, admission: TaskResponseAdmission,
): Promise<TaskDetail> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  if (!isTaskVersion(exactVersion) || !["todo", "in_progress", "done"].includes(status)) throw new ApiError("protocol");
  const response = await request(`/api/v1/projects/${project}/tasks/${task}/status`, signal, {
    method: "PUT", redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: stringifyApiJson({ version: exactVersion, status }),
  });
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 200) admission.onWriteConfirmed?.();
  return json(response, signal, (data) => {
    const result = parseTaskDetail(data, project, task);
    if (response.status !== 200 || result.status !== status || result.version !== exactVersion && result.version !== exactVersion + 1n) {
      throw new ApiError("protocol", response.status);
    }
    return result;
  });
};

export const setTaskAgentPermission = async (
  projectId: string, taskId: string, allowAgents: boolean, exactVersion: bigint, signal: AbortSignal, admission: TaskResponseAdmission,
): Promise<TaskDetail> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  if (typeof allowAgents !== "boolean" || !isTaskVersion(exactVersion)) throw new ApiError("protocol");
  const response = await request(`/api/v1/projects/${project}/tasks/${task}`, signal, {
    method: "PATCH", redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: stringifyApiJson({ version: exactVersion, allowAgents }),
  });
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 200) admission.onWriteConfirmed?.();
  return json(response, signal, (data) => {
    const result = parseTaskDetail(data, project, task);
    if (response.status !== 200 || result.allowAgents !== allowAgents || result.version !== exactVersion && result.version !== exactVersion + 1n) {
      throw new ApiError("protocol", response.status);
    }
    return result;
  });
};

export const setTaskRequiredPlatform = async (
  projectId: string, taskId: string, requiredPlatform: ExecutionPlatform | null, exactVersion: bigint, signal: AbortSignal, admission: TaskResponseAdmission,
): Promise<TaskDetail> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  if (requiredPlatform !== null && requiredPlatform !== "windows" && requiredPlatform !== "linux" && requiredPlatform !== "macos" || !isTaskVersion(exactVersion)) throw new ApiError("protocol");
  const response = await request(`/api/v1/projects/${project}/tasks/${task}`, signal, {
    method: "PATCH", redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: stringifyApiJson({ version: exactVersion, requiredPlatform }),
  });
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 200) admission.onWriteConfirmed?.();
  return json(response, signal, (data) => {
    const result = parseTaskDetail(data, project, task);
    if (response.status !== 200 || result.requiredPlatform !== requiredPlatform || result.version !== exactVersion && result.version !== exactVersion + 1n) {
      throw new ApiError("protocol", response.status);
    }
    return result;
  });
};

const attachmentTaskUrl = (projectId: string, taskId: string): string =>
  `/api/v1/projects/${requestId(projectId)}/tasks/${requestId(taskId)}`;

const encodedAttachmentPath = (path: string): string => {
  if (!isAttachmentPath(path)) throw new ApiError("protocol");
  return path.split("/").map(encodeURIComponent).join("/");
};

export const attachmentPageUrl = (projectId: string, taskId: string, path: string): string =>
  `/projects/${requestId(projectId)}/tasks/${requestId(taskId)}/attachments/${encodedAttachmentPath(path)}`;

export const attachmentDownloadUrl = (projectId: string, taskId: string, path: string): string =>
  `${attachmentTaskUrl(projectId, taskId)}/attachments/files/${encodedAttachmentPath(path)}`;

export const attachmentPreviewRoot = (projectId: string, taskId: string): string =>
  `${attachmentTaskUrl(projectId, taskId)}/preview/`;

export const attachmentPreviewUrl = (projectId: string, taskId: string, path: string): string =>
  `${attachmentPreviewRoot(projectId, taskId)}${encodedAttachmentPath(path)}`;

export const listAttachments = (
  projectId: string, taskId: string, query: { readonly limit?: number; readonly cursor?: string }, signal: AbortSignal,
): Promise<AttachmentPage> => {
  const url = `${attachmentTaskUrl(projectId, taskId)}/attachments`;
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new ApiError("protocol");
    parameters.set("limit", String(query.limit));
  }
  if (query.cursor !== undefined) {
    if (query.cursor === "") throw new ApiError("protocol");
    parameters.set("cursor", query.cursor);
  }
  return read(parameters.size === 0 ? url : `${url}?${parameters}`, signal, parseAttachmentPage);
};

export const attachmentContentType = (path: string): string =>
  mime.getType(path) ?? "application/octet-stream";

export const putAttachment = async (
  projectId: string, taskId: string, path: string, file: File, signal: AbortSignal,
): Promise<Attachment> => {
  const response = await request(attachmentDownloadUrl(projectId, taskId, path), signal, {
    method: "PUT", body: file, redirect: "error", headers: { Accept: "application/json", "Content-Type": attachmentContentType(path) },
  });
  return json(response, signal, (data) => {
    const attachment = parseAttachment(data);
    if ((response.status !== 200 && response.status !== 201) || attachment.path !== path) throw new ApiError("protocol", response.status);
    return attachment;
  });
};

export const removeAttachment = async (projectId: string, taskId: string, path: string, signal: AbortSignal): Promise<void> => {
  const response = await request(attachmentDownloadUrl(projectId, taskId, path), signal, { method: "DELETE", redirect: "error" });
  if (!response.ok) return json(response, signal, () => { throw new ApiError("protocol", response.status); });
  if (response.status !== 204) throw new ApiError("protocol", response.status);
};

export const readAttachmentText = async (projectId: string, taskId: string, path: string, signal: AbortSignal): Promise<string> => {
  const response = await request(attachmentDownloadUrl(projectId, taskId, path), signal);
  if (!response.ok) return json(response, signal, () => { throw new ApiError("protocol", response.status); });
  if (response.status !== 200) throw new ApiError("protocol", response.status);
  try {
    const text = await response.text();
    signal.throwIfAborted();
    return text;
  } catch (error) {
    signal.throwIfAborted();
    if (isAbortError(error)) throw error;
    throw new ApiError("network", response.status, "network", null, undefined, error);
  }
};

export const checkAttachmentPreview = async (projectId: string, taskId: string, path: string, signal: AbortSignal): Promise<void> => {
  const response = await request(attachmentPreviewUrl(projectId, taskId, path), signal, { method: "HEAD" });
  if (!response.ok) {
    const header = response.headers.get("X-Request-ID");
    const requestId = header !== null && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(header) ? header : null;
    throw new ApiError("server", response.status, response.status === 401 ? "unauthenticated" : "server", requestId);
  }
  if (response.status !== 200) throw new ApiError("protocol", response.status);
};
