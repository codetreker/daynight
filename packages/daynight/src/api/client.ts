import { parseTaskPropertyResource, parseTaskPropertySchema, readWorkerClaim } from "./task-properties.js";
import { resourcePath } from "./resource-path.js";
import { performance } from "node:perf_hooks";
import { parseApiJson, stringifyApiJson } from "./json.js";
import { OperationError } from "./operation.js";
import { validateServerToken, validateTokenTransport } from "../config/server-token.js";
import type { Operation } from "./operation.js";
import { canonicalId, parsePage, parseProject, parseProjectMembers, parseServerError, parseTask, parseTaskGraph, parseTaskAttachment, parseUser, parseWorkerReportReceipt, ProtocolError, validateAttachmentPath } from "./parse.js";
import type { AttachmentConsumer, CreateProjectInput, CreateTaskInput, DeleteTaskInput, ErrorDetails, Project, ProjectMember, PutTaskAttachmentInput, ReadyTaskFilters, ServerError, Task, SetTaskStatusInput, TaskAttachment, TaskFilters, TaskGraph, UpdateTaskInput, ClaimWorkerTaskInput, CompleteWorkerTaskInput, ReleaseWorkerClaimInput, ResumeWorkerTaskInput, WithdrawWorkerClaimInput, UpdateWorkerClaimInput, User, WorkerClaim, WorkerClaimDescriptor, WorkerHerdr, Page, TaskPageQuery, WorkerReport, WorkerReportReceipt, TaskPropertyResource, TaskPropertySchema, SetTaskPropertyInput, RemoveTaskPropertyInput } from "./types.js";

type Context = { readonly operation: string; readonly projectId?: string; readonly taskId?: string };
export type ApiPhase = "prepare" | "request" | "response" | "protocol" | "pagination";

export class ApiError extends Error {
  readonly operation: string;
  readonly phase: ApiPhase;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly details?: ErrorDetails;
  readonly outcomeUnconfirmed: boolean;
  readonly confirmedRefusal: boolean;

  constructor(context: Context, phase: ApiPhase, options: {
    readonly cause: unknown;
    readonly status?: number;
    readonly serverError?: ServerError;
    readonly outcomeUnconfirmed?: boolean;
    readonly confirmedRefusal?: boolean;
  }) {
    const target = [context.projectId === undefined ? "" : ` project=${context.projectId}`, context.taskId === undefined ? "" : ` task=${context.taskId}`].join("");
    const server = options.serverError;
    const reason = server === undefined
      ? options.cause instanceof OperationError ? options.cause.message : phase === "protocol" || phase === "pagination" ? "Invalid server response." : "Local HTTP request failed."
      : `${server.code}: ${server.message} (requestId=${server.requestId})`;
    const details = server?.details;
    const detailText = details === undefined ? "" : ` details=${JSON.stringify(details)}`;
    super(`${context.operation}${target} [${phase}]: ${reason}${detailText}${options.status === 401 ? " Run daynight login to authenticate." : ""}${options.outcomeUnconfirmed === true ? " Remote mutation outcome is unconfirmed; query the target before retrying." : ""}`, { cause: options.cause });
    this.name = "ApiError";
    this.operation = context.operation;
    this.phase = phase;
    if (context.projectId !== undefined) this.projectId = context.projectId;
    if (context.taskId !== undefined) this.taskId = context.taskId;
    if (options.status !== undefined) this.status = options.status;
    if (server !== undefined) { this.code = server.code; this.requestId = server.requestId; }
    if (details !== undefined) this.details = details;
    this.outcomeUnconfirmed = options.outcomeUnconfirmed === true;
    this.confirmedRefusal = options.confirmedRefusal === true;
  }
}

