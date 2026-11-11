import { toolCommand, verifyToolLaunch, type ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import type { Operation } from "../../../api/operation.js";
import { runHerdrCommand } from "./command.js";
import type { HerdrCommand, HerdrCommandResult } from "./command.js";

export type NativeVersionAgent = "codex" | "copilot" | "claude";

export class NativeVersionOutputError extends Error {
  constructor(agent: NativeVersionAgent) {
    super(`Cannot identify the installed ${agent} executable version.`);
    this.name = "NativeVersionOutputError";
  }
}

export const parseNativeAgentVersion = (agent: NativeVersionAgent, output: string): string => {
  const match = agent === "codex" ? /^codex-cli (\d+\.\d+\.\d+)(?:\s|$)/m.exec(output)
    : agent === "claude" ? /^(\d+\.\d+\.\d+) \(Claude Code\)(?:\s|$)/m.exec(output)
    : /^GitHub Copilot CLI (\d+\.\d+\.\d+)(?:[.\s]|$)/m.exec(output);
  if (match === null || Buffer.byteLength(match[1]!) > 256) throw new NativeVersionOutputError(agent);
  return match[1]!;
};

export const probeNativeAgentVersion = async (options: {
  agent: NativeVersionAgent;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  toolLaunch?: ResolvedToolLaunch;
  toolRuntimeRoot?: string;
  runCommand?: (command: HerdrCommand, operation: Operation) => Promise<HerdrCommandResult>;
}, operation: Operation): Promise<string> => {
  const runCommand = options.runCommand === undefined ? runHerdrCommand : options.runCommand;
  if (options.toolLaunch) {
    if (options.toolLaunch.tool !== options.agent) throw new Error("Native version tool differs from its request.");
    if (options.agent === "copilot" && options.toolLaunch.context === "web") {
      const { inspectWorkerToolLaunch } = await import("../native-selection.js");
      return (await inspectWorkerToolLaunch({ launch: options.toolLaunch, cwd: options.cwd, environment: options.environment, ...(options.toolRuntimeRoot ? { toolRuntimeRoot: options.toolRuntimeRoot } : {}) }, operation)).version;
    }
    await verifyToolLaunch(options.toolLaunch, operation);
  }
  const command = options.toolLaunch ? toolCommand(options.toolLaunch, options.agent === "copilot" ? ["--no-auto-update", "--version"] : ["--version"]) : { file: options.agent, args: ["--version"] };
  const result = await runCommand({ ...command, environment: options.environment, cwd: options.cwd }, operation);
  return parseNativeAgentVersion(options.agent, result.stdout);
};
