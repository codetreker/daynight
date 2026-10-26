import path from "node:path";
import { open, readdir, realpath } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { Operation } from "../../../api/operation.js";
import { canonicalId } from "../../../api/parse.js";
import { runHerdrCommand } from "./command.js";
import type { HerdrCommand, HerdrCommandResult } from "./command.js";
import type { HerdrRpcClient } from "./rpc.js";

type NativeAgent = "codex" | "copilot";
export type HerdrNativeStart = {
  context: { cwd: string };
  configuration: { agent: NativeAgent; model: string | null; args: readonly string[] };
  resumeSessionId?: string;
};
export type NativeHistoryEvidence = { path: string; sessionId: string; cwd: string };
export type HerdrNativePreflight = {
  agent: NativeAgent;
  version: string;
  nativeHome: string;
  sqliteHome: string | null;
  integrationConfigured: true;
  history: NativeHistoryEvidence | null;
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
const sameCwd = async (actual: unknown, expected: string): Promise<string> => {
  if (typeof actual !== "string" || !path.isAbsolute(actual)) throw new Error("The original native history has no absolute working directory.");
  const [left, right] = await Promise.all([realpath(actual), realpath(expected)]);
  if (left !== right) throw new Error("The original native history belongs to a different working directory; it cannot resume this claim.");
  return right;
};
const sessionId = (value: string): string => {
  const id = canonicalId(value);
  if (id === null) throw new Error("A native resume session must be an exact UUID.");
  return id;
};
const codexHistory = async (root: string, id: string, cwd: string, operation: Operation): Promise<NativeHistoryEvidence> => {
  const candidates: string[] = [];
  let visited = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    operation.check();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      operation.check();
      if (++visited > 100_000) throw new Error("The Codex history manifest scan exceeded its supported entry limit.");
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(target, depth + 1);
      else if (entry.isFile() && (entry.name.endsWith(`-${id}.jsonl`) || entry.name.endsWith(`-${id}.jsonl.gz`) || entry.name.endsWith(`-${id}.jsonl.zst`))) candidates.push(target);
    }
  };
  await walk(path.join(root, "sessions"), 0);
  if (candidates.length !== 1) throw new Error(`The original Codex session ${id} must have exactly one readable rollout manifest; found ${candidates.length}.`);
  const file = candidates[0]!;
  if (!file.endsWith(".jsonl")) throw new Error("Compressed Codex rollout manifests are not supported by this adapter; retain the original native history and inspect its format.");
  const event = json(await readMetadata(file, operation, true), "Codex session metadata");
  const payload = mapping(event.payload, "Codex session metadata payload");
  if (event.type !== "session_meta" || payload.id !== id) throw new Error("The original Codex rollout manifest does not identify the requested session.");
  return { path: file, sessionId: id, cwd: await sameCwd(payload.cwd, cwd) };
};
const copilotHistory = async (root: string, id: string, cwd: string, operation: Operation): Promise<NativeHistoryEvidence> => {
  const directory = path.join(root, "session-state", id);
  const workspaceFile = path.join(directory, "workspace.yaml");
  const source = await readMetadata(workspaceFile, operation);
  let decoded: unknown;
  try { decoded = parseYaml(source) as unknown; }
  catch { throw new Error("The original Copilot workspace metadata is invalid; inspect the native history without exposing its contents."); }
  const workspace = mapping(decoded, "Copilot workspace metadata");
  if (workspace.id !== id) throw new Error("The original Copilot workspace metadata does not identify the requested session.");
  await sameCwd(workspace.cwd, cwd);
  const file = path.join(directory, "events.jsonl");
  const event = json(await readMetadata(file, operation, true), "Copilot session event");
  const data = mapping(event.data, "Copilot session event data");
  const context = mapping(data.context, "Copilot session event context");
  if (event.type !== "session.start" || data.sessionId !== id) throw new Error("The original Copilot event history does not identify the requested session.");
  return { path: file, sessionId: id, cwd: await sameCwd(context.cwd, cwd) };
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
    // Native manifests establish prerequisites; only the subsequent official hook report and actual resume establish runtime continuity.
    verifyStart: async (input: HerdrNativeStart, operation: Operation): Promise<HerdrNativePreflight> => {
      operation.check();
      const agent = input.configuration.agent;
      if (agent !== "codex" && agent !== "copilot") throw new Error("The native agent must be codex or copilot.");
      const cwd = absolute(input.context.cwd, "Native working directory");
      const root = nativeHome(agent, environment, home);
      const sqliteHome = agent === "codex" ? environment.CODEX_SQLITE_HOME === undefined ? root : absolute(environment.CODEX_SQLITE_HOME, "CODEX_SQLITE_HOME") : null;
      const versionText = (await runCommand({ file: agent, args: ["--version"], environment }, operation)).stdout;
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
        try { output = (await runCommand({ file: runtime.file, args: runtime.args, environment }, operation)).stdout; }
        catch (cause) { operation.check(); throw new Error(`The official ${agent} Herdr hook requires the ${runtime.file} runtime to be available.`, { cause }); }
        if (!runtime.version.test(output)) throw new Error(`Cannot identify the ${runtime.file} runtime required by the official ${agent} Herdr hook.`);
      }
      const asset = path.join(root, ...(agent === "copilot" ? ["hooks"] : []), platform === "win32" ? "herdr-agent-state.ps1" : "herdr-agent-state.sh");
      await readMetadata(asset, operation);
      const expected = hookCommand(asset, agent, platform);
      if (agent === "codex") {
        const help = (await runCommand({ file: agent, args: ["--help"], environment }, operation)).stdout;
        if (!help.includes("--no-daemon")) throw new Error("This Codex executable lacks --no-daemon; a worker requires isolated native execution without a shared human daemon.");
        const features = (await runCommand({ file: agent, args: ["features", "list"], environment }, operation)).stdout;
        if (!features.split(/\r?\n/).some((line) => /^hooks\s+\S+\s+true\s*$/.test(line))) throw new Error("Codex hooks are disabled; enable the official SessionStart integration explicitly before running the worker.");
        const file = json(await readMetadata(path.join(root, "hooks.json"), operation), "Codex hooks configuration");
        if (!configuredHook(mapping(file.hooks, "Codex hooks configuration hooks"), expected, agent, platform)) throw new Error("Codex SessionStart does not invoke the installed official Herdr hook; configure and trust that hook explicitly.");
      } else {
        const effective = json((await runCommand({ file: agent, args: ["config", "hooks"], environment }, operation)).stdout, "Copilot effective hooks configuration");
        if (!configuredHook(effective, expected, agent, platform)) throw new Error("Copilot SessionStart does not invoke the installed official Herdr hook; configure it explicitly.");
      }
      let history: NativeHistoryEvidence | null = null;
      if (input.resumeSessionId !== undefined) {
        const id = sessionId(input.resumeSessionId);
        history = agent === "codex" ? await codexHistory(root, id, cwd, operation) : await copilotHistory(root, id, cwd, operation);
      }
      operation.check();
      return { agent, version: versionMatch[1]!, nativeHome: root, sqliteHome, integrationConfigured: true, history };
    },
  };
};

export type HerdrPreflight = ReturnType<typeof createHerdrPreflight>;
