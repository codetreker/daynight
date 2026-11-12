import type { WorkerCloudReport, WorkerCloudReportReceipt, WorkerCloudResource, WorkerPromptSelector, WorkerPromptResults } from "../../api/worker-configuration.js";
import { readWorkerClaim } from "../../api/task-properties.js";
import { ApiError, createApiClient } from "../../api/client.js";
import type { ApiClient } from "../../api/client.js";
import { createOperation } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import { canonicalId, ProtocolError } from "../../api/parse.js";
import type { Page, Project, Task, TaskFilters, TaskPlatform, UpdateWorkerClaimInput, WorkerClaimDescriptor, ReleaseWorkerClaimInput, WorkerReport, WorkerReportReceipt } from "../../api/types.js";
import { normalizeServerUrl } from "../../config/server.js";
import { validateServerToken, validateTokenTransport } from "../../config/server-token.js";
import { repositoryIdentity } from "../../repository/identity.js";
import type { ProjectIdentity } from "./types.js";
import type { MonitoringRead, MonitoringReceipt } from "../../api/worker-monitoring.js";
import type { Observation } from "./monitoring/types.js";

export type WorkerInventory = {
  readonly tasks: readonly Task[];
  readonly coveredProjectIds: readonly string[];
  readonly unavailableProjectIds: readonly string[];
};

export const isUnavailableProject = (error: unknown): boolean =>
  error instanceof ApiError && error.phase === "response" && error.status === 404 && error.code === "not_found";

export type WorkerRemote = {
  readonly serverOrigin: string;
  currentUserId(signal: AbortSignal): Promise<string>;
  report(workerId: string, report: WorkerReport, operation: Operation): Promise<WorkerReportReceipt>;
  readMonitoring(workerId: string, operation: Operation, requestId: string): Promise<MonitoringRead>;
  writeMonitoring(workerId: string, expectedRevision: string | null, observation: Observation, operation: Operation, requestId: string): Promise<MonitoringReceipt>;
  configuration(workerId: string, signal: AbortSignal, operation?: Operation): Promise<WorkerCloudResource>;
  reportConfiguration(workerId: string, report: WorkerReport, configuration: WorkerCloudReport, operation: Operation, selectors?: readonly WorkerPromptSelector[]): Promise<WorkerCloudReportReceipt & { readonly prompts?: WorkerPromptResults }>;
  readTask(projectId: string, taskId: string, signal: AbortSignal): Promise<Task>;
  authorizeControl(projectId: string, originalUserId: string, signal: AbortSignal): Promise<void>;
  release(projectId: string, taskId: string, input: ReleaseWorkerClaimInput, signal: AbortSignal): Promise<Task>;
  project(projectId: string, signal: AbortSignal): Promise<Project>;
  resolveProject(repository: { readonly repoUrl: string; readonly projectId?: string }, signal: AbortSignal): Promise<Project>;
  ownInventory(projects: readonly ProjectIdentity[], workerId: string, signal: AbortSignal, onUnavailable?: (projectId: string) => void, onFailure?: (projectId: string, error: unknown) => void): Promise<WorkerInventory>;
  candidates(projectId: string, platform: TaskPlatform, signal: AbortSignal, platformSpecific?: boolean): AsyncGenerator<Task>;
  claim(candidate: Task, descriptor: WorkerClaimDescriptor, signal: AbortSignal): Promise<Task>;
  update(task: Task, input: Omit<UpdateWorkerClaimInput, "version" | "claimId">, signal: AbortSignal): Promise<Task>;
};

