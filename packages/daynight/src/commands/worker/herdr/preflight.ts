import path from "node:path";
import { open, realpath } from "node:fs/promises";
import { gte } from "semver";
import type { Operation } from "../../../api/operation.js";
import { codexProjectTrustArguments, nativeAgentPermissionArguments, nativeAgentPermissionEnvironment, validateHerdrAgentArguments } from "./arguments.js";
import { runHerdrCommand } from "./command.js";
import type { HerdrCommand, HerdrCommandResult } from "./command.js";
import type { HerdrRpcClient } from "./rpc.js";
import { assertCodexInstallConfigurationSafe } from "./codex-install-safety.js";

type NativeAgent = "codex" | "copilot";
export type HerdrNativeStart = {
  context: { cwd: string };
  configuration: { agent: NativeAgent; model: string | null; args: readonly string[] };
  resumeSessionId?: string;
};
export type HerdrNativePreflight = {
  agent: NativeAgent;
  version: string;
  nativeHome: string;
  integrationConfigured: true;
};
export type NativePrerequisiteCommandRunner = (command: HerdrCommand, operation: Operation) => Promise<HerdrCommandResult>;
export type NativePrerequisiteCheck = {
  kind: "home" | "version" | "runtime" | "configuration";
  label: string;
  remedy: string;
  verify: (operation: Operation) => Promise<string>;
};

export const hasNativePrerequisiteCleanupFailure = (cause: unknown): boolean => {
  // Command cleanup is aggregated; cancellation must preserve evidence that an owned process may still be running.
  let failure = cause;
  while (failure instanceof Error) {
    if (failure instanceof AggregateError) return true;
    failure = failure.cause;
  }
  return false;
};
const metadataLimit = 1_048_576;
type IntegrationState = "not_installed" | "current" | "outdated";

const integrationState = (result: Record<string, unknown>, agent: NativeAgent): IntegrationState => {
  if (result.type !== "integration_list" || !Array.isArray(result.integrations)) throw new Error("Herdr returned invalid integration metadata.");
  const targets = new Set<string>();
  let state: IntegrationState | undefined;
  for (const value of result.integrations as unknown[]) {
    const info = mapping(value, "Herdr integration metadata");
    if (typeof info.target !== "string" || info.target === "" || targets.has(info.target) ||
      typeof info.label !== "string" || typeof info.command !== "string" || typeof info.available !== "boolean" ||
      (info.state !== "not_installed" && info.state !== "current" && info.state !== "outdated")) {
      throw new Error("Herdr returned invalid integration metadata.");
    }
    targets.add(info.target);
    if (info.target === agent) state = info.state;
  }
  if (state === undefined) throw new Error(`Herdr integration metadata does not contain the ${agent} target.`);
  return state;
};

const mapping = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
};
const json = (source: string, label: string): Record<string, unknown> => {
  let decoded: unknown;
  try { decoded = JSON.parse(source) as unknown; }
  // Parser exceptions can echo private configuration bytes; diagnostics retain the failing subject without that excerpt.
  catch { throw new Error(`${label} is not valid JSON; inspect the native configuration without exposing its contents.`); }
  return mapping(decoded, label);
};
const absolute = (value: string, label: string): string => {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`${label} must be an absolute path; expand native home overrides before starting the worker.`);
  return path.normalize(value);
};
const nativeHome = (agent: NativeAgent, environment: NodeJS.ProcessEnv, home: string): string => {
  const key = agent === "codex" ? "CODEX_HOME" : "COPILOT_HOME";
  const value = environment[key];
  return value === undefined ? path.join(home, `.${agent}`) : absolute(value, key);
};
const readMetadata = async (file: string, operation: Operation, preserveBom = false): Promise<string> => {
  operation.check();
  const handle = await open(file, "r");
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      operation.check();
      const buffer = Buffer.alloc(16_384);
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      operation.consume(result.bytesRead);
      const chunk = buffer.subarray(0, result.bytesRead);
      bytes += chunk.length;
      if (bytes > metadataLimit) throw new Error(`Native metadata ${file} exceeds the supported one MiB header/configuration limit.`);
      chunks.push(chunk);
    }
    operation.check();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: preserveBom }).decode(Buffer.concat(chunks));
  } finally { await handle.close(); }
};
const hookCommand = (file: string, agent: NativeAgent, platform: NodeJS.Platform): string => {
  const command = platform === "win32" ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${file.replaceAll('"', '\\"')}"` : `bash '${file.replaceAll("'", "'\"'\"'")}'`;
  return agent === "codex" ? `${command} session` : command;
};
const configuredHook = (hooks: Record<string, unknown>, expected: string, agent: NativeAgent, platform: NodeJS.Platform): boolean => {
  const entries = hooks[agent === "codex" ? "SessionStart" : "sessionStart"];
  if (!Array.isArray(entries)) return false;
  return entries.some((value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    if (entry.matcher !== undefined && entry.matcher !== "") return false;
    const commands = agent === "codex" ? entry.hooks : [entry];
    return Array.isArray(commands) && commands.some((item: unknown) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
      const hook = item as Record<string, unknown>;
      return hook.type === "command" && hook.enabled !== false && hook[agent === "codex" ? "command" : platform === "win32" ? "powershell" : "bash"] === expected;
    });
  });
};

