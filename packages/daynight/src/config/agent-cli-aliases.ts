import path from "node:path";
import { parseConfigurationDocument } from "./document.js";
import { MissingConfigurationFileError } from "./errors.js";
import { readConfigurationSource } from "./files.js";
import type { ConfigurationPaths } from "./paths.js";

export type AgentCliAliasName = "daynight" | "dn";
export type AgentCliAliases = Readonly<Partial<Record<AgentCliAliasName, string>>>;

export const parseAgentCliAliases = (source: string, paths: ConfigurationPaths): AgentCliAliases => {
  const { mapping } = parseConfigurationDocument(source, paths);
  if (!Object.hasOwn(mapping, "agentCliAliases")) return {};
  const configured = mapping.agentCliAliases;
  if (typeof configured !== "object" || configured === null || Array.isArray(configured)) {
    throw new TypeError("agentCliAliases must be a mapping from command names to executable targets.");
  }
  const result: Partial<Record<AgentCliAliasName, string>> = {};
  for (const [name, target] of Object.entries(configured)) {
    if (name !== "daynight" && name !== "dn") throw new TypeError("agentCliAliases supports only daynight and dn command names.");
    if (typeof target !== "string" || !target.isWellFormed() || /\p{Cc}/u.test(target) ||
      !(path.isAbsolute(target) || /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(target))) {
      throw new TypeError(`agentCliAliases.${name} must be a command name or an absolute executable path, without arguments or control characters.`);
    }
    result[name] = target;
  }
  return result;
};

export const readAgentCliAliases = async (paths: ConfigurationPaths, signal?: AbortSignal): Promise<AgentCliAliases> => {
  let source: string;
  try { source = await readConfigurationSource(paths, signal); }
  catch (cause) {
    if (cause instanceof MissingConfigurationFileError) return {};
    throw cause;
  }
  return parseAgentCliAliases(source, paths);
};