export type ApiClient = {
  getCurrentUser(): Promise<User>;
  reportWorker(workerId: string, input: WorkerReport): Promise<WorkerReportReceipt>;
  createProject(input: CreateProjectInput): Promise<Project>;
  getProject(projectId: string): Promise<Project>;
  listProjects(): Promise<readonly Project[]>;
  listProjectMembers(projectId: string): Promise<readonly ProjectMember[]>;
  createTask(projectId: string, input: CreateTaskInput): Promise<Task>;
  getTask(projectId: string, taskId: string): Promise<Task>;
  getTaskPropertySchema(): Promise<TaskPropertySchema>;
  getTaskProperties(projectId: string, taskId: string): Promise<TaskPropertyResource>;
  setTaskProperty(projectId: string, taskId: string, name: string, input: SetTaskPropertyInput): Promise<TaskPropertyResource>;
  removeTaskProperty(projectId: string, taskId: string, name: string, input: RemoveTaskPropertyInput): Promise<TaskPropertyResource>;
  listTasks(projectId: string, filters?: TaskFilters): Promise<readonly Task[]>;
  listTaskPage(projectId: string, query: TaskPageQuery): Promise<Page<Task>>;
  listReadyTasks(projectId: string, limit: number, filters?: ReadyTaskFilters): Promise<readonly Task[]>;
  updateTask(projectId: string, taskId: string, input: UpdateTaskInput): Promise<Task>;
  deleteTask(projectId: string, taskId: string, input: DeleteTaskInput): Promise<void>;
  setTaskStatus(projectId: string, taskId: string, input: SetTaskStatusInput): Promise<Task>;
  claimWorkerTask(projectId: string, taskId: string, input: ClaimWorkerTaskInput): Promise<Task>;
  updateWorkerClaim(projectId: string, taskId: string, input: UpdateWorkerClaimInput): Promise<Task>;
  completeWorkerTask(projectId: string, taskId: string, input: CompleteWorkerTaskInput): Promise<Task>;
  releaseWorkerClaim(projectId: string, taskId: string, input: ReleaseWorkerClaimInput): Promise<Task>;
  withdrawWorkerClaim(projectId: string, taskId: string, input: WithdrawWorkerClaimInput): Promise<Task>;
  resumeWorkerTask(projectId: string, taskId: string, input: ResumeWorkerTaskInput): Promise<Task>;
  getTaskGraph(projectId: string, taskId: string): Promise<TaskGraph>;
  putTaskAttachment(projectId: string, taskId: string, path: string, input: PutTaskAttachmentInput): Promise<TaskAttachment>;
  listTaskAttachments(projectId: string, taskId: string): Promise<readonly TaskAttachment[]>;
  readTaskAttachment(projectId: string, taskId: string, path: string, consume: AttachmentConsumer): Promise<void>;
  removeTaskAttachment(projectId: string, taskId: string, path: string): Promise<void>;
};

const resourceId = (value: string): string => {
  const parsed = canonicalId(value);
  if (parsed === null) throw new Error("Resource ID must be a hyphenated UUID.");
  return parsed;
};

const attachmentPrefix = (projectId: string, taskId: string): string => `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/attachments`;
const encodeAttachmentPath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

