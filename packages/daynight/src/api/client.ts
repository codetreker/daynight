import { jsonObjectSources } from "./json-source.js";
import { randomUUID } from "node:crypto";
import { parseCreatedTeamInvitation, parseTeamInvitations, parseTeamInvitationRevoke } from "./team-invitations.js";
import { sameStartupReport } from "../session/startup.js";
import { parseBot, botName, botVersion } from "../commands/bot/api.js";
import type { Bot, CreateBotInput, DeleteBotInput } from "../commands/bot/api.js";
import { parseWorkerPage, parseWorkerDetail } from "../commands/worker/query-api.js";
import type { WorkerList, WorkerDetailResponse, WorkerSummary } from "../commands/worker/query-api.js";
import { parseTaskPropertyResource, parseTaskPropertySchema, readWorkerClaim, readSessionStartupReport } from "./task-properties.js";
import { resourcePath } from "./resource-path.js";
import { canonicalStepId, confirmAddedTaskStep, confirmDeletedTaskStep, confirmMovedTaskStep, confirmUpdatedTaskStep, decodeStepsJsonSource, parseStepResource, parseStepsResource, TASK_STEPS_RESPONSE_BYTES } from "./task-steps.js";
import { decodeThreadJsonSource, parseThreadMessage, parseThreadPage, THREAD_MESSAGE_BYTES, THREAD_PAGE_BYTES } from "./thread.js";
import type { AddTaskStepInput, AddTaskStepOptions, DeleteTaskStepInput, MoveTaskStepInput, MoveTaskStepOptions, SetTaskStepStatusInput, TaskStepWriteOptions, TaskStepsReadOptions, UpdateTaskStepInput, StepsResource, StepResource, ThreadReadQuery, PostThreadMessageInput, ThreadMessage, ThreadPage } from "./types.js";
import { isNonemptyText, isText } from "../platform/text.js";
import { performance } from "node:perf_hooks";
import { parseApiJson, stringifyApiJson } from "./json.js";
import { OperationError } from "./operation.js";
import { validateServerToken, validateTokenTransport } from "../config/server-token.js";
import type { Operation } from "./operation.js";
import { canonicalId, parsePage, parseProject, parseCreatedProject, parseProjectAccess, parseProjectParticipants, parseProjectTransferPreview, parseProjectTransferReceipt, parseServerError, parseTask, parseTaskGraph, parseTaskAttachment, parseTeam, parseTeamDeleteReceipt, parseTeamMembers, parseTeamMemberRoleReceipt, parseRemoveTeamMemberReceipt, parseUser, parseWorkerReportReceipt, parseProjectInvitationInspection, parseProjectInvitationAcceptance, parseTeamInvitationInspection, parseTeamInvitationAcceptance, ProtocolError, validateAttachmentPath } from "./parse.js";
import type { ProjectTransferPreview, ProjectTransferReceipt, Team, TeamMember, TeamMemberWithProfile, TeamMemberRoleReceipt, RemoveTeamMemberReceipt, TeamRole, InvitationScope, InvitationInspection, InvitationAcceptance, TeamInvitation, CreatedTeamInvitation, TeamInvitationRevokeReceipt } from "./types.js";
import type { AttachmentConsumer, CreateProjectInput, CreateTaskInput, DeleteTaskInput, ErrorDetails, Project, ProjectAccess, ProjectParticipant, PutTaskAttachmentInput, ReadyTaskFilters, ServerError, Task, SetTaskStatusInput, TaskAttachment, TaskFilters, TaskGraph, UpdateTaskInput, ClaimWorkerTaskInput, CompleteWorkerTaskInput, ReleaseWorkerClaimInput, ResumeWorkerTaskInput, WithdrawWorkerClaimInput, UpdateWorkerClaimInput, User, WorkerClaim, WorkerClaimDescriptor, WorkerHerdr, Page, TaskPageQuery, WorkerReport, WorkerReportReceipt, TaskPropertyResource, TaskPropertySchema, SetTaskPropertyInput, RemoveTaskPropertyInput } from "./types.js";

type Context = { readonly operation: string; readonly projectId?: string; readonly taskId?: string; readonly stepId?: string; readonly sentRequestId?: string };
export type ApiPhase = "prepare" | "request" | "response" | "protocol" | "pagination";

export class ApiError extends Error {
  readonly operation: string;
  readonly phase: ApiPhase;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly stepId?: string;
  readonly serverMessage?: string;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly sentRequestId?: string;
  readonly responseRequestId?: string;
  readonly details?: ErrorDetails;
  readonly outcomeUnconfirmed: boolean;
  readonly confirmedRefusal: boolean;
  readonly confirmedMutationId?: string;

  constructor(context: Context, phase: ApiPhase, options: {
    readonly cause: unknown;
    readonly status?: number;
    readonly serverError?: ServerError;
    readonly outcomeUnconfirmed?: boolean;
    readonly confirmedRefusal?: boolean;
    readonly confirmedMutationId?: string;
    readonly responseRequestId?: string;
  }) {
    const target = [context.projectId === undefined ? "" : ` project=${context.projectId}`, context.taskId === undefined ? "" : ` task=${context.taskId}`, context.stepId === undefined ? "" : ` step=${context.stepId}`].join("");
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
    if (context.stepId !== undefined) this.stepId = context.stepId;
    if (context.sentRequestId !== undefined) this.sentRequestId = context.sentRequestId;
    if (options.responseRequestId !== undefined) this.responseRequestId = options.responseRequestId;
    if (options.status !== undefined) this.status = options.status;
    if (server !== undefined) { this.code = server.code; this.requestId = server.requestId; this.serverMessage = server.message; }
    if (details !== undefined) this.details = details;
    this.outcomeUnconfirmed = options.outcomeUnconfirmed === true;
    this.confirmedRefusal = options.confirmedRefusal === true;
    if (options.confirmedMutationId !== undefined) this.confirmedMutationId = options.confirmedMutationId;
  }
}