const codexConfigurationArguments = (args: readonly string[]): { arguments: string[]; profile: boolean } => {
  const relevant = new Set(["-c", "--config", "--enable", "--disable", "-p", "--profile"]);
  const selected: string[] = [];
  let profile = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const equals = argument.indexOf("=");
    const option = equals < 0 ? argument : argument.slice(0, equals);
    if (!relevant.has(option)) continue;
    profile ||= option === "-p" || option === "--profile";
    selected.push(argument);
    if (equals < 0) selected.push(args[++index]!);
  }
  return { arguments: selected, profile };
};

export const nativeHookRuntimeChecks = (options: {
  environment: NodeJS.ProcessEnv;
  cwd: string;
  platform: NodeJS.Platform;
  runCommand?: NativePrerequisiteCommandRunner;
}): readonly NativePrerequisiteCheck[] => {
  const runCommand = options.runCommand === undefined ? runHerdrCommand : options.runCommand;
  const runtimes = options.platform === "win32"
    ? [{ file: "powershell", args: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], version: /^\d+\.\d+/m }]
    : [{ file: "bash", args: ["--version"], version: /^GNU bash, version /m }, { file: "python3", args: ["--version"], version: /^Python 3\./m }];
  return runtimes.map((runtime) => ({
    kind: "runtime", label: `${runtime.file} hook runtime`,
    remedy: `Install ${runtime.file} and make it available on PATH for the official Herdr hook.`,
    verify: async (operation) => {
      let output: string;
      try { output = (await runCommand({ file: runtime.file, args: runtime.args, environment: options.environment, cwd: options.cwd }, operation)).stdout; }
      catch (cause) {
        if (!hasNativePrerequisiteCleanupFailure(cause)) operation.check();
        throw new Error(`The official Herdr hook requires the ${runtime.file} runtime to be available.`, { cause });
      }
      if (!runtime.version.test(output)) throw new Error(`Cannot identify the ${runtime.file} runtime required by the official Herdr hook.`);
      return output.split(/\r?\n/)[0]!;
    },
  }));
};

