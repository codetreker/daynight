import path from "node:path";
import { parseConfigurationDocument } from "../../config/document.js";
import { readConfigurationSource } from "../../config/files.js";
import { resolveRepositoryRoot as resolveSharedRepositoryRoot, validateRepositoryRoot } from "../../repository/location.js";
import { MissingConfigurationFieldError } from "../../config/errors.js";
import { ancestorIdentities, missingPathsReferToSameDirectory, pathsEqual, pathsOverlap, resolvePhysicalDirectory } from "../../platform/filesystem.js";
import type { ReviewPaths } from "./paths.js";
import type { PathApi, PhysicalDirectory } from "../../platform/filesystem.js";

export type RepositoryConfiguration = {
  coordinate: string;
  host: string;
  owner: string;
  name: string;
  remote: string;
  path: string;
};

export type ReviewConfiguration = {
  pollIntervalMs: number;
  maxConcurrentWorker: number;
  agentTimeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  copilotModel?: string;
  copilotReasoningEffort?: string;
  repositories: RepositoryConfiguration[];
};

export { defaultRepositoryRoot } from "../../repository/location.js";

export const configurationDefaults = {
  pollIntervalMs: 60_000,
  maxConcurrentWorker: 1,
  agentTimeoutMs: 1_800_000,
  maxAttempts: 3,
  retryDelayMs: 30_000,
} as const;

const asMapping = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be a mapping.`);
  }
  return value as Record<string, unknown>;
};

const validateKeys = (
  value: Record<string, unknown>,
  accepted: readonly string[],
  field: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!accepted.includes(key)) {
      throw new Error(`${field} contains unsupported field ${JSON.stringify(key)}.`);
    }
  }
};

const nonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${field} must be a nonempty string without NUL characters.`);
  }
  return value;
};

const positiveInteger = (
  mapping: Record<string, unknown>,
  field: keyof typeof configurationDefaults,
): number => {
  if (!Object.hasOwn(mapping, field)) {
    return configurationDefaults[field];
  }
  const value = mapping[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`review.${field} must be a positive safe integer.`);
  }
  if (field.endsWith("Ms") && value > 2_147_483_647) {
    throw new Error(`review.${field} must not exceed the supported timer limit of 2147483647 milliseconds.`);
  }
  return value;
};

