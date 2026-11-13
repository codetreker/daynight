import { readTaskPaused, readWorkerClaim } from "./task-properties";
import mime from "mime";
import { parseTaskSync } from "./task-sync";
import { timestamp } from "./parse";
import { isTaskVersion, parseApiJson, stringifyApiJson } from "./json";
import { canonicalId, id, record, isAttachmentPath, parseAttachment, parseAttachmentPage, parseProjectPage, parseServerError, parseTaskDetail } from "./parse";
import type { ExecutionPlatform, Attachment, AttachmentPage, ProjectPage, TaskDetail, TaskStatus, TaskSyncRead } from "./types";
import { decodeProjectPageJson, decodeTaskGraphJson, decodeTaskSyncJson, type TaskSyncJsonRead } from "./project-json";

const serverMessages: Readonly<Record<string, string>> = {
  controller_offline: "The agent environment is offline. Reconnect it to load history and use controls.",
  relay_instance_unavailable: "The online agent is connected to another relay instance. Connect through its owning relay.",
  not_found: "The requested resource was not found.",
  task_deleted: "This task has been deleted.",
  unauthenticated: "Your session has expired. Please sign in again.",
  forbidden: "You do not have permission to perform this action.",
  version_conflict: "The resource changed. Refresh it before trying again.",
  invitation_unavailable: "This invitation is no longer available.",
};

export class ApiError extends Error {
  readonly kind: "network" | "protocol" | "server";
  readonly status: number | null;
  readonly code: string;
  readonly requestId: string | null;
  readonly serverMessage: string | undefined;
  readonly stepsLimit: { readonly encodedBytes: number; readonly maxEncodedBytes: number } | undefined;
  readonly writeOutcome: "not_committed" | undefined;

  constructor(
    kind: ApiError["kind"],
    status: number | null = null,
    code: string = kind,
    requestId: string | null = null,
    cause?: unknown,
    serverMessage?: string,
    stepsLimit?: { readonly encodedBytes: number; readonly maxEncodedBytes: number },
    writeOutcome?: "not_committed",
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
    this.serverMessage = serverMessage;
    this.stepsLimit = stepsLimit;
    this.writeOutcome = writeOutcome;
  }
}

export const isAbortError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";

let authGeneration = 0;
let authPauseRevision = 0;
let authNetwork = new AbortController();
const responseSignals = new WeakMap<Response, AbortSignal>();
export const cancelAuthNetworkRequests = (): void => {
  const previous = authNetwork;
  authNetwork = new AbortController();
  previous.abort();
};
export const responseSignal = (response: Response, fallback: AbortSignal): AbortSignal => responseSignals.get(response) ?? fallback;
export const readAuthRequestGeneration = (): number => authGeneration;
const unauthorizedListeners = new Set<() => void>();
const authPauseListeners = new Set<() => void>();
type AuthPause = { readonly waiters: Set<() => void>; owner: symbol };
let authPause: AuthPause | null = null;

const releaseAuthRequests = (): void => {
  const pause = authPause;
  authPause = null;
  if (pause !== null) for (const resume of pause.waiters) resume();
};

export const invalidateAuthRequests = (): void => { authGeneration += 1; releaseAuthRequests(); };
export const pauseAuthRequests = (): (() => void) => {
  authPauseRevision += 1;
  const owner = Symbol();
  const created = authPause === null;
  const pause = authPause ?? { waiters: new Set(), owner };
  if (created) authPause = pause;
  else pause.owner = owner;
  if (created) for (const listener of authPauseListeners) listener();
  return () => { if (authPause === pause && pause.owner === owner) releaseAuthRequests(); };
};

export const authRequestsPaused = (): boolean => authPause !== null;
export const subscribeAuthPause = (listener: () => void): (() => void) => {
  authPauseListeners.add(listener);
  return () => { authPauseListeners.delete(listener); };
};
export const authRequestsPauseRevision = (): number => authPauseRevision;

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
  responseSignals.get(response)?.throwIfAborted();
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