export const createApiClient = (options: {
  readonly serverUrl: string;
  readonly serverToken?: string;
  readonly expectedUserId?: string;
  readonly operation: Operation;
  readonly fetch?: typeof globalThis.fetch;
}): ApiClient => {
  const origin = new URL(options.serverUrl);
  if (!/^https?:$/.test(origin.protocol) || origin.username !== "" || origin.password !== "" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") throw new Error("serverUrl must be an HTTP(S) service origin without credentials, path, query or fragment.");
  const serverToken = options.serverToken === undefined ? undefined : validateServerToken(options.serverToken);
  const expectedUserId = options.expectedUserId === undefined ? undefined : resourceId(options.expectedUserId);
  if (serverToken !== undefined) validateTokenTransport(origin.origin);
  const operation = options.operation;
  const fetch = options.fetch ?? globalThis.fetch;

  type ResponseMode<T> =
    | { readonly kind: "json"; readonly parse: (value: unknown) => T }
    | { readonly kind: "bytes"; readonly consume: AttachmentConsumer; readonly result: T }
    | { readonly kind: "empty"; readonly result: T };
  type RequestBody = { readonly kind: "json"; readonly value: unknown } | { readonly kind: "bytes"; readonly value: ReadableStream<Uint8Array>; readonly contentType: string };
  const exchange = async <T>(context: Context, path: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", mode: ResponseMode<T>, statuses: readonly number[], body?: RequestBody, mutable = false): Promise<T> => {
    let phase: ApiPhase = "prepare";
    let dispatched = false;
    let status: number | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bodyFailure: unknown;
    let uploadReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let uploadFailure: unknown;
    let uploadDone = false;
    let removeAbort = (): void => {};
    let removeOperationAbort = (): void => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestDeadline = Infinity;
    let totalBudgetCapped = false;
    let serverError: ServerError | undefined;
    const controller = new AbortController();
    const checkRequest = (): void => {
      operation.check();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (performance.now() >= requestDeadline) {
        controller.abort(new OperationError(totalBudgetCapped ? "deadline" : "request_timeout"));
        throw controller.signal.reason;
      }
    };
    try {
      operation.check();
      let payload: string | ReadableStream<Uint8Array> | undefined;
      if (body?.kind === "json") payload = stringifyApiJson(body.value);
      else if (body?.kind === "bytes") {
        uploadReader = body.value.getReader();
        const source = uploadReader;
        void source.closed.catch((error: unknown) => { uploadFailure = error; });
        let pending: Uint8Array | undefined;
        let offset = 0;
        payload = new ReadableStream<Uint8Array>({
          pull: async (target) => {
            checkRequest();
            if (pending === undefined) {
              const chunk = await source.read();
              checkRequest();
              if (chunk.done) { uploadDone = true; target.close(); return; }
              pending = chunk.value;
              offset = 0;
            }
            target.enqueue(pending.subarray(offset, offset + 65_536));
            offset += 65_536;
            if (offset >= pending.byteLength) pending = undefined;
          },
          cancel: (reason) => source.cancel(reason),
        }, { highWaterMark: 0 });
      }
      const contentType = body === undefined ? undefined : body.kind === "json" ? "application/json" : body.contentType;
      const url = new URL(`/api/v1${path}`, origin);
      const remaining = operation.remainingMs();
      const timeout = Math.min(operation.limits.requestMs, remaining);
      totalBudgetCapped = remaining <= operation.limits.requestMs;
      requestDeadline = performance.now() + timeout;
      timer = setTimeout(() => controller.abort(new OperationError(totalBudgetCapped ? "deadline" : "request_timeout")), Math.ceil(timeout));
      timer.unref();
      const cancel = (): void => controller.abort(operation.signal.reason);
      operation.signal.addEventListener("abort", cancel, { once: true });
      removeOperationAbort = () => operation.signal.removeEventListener("abort", cancel);
      if (operation.signal.aborted) cancel();
      phase = "request";
      checkRequest();
      const aborted = new Promise<never>((_resolve, reject) => {
        const fail = (): void => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", fail, { once: true });
        removeAbort = () => controller.signal.removeEventListener("abort", fail);
        if (controller.signal.aborted) fail();
      });
      const response = await Promise.race([Promise.resolve().then(() => {
        checkRequest();
        dispatched = true;
        return fetch(url, {
        method,
        headers: { "Daynight-Worker-Protocol": "2", Accept: mode.kind === "bytes" ? "*/*" : "application/json", ...(contentType === undefined ? {} : { "Content-Type": contentType }), ...(serverToken === undefined ? {} : { Authorization: `Bearer ${serverToken}` }) },
        ...(payload === undefined ? {} : { body: payload }),
        ...(body?.kind === "bytes" ? { duplex: "half" } : {}),
        ...(mutable ? { cache: "no-store" } : {}),
        redirect: "manual",
        signal: controller.signal,
        });
      }), aborted]);
      status = response.status;
      phase = "response";
      const success = statuses.includes(status);
      const binary = success && mode.kind === "bytes";
      const empty = success && mode.kind === "empty";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const chunks: string[] = [];
      let pendingText = "";
      let bytes = 0;
      let decodingError: unknown;
      if (response.body !== null) {
        reader = response.body.getReader();
        // Cancelling an already errored stream repeats its existing failure, rather than introducing a cleanup failure.
        void reader.closed.catch((error: unknown) => { bodyFailure = error; });
      }
      if (success && expectedUserId !== undefined) {
        phase = "protocol";
        const principal = response.headers.get("Daynight-User-ID");
        if (principal === null || canonicalId(principal) !== expectedUserId) throw new ProtocolError("The authenticated response principal does not match the expected user.");
        phase = "response";
      }
      if (reader !== undefined) {
        while (true) {
          checkRequest();
          const chunk = await Promise.race([reader.read(), aborted]);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (binary && mode.kind === "bytes") {
            for (let offset = 0; offset < chunk.value.byteLength; offset += 65_536) {
              checkRequest();
              await Promise.race([mode.consume(chunk.value.subarray(offset, offset + 65_536), controller.signal), aborted]);
            }
            continue;
          }
          operation.consume(chunk.value.byteLength);
          if (bytes > operation.limits.responseBytes) throw new OperationError("response_limit");
          if (empty) throw new ProtocolError("Expected an empty response body.");
          // Count the whole bounded body even when UTF-8 decoding fails before its end.
          if (decodingError === undefined) {
            try {
              pendingText += decoder.decode(chunk.value, { stream: true });
              if (pendingText.length >= 65_536) { chunks.push(pendingText); pendingText = ""; }
            }
            catch (error) { decodingError = error; }
          }
        }
      }
      checkRequest();
      phase = "protocol";
      if (success && mode.kind !== "json") return mode.result;
      if (decodingError !== undefined) throw decodingError;
      chunks.push(pendingText, decoder.decode());
      const responseContentType = response.headers.get("content-type");
      if (responseContentType === null || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(responseContentType)) throw new ProtocolError("Expected an application/json UTF-8 response.");
      const value = parseApiJson(chunks.join(""));
      checkRequest();
      if (!success) {
        if (status < 400 || status > 599) throw new ProtocolError("Unexpected HTTP status.");
        serverError = parseServerError(value);
        const confirmedRefusal = status >= 400 && status < 500;
        throw new ApiError(context, "response", { cause: new Error(serverError.message), status, serverError, confirmedRefusal, outcomeUnconfirmed: method !== "GET" && !confirmedRefusal });
      }
      if (mode.kind !== "json") throw new ProtocolError("Unexpected response mode.");
      const result = mode.parse(value);
      checkRequest();
      if (uploadReader !== undefined && !uploadDone) {
        await Promise.race([uploadReader.cancel(), aborted]);
        checkRequest();
      }
      return result;
    } catch (cause) {
      controller.abort(cause);
      let failure = cause;
      for (const [stream, existingFailure] of [[reader, bodyFailure], [uploadReader, uploadFailure]] as const) {
        if (stream === undefined) continue;
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const cleanup = stream.cancel(cause);
          await Promise.race([cleanup, new Promise<never>((_resolve, reject) => {
            cleanupTimer = setTimeout(() => reject(new Error("HTTP stream cancellation exceeded its 100 ms cleanup deadline.")), 100);
          })]);
        } catch (cleanupError) {
          if (cleanupError !== cause && cleanupError !== existingFailure) failure = new AggregateError([failure, cleanupError], "HTTP request failed and stream cleanup failed.", { cause });
        } finally {
          if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
        }
      }
      if (cause instanceof ApiError && failure === cause) throw cause;
      throw new ApiError(context, phase, {
        cause: failure,
        ...(status === undefined ? {} : { status }),
        ...(serverError === undefined ? {} : { serverError }),
        confirmedRefusal: cause instanceof ApiError && cause.confirmedRefusal,
        outcomeUnconfirmed: cause instanceof ApiError ? cause.outcomeUnconfirmed : method !== "GET" && dispatched,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbort();
      removeOperationAbort();
      reader?.releaseLock();
      uploadReader?.releaseLock();
    }
  };

  const request = <T>(context: Context, path: string, method: "GET" | "POST" | "PATCH", parse: (value: unknown) => T, body?: unknown): Promise<T> => exchange(context, path, method, { kind: "json", parse }, [method === "POST" ? 201 : 200], body === undefined ? undefined : { kind: "json", value: body });

  const list = async <T>(context: Context, path: string, parse: (item: unknown) => T, identity: (item: T) => string, filters: Record<string, string> = {}, mutable = false): Promise<readonly T[]> => {
    const result: T[] = [];
    const seenIdentities = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    try {
      do {
        operation.check();
        const query = new URLSearchParams({ ...filters, limit: "100", ...(cursor === null ? {} : { cursor }) });
        const page = await exchange(context, `${path}?${query}`, "GET", { kind: "json", parse: (value) => parsePage(value, parse, identity) }, [200], undefined, mutable);
        for (const item of page.items) {
          const key = identity(item);
          if (seenIdentities.has(key)) throw new ProtocolError("Duplicate resource identity across list pages.");
          seenIdentities.add(key);
          result.push(item);
        }
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (seenCursors.has(cursor)) throw new ProtocolError("Repeated pagination cursor.");
          seenCursors.add(cursor);
        }
      } while (cursor !== null);
      operation.check();
      return result;
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      throw new ApiError(context, "pagination", { cause });
    }
  };

  const taskFilterQuery = (filters: TaskFilters): Record<string, string> => {
    if (filters.status !== undefined && filters.status !== "todo" && filters.status !== "in_progress" && filters.status !== "done") throw new Error("Task status must be todo, in_progress or done.");
    if (filters.ready !== undefined && typeof filters.ready !== "boolean") throw new Error("Ready filter must be boolean.");
    if (filters.allowAgents !== undefined && typeof filters.allowAgents !== "boolean") throw new Error("Automatic execution filter must be boolean.");
    if (filters.compatiblePlatform !== undefined && filters.compatiblePlatform !== "windows" && filters.compatiblePlatform !== "linux" && filters.compatiblePlatform !== "macos") throw new Error("Compatible platform must be windows, linux or macos.");
    let workerId: string | undefined;
    if (filters.workerId !== undefined) {
      if (typeof filters.workerId !== "string") throw new Error("Worker ID filter must be a hyphenated UUID.");
      const parsed = canonicalId(filters.workerId);
      if (parsed === null) throw new Error("Worker ID filter must be a hyphenated UUID.");
      workerId = parsed;
    }
    return { ...(filters.status === undefined ? {} : { status: filters.status }), ...(filters.ready === undefined ? {} : { ready: String(filters.ready) }), ...(filters.allowAgents === undefined ? {} : { allowAgents: String(filters.allowAgents) }), ...(filters.compatiblePlatform === undefined ? {} : { compatiblePlatform: filters.compatiblePlatform }), ...(workerId === undefined ? {} : { workerId }) };
  };
  const filteredTask = (value: unknown, project: string, filters: TaskFilters): Task => {
    const task = parseTask(value, project);
    const worker = readWorkerClaim(task.properties);
    if (
      (filters.status !== undefined && task.status !== filters.status)
      || (filters.ready !== undefined && task.ready !== filters.ready)
      || (filters.allowAgents !== undefined && task.allowAgents !== filters.allowAgents)
      || (filters.compatiblePlatform !== undefined && task.requiredPlatform !== null && task.requiredPlatform !== filters.compatiblePlatform)
      || (filters.workerId !== undefined && (worker === undefined || worker.state !== "active" || worker.workerId !== canonicalId(filters.workerId)))
    ) throw new ProtocolError("Task does not match the requested filters.");
    return task;
  };
  const taskVersion = (version: bigint): void => {
    if (typeof version !== "bigint" || version < 1n || version > 9_223_372_036_854_775_807n) throw new Error("Task version must be a positive int64.");
  };
  const herdrMatches = (actual: WorkerHerdr | null, expected: WorkerHerdr | null): boolean => actual === null || expected === null ? actual === expected : actual.session === expected.session && actual.workspaceId === expected.workspaceId && actual.paneId === expected.paneId;
  const descriptorMatches = (worker: WorkerClaim, descriptor: WorkerClaimDescriptor): boolean => worker.claimId === canonicalId(descriptor.claimId) && worker.workerId === canonicalId(descriptor.workerId) && worker.machine.id === canonicalId(descriptor.machine.id) && worker.machine.name === descriptor.machine.name && worker.platform === descriptor.platform && worker.agent === descriptor.agent && worker.agentControlMode === (descriptor.agentControlMode ?? "herdr") && worker.worktreeId === canonicalId(descriptor.worktreeId);
  const workerMutation = <T extends { readonly version: bigint }>(projectId: string, taskId: string, action: string, suffix: string, method: "POST" | "PATCH" | "PUT", input: T, matches: (task: Task, worker: WorkerClaim | undefined) => boolean, sameValue = false): Promise<Task> => {
    if (Object.hasOwn(input, "continuityConfirmed")) throw new Error("continuityConfirmed is no longer accepted. New executions require fresh claim and worktree IDs.");
    const project = resourceId(projectId), task = resourceId(taskId);
    taskVersion(input.version);
    return exchange({ operation: action, projectId: project, taskId: task }, `/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(task)}${suffix}`, method, { kind: "json", parse: (value) => {
      const result = parseTask(value, project, task);
      const worker = readWorkerClaim(result.properties);
      if ((result.version !== input.version + 1n && !(sameValue && result.version === input.version)) || !matches(result, worker)) throw new ProtocolError("Task does not match the requested worker operation.");
      return result;
    } }, [200], { kind: "json", value: input }, true);
  };

  return {
    getCurrentUser: () => exchange({ operation: "auth.me" }, "/me", "GET", { kind: "json", parse: parseUser }, [200], undefined, true),
    reportWorker: (workerId, input) => {
      const worker = resourceId(workerId);
      return exchange({ operation: "worker.report" }, `/me/workers/${encodeURIComponent(worker)}/report`, "POST", { kind: "json", parse: parseWorkerReportReceipt }, [200], { kind: "json", value: input }, true);
    },
    createProject: (input) => request({ operation: "project.create" }, "/projects", "POST", (value) => parseProject(value), { name: input.name, repoUrl: input.repoUrl }),
    getProject: (projectId) => {
      const project = resourceId(projectId);
      return request({ operation: "project.show", projectId: project }, `/projects/${encodeURIComponent(project)}`, "GET", (value) => parseProject(value, project));
    },
    listProjects: () => list({ operation: "project.list" }, "/projects", (value) => parseProject(value), (project) => project.id),
    listProjectMembers: (projectId) => {
      const project = resourceId(projectId);
      return exchange({ operation: "project.members", projectId: project }, `/projects/${encodeURIComponent(project)}/members`, "GET", { kind: "json", parse: (value) => parseProjectMembers(value, project) }, [200], undefined, true);
    },
    createTask: (projectId, input) => {
      const project = resourceId(projectId);
      return request({ operation: "task.create", projectId: project }, `/projects/${encodeURIComponent(project)}/tasks`, "POST", (value) => parseTask(value, project), {
        title: input.title,
        ...(input.requiredPlatform === undefined ? {} : { requiredPlatform: input.requiredPlatform }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
        ...(input.externalDependsOn === undefined ? {} : { externalDependsOn: input.externalDependsOn }),
        ...(input.properties === undefined ? {} : { properties: input.properties }),
      });
    },
    getTask: (projectId, taskId) => {
      const project = resourceId(projectId), task = resourceId(taskId);
      return request({ operation: "task.show", projectId: project, taskId: task }, `/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(task)}`, "GET", (value) => parseTask(value, project, task));
    },
    getTaskPropertySchema: () => exchange({ operation: "task.properties.schema" }, "/task-properties/schema", "GET", { kind: "json", parse: parseTaskPropertySchema }, [200], undefined, true),
    getTaskProperties: (projectId, taskId) => {
      const project = resourceId(projectId), task = resourceId(taskId);
      return exchange({ operation: "task.properties", projectId: project, taskId: task }, resourcePath("projects", project, "tasks", task, "properties"), "GET", { kind: "json", parse: (value) => parseTaskPropertyResource(value, project, task) }, [200], undefined, true);
    },
    setTaskProperty: (projectId, taskId, name, input) => {
      const project = resourceId(projectId), task = resourceId(taskId);
      taskVersion(input.version);
      const pathname = resourcePath("projects", project, "tasks", task, "properties", name);
      return exchange({ operation: "task.set-property", projectId: project, taskId: task }, pathname, "PUT", { kind: "json", parse: (value) => {
        const result = parseTaskPropertyResource(value, project, task);
        if ((result.version !== input.version && result.version !== input.version + 1n) || !Object.hasOwn(result.properties, name)) throw new ProtocolError("Task does not confirm the requested property setting.");
        return result;
      } }, [200], { kind: "json", value: { version: input.version, valueText: input.valueText } }, true);
    },
    removeTaskProperty: (projectId, taskId, name, input) => {
      const project = resourceId(projectId), task = resourceId(taskId);
      taskVersion(input.version);
      const pathname = resourcePath("projects", project, "tasks", task, "properties", name);
      return exchange({ operation: "task.remove-property", projectId: project, taskId: task }, pathname, "DELETE", { kind: "json", parse: (value) => {
        const result = parseTaskPropertyResource(value, project, task);
        if ((result.version !== input.version && result.version !== input.version + 1n) || Object.hasOwn(result.properties, name)) throw new ProtocolError("Task does not confirm the requested property removal.");
        return result;
      } }, [200], { kind: "json", value: { version: input.version } }, true);
    },
    listTasks: (projectId, filters = {}) => {
      const project = resourceId(projectId);
      return list({ operation: "task.list", projectId: project }, `/projects/${encodeURIComponent(project)}/tasks`, (value) => filteredTask(value, project, filters), (task) => task.id, taskFilterQuery(filters));
    },
    listTaskPage: (projectId, query) => {
      const project = resourceId(projectId);
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new Error("Task page limit must be an integer from 1 to 100.");
      if (query.cursor !== undefined && (typeof query.cursor !== "string" || query.cursor === "")) throw new Error("Task page cursor must be a nonempty string.");
      const search = new URLSearchParams({ ...taskFilterQuery(query), limit: String(query.limit), ...(query.cursor === undefined ? {} : { cursor: query.cursor }) });
      return request({ operation: "task.list-page", projectId: project }, `/projects/${encodeURIComponent(project)}/tasks?${search}`, "GET", (value) => {
        const page = parsePage(value, (item) => filteredTask(item, project, query), (task) => task.id);
        if (page.items.length > query.limit) throw new ProtocolError("Task page exceeds the requested limit.");
        return page;
      });
    },
    listReadyTasks: (projectId, limit, filters = {}) => {
      const project = resourceId(projectId);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Ready task limit must be an integer from 1 to 100.");
      const { allowAgents, compatiblePlatform } = filters;
      const query = new URLSearchParams({ ready: "true", limit: String(limit), ...(allowAgents === undefined ? {} : { allowAgents: String(allowAgents) }), ...(compatiblePlatform === undefined ? {} : { compatiblePlatform }) });
      return request({ operation: "task.ready", projectId: project }, `/projects/${encodeURIComponent(project)}/tasks?${query}`, "GET", (value) => {
        const page = parsePage(value, (item) => {
          const task = parseTask(item, project);
          if (!task.ready || (allowAgents !== undefined && task.allowAgents !== allowAgents) || (compatiblePlatform !== undefined && task.requiredPlatform !== null && task.requiredPlatform !== compatiblePlatform)) throw new ProtocolError("Task does not match the requested ready filters.");
          return task;
        }, (task) => task.id);
        if (page.items.length > limit) throw new ProtocolError("Ready task page exceeds the requested limit.");
        return page.items;
      });
    },
    updateTask: (projectId, taskId, input) => {
      const project = resourceId(projectId), task = resourceId(taskId);
      return request({ operation: "task.update", projectId: project, taskId: task }, `/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(task)}`, "PATCH", (value) => parseTask(value, project, task), {
        version: input.version,
        ...(input.allowAgents === undefined ? {} : { allowAgents: input.allowAgents }),
        ...(input.requiredPlatform === undefined ? {} : { requiredPlatform: input.requiredPlatform }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
        ...(input.externalDependsOn === undefined ? {} : { externalDependsOn: input.externalDependsOn }),
        ...(input.properties === undefined ? {} : { properties: input.properties }),
      });
    },
    deleteTask: (projectId, taskId, input) => {
      const project = resourceId(projectId), task = resourceId(taskId);
      taskVersion(input.version);
      if (input.removeDepends !== undefined && typeof input.removeDepends !== "boolean") throw new Error("removeDepends must be a boolean.");
      return exchange({ operation: "task.delete", projectId: project, taskId: task }, `/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(task)}`, "DELETE", { kind: "empty", result: undefined }, [204], { kind: "json", value: { version: input.version, ...(input.removeDepends === undefined ? {} : { removeDepends: input.removeDepends }) } }, true);
    },
    setTaskStatus: (projectId, taskId, input) => {
      const project = resourceId(projectId), task = resourceId(taskId);
      if (input.status !== "todo" && input.status !== "in_progress" && input.status !== "done") throw new Error("Task status must be todo, in_progress or done.");
      taskVersion(input.version);
      return exchange({ operation: "task.set-status", projectId: project, taskId: task }, `/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(task)}/status`, "PUT", { kind: "json", parse: (value) => {
        const result = parseTask(value, project, task);
        if (result.status !== input.status || (result.version !== input.version && result.version !== input.version + 1n)) throw new ProtocolError("Task does not match the requested status or version.");
        return result;
      } }, [200], { kind: "json", value: { version: input.version, status: input.status } }, true);
    },
    claimWorkerTask: (projectId, taskId, input) => workerMutation(projectId, taskId, "worker.claim", "/worker-claim", "POST", input, (task, worker) => worker !== undefined && task.status === "in_progress" && worker.state === "active" && descriptorMatches(worker, input)),
    updateWorkerClaim: (projectId, taskId, input) => workerMutation(projectId, taskId, "worker.update", "/worker-claim", "PATCH", input, (task, worker) => worker !== undefined && task.status === "in_progress" && worker.state === "active" && worker.claimId === canonicalId(input.claimId) && (input.phase === undefined || worker.phase === input.phase) && (input.herdr === undefined || herdrMatches(worker.herdr, input.herdr)) && (input.nativeSessionId === undefined || worker.nativeSessionId === input.nativeSessionId), true),
    completeWorkerTask: (projectId, taskId, input) => workerMutation(projectId, taskId, "worker.complete", "/status", "PUT", { ...input, status: "done" }, (task, worker) => worker !== undefined && task.status === "done" && worker.state === "completed" && worker.claimId === canonicalId(input.claimId), true),
    releaseWorkerClaim: (projectId, taskId, input) => workerMutation(projectId, taskId, "worker.release", "/worker-claim/release", "POST", input, (task, worker) => worker !== undefined && task.status === "todo" && worker.state === "released" && worker.claimId === canonicalId(input.claimId)),
    withdrawWorkerClaim: (projectId, taskId, input) => {
      resourceId(input.claimId);
      return workerMutation(projectId, taskId, "worker.withdraw", "/worker-claim/withdraw", "POST", input, (task, worker) => worker === undefined && task.status === "todo" && !task.allowAgents && task.startedAt === null && task.completedAt === null);
    },
    resumeWorkerTask: (projectId, taskId, input) => workerMutation(projectId, taskId, "worker.resume", "/worker-claim/resume", "POST", input, (task, worker) => worker !== undefined && task.status === "in_progress" && worker.state === "active" && descriptorMatches(worker, input)),
    putTaskAttachment: (projectId, taskId, path, input) => {
      const project = resourceId(projectId), task = resourceId(taskId), attachmentPath = validateAttachmentPath(path);
      return exchange({ operation: "task.attachment.put", projectId: project, taskId: task }, `${attachmentPrefix(project, task)}/files/${encodeAttachmentPath(attachmentPath)}`, "PUT", { kind: "json", parse: (value) => parseTaskAttachment(value, attachmentPath) }, [200, 201], { kind: "bytes", value: input.body, contentType: input.contentType }, true);
    },
    listTaskAttachments: (projectId, taskId) => {
      const project = resourceId(projectId), task = resourceId(taskId);
      return list({ operation: "task.attachment.list", projectId: project, taskId: task }, attachmentPrefix(project, task), parseTaskAttachment, (attachment) => attachment.path, {}, true);
    },
    readTaskAttachment: (projectId, taskId, path, consume) => {
      const project = resourceId(projectId), task = resourceId(taskId), attachmentPath = validateAttachmentPath(path);
      return exchange({ operation: "task.attachment.read", projectId: project, taskId: task }, `${attachmentPrefix(project, task)}/files/${encodeAttachmentPath(attachmentPath)}`, "GET", { kind: "bytes", consume, result: undefined }, [200], undefined, true);
    },
    removeTaskAttachment: (projectId, taskId, path) => {
      const project = resourceId(projectId), task = resourceId(taskId), attachmentPath = validateAttachmentPath(path);
      return exchange({ operation: "task.attachment.remove", projectId: project, taskId: task }, `${attachmentPrefix(project, task)}/files/${encodeAttachmentPath(attachmentPath)}`, "DELETE", { kind: "empty", result: undefined }, [204], undefined, true);
    },
    getTaskGraph: (projectId, taskId) => {
      const project = resourceId(projectId), task = resourceId(taskId);
      return request({ operation: "task.graph", projectId: project, taskId: task }, `/projects/${encodeURIComponent(project)}/task-graph?taskId=${encodeURIComponent(task)}`, "GET", (value) => parseTaskGraph(value, project, task));
    },
  };
};
