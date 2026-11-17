import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import { WindowsProcessProofError } from "../../../src/commands/controller/windows-process-proof.js";
import { MappingProcessProofAcquisitionError } from "../../../src/commands/worker/herdr/tool-launch-process-proof.js";

const execute = promisify(execFile);
type CommandError = Error & { code?: string | number; killed?: boolean; signal?: string | null; elapsedMs?: number; file?: string; args?: readonly string[]; timeoutMs?: number; stdout?: string; stderr?: string };

const processProofErrors = (error: unknown) => {
  const stages = new Set(["open-process", "terminate-process", "wait-process", "exit-code", "creation-time", "basic-information", "command-line", "close-process-handle"]);
  const roles = new Set(["shell", "helper", "native child", "native descendant"]);
  const found: object[] = [], seen = new Set<Error>();
  const windows = (value: unknown) => value instanceof WindowsProcessProofError && stages.has(value.stage) && (value.domain === "Win32" || value.domain === "NTSTATUS") && Number.isInteger(value.code) && value.code >= -0x80000000 && value.code <= 0xffffffff
    ? { stage: value.stage, domain: value.domain, code: value.code } : undefined;
  const visit = (value: unknown, depth: number): void => {
    if (!(value instanceof Error) || seen.has(value) || depth > 12 || seen.size >= 64) return;
    seen.add(value);
    if (value instanceof MappingProcessProofAcquisitionError && Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 0x7fffffff && roles.has(value.role) && (value.phase === "capture" || value.phase === "observe")) {
      const proof = windows(value.cause);
      found.push({ pid: value.pid, role: value.role, phase: value.phase, ...(proof === undefined ? {} : { windows: proof }) });
      if (proof !== undefined && value.cause instanceof Error) seen.add(value.cause);
    } else {
      const proof = windows(value);
      if (proof !== undefined) found.push(proof);
    }
    visit(value.cause, depth + 1);
    if (value instanceof AggregateError) for (const nested of value.errors.slice(0, 64)) visit(nested, depth + 1);
  };
  visit(error, 0);
  return found;
};

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
  const proofErrors = processProofErrors(error);
  return { name: error.name, message: error.message, code: command.code ?? null, killed: command.killed ?? null, signal: command.signal ?? null, elapsedMs: command.elapsedMs ?? totalElapsedMs, totalElapsedMs, file: command.file, args: command.args, timeoutMs: command.timeoutMs, stdout: command.stdout, stderr: command.stderr, ...(proofErrors.length === 0 ? {} : { processProofErrors: proofErrors }) };
};
