import { valid, gte } from "semver";
import { createOperation } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import type { AgentControlMode, WorkerAgent } from "../../api/types.js";
import { runHerdrCommand } from "./herdr/command.js";
import { resolveHerdrInstancePaths } from "./herdr/instance.js";
import { createNativePrerequisiteChecks, hasNativePrerequisiteCleanupFailure, nativeHookRuntimeChecks } from "./herdr/preflight.js";
import type { NativePrerequisiteCheck, NativePrerequisiteCommandRunner } from "./herdr/preflight.js";
import type { WorkerPaths } from "./paths.js";
import { createWorkerPromptBuilder } from "./prompts.js";

export type WorkerEnvironmentCheck = {
  label: string;
  status: "passed" | "missing" | "unverified";
  detail: string;
  remedy?: string;
  agent?: WorkerAgent;
};

export type WorkerEnvironmentOptions = {
  homeDirectory: string;
  workingDirectory: string;
  paths: WorkerPaths;
  signal: AbortSignal;
  packageDirectory?: string;
  agentControlMode?: AgentControlMode;
  configuration?: { agent: WorkerAgent; model: string | null; args: readonly string[] };
};

export type WorkerEnvironmentDependencies = {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  runCommand?: NativePrerequisiteCommandRunner;
  verifySkill?: typeof createWorkerPromptBuilder;
};

type Probe = Pick<NativePrerequisiteCheck, "label" | "remedy" | "verify"> & { agent?: WorkerAgent };

const record = async (probe: Probe, operation: Operation): Promise<WorkerEnvironmentCheck> => {
  operation.check();
  const identity = { label: probe.label, ...(probe.agent === undefined ? {} : { agent: probe.agent }) };
  try {
    const detail = await probe.verify(operation);
    operation.check();
    return { ...identity, status: "passed", detail };
  } catch (cause) {
    if (hasNativePrerequisiteCleanupFailure(cause)) throw cause;
    operation.check();
    return { ...identity, status: "missing", detail: cause instanceof Error ? cause.message : "The prerequisite check failed.", remedy: probe.remedy };
  }
};

const integrationState = (source: string, agent: WorkerAgent): string => {
  const matches = [...source.matchAll(new RegExp(`^${agent}: ([a-z_]+)(?:\\s|$)`, "gm"))];
  if (matches.length !== 1) throw new Error(`Herdr did not report exactly one ${agent} integration state.`);
  const state = matches[0]![1]!;
  if (state !== "current") throw new Error(`The official ${agent} Herdr integration is ${state}.`);
  return "The installed official integration is current.";
};