// Response and transport errors may contain bearer secrets. Rebuild the cause chain
// from fixed classifications instead of copying any untrusted text or properties.
const safeTeamInvitationCause = (input: unknown, seen = new Set<object>(), depth = 0): Error => {
  try {
    if (!(input instanceof Error) || seen.has(input) || depth >= 16) return new Error("Untrusted error detail withheld.");
    seen.add(input);
    const cause = input.cause === undefined ? undefined : safeTeamInvitationCause(input.cause, seen, depth + 1);
    const options = cause === undefined ? undefined : { cause };
    let result: Error;
    if (input instanceof OperationError && ["cancelled", "deadline", "request_timeout", "request_limit", "response_limit", "total_limit", "disposed"].includes(input.kind)) {
      result = new OperationError(input.kind, options);
    } else if (input instanceof AggregateError) {
      result = new AggregateError(Array.from(input.errors as unknown[]).slice(0, 32).map((item) => safeTeamInvitationCause(item, seen, depth + 1)), "Invitation request and cleanup failed.", options);
    } else if (input instanceof ProtocolError) {
      result = new ProtocolError();
      if (cause !== undefined) Object.defineProperty(result, "cause", { value: cause, configurable: true });
    } else if (input instanceof SyntaxError) {
      result = new SyntaxError("Invalid invitation response JSON.", options);
    } else if (input instanceof TypeError) {
      result = new TypeError("Invitation transport or response decoding failed.", options);
    } else {
      const code = (input as Error & { readonly code?: unknown }).code;
      if (typeof code === "string" && ["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(code)) {
        result = Object.assign(new Error(`Invitation network error (${code}).`, options), { code });
      } else if (input.name === "AbortError") {
        result = new Error("Invitation request cancelled.", options);
        result.name = "AbortError";
      } else {
        result = new Error("Invitation request error details withheld.", options);
      }
    }
    seen.delete(input);
    return result;
  } catch {
    return new Error("Untrusted error detail withheld.");
  }
};

const safeInvitationFailure = (error: unknown, context: Context): ApiError => {
  if (!(error instanceof ApiError)) return new ApiError(context, "protocol", { cause: safeTeamInvitationCause(error) });
  const allowed = new Set(["identity_mismatch", "personal_team_immutable", "forbidden", "not_found", "unauthenticated", "invalid_input", "internal_error", "write_outcome_unknown"]);
  const serverError = error.code !== undefined && allowed.has(error.code)
    ? { code: error.code, message: "The invitation request was rejected by the server.", requestId: context.sentRequestId !== undefined && error.requestId === context.sentRequestId ? context.sentRequestId : "withheld" }
    : undefined;
  return new ApiError(context, error.phase, {
    cause: safeTeamInvitationCause(error.cause),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(serverError === undefined ? {} : { serverError }),
    ...(context.sentRequestId !== undefined && error.responseRequestId === context.sentRequestId ? { responseRequestId: context.sentRequestId } : {}),
    confirmedRefusal: error.confirmedRefusal, outcomeUnconfirmed: error.outcomeUnconfirmed,
    ...(error.confirmedMutationId === undefined ? {} : { confirmedMutationId: error.confirmedMutationId }),
  });
};

export type ApiClient = {
  listBots(): Promise<readonly Bot[]>;
  getBot(botId: string): Promise<Bot>;
  createBot(input: CreateBotInput): Promise<Bot>;
  deleteBot(botId: string, input: DeleteBotInput): Promise<Bot>;
  listWorkers(): Promise<WorkerList>;
  getWorker(workerId: string): Promise<WorkerDetailResponse>;
  listTaskSteps(projectId: string, taskId: string, options?: TaskStepsReadOptions): Promise<StepsResource>;
  addTaskStep(projectId: string, taskId: string, input: AddTaskStepInput, options: AddTaskStepOptions): Promise<StepsResource>;
  deleteTaskStep(projectId: string, taskId: string, stepId: string, input: DeleteTaskStepInput, options: TaskStepWriteOptions): Promise<StepsResource>;
  updateTaskStep(projectId: string, taskId: string, stepId: string, input: UpdateTaskStepInput, options: TaskStepWriteOptions): Promise<StepsResource>;
  setTaskStepStatus(projectId: string, taskId: string, stepId: string, input: SetTaskStepStatusInput, options: TaskStepWriteOptions): Promise<StepsResource>;
  moveTaskStep(projectId: string, taskId: string, stepId: string, input: MoveTaskStepInput, options: MoveTaskStepOptions): Promise<StepsResource>;
  getTaskStep(projectId: string, taskId: string, stepId: string): Promise<StepResource>;
  readTaskThread(projectId: string, taskId: string, query: ThreadReadQuery): Promise<ThreadPage>;
  postTaskThreadMessage(projectId: string, taskId: string, input: PostThreadMessageInput): Promise<ThreadMessage>;
  getCurrentUser(requirePrincipal?: boolean): Promise<User>;
  getTeamCurrentUser(): Promise<User>;
  inspectInvitation(scope: InvitationScope, token: string, userId: string): Promise<InvitationInspection>;
  acceptInvitation(scope: InvitationScope, token: string, userId: string, targetId: string, requestId: string): Promise<InvitationAcceptance>;
  listTeams(userId: string): Promise<readonly Team[]>;
  getTeam(userId: string, teamId: string): Promise<Team>;
  createTeam(userId: string, name: string, requestId: string): Promise<Team>;
  renameTeam(userId: string, team: Team, name: string, requestId: string): Promise<Team>;
  deleteTeam(userId: string, team: Team, requestId: string): Promise<{ readonly teamId: string; readonly deleted: true }>;
  listTeamMembers(userId: string, teamId: string): Promise<readonly TeamMemberWithProfile[]>;
  setTeamMemberRole(userId: string, member: TeamMember, role: TeamRole, requestId: string): Promise<TeamMemberRoleReceipt>;
  removeTeamMember(userId: string, member: TeamMember, requestId: string): Promise<RemoveTeamMemberReceipt>;
  listTeamProjects(userId: string, teamId: string): Promise<readonly Project[]>;
  listTeamInvitations(userId: string, teamId: string): Promise<readonly TeamInvitation[]>;
  createTeamInvitation(userId: string, teamId: string, requestId: string): Promise<CreatedTeamInvitation>;
  revokeTeamInvitation(userId: string, teamId: string, invitationId: string, requestId: string): Promise<TeamInvitationRevokeReceipt>;
  previewProjectTransfer(userId: string, projectId: string, targetTeamId: string): Promise<ProjectTransferPreview>;
  transferProject(userId: string, projectId: string, preview: ProjectTransferPreview, requestId: string): Promise<ProjectTransferReceipt>;
  reportWorker(workerId: string, input: WorkerReport): Promise<WorkerReportReceipt>;
  createProject(input: CreateProjectInput, requestId?: string): Promise<Project>;
  getProject(projectId: string, userId?: string): Promise<Project>;
  getProjectAccess(projectId: string): Promise<ProjectAccess>;
  listProjects(userId?: string): Promise<readonly Project[]>;
  listProjectMembers(projectId: string): Promise<readonly ProjectParticipant[]>;
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

const validateInvitationToken = (scope: InvitationScope, token: string): void => {
  const prefix = scope === "team" ? "dnteam_" : scope === "project" ? "dninvite_" : "";
  if (prefix === "" || !token.startsWith(prefix)) throw new Error("Invalid invitation secret.");
  const encoded = token.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded) || Buffer.from(encoded, "base64url").toString("base64url") !== encoded) throw new Error("Invalid invitation secret.");
};

