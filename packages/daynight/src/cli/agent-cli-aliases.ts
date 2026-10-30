import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import which from "which";
import type { AgentCliAliases, AgentCliAliasName } from "../config/agent-cli-aliases.js";

export type AgentCliAliasBinding = {
  name: AgentCliAliasName;
  target: string;
  executable: string;
};

export type PreparedAgentCliAliases = {
  environment: NodeJS.ProcessEnv;
  bindings: readonly AgentCliAliasBinding[];
  directory: string | null;
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Prepare private command shims for a newly launched Agent. The caller retains
 * the directory while any descendant can use it; successful preparation does
 * not change process.env or remove another execution's shims.
 */
export const prepareAgentCliAliases = async (options: {
  aliases: AgentCliAliases;
  environment: NodeJS.ProcessEnv;
  stateDirectory: string;
}): Promise<PreparedAgentCliAliases> => {
  const entries = Object.entries(options.aliases) as [AgentCliAliasName, string][];
  if (entries.length === 0) return { environment: options.environment, bindings: [], directory: null };
  if (process.platform === "win32") throw new Error("agentCliAliases is supported only on macOS and Linux; remove the setting to use the unchanged Agent environment on Windows.");
  if (!path.isAbsolute(options.stateDirectory)) throw new TypeError("Agent CLI alias state directory must be absolute.");
  if (options.stateDirectory.includes(path.delimiter)) throw new TypeError("agentCliAliases requires DN_CONFIG_DIR without the PATH delimiter; choose a state directory without colons.");
  const bindings: AgentCliAliasBinding[] = [];
  // Resolve every target against the original PATH before creating any alias.
  // realpath pins a development entry's symlink to its immutable build snapshot.
  for (const [name, target] of entries) {
    let executable: string;
    try {
      const candidate = path.isAbsolute(target) ? target : await which(target, { path: options.environment.PATH ?? "", nothrow: false });
      executable = await realpath(candidate);
      if (!(await stat(executable)).isFile()) throw new Error("Target is not a regular file.");
      await access(executable, constants.X_OK);
    } catch (cause) {
      throw new Error(`Cannot resolve agentCliAliases.${name} to an executable; install its target or configure an absolute executable path.`, { cause });
    }
    bindings.push({ name, target, executable });
  }
  const parent = path.join(options.stateDirectory, "agent-cli-aliases");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(parent, "execution-"));
  try {
    await chmod(directory, 0o700);
    for (const binding of bindings) {
      await writeFile(path.join(directory, binding.name), `#!/bin/sh\nexec ${shellQuote(binding.executable)} "$@"\n`, { flag: "wx", mode: 0o700 });
    }
  } catch (cause) {
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
  return {
    environment: { ...options.environment, DN_CONFIG_DIR: options.stateDirectory, PATH: [directory, options.environment.PATH].filter(value => value !== undefined).join(path.delimiter) },
    bindings,
    directory,
  };
};
