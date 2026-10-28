import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createApiClient } from "../../api/client.js";
import { createOperation } from "../../api/operation.js";
import type { OperationLimits } from "../../api/operation.js";
import { canonicalId } from "../../api/parse.js";
import type { Project, WorkerAgent } from "../../api/types.js";
import { verifyConfigurationUpdate } from "../../config/ownership.js";
import { parseConfigurationDocument } from "../../config/document.js";
import { updateConfigurationFile } from "../../config/files.js";
import { repositoryIdentity } from "../../repository/identity.js";
import { repositoryLocation, resolveRepositoryRoot } from "../../repository/location.js";
import { readWorkerConfigurationSnapshot, validateWorkerConfigurationSnapshotSource, validateWorkerConfigurationSource } from "./config.js";
import type { WorkerConfiguration, WorkerConfigurationSnapshot, WorkerRepositoryConfiguration } from "./config.js";
import type { WorkerPaths } from "./paths.js";

export type WorkerRepositorySnapshot = WorkerConfigurationSnapshot & {
  readonly registrationBaseline: readonly unknown[];
};

export type ChangeWorkerRepositoriesOptions = {
  readonly paths: WorkerPaths;
  readonly homeDirectory: string;
  readonly snapshot: WorkerRepositorySnapshot;
  readonly projects: readonly Project[];
  readonly addProjectIds?: readonly string[];
  readonly removeProjectIds?: readonly string[];
  readonly signal?: AbortSignal;
};

export type WorkerSetupOptions = {
  readonly paths: WorkerPaths;
  readonly homeDirectory: string;
  readonly snapshot: WorkerRepositorySnapshot;
  readonly projects: readonly Project[];
  readonly projectIds: readonly string[];
  readonly agent: WorkerAgent;
  readonly signal?: AbortSignal;
};

export type WorkerSetupPlan = {
  readonly configuration: WorkerConfiguration;
  readonly removedRepositories: readonly WorkerRepositoryConfiguration[];
  readonly resetRepositories: readonly WorkerRepositoryConfiguration[];
  readonly resetGlobalNativeSettings: boolean;
};

const workerRepositoryOwnership = {
  section: "worker", fields: ["repositories"],
  retainedSequence: { field: "repositories", identity: "remote", fields: ["projectId"] },
} as const;

const workerSetupOwnership = {
  section: "worker", fields: ["agent", "model", "args", "repositories"],
  retainedSequence: { field: "repositories", identity: "remote", fields: ["projectId", "agent", "model", "args"] },
} as const;

const registrationBaseline = (mapping: Record<string, unknown>): readonly unknown[] => {
  const worker = mapping.worker as Record<string, unknown> | undefined;
  const fields = ["serverUrl", "serverToken"].map((field) => [field, Object.hasOwn(mapping, field), mapping[field]]);
  return [
    ...fields, ["worker.repositoryRoot", worker !== undefined && Object.hasOwn(worker, "repositoryRoot"), worker?.repositoryRoot],
    ["worker.repositories", worker !== undefined && Object.hasOwn(worker, "repositories"), worker?.repositories],
  ];
};

const setupBaseline = (source: string | undefined, paths: WorkerPaths): readonly unknown[] => {
  const { mapping } = parseConfigurationDocument(source === undefined ? "{}" : source, paths);
  const worker = mapping.worker as Record<string, unknown> | undefined;
  return [
    registrationBaseline(mapping),
    ...["agent", "model", "args"].map((field) => [field, worker !== undefined && Object.hasOwn(worker, field), worker?.[field]]),
  ];
};

const repositorySnapshot = (snapshot: WorkerConfigurationSnapshot, paths: WorkerPaths): WorkerRepositorySnapshot => {
  const { mapping } = parseConfigurationDocument(snapshot.source === undefined ? "{}" : snapshot.source, paths);
  return { ...snapshot, registrationBaseline: registrationBaseline(mapping) };
};

const snapshotFromSource = async (source: string | undefined, paths: WorkerPaths, signal?: AbortSignal): Promise<WorkerRepositorySnapshot> =>
  repositorySnapshot(await validateWorkerConfigurationSnapshotSource(source, paths, signal), paths);

export const readWorkerRepositorySnapshot = async (paths: WorkerPaths, signal?: AbortSignal): Promise<WorkerRepositorySnapshot> =>
  repositorySnapshot(await readWorkerConfigurationSnapshot(paths, signal), paths);

