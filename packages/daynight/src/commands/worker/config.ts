import { parseProviderArguments } from "../controller/providers/projection.js";
import path from "node:path";
import { canonicalId } from "../../api/parse.js";
import { parseConfigurationDocument } from "../../config/document.js";
import { MissingConfigurationFileError } from "../../config/errors.js";
import { readConfigurationSource } from "../../config/files.js";
import { parseServerConfiguration } from "../../config/server.js";
import type { ServerConfiguration } from "../../config/server.js";
import { ancestorIdentities, missingPathsReferToSameDirectory, pathsOverlap, resolvePhysicalDirectory } from "../../platform/filesystem.js";
import type { PathApi, PhysicalDirectory } from "../../platform/filesystem.js";
import { parseLocalToolPaths, type ToolPaths } from "../../platform/tool-path-choice.js";
import { repositoryIdentity } from "../../repository/identity.js";
import { defaultRepositoryRoot, validateRepositoryRoot } from "../../repository/location.js";
import { validateHerdrAgentArguments } from "./herdr/arguments.js";
import type { WorkerPaths } from "./paths.js";
import type { ExecutionConfiguration } from "./types.js";
import type { AgentControlMode } from "../../api/types.js";
import type { WorkerCloudNative } from "../../api/worker-configuration.js";
import { parseWorkerLocalNativeOverrides, type WorkerLocalNativeOverrides } from "./local-native.js";
import { normalizeWorkerNative } from "./native-overrides.js";

export type WorkerRepositoryConfiguration = ExecutionConfiguration & {
  remote: string;
  path: string;
  projectId?: string;
};

export type WorkerConfiguration = ExecutionConfiguration & {
  repositoryRoot: string;
  readonly toolPaths: ToolPaths;
  maxConcurrent: number;
  pollIntervalMs: number;
  preferPlatformSpecificTasks: boolean;
  repositories: readonly WorkerRepositoryConfiguration[];
};

export type WorkerConfigurationSnapshot = ServerConfiguration & {
  readonly source: string | undefined;
  readonly configuration: WorkerConfiguration;
};

export const workerConfigurationDefaults = Object.freeze({
  repositoryRoot: defaultRepositoryRoot,
  maxConcurrent: 1,
  pollIntervalMs: 60_000,
  preferPlatformSpecificTasks: false,
  recoveryLimit: 3,
  agent: "copilot" as const,
});

const mapping = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${field} must be a mapping.`);
  return value as Record<string, unknown>;
};

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "" || !value.isWellFormed() || /\p{Cc}/u.test(value)) throw new TypeError(`${field} must be nonempty text without control characters.`);
  return value;
};

const number = (value: Record<string, unknown>, field: keyof Pick<WorkerConfiguration, "maxConcurrent" | "pollIntervalMs" | "recoveryLimit">): number => {
  if (!Object.hasOwn(value, field)) return workerConfigurationDefaults[field];
  const result = value[field];
  const minimum = field === "recoveryLimit" ? 0 : field === "pollIntervalMs" ? 1000 : 1;
  const maximum = field === "recoveryLimit" ? 10 : field === "pollIntervalMs" ? 60_000 : 64;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new TypeError(`worker.${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return result;
};

const platformPreference = (worker: Record<string, unknown>): boolean => {
  if (!Object.hasOwn(worker, "preferPlatformSpecificTasks")) return workerConfigurationDefaults.preferPlatformSpecificTasks;
  if (typeof worker.preferPlatformSpecificTasks !== "boolean") throw new TypeError("worker.preferPlatformSpecificTasks must be a boolean.");
  return worker.preferPlatformSpecificTasks;
};

const agentConfiguration = (value: Record<string, unknown>, field: string, inherited: ExecutionConfiguration, local?: WorkerLocalNativeOverrides): ExecutionConfiguration => {
  const agent = Object.hasOwn(value, "agent") ? value.agent : inherited.agent;
  if (agent !== "codex" && agent !== "copilot" && agent !== "claude") throw new TypeError(`${field}.agent must be codex, claude or copilot.`);
  const sameKind = agent === inherited.agent;
  const model = Object.hasOwn(value, "model") ? value.model === null ? null : text(value.model, `${field}.model`) : sameKind ? inherited.model : null;
  if (model !== null && Buffer.byteLength(model) > 256) throw new TypeError(`${field}.model must be at most 256 UTF-8 bytes.`);
  let args: readonly string[];
  if (Object.hasOwn(value, "args")) {
    if (!Array.isArray(value.args)) throw new TypeError(`${field}.args must be a sequence of native arguments.`);
    if (value.args.length > 128) throw new TypeError(`${field}.args must contain at most 128 arguments.`);
    args = value.args.map((argument: unknown) => {
      const parsed = text(argument, `${field}.args`);
      if (Buffer.byteLength(parsed) > 4096) throw new TypeError(`${field}.args entries must be at most 4096 UTF-8 bytes.`);
      return parsed;
    });
  } else args = sameKind ? [...inherited.args] : [];
  if (local !== undefined && (local.agentModel !== undefined || local.agentReasoningEffort !== undefined)) {
    return { ...normalizeWorkerNative({ agent, model, args }, inherited.agentControlMode ?? "herdr", local).native, validateNativeSelection: true, agentControlMode: inherited.agentControlMode ?? "herdr", recoveryLimit: inherited.recoveryLimit };
  }
  if (inherited.agentControlMode === "web") parseProviderArguments(agent, args);
  else validateHerdrAgentArguments(agent, args);
  return { agent, agentControlMode: inherited.agentControlMode ?? "herdr", model, args, recoveryLimit: inherited.recoveryLimit };
};

