import { homedir } from "node:os";
import { createByteOutput } from "./byte-output.js";
import { createTerminalPrompt } from "./prompts.js";
import type { CliPrompt } from "./prompts.js";

export type CliContext = {
  version: string;
  packageDirectory: string;
  homeDirectory: () => string;
  workingDirectory: () => string;
  stdout: (text: string) => void;
  stdoutBytes: (chunk: Uint8Array, signal: AbortSignal) => Promise<void>;
  closeStdoutBytes?: () => Promise<void>;
  stderr: (text: string) => void;
  prompt?: CliPrompt;
};

export type CliCommand = {
  run: (args: readonly string[], context: CliContext) => Promise<void>;
};

export class UsageError extends Error {
  constructor(message: string, readonly helpCommand = "daynight --help") {
    super(message);
    this.name = "UsageError";
  }
}

export const isHelp = (argument: string | undefined): boolean => argument === "--help" || argument === "-h";

export const createCliContext = (version: string, packageDirectory: string): CliContext => {
  const binaryOutput = createByteOutput();
  return {
    version,
    packageDirectory,
    homeDirectory: homedir,
    workingDirectory: process.cwd,
    stdout: (text) => { process.stdout.write(text); },
    stdoutBytes: binaryOutput.write,
    closeStdoutBytes: binaryOutput.close,
    stderr: (text) => { process.stderr.write(text); },
    prompt: createTerminalPrompt(),
  };
};