export const remoteIdentity = (
  remote: string,
  field: string,
): Pick<RepositoryConfiguration, "coordinate" | "host" | "owner" | "name"> => {
  const invalidRemote = (): Error =>
    new Error(
      `${field} must be an HTTPS or SSH GitHub repository address with an owner and repository name; HTTPS credentials, query strings, and fragments are not allowed.`,
    );
  let host: string;
  let coordinate: string;
  const scp = /^git@([^\s/:]+):([^\s]+)$/.exec(remote);
  if (scp !== null) {
    host = scp[1]!;
    coordinate = scp[2]!;
    try {
      const parsedHost = new URL(`ssh://git@${host}`);
      if (parsedHost.hostname.toLowerCase() !== host.toLowerCase() || parsedHost.port !== "") {
        throw invalidRemote();
      }
    } catch (cause) {
      throw new Error(`${field} has an invalid SSH host.`, { cause });
    }
  } else {
    if (!/^(?:https|ssh):\/\//i.test(remote)) {
      throw invalidRemote();
    }
    let url: URL;
    try {
      url = new URL(remote);
    } catch (cause) {
      throw new Error(`${field} is not a supported GitHub repository address.`, { cause });
    }
    if (
      !["https:", "ssh:"].includes(url.protocol) ||
      url.search !== "" ||
      url.hash !== "" ||
      url.password !== "" ||
      (url.protocol === "https:" && url.username !== "") ||
      (url.protocol === "ssh:" && url.username !== "git") ||
      /\s/.test(remote)
    ) {
      throw invalidRemote();
    }
    host = url.protocol === "https:" ? url.host : url.hostname;
    coordinate = url.pathname.slice(1);
    if (!remote.endsWith(url.pathname)) {
      throw invalidRemote();
    }
  }
  try {
    const normalizedHost = new URL(`https://${host}`);
    if (normalizedHost.hostname === "" || normalizedHost.pathname !== "/" || normalizedHost.search !== "" || normalizedHost.hash !== "" || normalizedHost.username !== "" || normalizedHost.password !== "") {
      throw invalidRemote();
    }
    host = normalizedHost.hostname.replace(/\.$/, "") +
      (normalizedHost.port === "" ? "" : `:${normalizedHost.port}`);
  } catch (cause) {
    throw new Error(`${field} has an invalid repository host.`, { cause });
  }
  coordinate = coordinate.replace(/\/$/, "").replace(/\.git$/, "");
  const match = /^([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([a-z\d_.-]+)$/i.exec(coordinate);
  if (match === null || host === "" || match[2] === "." || match[2] === "..") {
    throw invalidRemote();
  }
  const owner = match[1]!.toLowerCase();
  const name = match[2]!.toLowerCase();
  host = host.toLowerCase();
  return { coordinate: `${host}/${owner}/${name}`, host, owner, name };
};

const validateRepositoryPaths = (
  repositories: readonly RepositoryConfiguration[],
  repositoryPaths: readonly string[],
  stateDirectory: string,
  pathApi: PathApi,
): void => {
  for (const [index, repositoryPath] of repositoryPaths.entries()) {
    if (pathsOverlap(repositoryPath, stateDirectory, pathApi)) {
      throw new Error(
        `review.repositories[${index}].path must not overlap the state directory ${stateDirectory}.`,
      );
    }
    const duplicate = repositoryPaths
      .slice(0, index)
      .findIndex((previous) => pathsEqual(previous, repositoryPath, pathApi));
    if (duplicate !== -1) {
      throw new Error(
        `review.repositories[${index}].path resolves to the same location as review.repositories[${duplicate}].path (${repositories[duplicate]!.coordinate}).`,
      );
    }
  }
};

export const resolveRepositoryRoot = (
  configuredRoot: unknown,
  runtimePaths: ReviewPaths,
  homeDirectory: string,
  pathApi: PathApi = path,
): string => resolveSharedRepositoryRoot(configuredRoot, runtimePaths, homeDirectory, "review.repositoryRoot", pathApi);

export const reviewConfigurationMapping = (root: Record<string, unknown>): Record<string, unknown> => {
  if (!Object.hasOwn(root, "review")) {
    return {};
  }
  const review = asMapping(root.review, "review");
  validateKeys(review, ["repositoryRoot", "repositories", ...Object.keys(configurationDefaults), "copilotModel", "copilotReasoningEffort"], "review");
  return review;
};

const parseReviewConfiguration = (
  source: string,
  runtimePaths: ReviewPaths,
  pathApi: PathApi,
  allowMissingRepositories: boolean,
): ReviewConfiguration => {
  const { mapping: root } = parseConfigurationDocument(source, runtimePaths);
  const mapping = reviewConfigurationMapping(root);
  if (Object.hasOwn(mapping, "repositoryRoot")) {
    validateRepositoryRoot(mapping.repositoryRoot, "review.repositoryRoot", pathApi);
  }
  const settings = {
    pollIntervalMs: positiveInteger(mapping, "pollIntervalMs"),
    maxConcurrentWorker: positiveInteger(mapping, "maxConcurrentWorker"),
    agentTimeoutMs: positiveInteger(mapping, "agentTimeoutMs"),
    maxAttempts: positiveInteger(mapping, "maxAttempts"),
    retryDelayMs: positiveInteger(mapping, "retryDelayMs"),
    ...(Object.hasOwn(mapping, "copilotModel") ? { copilotModel: nonEmptyString(mapping.copilotModel, "review.copilotModel") } : {}),
    ...(Object.hasOwn(mapping, "copilotReasoningEffort") ? { copilotReasoningEffort: nonEmptyString(mapping.copilotReasoningEffort, "review.copilotReasoningEffort") } : {}),
  };
  if (!Object.hasOwn(mapping, "repositories")) {
    if (allowMissingRepositories) {
      return { ...settings, repositories: [] };
    }
    throw new MissingConfigurationFieldError("review.repositories", "Review repositories are not configured; use daynight review add-repo <remote>.");
  }
  if (!Array.isArray(mapping.repositories) || mapping.repositories.length === 0) {
    throw new Error("review.repositories must be a nonempty sequence.");
  }
  const identities = new Set<string>();
  const repositories = mapping.repositories.map((value: unknown, index: number) => {
    const field = `review.repositories[${index}]`;
    const repository = asMapping(value, field);
    validateKeys(repository, ["remote", "path"], field);
    const remote = nonEmptyString(repository.remote, `${field}.remote`);
    const identity = remoteIdentity(remote, `${field}.remote`);
    if (identities.has(identity.coordinate)) {
      throw new Error(`${field}.remote duplicates repository ${identity.coordinate}.`);
    }
    identities.add(identity.coordinate);
    const configuredPath = nonEmptyString(repository.path, `${field}.path`);
    if (configuredPath.startsWith("~")) {
      throw new Error(`${field}.path must use an absolute path or a config-directory-relative path; tilde expansion is not supported.`);
    }
    if (pathApi.sep === "\\" && /^[a-z]:(?![\\/])/i.test(configuredPath)) {
      throw new Error(`${field}.path must not use a drive-relative Windows path.`);
    }
    return {
      ...identity,
      remote,
      path: pathApi.resolve(pathApi.dirname(runtimePaths.configFile), configuredPath),
    };
  });
  validateRepositoryPaths(repositories, repositories.map((repository) => repository.path), runtimePaths.stateDirectory, pathApi);
  return {
    ...settings,
    repositories,
  };
};

export const parseConfiguration = (
  source: string,
  runtimePaths: ReviewPaths,
  pathApi: PathApi = path,
): ReviewConfiguration => parseReviewConfiguration(source, runtimePaths, pathApi, false);

const validatePhysicalRepositoryPaths = async (
  configuration: ReviewConfiguration,
  stateDirectory: PhysicalDirectory,
  repositoryDirectories: readonly PhysicalDirectory[],
  statePath: string,
): Promise<void> => {
  const ancestors = new Map<string, Promise<Set<string>>>();
  const ancestryOf = (directory: PhysicalDirectory): Promise<Set<string>> => {
    const cached = ancestors.get(directory.ancestorIdentity);
    if (cached !== undefined) {
      return cached;
    }
    const result = ancestorIdentities(directory.ancestorPath);
    ancestors.set(directory.ancestorIdentity, result);
    return result;
  };
  const stateAncestors = await ancestryOf(stateDirectory);
  for (const [index, directory] of repositoryDirectories.entries()) {
    const repositoryAncestors = await ancestryOf(directory);
    const sharedAncestor = directory.ancestorIdentity === stateDirectory.ancestorIdentity;
    const prefixLength = Math.min(directory.missingComponents.length, stateDirectory.missingComponents.length);
    const statePrefix = stateDirectory.missingComponents.slice(0, prefixLength);
    const repositoryPrefix = directory.missingComponents.slice(0, prefixLength);
    const sharedMissingPrefix = sharedAncestor && (statePrefix.every((component, componentIndex) => component === repositoryPrefix[componentIndex]) ||
      await missingPathsReferToSameDirectory(directory.ancestorPath, statePrefix, repositoryPrefix));
    if (
      (stateDirectory.missingComponents.length === 0 && repositoryAncestors.has(stateDirectory.ancestorIdentity)) ||
      (directory.missingComponents.length === 0 && stateAncestors.has(directory.ancestorIdentity)) || sharedMissingPrefix
    ) {
      throw new Error(`review.repositories[${index}].path must not overlap the state directory ${statePath}.`);
    }
    for (const [previousIndex, previous] of repositoryDirectories.slice(0, index).entries()) {
      if (directory.ancestorIdentity !== previous.ancestorIdentity) {
        continue;
      }
      const sameComponents = directory.missingComponents.length === previous.missingComponents.length;
      const exact = sameComponents && directory.missingComponents.every(
        (component, componentIndex) => component === previous.missingComponents[componentIndex],
      );
      const observedSameDirectory = !exact && sameComponents && await missingPathsReferToSameDirectory(
        directory.ancestorPath,
        previous.missingComponents,
        directory.missingComponents,
      );
      if (exact || observedSameDirectory) {
        throw new Error(`review.repositories[${index}].path resolves to the same location as review.repositories[${previousIndex}].path (${configuration.repositories[previousIndex]!.coordinate}).`);
      }
    }
  }
};

export const loadConfiguration = async (
  runtimePaths: ReviewPaths,
): Promise<ReviewConfiguration> => {
  return validateConfigurationSource(await readConfigurationSource(runtimePaths), runtimePaths);
};

const validateReviewConfigurationSource = async (
  source: string,
  runtimePaths: ReviewPaths,
  allowMissingRepositories: boolean,
): Promise<ReviewConfiguration> => {
  try {
    const configuration = parseReviewConfiguration(source, runtimePaths, path, allowMissingRepositories);
    const [stateDirectory, ...repositoryDirectories] = await Promise.all([
      resolvePhysicalDirectory(runtimePaths.stateDirectory),
      ...configuration.repositories.map((repository) => resolvePhysicalDirectory(repository.path)),
    ]);
    await validatePhysicalRepositoryPaths(configuration, stateDirectory!, repositoryDirectories, runtimePaths.stateDirectory);
    return configuration;
  } catch (cause) {
    throw new Error(`Invalid configuration file ${runtimePaths.configFile}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
};

export const validateConfigurationSource = async (
  source: string,
  runtimePaths: ReviewPaths,
): Promise<ReviewConfiguration> => validateReviewConfigurationSource(source, runtimePaths, false);

export const validateRegistrationConfigurationSource = async (
  source: string,
  runtimePaths: ReviewPaths,
): Promise<ReviewConfiguration> => validateReviewConfigurationSource(source, runtimePaths, true);
