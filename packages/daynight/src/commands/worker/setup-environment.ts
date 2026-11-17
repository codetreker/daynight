import { valid, gte } from "semver";
import { createOperation, type Operation } from "../../api/operation.js";
import type { WorkerAgent } from "../../api/types.js";
import type { ToolPaths } from "../../platform/tool-path-choice.js";
import { hasOwnedCommandCleanupFailure, runOwnedCommand } from "./owned-command.js";
import type { WorkerPaths } from "./paths.js";

export type WorkerEnvironmentCheck = { label: string; status: "passed" | "missing" | "unverified"; detail: string; remedy?: string; agent?: WorkerAgent };
export type WorkerEnvironmentOptions = {
  homeDirectory: string; workingDirectory: string; paths: WorkerPaths; signal: AbortSignal;
  agentControlMode?: "web"; toolPaths?: ToolPaths;
  configuration?: { agent: WorkerAgent; model: string | null; args: readonly string[] };
};
export type WorkerEnvironmentDependencies = {
  environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; nodeVersion?: string; runCommand?: typeof runOwnedCommand;
};

export const inspectWorkerEnvironment = async (options: WorkerEnvironmentOptions, dependencies: WorkerEnvironmentDependencies = {}): Promise<readonly WorkerEnvironmentCheck[]> => {
  options.signal.throwIfAborted();
  const operation = createOperation({ signal: options.signal, limits: { totalMs: 30_000, requestMs: 10_000, totalBytes: 4 * 1_048_576 } });
  const check = async (label: string, remedy: string, verify: (scope: Operation) => Promise<string>): Promise<WorkerEnvironmentCheck> => {
    try { operation.check(); const detail = await verify(operation); operation.check(); return { label, status: "passed", detail }; }
    catch (error) {
      if (hasOwnedCommandCleanupFailure(error)) throw error;
      operation.check();
      return { label, status: "missing", detail: error instanceof Error ? error.message : "The prerequisite check failed.", remedy };
    }
  };
  try {
    if (options.configuration) return [{ label: `${options.configuration.agent} Web session runtime`, status: "unverified", agent: options.configuration.agent,
      detail: "The Controller verifies native authentication, capabilities and working-directory identity before dispatching task input.", remedy: `Authenticate ${options.configuration.agent} before starting the Web worker.` }];
    const platform = dependencies.platform ?? process.platform;
    const results = await Promise.allSettled([
      check("Operating system", "Run the worker on Linux, macOS or Windows.", async () => {
        if (!["linux", "darwin", "win32"].includes(platform)) throw new Error(`Unsupported worker platform: ${platform}.`);
        return platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
      }),
      check("Node.js", "Install Node.js 22 or newer and run Daynight with it.", async () => {
        const version = dependencies.nodeVersion ?? process.versions.node;
        if (valid(version) === null || !gte(version, "22.0.0")) throw new Error("Daynight requires Node.js 22 or newer.");
        return version;
      }),
      check("Git", "Install Git and make it available on PATH.", async scope => {
        const result = await (dependencies.runCommand ?? runOwnedCommand)({ file: "git", args: ["--version"], environment: dependencies.environment ?? process.env, cwd: options.workingDirectory }, scope);
        const match = /^git version ([^\r\n]+)/m.exec(result.stdout);
        if (!match) throw new Error("Cannot identify the installed Git executable.");
        return match[1]!;
      }),
    ]);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const checks = results.map(result => (result as PromiseFulfilledResult<WorkerEnvironmentCheck>).value);
    return [...checks, { label: "Task tools and Git transport", status: "unverified", detail: "Project Git access and task-specific tools are checked when the actual task uses them.", remedy: "Prepare Git credentials and task tools, including an authenticated GitHub CLI when PR delivery requires it." },
      { label: "Web Controller and native execution", status: "unverified", detail: "The Daynight relay and native Controller capabilities are verified by worker run." }];
  } finally { operation.dispose(); }
};
