import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createApiClient } from "../../api/client.js";
import { createOperation } from "../../api/operation.js";
import type { OperationLimits } from "../../api/operation.js";
import { canonicalId } from "../../api/parse.js";
import type { Project } from "../../api/types.js";
import { parseConfigurationDocument } from "../../config/document.js";
import { updateConfigurationFile } from "../../config/files.js";
import { repositoryIdentity } from "../../repository/identity.js";
import { repositoryLocation, resolveRepositoryRoot } from "../../repository/location.js";
import { readWorkerConfigurationSnapshot, validateWorkerConfigurationSnapshotSource, validateWorkerConfigurationSource } from "./config.js";
import type { WorkerConfigurationSnapshot, WorkerRepositoryConfiguration } from "./config.js";
import type { WorkerPaths } from "./paths.js";

export type WorkerRepositorySnapshot = WorkerConfigurationSnapshot & {
  readonly fingerprint: string;
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

const fingerprint = (mapping: Record<string, unknown>): string => {
  const worker = mapping.worker as Record<string, unknown> | undefined;
  const fields = ["serverUrl", "serverToken"].map((field) => [field, Object.hasOwn(mapping, field), mapping[field]]);
  return createHash("sha256").update(JSON.stringify([
    ...fields, ["worker.repositoryRoot", worker !== undefined && Object.hasOwn(worker, "repositoryRoot"), worker?.repositoryRoot],
    ["worker.repositories", worker !== undefined && Object.hasOwn(worker, "repositories"), worker?.repositories],
  ])).digest("hex");
};

const repositorySnapshot = (snapshot: WorkerConfigurationSnapshot, paths: WorkerPaths): WorkerRepositorySnapshot => {
  const { mapping } = parseConfigurationDocument(snapshot.source === undefined ? "{}" : snapshot.source, paths);
  return { ...snapshot, fingerprint: fingerprint(mapping) };
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

const unownedConfiguration = (mapping: Record<string, unknown>, ownedWorkerFields: readonly string[]): unknown => {
  const { worker, ...root } = mapping;
  if (!Object.hasOwn(mapping, "worker")) return { root, worker: {} };
  if (typeof worker !== "object" || worker === null || Array.isArray(worker)) throw new TypeError("worker must be a mapping.");
  return { root, worker: Object.fromEntries(Object.entries(worker).filter(([field]) => !ownedWorkerFields.includes(field))) };
};

const verifyUnownedConfiguration = (
  before: Record<string, unknown>,
  updatedSource: string,
  paths: WorkerPaths,
  ownedWorkerFields: readonly string[],
): void => {
  const { mapping: after } = parseConfigurationDocument(updatedSource, paths);
  if (!isDeepStrictEqual(unownedConfiguration(before, ownedWorkerFields), unownedConfiguration(after, ownedWorkerFields))) {
    throw new Error("Worker configuration uses shared YAML aliases that would change unrelated settings. Separate worker settings from those aliases, then run the command again.");
  }
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
    if (current.fingerprint !== snapshot.fingerprint) throw new Error("Worker repository configuration or service credentials changed while selecting projects. Run the command again with the current configuration.");
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
    if (!changed) return { result: current.configuration.repositories };
    const updatedSource = document.toString();
    verifyUnownedConfiguration(mapping, updatedSource, paths, ["repositories"]);
    const configuration = await validateWorkerConfigurationSource(updatedSource, paths, signal);
    return { source: updatedSource, result: configuration.repositories };
  }, signal);
};
