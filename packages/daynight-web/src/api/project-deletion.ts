import { ApiError, assertResponsePrincipal, json, request, requestId } from "./client";
import { parseServerError } from "./parse";
import { parseTeamRef } from "./team-parse";
import type { TeamRef } from "./auth-types";
import type { ExecutionPlatform, WorkerPhase } from "./types";
import { array, boolean, count, executionPlatform, id, malformed, nonemptyString, record, string, timestamp } from "./validation";

export type ProjectDeletionClaim = {
  readonly taskId: string;
  readonly title: string;
  readonly worker: {
    readonly machineName: string;
    readonly platform: ExecutionPlatform;
    readonly phase: WorkerPhase;
    readonly paused: boolean;
    readonly connectivity: "online" | "offline" | "unknown";
  };
};
export type ProjectDeletionPreview = {
  readonly observedAt: string;
  readonly project: { readonly id: string; readonly name: string; readonly repoUrl: string; readonly ownerTeam: TeamRef };
  readonly summary: { readonly taskCount: number; readonly unfinishedTaskCount: number; readonly attachmentCount: number };
  readonly activeClaims: readonly ProjectDeletionClaim[];
  readonly nextCursor: string | null;
};
export type ProjectDeletionReceipt = { readonly projectId: string; readonly deleted: true };

const exact = (data: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(data).some((key) => !keys.includes(key))) return malformed();
};
const parseClaim = (value: unknown): ProjectDeletionClaim => {
  const data = record(value), worker = record(data.worker);
  exact(data, ["taskId", "title", "worker"]);
  exact(worker, ["machineName", "platform", "phase", "paused", "connectivity"]);
  const phase = worker.phase;
  if (phase !== "preparing" && phase !== "executing" && phase !== "verifying" && phase !== "completing" && phase !== "waiting" && phase !== "paused") return malformed();
  const connectivity = worker.connectivity;
  if (connectivity !== "online" && connectivity !== "offline" && connectivity !== "unknown") return malformed();
  return { taskId: id(data.taskId), title: string(data.title), worker: { machineName: string(worker.machineName), platform: executionPlatform(worker.platform), phase, paused: boolean(worker.paused), connectivity } };
};
const parsePreview = (value: unknown, projectId: string): ProjectDeletionPreview => {
  const data = record(value), project = record(data.project), summary = record(data.summary);
  exact(data, ["observedAt", "project", "summary", "activeClaims", "nextCursor"]);
  exact(project, ["id", "name", "repoUrl", "ownerTeam"]);
  exact(summary, ["taskCount", "unfinishedTaskCount", "attachmentCount"]);
  const result: ProjectDeletionPreview = {
    observedAt: timestamp(data.observedAt),
    project: { id: id(project.id), name: string(project.name), repoUrl: string(project.repoUrl), ownerTeam: parseTeamRef(project.ownerTeam) },
    summary: { taskCount: count(summary.taskCount), unfinishedTaskCount: count(summary.unfinishedTaskCount), attachmentCount: count(summary.attachmentCount) },
    activeClaims: array(data.activeClaims, parseClaim), nextCursor: data.nextCursor === null ? null : nonemptyString(data.nextCursor),
  };
  if (result.project.id !== projectId || result.summary.unfinishedTaskCount > result.summary.taskCount || new Set(result.activeClaims.map((claim) => claim.taskId)).size !== result.activeClaims.length) return malformed();
  return result;
};

// Only this operation's correlated, validated error can prove a dispatched DELETE did not commit.
export class ProjectDeletionRefusal extends ApiError {}
export const isConfirmedProjectDeletionRefusal = (error: unknown): error is ProjectDeletionRefusal => error instanceof ProjectDeletionRefusal;

const refusal = async (response: Response, correlationId: string): Promise<ProjectDeletionRefusal | null> => {
  try {
    if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get("Content-Type") ?? "")) return null;
    const body: unknown = await response.clone().json();
    const parsed = parseServerError(body);
    if (parsed.requestId !== correlationId || response.headers.get("X-Request-ID") !== correlationId) return null;
    const known = response.status === 400 && parsed.code === "invalid_input" ||
      response.status === 401 && parsed.code === "unauthenticated" ||
      response.status === 403 && parsed.code === "forbidden" ||
      response.status === 404 && parsed.code === "not_found" ||
      response.status === 409 && parsed.code === "active_worker_claims";
    const notCommitted = response.status === 500 && parsed.code === "internal_error" && parsed.writeOutcome === "not_committed";
    return known || notCommitted ? new ProjectDeletionRefusal("server", response.status, parsed.code, parsed.requestId, undefined, undefined, undefined, parsed.writeOutcome) : null;
  } catch { return null; }
};

export const previewProjectDeletion = async (
  projectId: string, query: { readonly limit?: number; readonly cursor?: string }, userId: string, signal: AbortSignal, onMismatch: () => void,
): Promise<ProjectDeletionPreview> => {
  const project = requestId(projectId), user = requestId(userId), parameters = new URLSearchParams();
  if (query.limit !== undefined) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new ApiError("protocol");
    parameters.set("limit", String(query.limit));
  }
  if (query.cursor !== undefined) {
    if (query.cursor === "") throw new ApiError("protocol");
    parameters.set("cursor", query.cursor);
  }
  const response = await request(`/api/v1/projects/${project}/deletion-preview${parameters.size ? `?${parameters}` : ""}`, signal, { headers: { Accept: "application/json" } });
  assertResponsePrincipal(response, user, onMismatch);
  if (response.ok && response.status !== 200) throw new ApiError("protocol", response.status);
  return json(response, signal, (value) => parsePreview(value, project));
};

export const deleteProject = async (
  projectId: string, userId: string, signal: AbortSignal, onMismatch: () => void, onDispatch: () => void,
): Promise<ProjectDeletionReceipt> => {
  const project = requestId(projectId), user = requestId(userId);
  const correlationId = crypto.randomUUID();
  const response = await request(`/api/v1/projects/${project}`, signal, { method: "DELETE", headers: { Accept: "application/json", "X-Request-ID": correlationId } }, onDispatch);
  assertResponsePrincipal(response, user, onMismatch);
  if (!response.ok) {
    const confirmed = await refusal(response, correlationId);
    signal.throwIfAborted();
    if (confirmed !== null) throw confirmed;
    return json(response, signal, () => { throw new ApiError("protocol", response.status); });
  }
  if (response.status !== 200) throw new ApiError("protocol", response.status);
  return json(response, signal, (value) => {
    const data = record(value);
    exact(data, ["projectId", "deleted"]);
    if (id(data.projectId) !== project || data.deleted !== true) return malformed();
    return { projectId: project, deleted: true };
  });
};