export const readWorkerProjects = async (
  snapshot: WorkerRepositorySnapshot,
  signal?: AbortSignal,
  options: { readonly fetch?: typeof globalThis.fetch; readonly operationLimits?: Partial<OperationLimits> } = {},
): Promise<readonly Project[]> => {
  signal?.throwIfAborted();
  if (snapshot.serverToken === undefined) throw new Error("You are not logged in. Run daynight login to authenticate.");
  const operation = createOperation({ ...(signal === undefined ? {} : { signal }), ...(options.operationLimits === undefined ? {} : { limits: options.operationLimits }) });
  try {
    operation.check();
    const api = createApiClient({ serverUrl: snapshot.serverUrl, serverToken: snapshot.serverToken, operation, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
    return await api.listProjects();
  } finally { operation.dispose(); }
};

export const configuredWorkerProjectIds = (snapshot: WorkerRepositorySnapshot, projects: readonly Project[]): readonly string[] => {
  const ids = new Set<string>();
  for (const repository of snapshot.configuration.repositories) {
    if (repository.projectId !== undefined) { ids.add(repository.projectId); continue; }
    const identity = repositoryIdentity(repository.remote);
    const matches = projects.filter((project) => repositoryIdentity(project.repoUrl) === identity);
    if (matches.length > 1) throw new Error(`The configured repository matches multiple remote projects (${matches.map(({ id }) => id).join(", ")}); use daynight worker repo add --project <project-id> to identify it explicitly.`);
    if (matches.length === 1) ids.add(matches[0]!.id);
  }
  return [...ids];
};

const selectedProjects = (ids: readonly string[], projects: readonly Project[]): Project[] => {
  if (ids.length === 0) throw new Error("Select at least one existing remote project.");
  const selected = new Set<string>();
  return ids.flatMap((value) => {
    const id = canonicalId(value);
    if (id === null) throw new Error("Project ID must be a hyphenated UUID.");
    if (selected.has(id)) return [];
    selected.add(id);
    const project = projects.find((candidate) => candidate.id === id);
    if (project === undefined) throw new Error(`Project ${id} is not an accessible existing remote project.`);
    repositoryIdentity(project.repoUrl);
    return [project];
  });
};

const registeredProjectIndex = (repositories: readonly WorkerRepositoryConfiguration[], project: Project): number => {
  const identity = repositoryIdentity(project.repoUrl);
  const byProject = repositories.findIndex((repository) => repository.projectId === project.id);
  const byRemote = repositories.findIndex((repository) => repositoryIdentity(repository.remote) === identity);
  const index = byProject === -1 ? byRemote : byProject;
  if (index !== -1) {
    const existing = repositories[index]!;
    if (repositoryIdentity(existing.remote) !== identity || (existing.projectId !== undefined && existing.projectId !== project.id)) {
      throw new Error(`Project ${project.id} conflicts with an existing worker repository registration.`);
    }
  }
  return index;
};

const prepareSetupSource = async (source: string | undefined, options: WorkerSetupOptions): Promise<WorkerSetupPlan & { source: string }> => {
  const { paths, signal } = options;
  signal?.throwIfAborted();
  if (!path.isAbsolute(options.homeDirectory)) throw new Error("The current user's home directory must be an absolute path.");
  if (options.agent !== "codex" && options.agent !== "copilot" && options.agent !== "claude") throw new Error("Choose Codex, Claude or Copilot as the worker agent.");
  if (new Set(options.projectIds).size !== options.projectIds.length) throw new Error("Select distinct Projects for worker setup.");
  const projects = selectedProjects(options.projectIds, options.projects);
  const current = await snapshotFromSource(source, paths, signal);
  const { document, mapping } = parseConfigurationDocument(source === undefined ? "{}" : source, paths);
  const root = resolveRepositoryRoot(current.configuration.repositoryRoot, paths, options.homeDirectory, "worker.repositoryRoot");
  const retained = new Map<number, Project>();
  const additions: Project[] = [];
  for (const project of projects) {
    const index = registeredProjectIndex(current.configuration.repositories, project);
    if (index === -1) { additions.push(project); continue; }
    if (retained.has(index)) throw new Error("Selected Projects share the same repository identity.");
    retained.set(index, project);
  }
  if (!document.has("worker")) document.set("worker", document.createNode({}));
  if (!document.hasIn(["worker", "repositories"])) document.setIn(["worker", "repositories"], document.createNode([]));
  const resetGlobalNativeSettings = current.configuration.agent !== options.agent &&
    (document.hasIn(["worker", "model"]) || document.hasIn(["worker", "args"]));
  if (current.configuration.agent !== options.agent) {
    document.deleteIn(["worker", "model"]);
    document.deleteIn(["worker", "args"]);
  }
  document.setIn(["worker", "agent"], options.agent);
  const removedRepositories: WorkerRepositoryConfiguration[] = [];
  const resetRepositories: WorkerRepositoryConfiguration[] = [];
  for (let index = current.configuration.repositories.length - 1; index >= 0; index -= 1) {
    const repository = current.configuration.repositories[index]!;
    const project = retained.get(index);
    if (project === undefined) {
      document.deleteIn(["worker", "repositories", index]);
      removedRepositories.unshift(repository);
      continue;
    }
    document.setIn(["worker", "repositories", index, "projectId"], project.id);
    document.deleteIn(["worker", "repositories", index, "agent"]);
    if (repository.agent !== options.agent) {
      document.deleteIn(["worker", "repositories", index, "model"]);
      document.deleteIn(["worker", "repositories", index, "args"]);
      resetRepositories.unshift(repository);
    }
  }
  for (const project of additions) document.addIn(["worker", "repositories"], {
    projectId: project.id, remote: project.repoUrl, path: repositoryLocation(project.repoUrl, root),
  });
  const updatedSource = document.toString();
  verifyConfigurationUpdate(mapping, parseConfigurationDocument(updatedSource, paths).mapping, workerSetupOwnership);
  const configuration = await validateWorkerConfigurationSource(updatedSource, paths, signal);
  return { source: updatedSource, configuration, removedRepositories, resetRepositories, resetGlobalNativeSettings };
};

export const prepareWorkerSetup = async (options: WorkerSetupOptions): Promise<WorkerSetupPlan> => {
  const { source: _source, ...plan } = await prepareSetupSource(options.snapshot.source, options);
  return plan;
};

export const saveWorkerSetup = async (options: WorkerSetupOptions): Promise<WorkerConfiguration> => {
  const expected = setupBaseline(options.snapshot.source, options.paths);
  return updateConfigurationFile(options.paths, async (source) => {
    if (!isDeepStrictEqual(setupBaseline(source, options.paths), expected)) {
      throw new Error("Worker agent, repository configuration or service credentials changed during setup. Run daynight worker setup again with the current configuration.");
    }
    const prepared = await prepareSetupSource(source, options);
    return { kind: "write", source: prepared.source, result: prepared.configuration, ownership: workerSetupOwnership };
  }, options.signal);
};

export const changeWorkerRepositories = async (options: ChangeWorkerRepositoriesOptions): Promise<readonly WorkerRepositoryConfiguration[]> => {
  const { paths, snapshot, signal } = options;
  signal?.throwIfAborted();
  if (!path.isAbsolute(options.homeDirectory)) throw new Error("The current user's home directory must be an absolute path.");
  if ((options.addProjectIds === undefined) === (options.removeProjectIds === undefined)) throw new Error("Choose exactly one repository registration operation.");
  const adding = options.addProjectIds !== undefined;
  const projects = selectedProjects(adding ? options.addProjectIds! : options.removeProjectIds!, options.projects);
  return updateConfigurationFile(paths, async (source) => {
    const current = await snapshotFromSource(source, paths, signal);
    if (!isDeepStrictEqual(current.registrationBaseline, snapshot.registrationBaseline)) throw new Error("Worker repository configuration or service credentials changed while selecting projects. Run the command again with the current configuration.");
    const { document, mapping } = parseConfigurationDocument(source === undefined ? "{}" : source, paths);
    const repositories = [...current.configuration.repositories];
    let changed = false;
    if (adding) {
      const root = resolveRepositoryRoot(current.configuration.repositoryRoot, paths, options.homeDirectory, "worker.repositoryRoot");
      for (const project of projects) {
        const index = registeredProjectIndex(repositories, project);
        if (index !== -1) {
          const existing = repositories[index]!;
          // Retained SQLite bindings keep this exact transport URL, even when the Project address has an equivalent identity.
          if (existing.projectId !== project.id) {
            document.setIn(["worker", "repositories", index, "projectId"], project.id);
            repositories[index] = { ...existing, projectId: project.id };
            changed = true;
          }
          continue;
        }
        if (!document.has("worker")) document.set("worker", document.createNode({}));
        if (!document.hasIn(["worker", "repositories"])) document.setIn(["worker", "repositories"], document.createNode([]));
        const entry = { projectId: project.id, remote: project.repoUrl, path: repositoryLocation(project.repoUrl, root) };
        document.addIn(["worker", "repositories"], entry);
        repositories.push({ agent: current.configuration.agent, model: current.configuration.model, args: current.configuration.args, recoveryLimit: current.configuration.recoveryLimit, ...entry });
        changed = true;
      }
    } else {
      const removals = repositories.flatMap((repository, index) => projects.some((project) => repository.projectId === project.id ||
        (repository.projectId === undefined && repositoryIdentity(repository.remote) === repositoryIdentity(project.repoUrl))) ? [index] : []);
      for (const index of removals.toReversed()) { document.deleteIn(["worker", "repositories", index]); changed = true; }
    }
    if (!changed) return { kind: "unchanged", result: current.configuration.repositories };
    const updatedSource = document.toString();
    verifyConfigurationUpdate(mapping, parseConfigurationDocument(updatedSource, paths).mapping, workerRepositoryOwnership);
    const configuration = await validateWorkerConfigurationSource(updatedSource, paths, signal);
    return { kind: "write", source: updatedSource, result: configuration.repositories, ownership: workerRepositoryOwnership };
  }, signal);
};
