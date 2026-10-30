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
  if (match === null) throw new NativeVersionOutputError(agent);
  return match[1]!;
};

export const probeNativeAgentVersion = async (options: {
  agent: NativeVersionAgent;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  runCommand?: (command: HerdrCommand, operation: Operation) => Promise<HerdrCommandResult>;
}, operation: Operation): Promise<string> => {
  const runCommand = options.runCommand === undefined ? runHerdrCommand : options.runCommand;
  const result = await runCommand({ file: options.agent, args: ["--version"], environment: options.environment, cwd: options.cwd }, operation);
  return parseNativeAgentVersion(options.agent, result.stdout);
};
