import path from "node:path";
import { canonicalId } from "../../api/parse.js";
import { parseConfigurationDocument } from "../../config/document.js";
import { MissingConfigurationFileError } from "../../config/errors.js";
import { readConfigurationSource } from "../../config/files.js";
import { parseServerConfiguration } from "../../config/server.js";
import type { ServerConfiguration } from "../../config/server.js";
import { ancestorIdentities, missingPathsReferToSameDirectory, pathsOverlap, resolvePhysicalDirectory } from "../../platform/filesystem.js";
import type { PathApi, PhysicalDirectory } from "../../platform/filesystem.js";
import { repositoryIdentity } from "../../repository/identity.js";
import { defaultRepositoryRoot, validateRepositoryRoot } from "../../repository/location.js";
import { validateHerdrAgentArguments } from "./herdr/arguments.js";
import type { WorkerPaths } from "./paths.js";
import type { FrozenExecutionConfiguration } from "./types.js";

export type WorkerRepositoryConfiguration = FrozenExecutionConfiguration & {
  remote: string;
  path: string;
  projectId?: string;
};

export type WorkerConfiguration = FrozenExecutionConfiguration & {
  repositoryRoot: string;
  maxConcurrent: number;
  pollIntervalMs: number;
  repositories: readonly WorkerRepositoryConfiguration[];
};

export type WorkerConfigurationSnapshot = ServerConfiguration & {
  readonly source: string | undefined;
  readonly configuration: WorkerConfiguration;
};

export const workerConfigurationDefaults = Object.freeze({
  repositoryRoot: defaultRepositoryRoot,
  maxConcurrent: 1,
  pollIntervalMs: 5_000,
  recoveryLimit: 3,
  agent: "copilot" as const,
});

