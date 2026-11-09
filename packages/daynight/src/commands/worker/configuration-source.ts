import path from "node:path";
import { ApiError, createApiClient } from "../../api/client.js";
import { createOperation } from "../../api/operation.js";
import type { OperationLimits } from "../../api/operation.js";
import { canonicalId } from "../../api/parse.js";
import { parseWorkerCloudValue } from "../../api/worker-configuration.js";
import type { WorkerCloudNative, WorkerCloudValue } from "../../api/worker-configuration.js";
import type { AgentControlMode } from "../../api/types.js";
import { parseConfigurationDocument } from "../../config/document.js";
import { MissingConfigurationFileError } from "../../config/errors.js";
import { readConfigurationSource } from "../../config/files.js";
import { parseServerConfiguration } from "../../config/server.js";
import type { ServerConfiguration } from "../../config/server.js";
import { pathsOverlap } from "../../platform/filesystem.js";
import { RepositoryIdentityError, repositoryIdentity } from "../../repository/identity.js";
import { validateRepositoryRoot } from "../../repository/location.js";
import { resolveWorkerRepositoryPath, validateWorkerRepositoryLocations, workerConfigurationDefaults } from "./config.js";
import type { WorkerPaths } from "./paths.js";
import { parseWorkerLocalNativeOverrides, type WorkerLocalNativeOverrides } from "./local-native.js";

export { resolveCloudNative } from "./config.js";

export type WorkerLocalConfiguration = ServerConfiguration & WorkerLocalNativeOverrides & {
  readonly source: string | undefined;
  readonly repositoryRoot: string;
  readonly agentControlMode: AgentControlMode;
};

export type WorkerLocalRepository = { readonly remote: string; readonly path: string; readonly projectId: string };
export type WorkerBootstrapProjectResolver = (
  repository: { readonly repoUrl: string; readonly projectId?: string },
  signal: AbortSignal,
) => Promise<{ readonly id: string }>;