export const createWorkerRemote = (options: { readonly serverUrl: string; readonly serverToken?: string }): WorkerRemote => {
  const serverOrigin = normalizeServerUrl(options.serverUrl);
  const serverToken = options.serverToken === undefined ? undefined : validateServerToken(options.serverToken);
  if (serverToken !== undefined) validateTokenTransport(serverOrigin);
  let principal: string | null = null;
  const workerControlMode = { supported: false };
  const workerToolPaths = { supported: false };

  const query = async <T>(signal: AbortSignal, action: (api: ApiClient) => Promise<T>, expectedUserId?: string): Promise<T> => {
    const operation = createOperation({ signal });
    try {
      return await action(createApiClient({ workerControlMode, workerToolPaths, serverUrl: serverOrigin, ...(serverToken === undefined ? {} : { serverToken }), ...(expectedUserId === undefined ? {} : { expectedUserId }), operation }));
    } finally { operation.dispose(); }
  };
  const verifiedUserId = (): string => {
    if (principal === null) throw new Error("The worker must verify its authenticated user before accessing project ownership.");
    return principal;
  };
  const request = <T>(signal: AbortSignal, action: (api: ApiClient) => Promise<T>): Promise<T> => query(signal, action, verifiedUserId());

  const pages = async function* <T extends { readonly id: string }>(
    signal: AbortSignal,
    read: (api: ApiClient, cursor: string | undefined) => Promise<Page<T>>,
  ): AsyncGenerator<T> {
    const identities = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const page = await request(signal, (api) => read(api, cursor));
      for (const item of page.items) {
        if (identities.has(item.id)) throw new ProtocolError("Duplicate resource identity across worker list pages.");
        identities.add(item.id);
      }
      if (page.nextCursor !== null) {
        if (cursors.has(page.nextCursor)) throw new ProtocolError("Repeated worker pagination cursor.");
        cursors.add(page.nextCursor);
      }
      for (const item of page.items) { signal.throwIfAborted(); yield item; }
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    signal.throwIfAborted();
  };

  const taskPages = (projectId: string, filters: TaskFilters, signal: AbortSignal): AsyncGenerator<Task> =>
    pages(signal, (api, cursor) => api.listTaskPage(projectId, { ...filters, limit: 100, ...(cursor === undefined ? {} : { cursor }) }));

  return {
    serverOrigin,
    currentUserId: async (signal) => {
      signal.throwIfAborted();
      if (principal !== null) return principal;
      const user = await query(signal, (api) => api.getCurrentUser());
      if (principal !== null && principal !== user.id) throw new ProtocolError("The worker's authenticated user changed during identity verification.");
      principal = user.id;
      return principal;
    },
    report: (workerId, input, operation) => {
      operation.check();
      return createApiClient({ workerControlMode, workerToolPaths, serverUrl: serverOrigin, ...(serverToken === undefined ? {} : { serverToken }), expectedUserId: verifiedUserId(), operation }).reportWorker(workerId, input);
    },
    readMonitoring: (workerId, operation, requestId) => {
      operation.check();
      return createApiClient({ workerControlMode, workerToolPaths, serverUrl: serverOrigin, ...(serverToken === undefined ? {} : { serverToken }), expectedUserId: verifiedUserId(), operation }).readWorkerMonitoring(workerId, requestId);
    },
    writeMonitoring: (workerId, revision, observation, operation, requestId) => {
      operation.check();
      return createApiClient({ workerControlMode, workerToolPaths, serverUrl: serverOrigin, ...(serverToken === undefined ? {} : { serverToken }), expectedUserId: verifiedUserId(), operation }).writeWorkerMonitoring(workerId, revision, observation, requestId);
    },
    configuration: (workerId, signal, operation) => operation === undefined
      ? request(signal, api => api.getWorkerConfiguration(workerId))
      : createApiClient({ workerControlMode, workerToolPaths, serverUrl: serverOrigin, ...(serverToken === undefined ? {} : { serverToken }), expectedUserId: verifiedUserId(), operation }).getWorkerConfiguration(workerId),
    reportConfiguration: (workerId, input, configuration, operation, selectors) => {
      operation.check();
      return createApiClient({ workerControlMode, workerToolPaths, serverUrl: serverOrigin, ...(serverToken === undefined ? {} : { serverToken }), expectedUserId: verifiedUserId(), operation }).reportWorkerConfiguration(workerId, input, configuration, selectors);
    },
    readTask: (projectId, taskId, signal) => request(signal, (api) => api.getTask(projectId, taskId)),
    authorizeControl: async (projectId, originalUserId, signal) => {
      const access = await request(signal, (api) => api.getProjectAccess(projectId));
      if (verifiedUserId() !== originalUserId && access.effectiveRole !== "admin") throw new Error("Source management requires its original owner or a current project administrator.");
    },
    release: (projectId, taskId, input, signal) => request(signal, (api) => api.releaseWorkerClaim(projectId, taskId, input)),
    project: (projectId, signal) => request(signal, api => api.getProject(projectId)),
    resolveProject: async (repository, signal) => {
      const expected = repositoryIdentity(repository.repoUrl);
      let project: Project;
      if (repository.projectId !== undefined) {
        project = await request(signal, (api) => api.getProject(repository.projectId!));
      } else {
        // Project discovery is finite; its own API operation cannot become the daemon's lifetime budget.
        const projects = await request(signal, (api) => api.listProjects());
        const matches = projects.filter((value) => repositoryIdentity(value.repoUrl) === expected);
        if (matches.length === 0) throw new Error("Project does not exist for the configured worker repository.");
        if (matches.length !== 1) throw new Error(`Multiple projects match the configured worker repository (${matches.map(({ id }) => id).join(", ")}); configure projectId.`);
        project = await request(signal, (api) => api.getProject(matches[0]!.id));
      }
      if (repositoryIdentity(project.repoUrl) !== expected) throw new Error(`Project ${project.id} does not match the configured worker repository.`);
      signal.throwIfAborted();
      return project;
    },
    ownInventory: async (projects, workerId, signal, onUnavailable, onFailure) => {
      const owner = verifiedUserId();
      const selected = new Map<string, ProjectIdentity>();
      for (const project of projects) {
          const projectId = canonicalId(project.projectId);
        if (projectId === null) throw new Error("Worker project ID must be a hyphenated UUID.");
        selected.set(projectId, project);
      }
      const result: Task[] = [], coveredProjectIds: string[] = [], unavailableProjectIds: string[] = [];
      for (const projectId of selected.keys()) {
        const projectTasks: Task[] = [];
        try {
          for await (const task of taskPages(projectId, { workerId }, signal)) {
            if (readWorkerClaim(task.properties)?.userId !== owner) throw new ProtocolError("Worker inventory claim belongs to a different authenticated user.");
            projectTasks.push(task);
          }
        } catch (error) {
          if (!isUnavailableProject(error)) { try { onFailure?.(projectId, error); } catch { /* Observation does not replace the original error. */ } throw error; }
          onUnavailable?.(projectId);
          unavailableProjectIds.push(projectId);
          continue;
        }
        coveredProjectIds.push(projectId);
        result.push(...projectTasks);
      }
      signal.throwIfAborted();
      return { tasks: result, coveredProjectIds, unavailableProjectIds };
    },
    candidates: async function* (projectId, platform, signal, platformSpecific) {
      for await (const task of taskPages(projectId, { ready: true, allowAgents: true, automaticCandidate: true, compatiblePlatform: platform, assignedTo: "me", ...(platformSpecific === undefined ? {} : { platformSpecific }) }, signal)) {
        if (readWorkerClaim(task.properties)?.state === "active") throw new ProtocolError("Worker candidate has an active claim.");
        yield task;
      }
    },
    claim: async (candidate, descriptor, signal) => {
      const claimed = await request(signal, (api) => api.claimWorkerTask(candidate.projectId, candidate.id, { ...descriptor, version: candidate.version }));
      if (readWorkerClaim(claimed.properties)?.userId !== verifiedUserId()) throw new ApiError({ operation: "worker.claim", projectId: candidate.projectId, taskId: candidate.id }, "protocol", {
        cause: new ProtocolError("The granted worker claim belongs to a different authenticated user."), outcomeUnconfirmed: true,
      });
      return claimed;
    },
    update: (task, input, signal) => {
      const worker = readWorkerClaim(task.properties);
      if (worker === undefined || worker.state !== "active" || worker.userId !== verifiedUserId()) throw new Error("Worker summary update requires the original active claim and authenticated user.");
      return request(signal, (api) => api.updateWorkerClaim(task.projectId, task.id, { ...input, version: task.version, claimId: worker.claimId }));
    },
  };
};