export const request = async (url: string, signal: AbortSignal, init: RequestInit = {}, onDispatch?: () => void, onUnauthorized?: () => void): Promise<Response> => {
  signal.throwIfAborted();
  const generation = authGeneration;
  const ordinary = url !== "/api/v1/me" && url !== "/api/v1/auth/logout";
  if (ordinary) {
    while (authPause !== null) {
      await waitForIdentity(authPause, signal);
      signal.throwIfAborted();
      if (generation !== authGeneration) throw new DOMException("The authenticated account changed.", "AbortError");
    }
  }
  let response: Response;
  // Identity waits must not start a caller's network deadline.
  onDispatch?.();
  const networkSignal = ordinary ? AbortSignal.any([signal, authNetwork.signal]) : signal;
  networkSignal.throwIfAborted();
  try {
    const workerProtocol = /^\/api\/v1\/projects\/[^/]+\/(?:tasks|task-sync|task-graph)(?:[/?]|$)/.test(url) && !/\/(?:attachments|preview|sessions)(?:[/?]|$)/.test(url);
    const headers = workerProtocol ? { ...(init.headers instanceof Headers || Array.isArray(init.headers) ? Object.fromEntries(new Headers(init.headers)) : init.headers), "Daynight-Worker-Protocol": "2" } : init.headers;
    response = await fetch(url, { cache: "no-store", ...init, ...(headers ? { headers } : {}), signal: networkSignal, credentials: "same-origin", redirect: "error" });
  } catch (error) {
    networkSignal.throwIfAborted();
    if (isAbortError(error)) throw error;
    throw new ApiError("network", null, "network", null, error);
  }
  networkSignal.throwIfAborted();
  responseSignals.set(response, networkSignal);
  if (response.status === 401 && generation === authGeneration) {
    for (const listener of unauthorizedListeners) listener();
    // A newer account marker turns this response into a retained pause; its
    // old operation must not clear recovery state for the displayed account.
    if (!authRequestsPaused()) onUnauthorized?.();
  }
  networkSignal.throwIfAborted();
  return response;
};

export const json = async <T>(response: Response, signal: AbortSignal, parse: (data: unknown) => T, decode: (response: Response) => Promise<unknown> = async (value) => parseApiJson(await value.text()), includeStepsError = false, onServerError?: (error: ApiError) => void): Promise<T> => {
  const lifetime = responseSignal(response, signal);
  let body: unknown;
  try {
    lifetime.throwIfAborted();
    const contentType = response.headers.get("Content-Type");
    if (contentType === null || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) throw new Error("Invalid media type");
    body = await decode(response);
    lifetime.throwIfAborted();
  } catch (error) {
    lifetime.throwIfAborted();
    if (isAbortError(error)) throw error;
    throw new ApiError("protocol", response.status, "protocol", null, error);
  }
  try {
    if (response.ok) {
      const result = parse(body);
      lifetime.throwIfAborted();
      return result;
    }
    const serverError = parseServerError(body, includeStepsError);
    const error = new ApiError("server", response.status, serverError.code, serverError.requestId, undefined, serverError.serverMessage, serverError.stepsLimit, serverError.writeOutcome);
    onServerError?.(error);
    throw error;
  } catch (error) {
    lifetime.throwIfAborted();
    if (error instanceof ApiError) throw error;
    throw new ApiError("protocol", response.status, "protocol", null, error);
  }
};

export const read = async <T>(url: string, signal: AbortSignal, parse: (data: unknown) => T, decode?: (response: Response) => Promise<unknown>): Promise<T> =>
  json(await request(url, signal, { headers: { Accept: "application/json" } }), signal, parse, decode);

export const requestId = (value: string): string => {
  const id = canonicalId(value);
  if (id === null) throw new ApiError("protocol");
  return id;
};

export const listProjects = (query: { readonly limit?: number; readonly cursor?: string; readonly teamId?: string; readonly shared?: true }, signal: AbortSignal, admission?: TaskResponseAdmission): Promise<ProjectPage> => {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new ApiError("protocol");
    parameters.set("limit", String(query.limit));
  }
  if (query.cursor !== undefined) {
    if (query.cursor === "") throw new ApiError("protocol");
    parameters.set("cursor", query.cursor);
  }
  if (query.teamId !== undefined && query.shared !== undefined) throw new ApiError("protocol");
  if (query.teamId !== undefined) parameters.set("teamId", requestId(query.teamId));
  if (query.shared !== undefined) {
    if (query.shared !== true) throw new ApiError("protocol");
    parameters.set("shared", "true");
  }
  const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
  if (admission === undefined) return read(`/api/v1/projects${suffix}`, signal, parseProjectPage, decodeProjectPageJson);
  return request(`/api/v1/projects${suffix}`, signal, { headers: { Accept: "application/json" } }).then((response) => {
    assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
    return json(response, signal, parseProjectPage, decodeProjectPageJson);
  });
};

