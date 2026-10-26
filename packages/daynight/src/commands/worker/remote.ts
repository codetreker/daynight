import { createApiClient } from "../../api/client.js";
import type { ApiClient } from "../../api/client.js";
import { createOperation } from "../../api/operation.js";
import { canonicalId, ProtocolError } from "../../api/parse.js";
import type { Page, Project, Task, TaskFilters, TaskPlatform, UpdateWorkerClaimInput, WorkerClaimDescriptor } from "../../api/types.js";
import { normalizeServerUrl } from "../../config/server.js";
import { validateServerToken, validateTokenTransport } from "../../config/server-token.js";
import { repositoryIdentity } from "../../repository/identity.js";
import type { ProjectIdentity } from "./types.js";

export type WorkerRemote = {
  readonly serverOrigin: string;
  resolveProject(repository: { readonly repoUrl: string; readonly projectId?: string }, signal: AbortSignal): Promise<Project>;
  ownInventory(projects: readonly ProjectIdentity[], workerId: string, signal: AbortSignal): Promise<readonly Task[]>;
  candidates(projectId: string, platform: TaskPlatform, signal: AbortSignal): AsyncGenerator<Task>;
  claim(candidate: Task, descriptor: WorkerClaimDescriptor, signal: AbortSignal): Promise<Task>;
  update(task: Task, input: Omit<UpdateWorkerClaimInput, "version" | "claimId">, signal: AbortSignal): Promise<Task>;
};

export const createWorkerRemote = (options: { readonly serverUrl: string; readonly serverToken?: string }): WorkerRemote => {
  const serverOrigin = normalizeServerUrl(options.serverUrl);
  const serverToken = options.serverToken === undefined ? undefined : validateServerToken(options.serverToken);
  if (serverToken !== undefined) validateTokenTransport(serverOrigin);

  const request = async <T>(signal: AbortSignal, action: (api: ApiClient) => Promise<T>): Promise<T> => {
    const operation = createOperation({ signal });
    try {
      return await action(createApiClient({ serverUrl: serverOrigin, ...(serverToken === undefined ? {} : { serverToken }), operation }));
    } finally { operation.dispose(); }
  };

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
    ownInventory: async (projects, workerId, signal) => {
      const selected = new Map<string, ProjectIdentity>();
      for (const project of projects) {
        if (normalizeServerUrl(project.serverOrigin) !== serverOrigin) throw new Error(`Worker project ${project.projectId} belongs to a different service origin.`);
        const projectId = canonicalId(project.projectId);
        if (projectId === null) throw new Error("Worker project ID must be a hyphenated UUID.");
        selected.set(projectId, project);
      }
      const result: Task[] = [];
      for (const projectId of selected.keys()) {
        for await (const task of taskPages(projectId, { workerId }, signal)) result.push(task);
      }
      signal.throwIfAborted();
      return result;
    },
    candidates: async function* (projectId, platform, signal) {
      for await (const task of taskPages(projectId, { ready: true, allowAgents: true, compatiblePlatform: platform }, signal)) {
        if (task.properties.worker?.state === "released") continue;
        if (task.properties.worker?.state === "active") throw new ProtocolError("Worker candidate has an active claim.");
        yield task;
      }
    },
    claim: (candidate, descriptor, signal) => request(signal, (api) => api.claimWorkerTask(candidate.projectId, candidate.id, { ...descriptor, version: candidate.version })),
    update: (task, input, signal) => {
      const worker = task.properties.worker;
      if (worker === null || worker.state !== "active") throw new Error("Worker summary update requires the original active claim.");
      return request(signal, (api) => api.updateWorkerClaim(task.projectId, task.id, { ...input, version: task.version, claimId: worker.claimId }));
    },
  };
};