const mapping = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${field} must be a mapping.`);
  return value as Record<string, unknown>;
};

const keys = (value: Record<string, unknown>, accepted: readonly string[], field: string): void => {
  if (Object.keys(value).some((key) => !accepted.includes(key))) throw new TypeError(`${field} contains an unsupported field.`);
};

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "" || !value.isWellFormed() || /\p{Cc}/u.test(value)) throw new TypeError(`${field} must be nonempty text without control characters.`);
  return value;
};

const number = (value: Record<string, unknown>, field: keyof Pick<WorkerConfiguration, "maxConcurrent" | "pollIntervalMs" | "recoveryLimit">): number => {
  if (!Object.hasOwn(value, field)) return workerConfigurationDefaults[field];
  const result = value[field];
  const minimum = field === "recoveryLimit" ? 0 : 1;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < minimum || (field === "pollIntervalMs" && result > 2_147_483_647)) {
    throw new TypeError(`worker.${field} must be a ${minimum === 0 ? "nonnegative" : "positive"} safe integer${field === "pollIntervalMs" ? " no greater than 2147483647" : ""}.`);
  }
  return result;
};

const agentConfiguration = (value: Record<string, unknown>, field: string, inherited: FrozenExecutionConfiguration): FrozenExecutionConfiguration => {
  const agent = Object.hasOwn(value, "agent") ? value.agent : inherited.agent;
  if (agent !== "codex" && agent !== "copilot") throw new TypeError(`${field}.agent must be codex or copilot.`);
  const sameKind = agent === inherited.agent;
  const model = Object.hasOwn(value, "model") ? value.model === null ? null : text(value.model, `${field}.model`) : sameKind ? inherited.model : null;
  let args: readonly string[];
  if (Object.hasOwn(value, "args")) {
    if (!Array.isArray(value.args)) throw new TypeError(`${field}.args must be a sequence of native arguments.`);
    args = value.args.map((argument: unknown) => text(argument, `${field}.args`));
  } else args = sameKind ? [...inherited.args] : [];
  validateHerdrAgentArguments(agent, args);
  return { agent, model, args, recoveryLimit: inherited.recoveryLimit };
};

const repositoryPath = (value: unknown, field: string, paths: WorkerPaths, pathApi: PathApi): string => {
  const configured = text(value, field);
  if (configured.startsWith("~")) throw new TypeError(`${field} must be absolute or relative to the configuration directory; tilde expansion is not supported.`);
  if (pathApi.sep === "\\" && /^[a-z]:(?![\\/])/i.test(configured)) throw new TypeError(`${field} must not be a drive-relative Windows path.`);
  return pathApi.resolve(pathApi.dirname(paths.configFile), configured);
};

export const parseWorkerConfiguration = (source: string, paths: WorkerPaths, pathApi: PathApi = path): WorkerConfiguration => {
  const { mapping: root } = parseConfigurationDocument(source, paths);
  const worker = Object.hasOwn(root, "worker") ? mapping(root.worker, "worker") : {};
  keys(worker, ["repositoryRoot", "maxConcurrent", "pollIntervalMs", "recoveryLimit", "agent", "model", "args", "repositories"], "worker");
  const repositoryRoot = Object.hasOwn(worker, "repositoryRoot")
    ? validateRepositoryRoot(text(worker.repositoryRoot, "worker.repositoryRoot"), "worker.repositoryRoot", pathApi)
    : workerConfigurationDefaults.repositoryRoot;
  const effective = agentConfiguration(worker, "worker", {
    agent: workerConfigurationDefaults.agent, model: null, args: [], recoveryLimit: number(worker, "recoveryLimit"),
  });
  const configuredRepositories = Object.hasOwn(worker, "repositories") ? worker.repositories : [];
  if (!Array.isArray(configuredRepositories)) throw new TypeError("worker.repositories must be a sequence.");
  const identities = new Set<string>();
  const projects = new Set<string>();
  const locations: string[] = [];
  const repositories = configuredRepositories.map((entry: unknown, index: number): WorkerRepositoryConfiguration => {
    const field = `worker.repositories[${index}]`;
    const repository = mapping(entry, field);
    keys(repository, ["remote", "path", "projectId", "agent", "model", "args"], field);
    const remote = text(repository.remote, `${field}.remote`);
    const identity = repositoryIdentity(remote);
    if (identities.has(identity)) throw new TypeError(`${field}.remote duplicates a repository identity.`);
    identities.add(identity);
    const localPath = repositoryPath(repository.path, `${field}.path`, paths, pathApi);
    if (pathsOverlap(localPath, paths.stateDirectory, pathApi)) throw new TypeError(`${field}.path overlaps the Daynight state directory.`);
    if (locations.some((location) => pathsOverlap(location, localPath, pathApi))) throw new TypeError(`${field}.path overlaps another worker repository.`);
    locations.push(localPath);
    let projectId: string | undefined;
    if (Object.hasOwn(repository, "projectId")) {
      projectId = typeof repository.projectId === "string" ? canonicalId(repository.projectId) ?? undefined : undefined;
      if (projectId === undefined) throw new TypeError(`${field}.projectId must be a hyphenated UUID.`);
      if (projects.has(projectId)) throw new TypeError(`${field}.projectId duplicates another worker repository.`);
      projects.add(projectId);
    }
    return { ...agentConfiguration(repository, field, effective), remote, path: localPath, ...(projectId === undefined ? {} : { projectId }) };
  });
  return { ...effective, repositoryRoot, maxConcurrent: number(worker, "maxConcurrent"), pollIntervalMs: number(worker, "pollIntervalMs"), repositories };
};

const readWorkerConfigurationSource = async (paths: WorkerPaths, signal?: AbortSignal): Promise<string | undefined> => {
  signal?.throwIfAborted();
  try { return await readConfigurationSource(paths, signal); }
  catch (cause) {
    if (!(cause instanceof MissingConfigurationFileError)) throw cause;
    return undefined;
  }
};

export const readWorkerConfiguration = async (paths: WorkerPaths, signal?: AbortSignal): Promise<WorkerConfiguration> => {
  const source = await readWorkerConfigurationSource(paths, signal);
  return validateWorkerConfigurationSource(source === undefined ? "{}" : source, paths, signal);
};

export const validateWorkerConfigurationSnapshotSource = async (
  source: string | undefined,
  paths: WorkerPaths,
  signal?: AbortSignal,
): Promise<WorkerConfigurationSnapshot> => {
  const content = source === undefined ? "{}" : source;
  const configuration = await validateWorkerConfigurationSource(content, paths, signal);
  return { source, configuration, ...parseServerConfiguration(content, paths) };
};

export const readWorkerConfigurationSnapshot = async (paths: WorkerPaths, signal?: AbortSignal): Promise<WorkerConfigurationSnapshot> =>
  validateWorkerConfigurationSnapshotSource(await readWorkerConfigurationSource(paths, signal), paths, signal);

export const validateWorkerConfigurationSource = async (source: string, paths: WorkerPaths, signal?: AbortSignal): Promise<WorkerConfiguration> => {
  signal?.throwIfAborted();
  const configuration = parseWorkerConfiguration(source, paths);
  const physicalPaths: PhysicalDirectory[] = [];
  const physicalState = await resolvePhysicalDirectory(paths.stateDirectory);
  const ancestors = new Map<string, Promise<Set<string>>>();
  const ancestry = (directory: PhysicalDirectory): Promise<Set<string>> => {
    const existing = ancestors.get(directory.ancestorIdentity);
    if (existing !== undefined) return existing;
    const result = ancestorIdentities(directory.ancestorPath);
    ancestors.set(directory.ancestorIdentity, result);
    return result;
  };
  const overlaps = async (first: PhysicalDirectory, second: PhysicalDirectory): Promise<boolean> => {
    if (first.missingComponents.length === 0 && (await ancestry(second)).has(first.ancestorIdentity)) return true;
    if (second.missingComponents.length === 0 && (await ancestry(first)).has(second.ancestorIdentity)) return true;
    if (first.ancestorIdentity !== second.ancestorIdentity) return false;
    const length = Math.min(first.missingComponents.length, second.missingComponents.length);
    const left = first.missingComponents.slice(0, length);
    const right = second.missingComponents.slice(0, length);
    return left.every((component, index) => component === right[index]) || await missingPathsReferToSameDirectory(first.ancestorPath, left, right);
  };
  for (const [index, repository] of configuration.repositories.entries()) {
    signal?.throwIfAborted();
    const physical = await resolvePhysicalDirectory(repository.path);
    if (await overlaps(physical, physicalState)) throw new TypeError(`worker.repositories[${index}].path physically overlaps the Daynight state directory.`);
    for (const previous of physicalPaths) {
      if (await overlaps(previous, physical)) throw new TypeError(`worker.repositories[${index}].path physically overlaps another worker repository.`);
    }
    physicalPaths.push(physical);
  }
  signal?.throwIfAborted();
  return configuration;
};