// Invitation transports and response bodies are untrusted and may echo the bearer secret.
// Retain the shape and safe classifications of failures without copying their text or fields.
const safeInvitationCause = (input: unknown, seen = new WeakSet<object>(), depth = 0): Error => {
  if (!(input instanceof Error) || depth >= 16 || seen.has(input)) return new Error("Invitation failure details withheld.");
  seen.add(input);
  const cause = input.cause === undefined ? undefined : safeInvitationCause(input.cause, seen, depth + 1);
  const options = cause === undefined ? undefined : { cause };
  if (input instanceof AggregateError) return new AggregateError(Array.from(input.errors, (item: unknown) => safeInvitationCause(item, seen, depth + 1)), "Invitation request and cleanup failed.", options);
  if (input instanceof OperationError) return new OperationError(input.kind, options);
  const result = new Error(input instanceof ProtocolError ? "Invalid invitation response." : "Invitation failure details withheld.", options);
  if (input instanceof ProtocolError) result.name = "ProtocolError";
  return result;
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
  let stepsPrincipal = expectedUserId;
  const bindStepsPrincipal = (principal: string): void => {
    if (stepsPrincipal !== undefined && stepsPrincipal !== principal) throw new ProtocolError("The authenticated Steps response principal changed during the operation.");
    stepsPrincipal = principal;
  };
  const validRequestId = (value: string): boolean => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value);


  type JsonResponseMetadata = { readonly status: number; readonly success: boolean; readonly principalHeader: string | null; readonly principalId?: string; readonly locationHeader: string | null };
  type JsonParser<T> = (value: unknown, metadata: JsonResponseMetadata) => T;
  type ResponseMode<T> =
    | { readonly kind: "json"; readonly parse: JsonParser<T>; readonly requirePrincipal?: boolean; readonly checkFailurePrincipal?: boolean; readonly checkPrincipalOnError?: boolean; readonly onPrincipal?: (principal: string) => void; readonly responseBytes?: number; readonly decodeJsonSource?: (source: string, metadata: JsonResponseMetadata) => unknown; readonly confirmedFailure?: (status: number, error: ServerError) => boolean; readonly confirmMutation?: (result: T) => string; readonly secret?: string; readonly readOnly?: boolean; readonly allowIdentityMismatchRefusal?: boolean }
    | { readonly kind: "bytes"; readonly consume: AttachmentConsumer; readonly result: T }
    | { readonly kind: "empty"; readonly result: T };
  type RequestBody = { readonly kind: "json"; readonly value: unknown; readonly maxBytes?: number } | { readonly kind: "bytes"; readonly value: ReadableStream<Uint8Array>; readonly contentType: string };
  const exchange = async <T>(context: Context, path: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", mode: ResponseMode<T>, statuses: readonly number[], body?: RequestBody, mutable = false): Promise<T> => {
    const secret = mode.kind === "json" ? mode.secret : undefined;
    const mutation = method !== "GET" && !(mode.kind === "json" && mode.readOnly === true);
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
    let confirmedMutationId: string | undefined;
    let responseRequestId: string | undefined;
    let terminalFailure: ApiError | undefined;
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
      if (context.sentRequestId !== undefined && !validRequestId(context.sentRequestId)) throw new Error("Request ID must follow the supported 1-to-64-character request identity format.");
      if (body?.kind === "json") {
        payload = stringifyApiJson(body.value);
        if (body.maxBytes !== undefined && Buffer.byteLength(payload, "utf8") > body.maxBytes) throw new OperationError("request_limit");
      }
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
        headers: { "Daynight-Worker-Protocol": "2", Accept: mode.kind === "bytes" ? "*/*" : "application/json", ...(contentType === undefined ? {} : { "Content-Type": contentType }), ...(serverToken === undefined ? {} : { Authorization: `Bearer ${serverToken}` }), ...(context.sentRequestId === undefined ? {} : { "X-Request-ID": context.sentRequestId }) },
        ...(payload === undefined ? {} : { body: payload }),
        ...(body?.kind === "bytes" ? { duplex: "half" } : {}),
        ...(mutable ? { cache: "no-store" } : {}),
        redirect: "manual",
        signal: controller.signal,
        });
      }), aborted]);
      status = response.status;
      const observedRequestId = response.headers.get("X-Request-ID");
      if (observedRequestId !== null && validRequestId(observedRequestId) && (secret === undefined || canonicalId(observedRequestId) === observedRequestId)) responseRequestId = observedRequestId;
      phase = "response";
      const success = statuses.includes(status);
      let principalId: string | undefined;
      let invitationIdentityMismatch = false;
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
      if (success && (expectedUserId !== undefined || mode.kind === "json" && mode.requirePrincipal === true) || !success && mode.kind === "json" && (status !== 401 && mode.checkFailurePrincipal === true || response.headers.has("Daynight-User-ID") && mode.checkPrincipalOnError === true && (expectedUserId !== undefined || mode.requirePrincipal === true))) {
        phase = "protocol";
        const principal = response.headers.get("Daynight-User-ID");
        if (principal === null || canonicalId(principal) === null || mode.kind === "json" && mode.requirePrincipal === true && canonicalId(principal) !== principal) throw new ProtocolError("The authenticated response principal does not match the expected user.");
        principalId = canonicalId(principal)!;
        if (expectedUserId !== undefined && principalId !== expectedUserId) {
          if ((secret !== undefined || mode.kind === "json" && mode.allowIdentityMismatchRefusal === true) && !success && status === 409) invitationIdentityMismatch = true;
          else throw new ProtocolError("The authenticated response principal does not match the expected user.");
        }
        if (mode.kind === "json") {
          try { mode.onPrincipal?.(principalId); }
          catch (error) {
            if (error instanceof ProtocolError && (secret !== undefined || mode.allowIdentityMismatchRefusal === true) && !success && status === 409) invitationIdentityMismatch = true;
            else throw error;
          }
        }
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
          if (bytes > Math.min(operation.limits.responseBytes, mode.kind === "json" && mode.responseBytes !== undefined ? mode.responseBytes : Infinity)) throw new OperationError("response_limit");
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
      const responseContext: JsonResponseMetadata = { status, success, principalHeader: response.headers.get("Daynight-User-ID"), locationHeader: response.headers.get("Location"), ...(principalId === undefined ? {} : { principalId }) };
      const source = chunks.join("");
      if (invitationIdentityMismatch) jsonObjectSources(source);
      const value = mode.kind === "json" && mode.decodeJsonSource !== undefined ? mode.decodeJsonSource(source, responseContext) : parseApiJson(source);
      checkRequest();
      if (!success) {
        if (status < 400 || status > 599) throw new ProtocolError("Unexpected HTTP status.");
        serverError = parseServerError(value);
        if (invitationIdentityMismatch && serverError.code !== "identity_mismatch") { serverError = undefined; throw new ProtocolError("The authenticated response principal changed during the operation."); }
        if (secret !== undefined) {
          const safeCodes = ["unauthenticated", "forbidden", "invalid_input", "identity_mismatch", "invitation_unavailable", "write_outcome_unknown", "internal_error"];
          serverError = { code: safeCodes.includes(serverError.code) ? serverError.code : "server_error", message: "Invitation request failed.", requestId: canonicalId(serverError.requestId) === serverError.requestId ? serverError.requestId : "unavailable" };
        }
        const confirmedRefusal = status >= 400 && status < 500 || mode.kind === "json" && mode.confirmedFailure?.(status, serverError) === true;
        throw new ApiError(context, "response", { cause: new Error(serverError.message), status, serverError, confirmedRefusal, outcomeUnconfirmed: mutation && !confirmedRefusal, ...(responseRequestId === undefined ? {} : { responseRequestId }) });
      }
      if (mode.kind !== "json") throw new ProtocolError("Unexpected response mode.");
      if (secret !== undefined) {
        const containsSecret = (item: unknown): boolean => typeof item === "string" ? item.includes(secret) : Array.isArray(item) ? item.some(containsSecret) : typeof item === "object" && item !== null ? Object.entries(item).some(([key, child]) => key.includes(secret) || containsSecret(child)) : false;
        if (containsSecret(value)) throw new ProtocolError("Invitation response contains sensitive data.");
      }
      const result = mode.parse(value, responseContext);
      if (mode.confirmMutation !== undefined) confirmedMutationId = mode.confirmMutation(result);
      else checkRequest();
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
      terminalFailure = secret === undefined && cause instanceof ApiError && failure === cause ? cause : new ApiError(context, cause instanceof ApiError ? cause.phase : phase, {
        cause: secret === undefined ? failure : safeInvitationCause(failure),
        ...(status === undefined ? {} : { status }),
        ...(serverError === undefined ? {} : { serverError }),
        ...(responseRequestId === undefined ? {} : { responseRequestId }),
        confirmedRefusal: cause instanceof ApiError && cause.confirmedRefusal,
        outcomeUnconfirmed: cause instanceof ApiError ? cause.outcomeUnconfirmed : mutation && dispatched,
        ...(confirmedMutationId === undefined ? {} : { confirmedMutationId, outcomeUnconfirmed: false }),
      });
      throw terminalFailure;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbort();
      removeOperationAbort();
      const releaseFailures: unknown[] = [];
      for (const stream of [reader, uploadReader]) {
        try { stream?.releaseLock(); } catch (cause) { releaseFailures.push(cause); }
      }
      if (releaseFailures.length !== 0) {
        const cause = secret === undefined ? new AggregateError(terminalFailure === undefined ? releaseFailures : [terminalFailure, ...releaseFailures], "HTTP request completion and stream release failed.", terminalFailure === undefined ? undefined : { cause: terminalFailure }) : new AggregateError([...(terminalFailure === undefined ? [] : [terminalFailure]), ...releaseFailures].map((failure) => safeInvitationCause(failure)), "Invitation request stream release failed.");
        throw new ApiError(context, terminalFailure?.phase ?? phase, {
          cause,
          ...(status === undefined ? {} : { status }),
          ...(serverError === undefined ? {} : { serverError }),
          ...(responseRequestId === undefined ? {} : { responseRequestId }),
          confirmedRefusal: terminalFailure?.confirmedRefusal === true,
          outcomeUnconfirmed: terminalFailure === undefined ? confirmedMutationId === undefined && mutation && dispatched : terminalFailure.outcomeUnconfirmed,
          ...(confirmedMutationId === undefined ? {} : { confirmedMutationId, outcomeUnconfirmed: false }),
        });
      }
    }
  };

  const request = <T>(context: Context, path: string, method: "GET" | "POST" | "PATCH", parse: JsonParser<T>, body?: unknown): Promise<T> => exchange(context, path, method, { kind: "json", parse }, [method === "POST" ? 201 : 200], body === undefined ? undefined : { kind: "json", value: body });

  const list = async <T>(context: Context, path: string, parse: JsonParser<Page<T>>, identity: (item: T) => string, filters: Record<string, string> = {}, mutable = false, principal?: string): Promise<readonly T[]> => {
    const result: T[] = [];
    const seenIdentities = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    try {
      do {
        operation.check();
        const query = new URLSearchParams({ ...filters, limit: "100", ...(cursor === null ? {} : { cursor }) });
        const page = await exchange(context, `${path}?${query}`, "GET", { kind: "json", parse, ...(principal === undefined ? {} : { requirePrincipal: true, checkPrincipalOnError: true, onPrincipal: (actual: string) => { if (actual !== principal) throw new ProtocolError("The authenticated response principal changed during the operation."); } }) }, [200], undefined, mutable);
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

  const taskAssignmentFilter = (value: string | undefined): string | undefined => {
    if (value === undefined || value === "me" || value === "unassigned") return value;
    if (typeof value !== "string") throw new Error("Assigned-to filter must be a hyphenated UUID, me or unassigned.");
    const parsed = canonicalId(value);
    if (parsed === null) throw new Error("Assigned-to filter must be a hyphenated UUID, me or unassigned.");
    return parsed;
  };
  const taskAssignmentInput = (value: string | null | undefined): string | null | undefined => value === undefined || value === null ? value : resourceId(value);
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
    const assignedTo = taskAssignmentFilter(filters.assignedTo);
    return { ...(assignedTo === undefined ? {} : { assignedTo }), ...(filters.status === undefined ? {} : { status: filters.status }), ...(filters.ready === undefined ? {} : { ready: String(filters.ready) }), ...(filters.allowAgents === undefined ? {} : { allowAgents: String(filters.allowAgents) }), ...(filters.compatiblePlatform === undefined ? {} : { compatiblePlatform: filters.compatiblePlatform }), ...(workerId === undefined ? {} : { workerId }) };
  };
  const filteredTask = (value: unknown, project: string, filters: TaskFilters, expectedAssignment: string | null | undefined): Task => {
    const task = parseTask(value, project);
    const worker = readWorkerClaim(task.properties);
    if (
      (expectedAssignment !== undefined && task.assignedTo !== expectedAssignment)
      || (filters.status !== undefined && task.status !== filters.status)
      || (filters.ready !== undefined && task.ready !== filters.ready)
      || (filters.allowAgents !== undefined && task.allowAgents !== filters.allowAgents)
      || (filters.compatiblePlatform !== undefined && task.requiredPlatform !== null && task.requiredPlatform !== filters.compatiblePlatform)
      || (filters.workerId !== undefined && (worker === undefined || worker.state !== "active" || worker.workerId !== canonicalId(filters.workerId)))
    ) throw new ProtocolError("Task does not match the requested filters.");
    return task;
  };
  const taskPageParser = (project: string, filters: TaskFilters): JsonParser<Page<Task>> => {
    const selected = taskAssignmentFilter(filters.assignedTo);
    let boundPrincipal: string | undefined;
    return (value, metadata) => {
      let expectedAssignment: string | null | undefined = selected === "unassigned" ? null : selected;
      if (selected === "me") {
        const principal = metadata.principalHeader === null ? null : canonicalId(metadata.principalHeader);
        if (principal === null || principal !== metadata.principalHeader || boundPrincipal !== undefined && boundPrincipal !== principal) throw new ProtocolError("The authenticated response principal is invalid or changed during pagination.");
        boundPrincipal = principal;
        expectedAssignment = principal;
      }
      return parsePage(value, (item) => filteredTask(item, project, filters, expectedAssignment), (task) => task.id);
    };
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

  const updateStep = async (action: "update" | "set-status", projectId: string, taskId: string, stepId: string, input: UpdateTaskStepInput | SetTaskStepStatusInput, options: TaskStepWriteOptions): Promise<StepsResource> => {
    const context: Context = { operation: `task.step.${action}`, sentRequestId: options.requestId };
    try {
      const project = resourceId(projectId), task = resourceId(taskId), step = canonicalStepId(stepId);
      if (step === null) throw new Error("Step ID must contain exactly eight hexadecimal characters.");
      const target = { ...context, projectId: project, taskId: task, stepId: step };
      try {
        taskVersion(input.version);
        let normalized: UpdateTaskStepInput | SetTaskStepStatusInput;
        if (action === "update") {
          const fields = input as UpdateTaskStepInput;
          if (fields.title === undefined && fields.description === undefined) throw new Error("Provide at least one Step title or description.");
          if (fields.title !== undefined && !isNonemptyText(fields.title)) throw new Error("Step title must be nonempty Unicode text without NUL.");
          if (fields.description !== undefined && !isText(fields.description)) throw new Error("Step description must be Unicode text without NUL.");
          normalized = { version: fields.version, ...(fields.title === undefined ? {} : { title: fields.title }), ...(fields.description === undefined ? {} : { description: fields.description }) };
        } else {
          const fields = input as SetTaskStepStatusInput;
          if (!["todo", "in_progress", "done", "skipped"].includes(fields.status)) throw new Error("Step status must be todo, in_progress, done or skipped.");
          normalized = { version: fields.version, status: fields.status };
        }
        const previous = options.previous === undefined ? undefined : parseStepsResource(options.previous, project, task);
        if (previous !== undefined && previous.version !== input.version) throw new Error("Previous Steps resource does not match the submitted version.");
        const pathname = resourcePath("projects", project, "tasks", task, "steps", step) + (action === "set-status" ? "/status" : "");
        return await exchange(target, pathname, action === "update" ? "PATCH" : "PUT", {
          kind: "json", requirePrincipal: true, onPrincipal: bindStepsPrincipal, responseBytes: TASK_STEPS_RESPONSE_BYTES, decodeJsonSource: decodeStepsJsonSource,
          parse: (value) => parseStepsResource(value, project, task),
          confirmMutation: (result) => confirmUpdatedTaskStep(result, step, normalized, previous),
        }, [200], { kind: "json", value: normalized, maxBytes: 1_048_576 }, true);
      } catch (cause) {
        if (cause instanceof ApiError) throw cause;
        throw new ApiError(target, "prepare", { cause });
      }
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      throw new ApiError(context, "prepare", { cause });
    }
  };

  const accountPrincipal = (): ((metadata: JsonResponseMetadata) => string) => {
    let bound: string | undefined = expectedUserId;
    return (metadata) => {
      const principal = metadata.principalHeader === null ? null : canonicalId(metadata.principalHeader);
      if (principal === null || principal !== metadata.principalHeader || bound !== undefined && bound !== principal) throw new ProtocolError("The authenticated account response principal is invalid or changed.");
      bound = principal;
      return principal;
    };
  };

  return {
    listBots: () => {
      const principal = accountPrincipal();
      return list({ operation: "bot.list" }, "/me/bots", (value, metadata) => {
        const owner = principal(metadata);
        return parsePage(value, (item) => { const bot = parseBot(item, undefined, owner); if (bot.deletion !== null) throw new ProtocolError("Deleted Bot appeared in the ordinary list."); return bot; }, (bot) => bot.id);
      }, (bot) => bot.id);
    },
    getBot: (botId) => {
      const target = resourceId(botId), principal = accountPrincipal();
      return exchange({ operation: "bot.show" }, `/me/bots/${target}`, "GET", { kind: "json", requirePrincipal: true, parse: (value, metadata) => parseBot(value, target, principal(metadata)) }, [200]);
    },
    createBot: (input) => {
      const target = resourceId(input.id), principal = accountPrincipal();
      const name = botName(input.name);
      return exchange({ operation: "bot.create" }, "/me/bots", "POST", { kind: "json", requirePrincipal: true, parse: (value, metadata) => {
        const bot = parseBot(value, target, principal(metadata));
        if (input.overrides?.workerId !== undefined && bot.workerId !== input.overrides.workerId) throw new ProtocolError("Bot creation response does not match the submitted Worker.");
        if (bot.deletion === null && (bot.name !== name || ["workerId", "cwd", "provider"].some((key) => {
          const field = key as keyof NonNullable<CreateBotInput["overrides"]>;
          return bot.requestedOverrides[field] !== input.overrides?.[field];
        }))) throw new ProtocolError("Bot creation response does not match the submitted request.");
        return bot;
      }, confirmMutation: (bot) => bot.id }, [200], { kind: "json", value: { ...input, id: target, name } });
    },
    deleteBot: (botId, input) => {
      const target = resourceId(botId), principal = accountPrincipal();
      const body = { ifVersion: botVersion(input.ifVersion), deletionId: resourceId(input.deletionId) };
      return exchange({ operation: "bot.delete" }, `/me/bots/${target}`, "DELETE", { kind: "json", requirePrincipal: true, parse: (value, metadata) => {
        const bot = parseBot(value, target, principal(metadata));
        if (bot.deletion === null || bot.deletion.deletionId !== body.deletionId || bot.deletion.requestedVersion !== body.ifVersion) throw new ProtocolError("Bot deletion response does not match the submitted request.");
        return bot;
      }, confirmMutation: (bot) => bot.id }, [200], { kind: "json", value: body });
    },
    listWorkers: async () => {
      const principal = accountPrincipal();
      let observedAt: string | undefined;
      const items = await list<WorkerSummary>({ operation: "worker.list" }, "/me/workers", (value, metadata) => {
        principal(metadata);
        const page = parseWorkerPage(value);
        observedAt = page.observedAt;
        return page;
      }, (worker) => worker.workerId);
      return { observedAt: observedAt!, items };
    },
    getWorker: (workerId) => {
      const target = resourceId(workerId), principal = accountPrincipal();
      return exchange({ operation: "worker.show" }, `/me/workers/${target}`, "GET", { kind: "json", requirePrincipal: true, parse: (value, metadata) => { principal(metadata); return parseWorkerDetail(value, target); } }, [200]);
    },
    listTaskSteps: (projectId, taskId, options) => {
      const project = resourceId(projectId), task = resourceId(taskId);
      return exchange({ operation: "task.step.list", projectId: project, taskId: task, ...(options === undefined ? {} : { sentRequestId: options.requestId }) }, resourcePath("projects", project, "tasks", task, "steps"), "GET", {
        kind: "json", requirePrincipal: true, onPrincipal: bindStepsPrincipal, responseBytes: TASK_STEPS_RESPONSE_BYTES, decodeJsonSource: decodeStepsJsonSource,
        parse: (value) => parseStepsResource(value, project, task),
      }, [200], undefined, true);
    },
    getTaskStep: (projectId, taskId, stepId) => {
      const project = resourceId(projectId), task = resourceId(taskId), step = canonicalStepId(stepId);
      if (step === null) throw new Error("Step ID must contain exactly eight hexadecimal characters.");
      return exchange({ operation: "task.step.show", projectId: project, taskId: task, stepId: step }, resourcePath("projects", project, "tasks", task, "steps", step), "GET", {
        kind: "json", requirePrincipal: true, onPrincipal: bindStepsPrincipal, responseBytes: TASK_STEPS_RESPONSE_BYTES, decodeJsonSource: decodeStepsJsonSource,
        parse: (value) => parseStepResource(value, project, task, step),
      }, [200], undefined, true);
    },
    addTaskStep: async (projectId, taskId, input, options) => {
      const context: Context = { operation: "task.step.add", sentRequestId: options.requestId };
      try {
        const project = resourceId(projectId), task = resourceId(taskId), step = canonicalStepId(input.id);
        if (step === null) throw new Error("Step ID must contain exactly eight hexadecimal characters.");
        const target = { ...context, projectId: project, taskId: task, stepId: step };
        try {
          taskVersion(input.version);
          if (!isNonemptyText(input.title)) throw new Error("Step title must be nonempty Unicode text without NUL.");
          if (input.description !== undefined && !isText(input.description)) throw new Error("Step description must be Unicode text without NUL.");
          if (input.status !== undefined && !["todo", "in_progress", "done", "skipped"].includes(input.status)) throw new Error("Step status must be todo, in_progress, done or skipped.");
          if (input.before !== undefined && input.after !== undefined) throw new Error("before and after are mutually exclusive.");
          const anchor = (value: string): string => { const id = canonicalStepId(value); if (id === null) throw new Error("Step anchor must contain exactly eight hexadecimal characters."); return id; };
          const normalized: AddTaskStepInput = { version: input.version, id: step, title: input.title,
            ...(input.description === undefined ? {} : { description: input.description }), ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.before === undefined ? {} : { before: anchor(input.before) }), ...(input.after === undefined ? {} : { after: anchor(input.after) }) };
          const previous = options.previous === undefined ? undefined : parseStepsResource(options.previous, project, task);
          if (previous !== undefined && previous.version !== input.version) throw new Error("Previous Steps resource does not match the submitted version.");
          const pathname = resourcePath("projects", project, "tasks", task, "steps");
          return await exchange(target, pathname, "POST", {
            kind: "json", requirePrincipal: true, onPrincipal: bindStepsPrincipal, responseBytes: TASK_STEPS_RESPONSE_BYTES, decodeJsonSource: decodeStepsJsonSource,
            parse: (value, response) => {
              if (response.locationHeader !== `/api/v1${pathname}/${step}`) throw new ProtocolError("Step Location does not match the submitted identity.");
              return parseStepsResource(value, project, task);
            },
            confirmMutation: (result) => confirmAddedTaskStep(result, normalized, previous),
          }, [201], { kind: "json", value: normalized, maxBytes: 1_048_576 }, true);
        } catch (cause) {
          if (cause instanceof ApiError) throw cause;
          throw new ApiError(target, "prepare", { cause });
        }
      } catch (cause) {
        if (cause instanceof ApiError) throw cause;
        throw new ApiError(context, "prepare", { cause });
      }
    },
    updateTaskStep: (projectId, taskId, stepId, input, options) => updateStep("update", projectId, taskId, stepId, input, options),
    setTaskStepStatus: (projectId, taskId, stepId, input, options) => updateStep("set-status", projectId, taskId, stepId, input, options),
    moveTaskStep: async (projectId, taskId, stepId, input, options) => {
      const context: Context = { operation: "task.step.move", sentRequestId: options.requestId };
      try {
        const project = resourceId(projectId), task = resourceId(taskId), step = canonicalStepId(stepId);
        if (step === null) throw new Error("Step ID must contain exactly eight hexadecimal characters.");
        const target = { ...context, projectId: project, taskId: task, stepId: step };
        try {
          taskVersion(input.version);
          if ([input.before, input.after, input.position].filter((value) => value !== undefined).length !== 1) throw new Error("Exactly one Step position is required.");
          if (input.position !== undefined && input.position !== "first" && input.position !== "last") throw new Error("Step position must be first or last.");
          const anchor = (value: string): string => {
            const id = canonicalStepId(value);
            if (id === null || id === step) throw new Error("Step anchor must be another eight-hex Step ID.");
            return id;
          };
          const normalized: MoveTaskStepInput = { version: input.version,
            ...(input.before === undefined ? {} : { before: anchor(input.before) }),
            ...(input.after === undefined ? {} : { after: anchor(input.after) }),
            ...(input.position === undefined ? {} : { position: input.position }) };
          const previous = options.previous === undefined ? undefined : parseStepsResource(options.previous, project, task);
          if (previous !== undefined && previous.version !== input.version) throw new Error("Previous Steps resource does not match the submitted version.");
          return await exchange(target, resourcePath("projects", project, "tasks", task, "steps", step, "position"), "PUT", {
            kind: "json", requirePrincipal: true, onPrincipal: bindStepsPrincipal, responseBytes: TASK_STEPS_RESPONSE_BYTES, decodeJsonSource: decodeStepsJsonSource,
            parse: (value) => parseStepsResource(value, project, task),
            confirmMutation: (result) => confirmMovedTaskStep(result, step, normalized, previous),
          }, [200], { kind: "json", value: normalized, maxBytes: 1_048_576 }, true);
        } catch (cause) {
          if (cause instanceof ApiError) throw cause;
          throw new ApiError(target, "prepare", { cause });
        }
      } catch (cause) {
        if (cause instanceof ApiError) throw cause;
        throw new ApiError(context, "prepare", { cause });
      }
    },
    deleteTaskStep: async (projectId, taskId, stepId, input, options) => {
      const context: Context = { operation: "task.step.delete", sentRequestId: options.requestId };
      try {
        const project = resourceId(projectId), task = resourceId(taskId), step = canonicalStepId(stepId);
        if (step === null) throw new Error("Step ID must contain exactly eight hexadecimal characters.");
        const target = { ...context, projectId: project, taskId: task, stepId: step };
        try {
          taskVersion(input.version);
          const normalized: DeleteTaskStepInput = { version: input.version };
          const previous = options.previous === undefined ? undefined : parseStepsResource(options.previous, project, task);
          if (previous !== undefined && previous.version !== input.version) throw new Error("Previous Steps resource does not match the submitted version.");
          return await exchange(target, resourcePath("projects", project, "tasks", task, "steps", step), "DELETE", {
            kind: "json", requirePrincipal: true, onPrincipal: bindStepsPrincipal, responseBytes: TASK_STEPS_RESPONSE_BYTES, decodeJsonSource: decodeStepsJsonSource,
            parse: (value) => parseStepsResource(value, project, task),
            confirmMutation: (result) => confirmDeletedTaskStep(result, step, normalized, previous),
          }, [200], { kind: "json", value: normalized, maxBytes: 1_048_576 }, true);
        } catch (cause) {
          if (cause instanceof ApiError) throw cause;
          throw new ApiError(target, "prepare", { cause });
        }
      } catch (cause) {
        if (cause instanceof ApiError) throw cause;
        throw new ApiError(context, "prepare", { cause });
      }
    },
    readTaskThread: (projectId, taskId, query) => {
      const project = resourceId(projectId), task = resourceId(taskId);
      if (!Number.isInteger(query.count) || query.count < 1 || query.count > 100 || typeof query.details !== "boolean" || query.beforeId !== undefined && query.afterId !== undefined) throw new Error("Invalid Thread page query.");
      const normalized = { count: query.count, details: query.details, ...(query.beforeId === undefined ? {} : { beforeId: resourceId(query.beforeId) }), ...(query.afterId === undefined ? {} : { afterId: resourceId(query.afterId) }) };
      const params = new URLSearchParams({ count: String(normalized.count), details: String(normalized.details), ...(normalized.beforeId === undefined ? {} : { beforeId: normalized.beforeId }), ...(normalized.afterId === undefined ? {} : { afterId: normalized.afterId }) });
      return exchange({ operation: "task.thread.read", projectId: project, taskId: task }, `${resourcePath("projects", project, "tasks", task, "thread", "messages")}?${params}`, "GET", {
        kind: "json", requirePrincipal: true, responseBytes: THREAD_PAGE_BYTES,
        decodeJsonSource: (source, response) => decodeThreadJsonSource(source, response.success ? "page" : "error"),
        parse: (value) => parseThreadPage(value, normalized),
      }, [200], undefined, true);
    },
    postTaskThreadMessage: (projectId, taskId, input) => {
      const project = resourceId(projectId), task = resourceId(taskId);
      if (!isNonemptyText(input.body) || Buffer.byteLength(input.body, "utf8") > THREAD_MESSAGE_BYTES) throw new Error("Thread body must be nonempty text of at most 65536 UTF-8 bytes.");
      const normalized = { body: input.body, ...(input.replyTo === undefined ? {} : { replyTo: resourceId(input.replyTo) }), ...(input.claimId === undefined ? {} : { claimId: resourceId(input.claimId) }) };
      return exchange({ operation: "task.thread.post", projectId: project, taskId: task }, resourcePath("projects", project, "tasks", task, "thread", "messages"), "POST", {
        kind: "json", requirePrincipal: true, responseBytes: THREAD_MESSAGE_BYTES,
        decodeJsonSource: (source, response) => decodeThreadJsonSource(source, response.success ? "message" : "error"),
        parse: (value, response) => {
          const message = parseThreadMessage(value, false);
          if (message.author.userId !== response.principalId || message.body !== normalized.body || message.replyTo !== normalized.replyTo || message.author.Agent !== (normalized.claimId !== undefined)) throw new ProtocolError("Thread message does not match the submitted content or authenticated author.");
          return message;
        },
        confirmedFailure: (status, error) => status === 503 && error.code === "clock_not_advanced",
        confirmMutation: (message) => message.id,
      }, [201], { kind: "json", value: normalized }, true);
    },
    getCurrentUser: (requirePrincipal = false) => exchange({ operation: "auth.me" }, "/me", "GET", { kind: "json", requirePrincipal, parse: (value, metadata) => {
      const user = parseUser(value);
      if (requirePrincipal && user.id !== metadata.principalId) throw new ProtocolError("The authenticated response principal does not match the current user.");
      return user;
    } }, [200], undefined, true),
    getTeamCurrentUser: () => exchange({ operation: "auth.me" }, "/me", "GET", { kind: "json", requirePrincipal: true, parse: (value, response) => {
      const user = parseUser(value);
      if (user.id !== response.principalId) throw new ProtocolError("The authenticated response principal does not match the user.");
      return user;
    } }, [200], undefined, true),
    inspectInvitation: (scope, token, userId) => {
      const user = resourceId(userId);
      validateInvitationToken(scope, token);
      const path = scope === "team" ? "/team-invitations/inspect" : "/invitations/inspect";
      return exchange({ operation: "invitation.inspect" }, path, "POST", {
        kind: "json", secret: token, readOnly: true, requirePrincipal: true, checkFailurePrincipal: true, checkPrincipalOnError: true,
        onPrincipal: (actual) => { if (actual !== user) throw new ProtocolError("The authenticated response principal changed during the operation."); },
        parse: (value) => scope === "team" ? parseTeamInvitationInspection(value, user) : parseProjectInvitationInspection(value, user),
      }, [200], { kind: "json", value: { token } }, true);
    },
    acceptInvitation: (scope, token, userId, targetId, requestId) => {
      const user = resourceId(userId), target = resourceId(targetId);
      validateInvitationToken(scope, token);
      if (canonicalId(requestId) !== requestId) throw new Error("Invitation request ID must be a canonical UUID.");
      const path = scope === "team" ? "/team-invitations/accept" : "/invitations/accept";
      return exchange({ operation: "invitation.accept", sentRequestId: requestId }, path, "POST", {
        kind: "json", secret: token, requirePrincipal: true, checkFailurePrincipal: true, checkPrincipalOnError: true,
        onPrincipal: (actual) => { if (actual !== user) throw new ProtocolError("The authenticated response principal changed during the operation."); },
        parse: (value) => scope === "team" ? parseTeamInvitationAcceptance(value, user, target) : parseProjectInvitationAcceptance(value, user, target),
        confirmMutation: () => target,
      }, [200], { kind: "json", value: { token, expectedUserId: user } }, true);
    },
    listTeams: (userId) => {
      const user = resourceId(userId);
      return list({ operation: "team.list" }, "/teams", (value) => parsePage(value, (item) => parseTeam(item, user), (team) => team.id), (team) => team.id, {}, true, user);
    },
    getTeam: (userId, teamId) => {
      const user = resourceId(userId), team = resourceId(teamId);
      return exchange({ operation: "team.show" }, `/teams/${encodeURIComponent(team)}`, "GET", { kind: "json", requirePrincipal: true, checkPrincipalOnError: true, onPrincipal: (actual) => { if (actual !== user) throw new ProtocolError("The authenticated response principal changed during the operation."); }, parse: (value) => parseTeam(value, user, team) }, [200], undefined, true);
    },
    createTeam: (userId, name, requestId) => {
      const user = resourceId(userId);
      if (!isNonemptyText(name)) throw new Error("Team name must be nonempty Unicode text without NUL.");
      return exchange({ operation: "team.create", sentRequestId: requestId }, "/teams", "POST", {
        kind: "json", requirePrincipal: true, checkPrincipalOnError: true,
        onPrincipal: (actual) => { if (actual !== user) throw new ProtocolError("The authenticated response principal changed during the operation."); },
        parse: (value, response) => {
          const result = parseTeam(value, user);
          if (result.kind !== "ordinary" || result.name !== name || result.membership.role !== "admin" || response.locationHeader !== `/api/v1/teams/${result.id}`) throw new ProtocolError("Team creation receipt does not match the request.");
          return result;
        }, confirmMutation: (result) => result.id,
      }, [201], { kind: "json", value: { name, expectedUserId: user } }, true);
    },
    renameTeam: (userId, team, name, requestId) => {
      const user = resourceId(userId), target = resourceId(team.id);
      if (!isNonemptyText(name)) throw new Error("Team name must be nonempty Unicode text without NUL.");
      taskVersion(team.version);
      return exchange({ operation: "team.rename", sentRequestId: requestId }, `/teams/${encodeURIComponent(target)}`, "PATCH", {
        kind: "json", requirePrincipal: true, checkPrincipalOnError: true,
        onPrincipal: (actual) => { if (actual !== user) throw new ProtocolError("The authenticated response principal changed during the operation."); },
        parse: (value) => {
          const result = parseTeam(value, user, target);
          if (result.kind !== "ordinary" || result.name !== name || result.membership.role !== "admin" || result.version !== team.version + (team.name === name ? 0n : 1n)) throw new ProtocolError("Team rename receipt does not match the request.");
          return result;
        }, confirmMutation: (result) => result.id,
      }, [200], { kind: "json", value: { name, version: team.version, expectedUserId: user } }, true);
    },
    deleteTeam: (userId, team, requestId) => {
      const user = resourceId(userId), target = resourceId(team.id);
      if (team.name === null) throw new Error("Personal Team cannot be deleted.");
      taskVersion(team.version);
      return exchange({ operation: "team.delete", sentRequestId: requestId }, `/teams/${encodeURIComponent(target)}`, "DELETE", {
        kind: "json", requirePrincipal: true, checkPrincipalOnError: true,
        onPrincipal: (actual) => { if (actual !== user) throw new ProtocolError("The authenticated response principal changed during the operation."); },
        parse: (value) => parseTeamDeleteReceipt(value, target), confirmMutation: (result) => result.teamId,
      }, [200], { kind: "json", value: { name: team.name, version: team.version, expectedUserId: user } }, true);
    },
    listTeamInvitations: async (userId, teamId) => {
      const user = resourceId(userId), team = resourceId(teamId);
      const context = { operation: "team.invitation.list", sentRequestId: randomUUID() };
      try {
        return await exchange(context, `/teams/${encodeURIComponent(team)}/invitations`, "GET", {
          kind: "json", requirePrincipal: true, checkPrincipalOnError: true,
          onPrincipal: (actual) => { if (actual !== user) throw new ProtocolError("The authenticated response principal changed during the operation."); },
          parse: (value) => parseTeamInvitations(value, team),
        }, [200], undefined, true);
      } catch (error) { throw safeInvitationFailure(error, context); }
    },
    createTeamInvitation: async (userId, teamId, requestId) => {
      const user = resourceId(userId), team = resourceId(teamId);
      const context = { operation: "team.invitation.create", sentRequestId: requestId };
      try {
        return await exchange(context, `/teams/${encodeURIComponent(team)}/invitations`, "POST", {
          kind: "json", requirePrincipal: true, checkPrincipalOnError: true, allowIdentityMismatchRefusal: true,
          onPrincipal: (actual) => { if (actual !== user) throw new ProtocolError("The authenticated response principal changed during the operation."); },
          parse: (value, response) => {
            const result = parseCreatedTeamInvitation(value, team, user, origin.origin);
            if (response.locationHeader !== `/api/v1/teams/${team}/invitations/${result.id}`) throw new ProtocolError();
            return result;
          },
          confirmMutation: (result) => result.id,
        }, [201], { kind: "json", value: { expectedUserId: user } }, true);
      } catch (error) { throw safeInvitationFailure(error, context); }
    },
    revokeTeamInvitation: async (userId, teamId, invitationId, requestId) => {
      const user = resourceId(userId), team = resourceId(teamId), invitation = resourceId(invitationId);
      const context = { operation: "team.invitation.revoke", sentRequestId: requestId };
      try {
        return await exchange(context, `/teams/${encodeURIComponent(team)}/invitations/${encodeURIComponent(invitation)}`, "DELETE", {
          kind: "json", requirePrincipal: true, checkPrincipalOnError: true, allowIdentityMismatchRefusal: true,
          onPrincipal: (actual) => { if (actual !== user) throw new ProtocolError("The authenticated response principal changed during the operation."); },
          parse: (value) => parseTeamInvitationRevoke(value, team, invitation), confirmMutation: (result) => result.invitationId,
        }, [200], { kind: "json", value: { expectedUserId: user } }, true);
      } catch (error) { throw safeInvitationFailure(error, context); }
    },
    listTeamMembers: (userId, teamId) => {
      const user = resourceId(userId), team = resourceId(teamId);
      return exchange({ operation: "team.member.list" }, resourcePath("teams", team, "members"), "GET", {
        kind: "json", requirePrincipal: true, checkPrincipalOnError: true,
        onPrincipal: (actual) => { if (actual !== user) throw new ProtocolError("The authenticated response principal changed during the operation."); },
        parse: (value) => parseTeamMembers(value, team, user),
      }, [200], undefined, true);
    },
    setTeamMemberRole: (userId, member, role, requestId) => {
      const user = resourceId(userId), team = resourceId(member.teamId), target = resourceId(member.userId);
      const previous = { ...member, teamId: team, userId: target };
      if (role !== "member" && role !== "admin") throw new Error("Team role must be member or admin.");
      taskVersion(member.version);
      return exchange({ operation: "team.member.set-role", sentRequestId: requestId }, resourcePath("teams", team, "members", target), "PATCH", {
        kind: "json", requirePrincipal: true, checkPrincipalOnError: true,
        onPrincipal: (actual) => { if (actual !== user) throw new ProtocolError("The authenticated response principal changed during the operation."); },
        parse: (value) => parseTeamMemberRoleReceipt(value, user, previous, role), confirmMutation: (result) => result.membership.teamId,
      }, [200], { kind: "json", value: { version: member.version, role, expectedUserId: user } }, true);
    },
    removeTeamMember: (userId, member, requestId) => {
      const user = resourceId(userId), team = resourceId(member.teamId), target = resourceId(member.userId);
      const previous = { ...member, teamId: team, userId: target };
      taskVersion(member.version);
      return exchange({ operation: "team.member.remove", sentRequestId: requestId }, resourcePath("teams", team, "members", target), "DELETE", {
        kind: "json", requirePrincipal: true, checkPrincipalOnError: true,
        onPrincipal: (actual) => { if (actual !== user) throw new ProtocolError("The authenticated response principal changed during the operation."); },
        parse: (value) => parseRemoveTeamMemberReceipt(value, user, previous), confirmMutation: (result) => result.teamId,
      }, [200], { kind: "json", value: { version: member.version, expectedUserId: user } }, true);
    },
    listTeamProjects: (userId, teamId) => {
      const user = resourceId(userId), team = resourceId(teamId);
      return list({ operation: "team.projects" }, "/projects", (value) => parsePage(value, (item) => {
        const project = parseProject(item);
        if (project.ownership.teamId !== team) throw new ProtocolError("Project does not belong to the requested Team.");
        return project;
      }, (project) => project.id), (project) => project.id, { teamId: team }, true, user);
    },
    previewProjectTransfer: (userId, projectId, targetTeamId) => {
      const user = resourceId(userId), project = resourceId(projectId), target = resourceId(targetTeamId);
      return exchange({ operation: "project.transfer-preview", projectId: project }, `/projects/${encodeURIComponent(project)}/transfer-preview`, "POST", {
        kind: "json", readOnly: true, requirePrincipal: true, checkPrincipalOnError: true,
        onPrincipal: (actual) => { if (actual !== user) throw new ProtocolError("The authenticated response principal changed during the operation."); },
        parse: (value) => parseProjectTransferPreview(value, target),
      }, [200], { kind: "json", value: { targetTeamId: target } }, true);
    },
    transferProject: (userId, projectId, preview, requestId) => {
      const user = resourceId(userId), project = resourceId(projectId), target = resourceId(preview.targetTeam.id), source = resourceId(preview.ownership.teamId);
      taskVersion(preview.ownership.version); taskVersion(preview.targetTeam.version);
      if (preview.sourceTeam.id !== source) throw new Error("Transfer preview has inconsistent source ownership.");
      return exchange({ operation: "project.transfer", projectId: project, sentRequestId: requestId }, `/projects/${encodeURIComponent(project)}/transfer`, "POST", {
        kind: "json", requirePrincipal: true, checkPrincipalOnError: true,
        onPrincipal: (actual) => { if (actual !== user) throw new ProtocolError("The authenticated response principal changed during the operation."); },
        parse: (value) => parseProjectTransferReceipt(value, project, user, preview), confirmMutation: (result) => result.projectId,
      }, [200], { kind: "json", value: { ownership: { teamId: source, version: preview.ownership.version }, targetTeam: { id: target, version: preview.targetTeam.version }, expectedUserId: user } }, true);
    },
    reportWorker: (workerId, input) => {
      const worker = resourceId(workerId);
      return exchange({ operation: "worker.report" }, `/me/workers/${encodeURIComponent(worker)}/report`, "POST", { kind: "json", parse: parseWorkerReportReceipt }, [200], { kind: "json", value: input }, true);
    },
    createProject: (input, requestId) => {
      const expected = resourceId(input.expectedUserId);
      const teamId = input.teamId === undefined ? undefined : resourceId(input.teamId);
      return exchange({ operation: "project.create", ...(requestId === undefined ? {} : { sentRequestId: requestId }) }, "/projects", "POST", {
        kind: "json", requirePrincipal: true, checkFailurePrincipal: true,
        onPrincipal: (principal) => { if (principal !== expected) throw new ProtocolError("The authenticated response principal does not match the expected user."); },
        parse: (value) => {
          const project = parseCreatedProject(value, expected, teamId);
          if (project.name !== input.name || project.repoUrl !== input.repoUrl) throw new ProtocolError("Project creation receipt does not match the request.");
          return project;
        }, confirmMutation: (project) => project.id,
      }, [201], { kind: "json", value: { name: input.name, repoUrl: input.repoUrl, expectedUserId: expected, ...(teamId === undefined ? {} : { teamId }) } });
    },
    getProject: (projectId, userId) => {
      const project = resourceId(projectId);
      if (userId !== undefined) {
        const user = resourceId(userId);
        return exchange({ operation: "project.show", projectId: project }, `/projects/${encodeURIComponent(project)}`, "GET", {
          kind: "json", requirePrincipal: true, checkPrincipalOnError: true,
          onPrincipal: (actual) => { if (actual !== user) throw new ProtocolError("The authenticated response principal changed during the operation."); },
          parse: (value) => parseProject(value, project),
        }, [200], undefined, true);
      }
      return request({ operation: "project.show", projectId: project }, `/projects/${encodeURIComponent(project)}`, "GET", (value) => parseProject(value, project));
    },
    listProjects: (userId) => list({ operation: "project.list" }, "/projects", (value) => parsePage(value, (item) => parseProject(item), (project) => project.id), (project) => project.id, {}, userId !== undefined, userId === undefined ? undefined : resourceId(userId)),
    getProjectAccess: (projectId) => {
      const project = resourceId(projectId);
      return exchange({ operation: "project.access", projectId: project }, `/projects/${encodeURIComponent(project)}/access`, "GET", { kind: "json", parse: (value) => parseProjectAccess(value, project, expectedUserId) }, [200], undefined, true);
    },
    listProjectMembers: (projectId) => {
      const project = resourceId(projectId);
      return exchange({ operation: "project.members", projectId: project }, `/projects/${encodeURIComponent(project)}/members`, "GET", { kind: "json", parse: (value) => parseProjectParticipants(value, project, expectedUserId) }, [200], undefined, true);
    },
    createTask: (projectId, input) => {
      const project = resourceId(projectId);
      const assignedTo = taskAssignmentInput(input.assignedTo);
      return request({ operation: "task.create", projectId: project }, `/projects/${encodeURIComponent(project)}/tasks`, "POST", (value) => {
        const task = parseTask(value, project);
        if (task.assignedTo !== (assignedTo === undefined ? null : assignedTo)) throw new ProtocolError("Task does not confirm the requested assignment.");
        return task;
      }, {
        title: input.title,
        ...(assignedTo === undefined ? {} : { assignedTo }),
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
      return list({ operation: "task.list", projectId: project }, `/projects/${encodeURIComponent(project)}/tasks`, taskPageParser(project, filters), (task) => task.id, taskFilterQuery(filters));
    },
    listTaskPage: (projectId, query) => {
      const project = resourceId(projectId);
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new Error("Task page limit must be an integer from 1 to 100.");
      if (query.cursor !== undefined && (typeof query.cursor !== "string" || query.cursor === "")) throw new Error("Task page cursor must be a nonempty string.");
      const search = new URLSearchParams({ ...taskFilterQuery(query), limit: String(query.limit), ...(query.cursor === undefined ? {} : { cursor: query.cursor }) });
      const parse = taskPageParser(project, query);
      return request({ operation: "task.list-page", projectId: project }, `/projects/${encodeURIComponent(project)}/tasks?${search}`, "GET", (value, metadata) => {
        const page = parse(value, metadata);
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
      const assignedTo = taskAssignmentInput(input.assignedTo);
      return request({ operation: "task.update", projectId: project, taskId: task }, `/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(task)}`, "PATCH", (value) => {
        const result = parseTask(value, project, task);
        if (assignedTo !== undefined && result.assignedTo !== assignedTo) throw new ProtocolError("Task does not confirm the requested assignment.");
        return result;
      }, {
        version: input.version,
        ...(assignedTo === undefined ? {} : { assignedTo }),
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
    updateWorkerClaim: (projectId, taskId, input) => workerMutation(projectId, taskId, "worker.update", "/worker-claim", "PATCH", input, (task, worker) => worker !== undefined && task.status === "in_progress" && worker.state === "active" && worker.claimId === canonicalId(input.claimId) && (input.phase === undefined || worker.phase === input.phase) && (input.herdr === undefined || herdrMatches(worker.herdr, input.herdr)) && (input.nativeSessionId === undefined || worker.nativeSessionId === input.nativeSessionId) && (input.startupReport === undefined || sameStartupReport(readSessionStartupReport(task.properties), input.startupReport)), true),
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
      return list({ operation: "task.attachment.list", projectId: project, taskId: task }, attachmentPrefix(project, task), (value) => parsePage(value, parseTaskAttachment, (attachment) => attachment.path), (attachment) => attachment.path, {}, true);
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