export const getTaskSync = async (
  projectId: string, query: { readonly epoch?: string; readonly since?: string },
  expectedUserId: string, signal: AbortSignal, onPrincipalMismatch?: () => void,
): Promise<TaskSyncRead> => {
  const project = requestId(projectId);
  requestId(expectedUserId);
  const parameters = new URLSearchParams();
  if (query.epoch !== undefined) parameters.set("epoch", requestId(query.epoch));
  if (query.since !== undefined) {
    if (query.epoch === undefined) throw new ApiError("protocol");
    try { parameters.set("since", timestamp(query.since)); }
    catch (error) { throw new ApiError("protocol", null, "protocol", null, error); }
  }
  const suffix = parameters.size === 0 ? "" : `?${parameters}`;
  const response = await request(`/api/v1/projects/${project}/task-sync${suffix}`, signal, { headers: { Accept: "application/json" } });
  assertResponsePrincipal(response, expectedUserId, onPrincipalMismatch);
  if (!response.ok) return json(response, signal, () => { throw new ApiError("protocol", response.status); }, decodeTaskGraphJson);
  return json(response, signal, (body) => {
    const read = body as TaskSyncJsonRead;
    return { sync: parseTaskSync(read.value, project, expectedUserId), receivedMonotonic: read.receivedMonotonic };
  }, decodeTaskSyncJson);
};

export type TaskResponseAdmission = {
  readonly userId: string;
  readonly onPrincipalMismatch: () => void;
  readonly onWriteConfirmed?: () => void;
  readonly onWriteRejected?: (error: ApiError) => void;
  readonly onDispatch?: () => void;
};

export type TaskObservation = { readonly epoch: string; readonly detail: TaskDetail };

export type CreateTaskInput = {
  readonly title: string;
  readonly description?: string;
  readonly type?: "task" | "goal";
  readonly parentId?: string | null;
  readonly status?: TaskStatus;
  readonly assignedTo?: string | null;
};

export const createTask = async (projectId: string, input: CreateTaskInput, signal: AbortSignal, admission: TaskResponseAdmission): Promise<TaskDetail> => {
  const project = requestId(projectId);
  const body = { ...input,
    ...(input.parentId === undefined ? {} : { parentId: input.parentId === null ? null : requestId(input.parentId) }),
    ...(input.assignedTo === undefined ? {} : { assignedTo: input.assignedTo === null ? null : requestId(input.assignedTo) }) };
  const response = await request(`/api/v1/projects/${project}/tasks`, signal, {
    method: "POST", redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: stringifyApiJson(body),
  });
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 201) admission.onWriteConfirmed?.();
  return json(response, signal, (data) => {
    const result = parseTaskDetail(data, project, id(record(data).id));
    if (response.status !== 201 || result.type !== (body.type ?? "task") || result.parentId !== (body.parentId ?? null) ||
      result.title !== body.title || result.description !== (body.description ?? "") ||
      result.status !== (body.status ?? (result.type === "goal" ? "todo" : "proposed")) ||
      body.assignedTo !== undefined && result.assignedTo !== body.assignedTo) throw new ApiError("protocol", response.status);
    return result;
  });
};

export const updateTaskFields = async (
  projectId: string, taskId: string, fields: { readonly title?: string; readonly description?: string; readonly parentId?: string | null; readonly tagIds?: readonly string[] },
  exactVersion: bigint, signal: AbortSignal, admission: TaskResponseAdmission,
): Promise<TaskDetail> => {
  const project = requestId(projectId), task = requestId(taskId);
  if (!isTaskVersion(exactVersion) || fields.title === undefined && fields.description === undefined && fields.parentId === undefined && fields.tagIds === undefined) throw new ApiError("protocol");
  const tagIds = fields.tagIds?.map(requestId);
  if (tagIds !== undefined && new Set(tagIds).size !== tagIds.length) throw new ApiError("protocol");
  const body = { ...fields, ...(fields.parentId === undefined ? {} : { parentId: fields.parentId === null ? null : requestId(fields.parentId) }), ...(tagIds === undefined ? {} : { tagIds }) };
  const response = await request(`/api/v1/projects/${project}/tasks/${task}`, signal, {
    method: "PATCH", redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: stringifyApiJson({ version: exactVersion, ...body }),
  }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 200) admission.onWriteConfirmed?.();
  return json(response, signal, (data) => {
    const result = parseTaskDetail(data, project, task);
    if (response.status !== 200 || result.version !== exactVersion && result.version !== exactVersion + 1n ||
      body.title !== undefined && result.title !== body.title || body.description !== undefined && result.description !== body.description ||
      body.parentId !== undefined && result.parentId !== body.parentId ||
      tagIds !== undefined && (result.tags.length !== tagIds.length || result.tags.some(tag => !tagIds.includes(tag.id)))) throw new ApiError("protocol", response.status);
    return result;
  }, undefined, false, admission.onWriteRejected);
};