export const createNativePrerequisiteChecks = (options: {
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
  platform?: NodeJS.Platform;
  runCommand?: NativePrerequisiteCommandRunner;
}, input: HerdrNativeStart): readonly [NativePrerequisiteCheck, NativePrerequisiteCheck, ...NativePrerequisiteCheck[]] => {
  const home = absolute(options.homeDirectory, "Native user home");
  const platform = options.platform === undefined ? process.platform : options.platform;
  const runCommand = options.runCommand === undefined ? runHerdrCommand : options.runCommand;
  const agent = input.configuration.agent;
  if (agent !== "codex" && agent !== "copilot") throw new Error("The native agent must be codex or copilot.");
  const environment = { ...options.environment, ...nativeAgentPermissionEnvironment(agent) };
  const cwd = absolute(input.context.cwd, "Native working directory");
  validateHerdrAgentArguments(agent, input.configuration.args);
  const root = (): string => nativeHome(agent, environment, home);
  const asset = (): string => path.join(root(), ...(agent === "copilot" ? ["hooks"] : []), platform === "win32" ? "herdr-agent-state.ps1" : "herdr-agent-state.sh");
  const checks: [NativePrerequisiteCheck, NativePrerequisiteCheck, ...NativePrerequisiteCheck[]] = [{
    kind: "home", label: `${agent} native directories`,
    remedy: `Set ${agent === "codex" ? "CODEX_HOME and CODEX_SQLITE_HOME" : "COPILOT_HOME"} to absolute paths, or unset the overrides to use their native defaults.`,
    verify: async (operation) => {
      operation.check();
      const directory = root();
      if (agent === "codex" && environment.CODEX_SQLITE_HOME !== undefined) absolute(environment.CODEX_SQLITE_HOME, "CODEX_SQLITE_HOME");
      return directory;
    },
  }, {
    kind: "version", label: `${agent} executable`,
    remedy: `Install or update the ${agent} CLI and make it available on PATH.`,
    verify: async (operation) => {
      const output = (await runCommand({ file: agent, args: ["--version"], environment, cwd }, operation)).stdout;
      const match = agent === "codex" ? /^codex-cli (\d+\.\d+\.\d+)(?:\s|$)/m.exec(output) : /^GitHub Copilot CLI (\d+\.\d+\.\d+)(?:[.\s]|$)/m.exec(output);
      if (match === null) throw new Error(`Cannot identify the installed ${agent} executable version.`);
      // Earlier releases expose the bypass flag while still showing an interactive startup hook review.
      // https://github.com/openai/codex/commit/5fb5e47767ac4910f7c208481c23bf4d2fe5cf62
      if (agent === "codex" && !gte(match[1]!, "0.135.0")) throw new Error("Codex 0.135.0 or newer is required to bypass startup hook trust review.");
      return match[1]!;
    },
  }, ...nativeHookRuntimeChecks({ environment, cwd, platform, runCommand }), {
    kind: "configuration", label: `${agent} official hook asset`,
    remedy: `Run herdr integration install ${agent}, then inspect herdr integration status.`,
    verify: async (operation) => { const file = asset(); await readMetadata(file, operation); return file; },
  }];
  checks.push({
    kind: "configuration", label: `${agent} unattended full access`,
    remedy: `Update ${agent} to a version supporting all worker permission flags${agent === "codex" ? " and --no-daemon" : ""}.`,
    verify: async (operation) => {
      const required = agent === "codex" ? ["--no-daemon", ...nativeAgentPermissionArguments(agent)] : nativeAgentPermissionArguments(agent);
      const help = (await runCommand({ file: agent, args: [...required, "--help"], environment, cwd }, operation)).stdout;
      for (const flag of required.filter((value) => value !== "--no-sandbox")) {
        if (!help.includes(flag)) throw new Error(`This ${agent} executable lacks ${flag}; a worker requires unattended full access and isolated native execution.`);
      }
      return "The worker permission flags are supported together.";
    },
  });
  if (agent === "codex") checks.push({
    kind: "configuration", label: "codex effective hooks feature",
    remedy: "Enable Codex hooks in the effective configuration used by this worker; inspect codex features list with the same configuration overrides.",
    verify: async (operation) => {
      const config = codexConfigurationArguments(input.configuration.args);
      const canonicalCwd = path.normalize(await realpath(cwd));
      let features: string;
      try { features = (await runCommand({ file: agent, args: [...config.arguments, ...codexProjectTrustArguments(canonicalCwd), "features", "list"], environment, cwd: canonicalCwd }, operation)).stdout; }
      catch (cause) {
        if (!hasNativePrerequisiteCleanupFailure(cause)) operation.check();
        // Codex 0.164 rejects profile selection for this read-only command; checking its unrelated default configuration would be incorrect.
        // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/cli/src/main.rs#L1977-L2003
        if (config.profile) throw new Error("Codex cannot verify effective hook configuration for the selected profile with its read-only features command; use supported explicit --config/--enable/--disable settings or a CLI with profile-aware feature inspection.", { cause });
        throw cause;
      }
      if (!features.split(/\r?\n/).some((line) => /^hooks\s+\S+\s+true\s*$/.test(line))) throw new Error("Codex hooks are disabled; enable the official SessionStart integration explicitly before running the worker.");
      return "The hooks feature is enabled in the inspected working directory.";
    },
  });
  checks.push({
    kind: "configuration", label: `${agent} effective SessionStart hook`,
    remedy: `Run herdr integration install ${agent}, then configure its SessionStart hook.`,
    verify: async (operation) => {
      const expected = hookCommand(asset(), agent, platform);
      if (agent === "codex") {
        const file = json(await readMetadata(path.join(root(), "hooks.json"), operation), "Codex hooks configuration");
        if (!configuredHook(mapping(file.hooks, "Codex hooks configuration hooks"), expected, agent, platform)) throw new Error("Codex SessionStart does not invoke the installed official Herdr hook; configure that hook explicitly.");
      } else {
        const effective = json((await runCommand({ file: agent, args: ["config", "hooks"], environment, cwd }, operation)).stdout, "Copilot effective hooks configuration");
        if (!configuredHook(effective, expected, agent, platform)) throw new Error("Copilot SessionStart does not invoke the installed official Herdr hook; configure it explicitly.");
      }
      return "The inspected SessionStart configuration invokes the official Herdr hook.";
    },
  });
  return checks;
};

