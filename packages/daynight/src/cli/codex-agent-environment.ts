import path from "node:path";

const object = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Preserve the native configuration's PATH while keeping opted-in aliases first. */
export const codexAgentCliOverrides = (environment: Readonly<{ PATH: string; DN_CONFIG_DIR?: string }>, response: unknown): Record<string, string> => {
  const config = object(object(response)?.config);
  if (!config) throw new Error("Codex did not return its effective configuration; Agent CLI aliases cannot be applied safely.");
  const rawPolicy = config.shell_environment_policy;
  const policy = object(rawPolicy);
  if (rawPolicy != null && !policy) throw new Error("Codex returned an invalid shell environment policy.");
  const set = object(policy?.set);
  if (policy?.set != null && !set) throw new Error("Codex returned invalid shell environment overrides.");
  const configuredPath = set?.PATH;
  if (configuredPath !== undefined && typeof configuredPath !== "string") throw new Error("Codex returned a non-string shell PATH override.");
  // Prepared aliases always put their private directory first. Preserve the
  // configured tail verbatim, including an empty PATH and empty path entries.
  const directory = environment.PATH.split(path.delimiter)[0]!;
  if (!path.isAbsolute(directory)) throw new Error("Agent CLI aliases require an absolute private PATH directory.");
  return {
    "shell_environment_policy.set.PATH": configuredPath === undefined ? environment.PATH : `${directory}${path.delimiter}${configuredPath}`,
    ...(environment.DN_CONFIG_DIR === undefined ? {} : { "shell_environment_policy.set.DN_CONFIG_DIR": environment.DN_CONFIG_DIR }),
  };
};