const mapping = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${field} must be a mapping.`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "" || !value.isWellFormed() || /\p{Cc}/u.test(value)) throw new TypeError(`${field} must be nonempty text without control characters.`);
  return value;
};
const sourceMapping = (source: string | undefined, paths: WorkerPaths): Record<string, unknown> =>
  parseConfigurationDocument(source === undefined ? "{}" : source, paths).mapping;
const workerMapping = (root: Record<string, unknown>): Record<string, unknown> => Object.hasOwn(root, "worker") ? mapping(root.worker, "worker") : {};

const readSource = async (paths: WorkerPaths, signal?: AbortSignal): Promise<string | undefined> => {
  try { return await readConfigurationSource(paths, signal); }
  catch (error) { if (error instanceof MissingConfigurationFileError) return undefined; throw error; }
};

export const parseWorkerLocalConfiguration = (source: string | undefined, paths: WorkerPaths): WorkerLocalConfiguration => {
  const worker = workerMapping(sourceMapping(source, paths));
  const agentControlMode = Object.hasOwn(worker, "agentControlMode") ? worker.agentControlMode : "herdr";
  if (agentControlMode !== "herdr" && agentControlMode !== "web") throw new TypeError("worker.agentControlMode must be herdr or web.");
  const repositoryRoot = Object.hasOwn(worker, "repositoryRoot")
    ? validateRepositoryRoot(text(worker.repositoryRoot, "worker.repositoryRoot"), "worker.repositoryRoot")
    : workerConfigurationDefaults.repositoryRoot;
  return { source, ...parseServerConfiguration(source === undefined ? "{}" : source, paths), repositoryRoot, agentControlMode, ...parseWorkerLocalNativeOverrides(worker) };
};

export const readWorkerLocalConfiguration = async (paths: WorkerPaths, signal?: AbortSignal): Promise<WorkerLocalConfiguration> => {
  signal?.throwIfAborted();
  return parseWorkerLocalConfiguration(await readSource(paths, signal), paths);
};

const matchesRemote = (remote: unknown, expected: string): boolean => {
  if (typeof remote !== "string") return false;
  try { return repositoryIdentity(remote) === expected; }
  catch (error) {
    // An obsolete managed entry without a valid identity cannot supply this cloud Project's local path.
    if (error instanceof RepositoryIdentityError) return false;
    throw error;
  }
};

export const workerLocalRepositoryForProject = async (
  local: WorkerLocalConfiguration,
  paths: WorkerPaths,
  project: { readonly id: string; readonly repoUrl: string },
): Promise<WorkerLocalRepository | undefined> => {
  const worker = workerMapping(sourceMapping(local.source, paths));
  if (!Array.isArray(worker.repositories)) return undefined;
  const expectedRemote = repositoryIdentity(project.repoUrl);
  const matches = worker.repositories.flatMap((entry: unknown, index: number) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const repository = entry as Record<string, unknown>;
    const projectId = typeof repository.projectId === "string" ? canonicalId(repository.projectId) : null;
    const selected = projectId === project.id || !Object.hasOwn(repository, "projectId") && matchesRemote(repository.remote, expectedRemote);
    if (!selected) return [];
    const field = `worker.repositories[${index}]`;
    const remote = text(repository.remote, `${field}.remote`);
    if (repositoryIdentity(remote) !== expectedRemote) throw new Error(`Project ${project.id} conflicts with its local repository mapping.`);
    const localPath = resolveWorkerRepositoryPath(repository.path, `${field}.path`, paths, path);
    if (pathsOverlap(localPath, paths.stateDirectory, path)) throw new TypeError(`${field}.path overlaps the Daynight state directory.`);
    return [{ remote, path: localPath, projectId: project.id }];
  });
  if (matches.length > 1) throw new Error(`Project ${project.id} has multiple local repository mappings.`);
  await validateWorkerRepositoryLocations(matches, paths);
  return matches[0];
};

export const workerLocalRepositoryForId = async (
  local: WorkerLocalConfiguration, paths: WorkerPaths, projectId: string,
): Promise<WorkerLocalRepository | undefined> => {
  const worker = workerMapping(sourceMapping(local.source, paths));
  if (!Array.isArray(worker.repositories)) return undefined;
  const matches = worker.repositories.flatMap((entry: unknown, index: number) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const repository = entry as Record<string, unknown>;
    if (typeof repository.projectId !== "string" || canonicalId(repository.projectId) !== projectId) return [];
    const field = `worker.repositories[${index}]`;
    const remote = text(repository.remote, `${field}.remote`);
    repositoryIdentity(remote);
    const localPath = resolveWorkerRepositoryPath(repository.path, `${field}.path`, paths, path);
    if (pathsOverlap(localPath, paths.stateDirectory, path)) throw new TypeError(`${field}.path overlaps the Daynight state directory.`);
    return [{ remote, path: localPath, projectId }];
  });
  if (matches.length > 1) throw new Error(`Project ${projectId} has multiple local repository mappings.`);
  await validateWorkerRepositoryLocations(matches, paths);
  return matches[0];
};

export const workerLocalExplicitProjectIds = (local: WorkerLocalConfiguration, paths: WorkerPaths): readonly string[] => {
  const worker = workerMapping(sourceMapping(local.source, paths));
  if (!Array.isArray(worker.repositories)) return [];
  return [...new Set(worker.repositories.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const projectId = (entry as Record<string, unknown>).projectId;
    const id = typeof projectId === "string" ? canonicalId(projectId) : null;
    return id === null ? [] : [id];
  }))];
};

export const workerLocalUnboundRepositoryIndexes = (local: WorkerLocalConfiguration, paths: WorkerPaths): readonly number[] => {
  const worker = workerMapping(sourceMapping(local.source, paths));
  if (!Array.isArray(worker.repositories)) return [];
  return worker.repositories.flatMap((entry: unknown, index: number) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const repository = entry as Record<string, unknown>;
    return typeof repository.projectId === "string" && canonicalId(repository.projectId) !== null ? [] : [index];
  });
};

export const workerLocalUnboundRepository = async (local: WorkerLocalConfiguration, paths: WorkerPaths, index: number): Promise<{ remote: string; path: string; invalidProjectId: boolean }> => {
  const worker = workerMapping(sourceMapping(local.source, paths));
  if (!Array.isArray(worker.repositories)) throw new Error("The local worker repository mapping is unavailable.");
  const field = `worker.repositories[${index}]`;
  const repository = mapping(worker.repositories[index], field);
  const invalidProjectId = Object.hasOwn(repository, "projectId");
  if (typeof repository.projectId === "string" && canonicalId(repository.projectId) !== null) throw new Error("The local worker repository mapping is no longer unbound.");
  const remote = text(repository.remote, `${field}.remote`);
  repositoryIdentity(remote);
  const localPath = resolveWorkerRepositoryPath(repository.path, `${field}.path`, paths, path);
  if (pathsOverlap(localPath, paths.stateDirectory, path)) throw new TypeError(`${field}.path overlaps the Daynight state directory.`);
  await validateWorkerRepositoryLocations([{ path: localPath }], paths);
  return { remote, path: localPath, invalidProjectId };
};

const nativeOverrides = (worker: Record<string, unknown>): Partial<WorkerCloudNative> => ({
  ...(Object.hasOwn(worker, "agent") ? { agent: worker.agent as WorkerCloudNative["agent"] } : {}),
  ...(Object.hasOwn(worker, "model") ? { model: worker.model as WorkerCloudNative["model"] } : {}),
  ...(Object.hasOwn(worker, "args") ? { args: worker.args as WorkerCloudNative["args"] } : {}),
});

export const parseWorkerCloudBootstrap = async (
  source: string | undefined,
  paths: WorkerPaths,
  resolveProject: WorkerBootstrapProjectResolver,
  signal: AbortSignal,
): Promise<WorkerCloudValue> => {
  signal.throwIfAborted();
  const worker = workerMapping(sourceMapping(source, paths));
  const repositories = Object.hasOwn(worker, "repositories") ? worker.repositories : [];
  if (!Array.isArray(repositories)) throw new TypeError("worker.repositories must be a sequence.");
  if (repositories.length > 128) throw new RangeError("worker.repositories must contain at most 128 Projects.");
  const projects = [];
  for (const [index, entry] of repositories.entries()) {
    signal.throwIfAborted();
    const field = `worker.repositories[${index}]`;
    const repository = mapping(entry, field);
    const repoUrl = text(repository.remote, `${field}.remote`);
    repositoryIdentity(repoUrl);
    const configuredProjectId = Object.hasOwn(repository, "projectId") ? typeof repository.projectId === "string" ? canonicalId(repository.projectId) : null : undefined;
    if (configuredProjectId === null) throw new TypeError(`${field}.projectId must be a hyphenated UUID.`);
    const project = await resolveProject({ repoUrl, ...(configuredProjectId === undefined ? {} : { projectId: configuredProjectId }) }, signal);
    projects.push({ projectId: project.id, nativeOverrides: nativeOverrides(repository) });
  }
  signal.throwIfAborted();
  return parseWorkerCloudValue({
    maxConcurrent: Object.hasOwn(worker, "maxConcurrent") ? worker.maxConcurrent : workerConfigurationDefaults.maxConcurrent,
    pollIntervalMs: Object.hasOwn(worker, "pollIntervalMs") ? worker.pollIntervalMs : workerConfigurationDefaults.pollIntervalMs,
    recoveryLimit: Object.hasOwn(worker, "recoveryLimit") ? worker.recoveryLimit : workerConfigurationDefaults.recoveryLimit,
    preferPlatformSpecificTasks: Object.hasOwn(worker, "preferPlatformSpecificTasks") ? worker.preferPlatformSpecificTasks : workerConfigurationDefaults.preferPlatformSpecificTasks,
    native: { agent: workerConfigurationDefaults.agent, model: null, args: [], ...nativeOverrides(worker) },
    projects: projects.sort((left, right) => left.projectId.localeCompare(right.projectId)),
  });
};

export const readWorkerCloudBootstrap = async (paths: WorkerPaths, resolveProject: WorkerBootstrapProjectResolver, signal: AbortSignal): Promise<WorkerCloudValue> =>
  parseWorkerCloudBootstrap(await readSource(paths, signal), paths, resolveProject, signal);

export const assertWorkerConfigurationIsLocal = async (
  paths: WorkerPaths,
  signal?: AbortSignal,
  options: { readonly source?: string | undefined; readonly fetch?: typeof globalThis.fetch; readonly operationLimits?: Partial<OperationLimits> } = {},
): Promise<void> => {
  const source = Object.hasOwn(options, "source") ? options.source : await readSource(paths, signal);
  const root = sourceMapping(source, paths);
  if (!Object.hasOwn(root, "workerId")) return;
  const workerId = typeof root.workerId === "string" ? canonicalId(root.workerId) : null;
  if (workerId === null) throw new Error("Configuration workerId must be a hyphenated UUID.");
  const connection = parseServerConfiguration(source === undefined ? "{}" : source, paths);
  const operation = createOperation({ ...(signal === undefined ? {} : { signal }), ...(options.operationLimits === undefined ? {} : { limits: options.operationLimits }) });
  try {
    const apiOptions = { ...connection, operation, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) };
    const user = await createApiClient(apiOptions).getCurrentUser();
    let resource;
    try { resource = await createApiClient({ ...apiOptions, expectedUserId: user.id }).getWorkerConfiguration(workerId); }
    catch (error) { if (error instanceof ApiError && error.status === 404 && error.code === "not_found") return; throw error; }
    if (resource.desired !== null) throw new Error("This Worker's runtime configuration is cloud-managed. View and edit it in My Workers; local paths and agentControlMode remain in the local configuration file.");
  } finally { operation.dispose(); }
};