export const createHerdrPreflight = (options: {
  rpc: Pick<HerdrRpcClient, "request">;
  assertIntegrationEnvironment: (root: string) => void;
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
  platform?: NodeJS.Platform;
  runCommand?: NativePrerequisiteCommandRunner;
}) => {
  const home = absolute(options.homeDirectory, "Native user home");
  const environment = { ...options.environment };
  return {
    verifyStart: async (input: HerdrNativeStart, operation: Operation): Promise<HerdrNativePreflight> => {
      operation.check();
      const agent = input.configuration.agent;
      const [directories, executable, ...checks] = createNativePrerequisiteChecks({ ...options, environment, homeDirectory: home }, input);
      const root = await directories.verify(operation);
      const version = await executable.verify(operation);
      operation.check();
      const integrations = await options.rpc.request("integration.list", {}, operation);
      operation.check();
      if (integrationState(integrations, agent) !== "current") {
        if (agent === "codex") {
          options.assertIntegrationEnvironment(root);
          const pong = await options.rpc.request("ping", {}, operation);
          operation.check();
          if (pong.type !== "pong" || pong.version !== "0.9.5" || pong.protocol !== 22 ||
            typeof pong.capabilities !== "object" || pong.capabilities === null || Array.isArray(pong.capabilities)) {
            throw new Error("Cannot safely install the Codex integration: the configuration rewrite is audited only for Herdr 0.9.5 with protocol 22 and server capabilities.");
          }
          let source: string;
          try { source = await readMetadata(path.join(root, "config.toml"), operation, true); }
          catch (cause) {
            if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
            source = "";
          }
          operation.check();
          assertCodexInstallConfigurationSafe(source);
          operation.check();
          options.assertIntegrationEnvironment(root);
        }
        const installed = await options.rpc.request("integration.install", { target: agent }, operation);
        operation.check();
        if (installed.type !== "integration_install" || installed.target !== agent) throw new Error("Herdr returned an invalid integration install result.");
        const details = mapping(installed.details, "Herdr integration install result details");
        if (!Array.isArray(details.messages) || !details.messages.every((message: unknown) => typeof message === "string")) throw new Error("Herdr returned an invalid integration install result.");
        const refreshed = await options.rpc.request("integration.list", {}, operation);
        operation.check();
        if (integrationState(refreshed, agent) !== "current") throw new Error(`The official ${agent} Herdr integration is not current after installation; inspect herdr integration status.`);
      }
      for (const check of checks) await check.verify(operation);
      operation.check();
      return { agent, version, nativeHome: root, integrationConfigured: true };
    },
  };
};

export type HerdrPreflight = ReturnType<typeof createHerdrPreflight>;
