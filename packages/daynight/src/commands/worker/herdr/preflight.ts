import path from "node:path";
import { open } from "node:fs/promises";
import type { Operation } from "../../../api/operation.js";
import { validateHerdrAgentArguments } from "./arguments.js";
import { runHerdrCommand } from "./command.js";
import type { HerdrCommand, HerdrCommandResult } from "./command.js";
import type { HerdrRpcClient } from "./rpc.js";

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
type CommandRunner = (command: HerdrCommand, operation: Operation) => Promise<HerdrCommandResult>;
const metadataLimit = 1_048_576;

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
const readMetadata = async (file: string, operation: Operation, firstLine = false): Promise<string> => {
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
      const newline = firstLine ? chunk.indexOf(0x0a) : -1;
      const selected = newline < 0 ? chunk : chunk.subarray(0, newline);
      bytes += selected.length;
      if (bytes > metadataLimit) throw new Error(`Native metadata ${file} exceeds the supported one MiB header/configuration limit.`);
      chunks.push(selected);
      if (newline >= 0) break;
    }
    operation.check();
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
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

export const createHerdrPreflight = (options: {
  rpc: Pick<HerdrRpcClient, "request">;
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
  platform?: NodeJS.Platform;
  runCommand?: CommandRunner;
}) => {
  const home = absolute(options.homeDirectory, "Native user home");
  const platform = options.platform === undefined ? process.platform : options.platform;
  const environment = { ...options.environment };
  const runCommand = options.runCommand === undefined ? runHerdrCommand : options.runCommand;
  return {
    verifyStart: async (input: HerdrNativeStart, operation: Operation): Promise<HerdrNativePreflight> => {
      operation.check();
      const agent = input.configuration.agent;
      if (agent !== "codex" && agent !== "copilot") throw new Error("The native agent must be codex or copilot.");
      const cwd = absolute(input.context.cwd, "Native working directory");
      validateHerdrAgentArguments(agent, input.configuration.args);
      const root = nativeHome(agent, environment, home);
      const versionText = (await runCommand({ file: agent, args: ["--version"], environment, cwd }, operation)).stdout;
      const versionMatch = agent === "codex" ? /^codex-cli (\d+\.\d+\.\d+)(?:\s|$)/m.exec(versionText) : /^GitHub Copilot CLI (\d+\.\d+\.\d+)(?:[.\s]|$)/m.exec(versionText);
      if (versionMatch === null) throw new Error(`Cannot identify the installed ${agent} executable version.`);
      const integrations = await options.rpc.request("integration.list", {}, operation);
      if (integrations.type !== "integration_list" || !Array.isArray(integrations.integrations)) throw new Error("Herdr returned invalid integration metadata.");
      const installed = integrations.integrations.filter((value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) && (value as Record<string, unknown>).target === agent);
      if (installed.length !== 1 || (installed[0] as Record<string, unknown>).state !== "current") throw new Error(`The official ${agent} Herdr integration is missing or outdated; inspect it with herdr integration list and configure it explicitly.`);
      const runtimes = platform === "win32"
        ? [{ file: "powershell", args: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], version: /^\d+\.\d+/m }]
        : [{ file: "bash", args: ["--version"], version: /^GNU bash, version /m }, { file: "python3", args: ["--version"], version: /^Python 3\./m }];
      for (const runtime of runtimes) {
        let output: string;
        try { output = (await runCommand({ file: runtime.file, args: runtime.args, environment, cwd }, operation)).stdout; }
        catch (cause) { operation.check(); throw new Error(`The official ${agent} Herdr hook requires the ${runtime.file} runtime to be available.`, { cause }); }
        if (!runtime.version.test(output)) throw new Error(`Cannot identify the ${runtime.file} runtime required by the official ${agent} Herdr hook.`);
      }
      const asset = path.join(root, ...(agent === "copilot" ? ["hooks"] : []), platform === "win32" ? "herdr-agent-state.ps1" : "herdr-agent-state.sh");
      await readMetadata(asset, operation);
      const expected = hookCommand(asset, agent, platform);
      if (agent === "codex") {
        const help = (await runCommand({ file: agent, args: ["--help"], environment, cwd }, operation)).stdout;
        if (!help.includes("--no-daemon")) throw new Error("This Codex executable lacks --no-daemon; a worker requires isolated native execution without a shared human daemon.");
        const config = codexConfigurationArguments(input.configuration.args);
        let features: string;
        try { features = (await runCommand({ file: agent, args: [...config.arguments, "features", "list"], environment, cwd }, operation)).stdout; }
        catch (cause) {
          operation.check();
          // Codex 0.164 rejects profile selection for this read-only command; checking its unrelated default configuration would be incorrect.
          // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/cli/src/main.rs#L1977-L2003
          if (config.profile) throw new Error("Codex cannot verify effective hook configuration for the selected profile with its read-only features command; use supported explicit --config/--enable/--disable settings or a CLI with profile-aware feature inspection.", { cause });
          throw cause;
        }
        if (!features.split(/\r?\n/).some((line) => /^hooks\s+\S+\s+true\s*$/.test(line))) throw new Error("Codex hooks are disabled; enable the official SessionStart integration explicitly before running the worker.");
        const file = json(await readMetadata(path.join(root, "hooks.json"), operation), "Codex hooks configuration");
        if (!configuredHook(mapping(file.hooks, "Codex hooks configuration hooks"), expected, agent, platform)) throw new Error("Codex SessionStart does not invoke the installed official Herdr hook; configure and trust that hook explicitly.");
      } else {
        const effective = json((await runCommand({ file: agent, args: ["config", "hooks"], environment, cwd }, operation)).stdout, "Copilot effective hooks configuration");
        if (!configuredHook(effective, expected, agent, platform)) throw new Error("Copilot SessionStart does not invoke the installed official Herdr hook; configure it explicitly.");
      }
      operation.check();
      return { agent, version: versionMatch[1]!, nativeHome: root, integrationConfigured: true };
    },
  };
};

export type HerdrPreflight = ReturnType<typeof createHerdrPreflight>;