// The epoch and body are one server snapshot; neither a cached epoch nor a
// search result can substitute for this receipt.
export const getTaskObservation = async (projectId: string, taskId: string, signal: AbortSignal, admission: TaskResponseAdmission, correlationId?: string): Promise<TaskObservation> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  const response = await request(`/api/v1/projects/${project}/tasks/${task}`, signal, { headers: { Accept: "application/json", ...(correlationId === undefined ? {} : { "X-Request-ID": correlationId }) } });
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (!response.ok) return json(response, signal, () => { throw new ApiError("protocol", response.status); });
  if (response.status !== 200) throw new ApiError("protocol", response.status);
  const header = response.headers.get("Daynight-Task-Epoch");
  if (header === null || canonicalId(header) !== header) throw new ApiError("protocol", response.status);
  const detail = await json(response, signal, (data) => parseTaskDetail(data, project, task));
  responseSignal(response, signal).throwIfAborted();
  return { epoch: header, detail };
};

export const getTask = async (projectId: string, taskId: string, signal: AbortSignal, admission: TaskResponseAdmission, correlationId?: string): Promise<TaskDetail> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  const response = await request(`/api/v1/projects/${project}/tasks/${task}`, signal, { headers: { Accept: "application/json", ...(correlationId === undefined ? {} : { "X-Request-ID": correlationId }) } });
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
  }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 204) { admission.onWriteConfirmed?.(); responseSignal(response, signal).throwIfAborted(); return; }
  if (response.ok) throw new ApiError("protocol", response.status);
  await json(response, signal, () => { throw new ApiError("protocol", response.status); }, undefined, false, admission.onWriteRejected);
};

export const setTaskStatus = async (
  projectId: string, taskId: string, status: TaskStatus, exactVersion: bigint, signal: AbortSignal, admission: TaskResponseAdmission,
): Promise<TaskDetail> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  if (!isTaskVersion(exactVersion) || !["proposed", "todo", "in_progress", "done", "cancelled"].includes(status)) throw new ApiError("protocol");
  const response = await request(`/api/v1/projects/${project}/tasks/${task}/status`, signal, {
    method: "PUT", redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: stringifyApiJson({ version: exactVersion, status }),
  }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 200) admission.onWriteConfirmed?.();
  return json(response, signal, (data) => {
    const result = parseTaskDetail(data, project, task);
    if (response.status !== 200 || result.status !== status || result.version !== exactVersion && result.version !== exactVersion + 1n) {
      throw new ApiError("protocol", response.status);
    }
    return result;
  }, undefined, false, admission.onWriteRejected);
};

export const withdrawWorkerClaim = async (
  projectId: string, taskId: string, claimId: string, exactVersion: bigint, signal: AbortSignal, admission: TaskResponseAdmission,
): Promise<TaskDetail> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  const claim = requestId(claimId);
  if (!isTaskVersion(exactVersion)) throw new ApiError("protocol");
  const response = await request(`/api/v1/projects/${project}/tasks/${task}/worker-claim/withdraw`, signal, {
    method: "POST", redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: stringifyApiJson({ version: exactVersion, claimId: claim }),
  }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 200) admission.onWriteConfirmed?.();
  return json(response, signal, (data) => {
    const result = parseTaskDetail(data, project, task);
    if (response.status !== 200 || result.version !== exactVersion + 1n || readWorkerClaim(result.properties) !== undefined ||
      result.status !== "todo" || result.allowAgents || result.startedAt !== null || result.completedAt !== null) throw new ApiError("protocol", response.status);
    return result;
  }, undefined, false, admission.onWriteRejected);
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
  }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 200) admission.onWriteConfirmed?.();
  return json(response, signal, (data) => {
    const result = parseTaskDetail(data, project, task);
    if (response.status !== 200 || result.allowAgents !== allowAgents || result.version !== exactVersion && result.version !== exactVersion + 1n) {
      throw new ApiError("protocol", response.status);
    }
    return result;
  }, undefined, false, admission.onWriteRejected);
};

