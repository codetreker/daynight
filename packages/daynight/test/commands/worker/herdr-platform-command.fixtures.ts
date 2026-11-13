import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
type CommandError = Error & { code?: string | number; killed?: boolean; signal?: string | null; elapsedMs?: number; file?: string; args?: readonly string[]; timeoutMs?: number; stdout?: string; stderr?: string };

export const executePlatformCommand = async (file: string, args: readonly string[], options: ExecFileOptions) => {
  const startedAt = performance.now();
  try { return await execute(file, args, { ...options, encoding: "utf8" }); }
  catch (error) {
    if (error instanceof Error) Object.assign(error, { file, args, timeoutMs: options.timeout, elapsedMs: performance.now() - startedAt });
    throw error;
  }
};

export const platformErrorDetails = (error: unknown, totalElapsedMs: number) => {
  if (!(error instanceof Error)) return { name: "NonErrorThrown", message: String(error), code: null, killed: null, signal: null, elapsedMs: totalElapsedMs, totalElapsedMs };
  const command = error as CommandError;
  return { name: error.name, message: error.message, code: command.code ?? null, killed: command.killed ?? null, signal: command.signal ?? null, elapsedMs: command.elapsedMs ?? totalElapsedMs, totalElapsedMs, file: command.file, args: command.args, timeoutMs: command.timeoutMs, stdout: command.stdout, stderr: command.stderr };
};