export const resolveWorkerRepositoryPath = (value: unknown, field: string, paths: WorkerPaths, pathApi: PathApi): string => {
  const configured = text(value, field);
  if (configured.startsWith("~")) throw new TypeError(`${field} must be absolute or relative to the configuration directory; tilde expansion is not supported.`);
  if (pathApi.sep === "\\" && /^[a-z]:(?![\\/])/i.test(configured)) throw new TypeError(`${field} must not be a drive-relative Windows path.`);
  const resolved = pathApi.resolve(pathApi.dirname(paths.configFile), configured);
  if (Buffer.byteLength(resolved) > 4096) throw new TypeError(`${field} must be at most 4096 UTF-8 bytes after resolution.`);
  return resolved;
};

export const parseWorkerConfiguration = (source: string, paths: WorkerPaths, pathApi: PathApi = path): WorkerConfiguration => {
  const { mapping: root } = parseConfigurationDocument(source, paths);
  const worker = Object.hasOwn(root, "worker") ? mapping(root.worker, "worker") : {};
  const repositoryRoot = Object.hasOwn(worker, "repositoryRoot")
    ? validateRepositoryRoot(text(worker.repositoryRoot, "worker.repositoryRoot"), "worker.repositoryRoot", pathApi)
    : workerConfigurationDefaults.repositoryRoot;
  const agentControlMode = Object.hasOwn(worker, "agentControlMode") ? worker.agentControlMode : "herdr";
  if (agentControlMode !== "herdr" && agentControlMode !== "web") throw new TypeError("worker.agentControlMode must be herdr or web.");
  const local = parseWorkerLocalNativeOverrides(worker);
  const effective = agentConfiguration(worker, "worker", {
    agent: workerConfigurationDefaults.agent, agentControlMode, model: null, args: [], recoveryLimit: number(worker, "recoveryLimit"),
  }, local);
  const configuredRepositories = Object.hasOwn(worker, "repositories") ? worker.repositories : [];
  if (!Array.isArray(configuredRepositories)) throw new TypeError("worker.repositories must be a sequence.");
  if (configuredRepositories.length > 128) throw new TypeError("worker.repositories must contain at most 128 Projects.");
  const identities = new Set<string>();
  const projects = new Set<string>();
  const locations: string[] = [];
  const repositories = configuredRepositories.map((entry: unknown, index: number): WorkerRepositoryConfiguration => {
    const field = `worker.repositories[${index}]`;
    const repository = mapping(entry, field);
    const remote = text(repository.remote, `${field}.remote`);
    const identity = repositoryIdentity(remote);
    if (identities.has(identity)) throw new TypeError(`${field}.remote duplicates a repository identity.`);
    identities.add(identity);
    const localPath = resolveWorkerRepositoryPath(repository.path, `${field}.path`, paths, pathApi);
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
    return { ...agentConfiguration(repository, field, effective, local), remote, path: localPath, ...(projectId === undefined ? {} : { projectId }) };
  });
  return { ...effective, repositoryRoot, toolPaths: parseLocalToolPaths(worker.toolPaths, pathApi), maxConcurrent: number(worker, "maxConcurrent"), pollIntervalMs: number(worker, "pollIntervalMs"), preferPlatformSpecificTasks: platformPreference(worker), repositories };
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

export const validateWorkerRepositoryLocations = async (repositories: readonly { readonly path: string }[], paths: WorkerPaths, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted();
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
  for (const [index, repository] of repositories.entries()) {
    signal?.throwIfAborted();
    const physical = await resolvePhysicalDirectory(repository.path);
    if (await overlaps(physical, physicalState)) throw new TypeError(`worker.repositories[${index}].path physically overlaps the Daynight state directory.`);
    for (const previous of physicalPaths) {
      if (await overlaps(previous, physical)) throw new TypeError(`worker.repositories[${index}].path physically overlaps another worker repository.`);
    }
    physicalPaths.push(physical);
  }
  signal?.throwIfAborted();
};

export const validateWorkerConfigurationSource = async (source: string, paths: WorkerPaths, signal?: AbortSignal): Promise<WorkerConfiguration> => {
  signal?.throwIfAborted();
  const configuration = parseWorkerConfiguration(source, paths);
  await validateWorkerRepositoryLocations(configuration.repositories, paths, signal);
  return configuration;
};

export const resolveCloudNative = (native: WorkerCloudNative, agentControlMode: AgentControlMode, recoveryLimit: number): ExecutionConfiguration =>
  agentConfiguration({ ...native }, "worker.native", { ...native, agentControlMode, recoveryLimit });
