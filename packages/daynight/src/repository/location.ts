import path from "node:path";
import type { ConfigurationPaths } from "../config/paths.js";
import type { PathApi } from "../platform/filesystem.js";
import { repositoryIdentity } from "./identity.js";

export const defaultRepositoryRoot = "~/daynights";

export const validateRepositoryRoot = (value: unknown, field: string, pathApi: PathApi = path): string => {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) throw new Error(`${field} must be a nonempty string without NUL characters.`);
  if (value.startsWith("~") && value !== "~" && !value.startsWith("~/") && !(pathApi.sep === "\\" && value.startsWith("~\\"))) {
    throw new Error(`${field} supports only the current user's home directory (~ or ~/), absolute paths, or config-directory-relative paths.`);
  }
  if (pathApi.sep === "\\" && /^[a-z]:(?![\\/])/i.test(value)) throw new Error(`${field} must not use a drive-relative Windows path.`);
  return value;
};

export const resolveRepositoryRoot = (
  configuredRoot: unknown,
  paths: Pick<ConfigurationPaths, "configFile">,
  homeDirectory: string,
  field: string,
  pathApi: PathApi = path,
): string => {
  const root = validateRepositoryRoot(configuredRoot, field, pathApi);
  if (!pathApi.isAbsolute(homeDirectory)) throw new Error("The current user's home directory must be an absolute path.");
  return root === "~" || root.startsWith("~/") || (pathApi.sep === "\\" && root.startsWith("~\\"))
    ? pathApi.resolve(pathApi.join(homeDirectory, root.slice(2)))
    : pathApi.resolve(pathApi.dirname(paths.configFile), root);
};

export const repositoryPathComponent = (component: string): string => {
  if (component === "") return "%00";
  let escaped = component.replace(/[%<>:"/\\|?*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\.+$/, (dots) => "%2E".repeat(dots.length));
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(escaped)) escaped = `%${escaped.charCodeAt(0).toString(16).toUpperCase()}${escaped.slice(1)}`;
  return escaped;
};

export const repositoryLocation = (remote: string, root: string, pathApi: PathApi = path): string => {
  const identity = repositoryIdentity(remote);
  let components: string[];
  if (identity.startsWith("scp://")) {
    const remainder = identity.slice("scp://".length);
    let delimiter = remainder.indexOf(":");
    const bracket = remainder.indexOf("[");
    if (bracket >= 0 && bracket < delimiter) delimiter = remainder.indexOf("]:", bracket) + 1;
    components = ["@remote", "scp", remainder.slice(0, delimiter), ...remainder.slice(delimiter + 1).split("/")];
  } else if (identity.includes("://")) {
    const match = /^(https|ssh):\/\/([^/]+)\/(.*)$/.exec(identity)!;
    components = ["@remote", match[1]!, match[2]!, ...match[3]!.split("/")];
  } else components = identity.split("/");
  // We reserve @remote because canonical hosts cannot contain @, keeping transport, user and port identities separate from ordinary clones.
  return pathApi.join(root, ...components.map(repositoryPathComponent));
};
