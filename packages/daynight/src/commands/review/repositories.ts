import path from "node:path";
import { Document } from "yaml";
import { verifyConfigurationUpdate } from "../../config/ownership.js";
import { parseConfigurationDocument } from "../../config/document.js";
import { repositoryPathComponent } from "../../repository/location.js";
import { updateConfigurationFile } from "../../config/files.js";
import type { ConfigurationUpdate } from "../../config/files.js";
import { defaultRepositoryRoot, remoteIdentity, reviewConfigurationMapping, resolveRepositoryRoot, validateConfigurationSource, validateRegistrationConfigurationSource } from "./config.js";
import type { RepositoryConfiguration } from "./config.js";
import { missingPathsReferToSameDirectory, resolvePhysicalDirectory } from "../../platform/filesystem.js";
import type { ReviewPaths } from "./paths.js";

export type AddRepositoryInput = { remote: string; path?: string };
export type AddRepositoryOptions = { workingDirectory: string; homeDirectory: string };
export type AddRepositoryResult = { repository: RepositoryConfiguration; added: boolean };

const reviewRepositoryOwnership = {
  section: "review", fields: ["repositoryRoot", "repositories"],
  retainedSequence: { field: "repositories", identity: "remote", fields: [] },
} as const;

const sameDirectory = async (first: string, second: string): Promise<boolean> => {
  const [left, right] = await Promise.all([resolvePhysicalDirectory(first), resolvePhysicalDirectory(second)]);
  if (left.ancestorIdentity !== right.ancestorIdentity || left.missingComponents.length !== right.missingComponents.length) {
    return false;
  }
  return left.missingComponents.every((component, index) => component === right.missingComponents[index]) ||
    missingPathsReferToSameDirectory(left.ancestorPath, left.missingComponents, right.missingComponents);
};

export const updateRepositoryConfiguration = async (
  source: string | undefined,
  input: AddRepositoryInput,
  runtimePaths: ReviewPaths,
  options: AddRepositoryOptions,
): Promise<ConfigurationUpdate<AddRepositoryResult>> => {
  const existing = source === undefined ? undefined : await validateRegistrationConfigurationSource(source, runtimePaths);
  const document = source === undefined ? new Document({ review: { repositoryRoot: defaultRepositoryRoot, repositories: [] } }) : parseConfigurationDocument(source, runtimePaths).document;
  const mapping = document.toJS() as Record<string, unknown>;
  const decoded = reviewConfigurationMapping(mapping);
  const root = document.hasIn(["review", "repositoryRoot"]) ? decoded.repositoryRoot : defaultRepositoryRoot;
  const identity = remoteIdentity(input.remote, "remote");
  const previous = existing?.repositories.find((repository) => repository.coordinate === identity.coordinate);
  if (previous !== undefined && input.path === undefined) {
    return { kind: "unchanged", result: { repository: previous, added: false } };
  }
  let repositoryPath: string;
  if (input.path === undefined) {
    repositoryPath = path.join(resolveRepositoryRoot(root, runtimePaths, options.homeDirectory), ...[identity.host, identity.owner, identity.name].map(repositoryPathComponent));
  } else {
    if (input.path.trim() === "" || input.path.includes("\0") || input.path.startsWith("~")) {
      throw new Error("path must be a nonempty absolute path or working-directory-relative path without NUL characters; expand ~ before passing --path.");
    }
    if (path.sep === "\\" && /^[a-z]:(?![\\/])/i.test(input.path)) {
      throw new Error("path must not use a drive-relative Windows path.");
    }
    repositoryPath = path.resolve(options.workingDirectory, input.path);
  }
  if (previous !== undefined) {
    if (await sameDirectory(previous.path, repositoryPath)) {
      return { kind: "unchanged", result: { repository: previous, added: false } };
    }
    throw new Error(`Repository ${identity.coordinate} is already configured at ${previous.path}; the requested path ${repositoryPath} differs.`);
  }
  if (!document.hasIn(["review", "repositoryRoot"])) {
    document.setIn(["review", "repositoryRoot"], defaultRepositoryRoot);
  }
  if (!document.hasIn(["review", "repositories"])) {
    document.setIn(["review", "repositories"], document.createNode([]));
  }
  document.addIn(["review", "repositories"], { remote: input.remote, path: repositoryPath });
  const updatedSource = document.toString();
  verifyConfigurationUpdate(mapping, parseConfigurationDocument(updatedSource, runtimePaths).mapping, reviewRepositoryOwnership);
  const configuration = await validateConfigurationSource(updatedSource, runtimePaths);
  const repository = configuration.repositories.at(-1)!;
  return { kind: "write", result: { repository, added: true }, source: updatedSource, ownership: reviewRepositoryOwnership };
};

export const addRepository = async (
  input: AddRepositoryInput,
  runtimePaths: ReviewPaths,
  options: AddRepositoryOptions,
): Promise<AddRepositoryResult> => {
  if (!path.isAbsolute(options.workingDirectory) || !path.isAbsolute(options.homeDirectory)) {
    throw new Error("The working directory and home directory must be absolute paths.");
  }
  return updateConfigurationFile(runtimePaths, (source) => updateRepositoryConfiguration(source, input, runtimePaths, options));
};