const inspectProbes = async (probes: readonly Probe[], operation: Operation): Promise<WorkerEnvironmentCheck[]> => {
  const results = await Promise.allSettled(probes.map((probe) => record(probe, operation)));
  for (const result of results) {
    if (result.status === "rejected" && hasNativePrerequisiteCleanupFailure(result.reason)) throw result.reason;
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
  const runCommand = dependencies.runCommand === undefined ? runHerdrCommand : dependencies.runCommand;
  const operation = createOperation({ signal: options.signal, limits: { totalMs: 30_000, requestMs: 10_000, totalBytes: 4 * 1_048_576 } });
  const command = async (file: string, args: readonly string[], scope: Operation): Promise<string> =>
    (await runCommand({ file, args, environment, cwd: options.workingDirectory }, scope)).stdout;
  try {
    if (options.configuration !== undefined && options.agentControlMode === "web") {
      return [{ label: `${options.configuration.agent} Web session runtime`, status: "unverified", agent: options.configuration.agent,
        detail: "The Controller verifies native authentication, capabilities and working-directory identity before dispatching task input.",
        remedy: `Authenticate ${options.configuration.agent} before starting the Web worker.` }];
    }
    if (options.configuration !== undefined) {
      const { agent } = options.configuration;
      const probes = createNativePrerequisiteChecks({ homeDirectory: options.homeDirectory, environment, platform, runCommand }, {
        context: { cwd: options.workingDirectory }, configuration: options.configuration,
      }).filter(({ kind }) => kind !== "version" && kind !== "runtime");
      const checks = await inspectProbes(probes.map((probe) => ({ ...probe, agent })), operation);
      operation.check();
      return [...checks, {
        label: `${agent} provider authentication`, status: "unverified", agent,
        detail: "Read-only configuration checks do not prove provider authentication or execution in a future task worktree.",
        remedy: `Authenticate the ${agent} CLI before unattended task execution; the worker supplies full-access and task-directory trust settings for each launch.`,
      }];
    }

    let integrations: Promise<string> | undefined;
    const readIntegrations = (scope: Operation): Promise<string> => {
      if (integrations === undefined) integrations = command("herdr", ["integration", "status"], scope);
      return integrations;
    };
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
        const output = await command("git", ["--version"], scope);
        const match = /^git version ([^\r\n]+)/m.exec(output);
        if (match === null) throw new Error("Cannot identify the installed Git executable.");
        return match[1]!;
      },
    }, {
      label: "Herdr", remedy: "Install Herdr 0.9.5 or newer and make it available on PATH.",
      verify: async (scope) => {
        const output = await command("herdr", ["--version"], scope);
        const match = /^herdr (\S+)\s*$/m.exec(output);
        if (match === null || valid(match[1]) === null || !gte(match[1]!, "0.9.5")) throw new Error("The worker requires Herdr 0.9.5 or newer.");
        return match[1]!;
      },
    }, {
      label: "Private Herdr endpoint", remedy: "Use an OS account whose home path fits the private Herdr socket or named-pipe limit.",
      verify: async () => { const paths = resolveHerdrInstancePaths(options.paths, platform); return paths.apiEndpoint; },
    }, ...nativeHookRuntimeChecks({ environment, cwd: options.workingDirectory, platform, runCommand }), {
      label: "Bundled using-daynight skill", remedy: "Reinstall or update the Daynight npm package to restore its complete bundled skill.",
      verify: async (scope) => {
        if (options.packageDirectory === undefined) throw new Error("The installed package directory is unavailable for skill inspection.");
        const verify = dependencies.verifySkill === undefined ? createWorkerPromptBuilder : dependencies.verifySkill;
        await verify(options.packageDirectory);
        scope.check();
        return "The installed bundle includes the managed execution references.";
      },
    }];
    for (const agent of ["codex", "copilot", "claude"] as const) {
      const [, version] = createNativePrerequisiteChecks({ homeDirectory: options.homeDirectory, environment, platform, runCommand }, {
        context: { cwd: options.workingDirectory }, configuration: { agent, model: null, args: [] },
      });
      probes.push({ ...version, agent }, {
        label: `${agent} Herdr integration`, agent,
        remedy: `Run herdr integration install ${agent}, then inspect herdr integration status.`,
        verify: async (scope) => integrationState(await readIntegrations(scope), agent),
      });
    }
    const selected = options.agentControlMode === "web" ? probes.filter(probe => ["Operating system", "Node.js", "Git", "Bundled using-daynight skill"].includes(probe.label)) : probes;
    const checks = await inspectProbes(selected, operation);
    operation.check();
    const bundleChecks = options.packageDirectory === undefined
      ? checks.map((check) => check.label === "Bundled using-daynight skill" ? { ...check, status: "unverified" as const } : check)
      : checks;
    return [...bundleChecks, {
      label: "Task tools and Git transport", status: "unverified",
      detail: "Project Git access and task-specific tools are checked when the actual task uses them.",
      remedy: "Prepare Git credentials and task tools, including an authenticated GitHub CLI when PR delivery requires it.",
    }, {
      label: options.agentControlMode === "web" ? "Web Controller and native execution" : "Live Herdr protocol and native execution", status: "unverified",
      detail: options.agentControlMode === "web" ? "The Daynight relay and native Controller capabilities are verified by worker run." : "The private daemon protocol, capabilities and real native startup are verified by worker run.",
    }];
  } finally { operation.dispose(); }
};