export const unpauseTask = async (
  projectId: string, taskId: string, exactVersion: bigint, signal: AbortSignal, admission: TaskResponseAdmission,
): Promise<TaskDetail> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  if (!isTaskVersion(exactVersion)) throw new ApiError("protocol");
  const response = await request(`/api/v1/projects/${project}/tasks/${task}`, signal, {
    method: "PATCH", redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: stringifyApiJson({ version: exactVersion, properties: { paused: false } }),
  }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 200) admission.onWriteConfirmed?.();
  return json(response, signal, (data) => {
    const result = parseTaskDetail(data, project, task);
    if (response.status !== 200 || readTaskPaused(result.properties) !== false || result.version !== exactVersion && result.version !== exactVersion + 1n) {
      throw new ApiError("protocol", response.status);
    }
    return result;
  }, undefined, false, admission.onWriteRejected);
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
  }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 200) admission.onWriteConfirmed?.();
  return json(response, signal, (data) => {
    const result = parseTaskDetail(data, project, task);
    if (response.status !== 200 || result.requiredPlatform !== requiredPlatform || result.version !== exactVersion && result.version !== exactVersion + 1n) {
      throw new ApiError("protocol", response.status);
    }
    return result;
  }, undefined, false, admission.onWriteRejected);
};

export const setTaskAssignedTo = async (
  projectId: string, taskId: string, assignedTo: string | null, exactVersion: bigint, signal: AbortSignal, admission: TaskResponseAdmission,
): Promise<TaskDetail> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  const target = assignedTo === null ? null : requestId(assignedTo);
  if (!isTaskVersion(exactVersion)) throw new ApiError("protocol");
  const response = await request(`/api/v1/projects/${project}/tasks/${task}`, signal, {
    method: "PATCH", redirect: "error", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: stringifyApiJson({ version: exactVersion, assignedTo: target }),
  }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 200) admission.onWriteConfirmed?.();
  return json(response, signal, (data) => {
    const result = parseTaskDetail(data, project, task);
    if (response.status !== 200 || result.assignedTo !== target || result.version !== exactVersion && result.version !== exactVersion + 1n) {
      throw new ApiError("protocol", response.status);
    }
    return result;
  }, undefined, false, admission.onWriteRejected);
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
  responseSignal(response, signal).throwIfAborted();
  if (!response.ok) return json(response, signal, () => { throw new ApiError("protocol", response.status); });
  if (response.status !== 204) throw new ApiError("protocol", response.status);
};

export const readAttachmentText = async (projectId: string, taskId: string, path: string, signal: AbortSignal): Promise<string> => {
  const response = await request(attachmentDownloadUrl(projectId, taskId, path), signal);
  const lifetime = responseSignal(response, signal);
  lifetime.throwIfAborted();
  if (!response.ok) return json(response, signal, () => { throw new ApiError("protocol", response.status); });
  if (response.status !== 200) throw new ApiError("protocol", response.status);
  try {
    const text = await response.text();
    lifetime.throwIfAborted();
    return text;
  } catch (error) {
    lifetime.throwIfAborted();
    if (isAbortError(error)) throw error;
    throw new ApiError("network", response.status, "network", null, error);
  }
};

export const checkAttachmentPreview = async (projectId: string, taskId: string, path: string, signal: AbortSignal): Promise<void> => {
  const response = await request(attachmentPreviewUrl(projectId, taskId, path), signal, { method: "HEAD" });
  responseSignal(response, signal).throwIfAborted();
  if (!response.ok) {
    const header = response.headers.get("X-Request-ID");
    const requestId = header !== null && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(header) ? header : null;
    throw new ApiError("server", response.status, response.status === 401 ? "unauthenticated" : "server", requestId);
  }
  if (response.status !== 200) throw new ApiError("protocol", response.status);
};
