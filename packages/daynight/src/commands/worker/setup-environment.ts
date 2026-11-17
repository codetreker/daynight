import { valid, gte } from "semver";
import { createOperation } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import type { WorkerAgent } from "../../api/types.js";
import { hasOwnedCommandCleanupFailure, runOwnedCommand } from "./owned-command.js";
import type { OwnedCommand, OwnedCommandResult } from "./owned-command.js";

export type WorkerEnvironmentCheck = {
  label: string;
  status: "passed" | "missing" | "unverified";
  detail: string;
  remedy?: string;
  agent?: WorkerAgent;
};

export type WorkerEnvironmentOptions = {
  workingDirectory: string;
  signal: AbortSignal;
  configuration?: { agent: WorkerAgent; model: string | null; args: readonly string[] };
};

export type WorkerEnvironmentDependencies = {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  runCommand?: (command: OwnedCommand, operation: Operation) => Promise<OwnedCommandResult>;
};

type Probe = { label: string; remedy: string; verify: (operation: Operation) => Promise<string> };

const record = async (probe: Probe, operation: Operation): Promise<WorkerEnvironmentCheck> => {
  operation.check();
  try {
    const detail = await probe.verify(operation);
    operation.check();
    return { label: probe.label, status: "passed", detail };
  } catch (cause) {
    if (hasOwnedCommandCleanupFailure(cause)) throw cause;
    operation.check();
    return { label: probe.label, status: "missing", detail: cause instanceof Error ? cause.message : "The prerequisite check failed.", remedy: probe.remedy };
  }
};

const inspectProbes = async (probes: readonly Probe[], operation: Operation): Promise<WorkerEnvironmentCheck[]> => {
  const results = await Promise.allSettled(probes.map((probe) => record(probe, operation)));
  for (const result of results) {
    if (result.status === "rejected" && hasOwnedCommandCleanupFailure(result.reason)) throw result.reason;
  }
  operation.check();
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
};

export const inspectWorkerEnvironment = async (
  options: WorkerEnvironmentOptions,
  dependencies: WorkerEnvironmentDependencies = {},
): Promise<readonly WorkerEnvironmentCheck[]> => {
  options.signal.throwIfAborted();
  const platform = dependencies.platform === undefined ? process.platform : dependencies.platform;
  const environment = { ...(dependencies.environment === undefined ? process.env : dependencies.environment) };
  const runCommand = dependencies.runCommand === undefined ? runOwnedCommand : dependencies.runCommand;
  const operation = createOperation({ signal: options.signal, limits: { totalMs: 30_000, requestMs: 10_000, totalBytes: 4 * 1_048_576 } });
  try {
    if (options.configuration !== undefined) {
      return [{ label: `${options.configuration.agent} Web session runtime`, status: "unverified", agent: options.configuration.agent,
        detail: "The Controller verifies native authentication, capabilities and working-directory identity before dispatching task input.",
        remedy: `Authenticate ${options.configuration.agent} before starting the Web worker.` }];
    }
    const probes: Probe[] = [{
      label: "Operating system", remedy: "Run the worker on Linux, macOS or Windows.",
      verify: async () => {
        if (!["linux", "darwin", "win32"].includes(platform)) throw new Error(`Unsupported worker platform: ${platform}.`);
        return platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
      },
    }, {
      label: "Node.js", remedy: "Install Node.js 22 or newer and run Daynight with it.",
      verify: async () => {
        const version = dependencies.nodeVersion === undefined ? process.versions.node : dependencies.nodeVersion;
        if (valid(version) === null || !gte(version, "22.0.0")) throw new Error("Daynight requires Node.js 22 or newer.");
        return version;
      },
    }, {
      label: "Git", remedy: "Install Git and make it available on PATH.",
      verify: async (scope) => {
        const { stdout } = await runCommand({ file: "git", args: ["--version"], environment, cwd: options.workingDirectory }, scope);
        const match = /^git version ([^\r\n]+)/m.exec(stdout);
        if (match === null) throw new Error("Cannot identify the installed Git executable.");
        return match[1]!;
      },
    }];
    const checks = await inspectProbes(probes, operation);
    operation.check();
    return [...checks, {
      label: "Task tools and Git transport", status: "unverified",
      detail: "Project Git access and task-specific tools are checked when the actual task uses them.",
      remedy: "Prepare Git credentials and task tools, including an authenticated GitHub CLI when PR delivery requires it.",
    }, {
      label: "Web Controller and native execution", status: "unverified",
      detail: "The Daynight relay and native Controller capabilities are verified by worker run.",
    }];
  } finally { operation.dispose(); }
};
