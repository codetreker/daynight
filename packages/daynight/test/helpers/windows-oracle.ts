import { execFile, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";

const phasePrefix = "DAYNIGHT_ORACLE_PHASE:";
const outputLimit = 1024 * 1024;
export type OracleEvent = { kind: "windows-oracle"; stage: string; event: string; elapsedMs: number; at: string; [key: string]: unknown };
type Command = {
  stage: string;
  executable: string;
  args: string[];
  timeoutMs: number;
  killSignal: NodeJS.Signals;
  targetPid?: number;
  env?: NodeJS.ProcessEnv;
  redactStdout?: boolean;
  report?: (event: OracleEvent) => void;
};

export const powershellOracleScript = (body: string): string => `
[Console]::Error.WriteLine('${phasePrefix}script-start')
[Console]::Error.Flush()
$ErrorActionPreference = 'Stop'
function Write-OraclePhase([string] $phase) {
  [Console]::Error.WriteLine('${phasePrefix}' + $phase)
  [Console]::Error.Flush()
}
${body}
Write-OraclePhase 'script-completed'
`;

/** Preserve progress before a killed oracle loses its buffered output. */
export const runOracleCommand = async (command: Command): Promise<{ stdout: string; stderr: string }> => {
  const started = performance.now(), events: OracleEvent[] = [];
  let lastPhase: string | null = null;
  const reporting: { failure?: { cause: unknown } } = {};
  const report = command.report ?? (event => process.stderr.write(JSON.stringify(event) + "\n"));
  const emit = (event: string, fields: Record<string, unknown> = {}) => {
    const record: OracleEvent = { kind: "windows-oracle", stage: command.stage, event, elapsedMs: Math.round(performance.now() - started), at: new Date().toISOString(), ...fields };
    if (events.length < 32) events.push(record);
    if (reporting.failure === undefined) {
      try { report(record); } catch (cause) { reporting.failure = { cause }; }
    }
  };
  const invocation = { executable: command.executable, ...(command.targetPid === undefined ? {} : { targetPid: command.targetPid }), argumentCount: command.args.length, argumentsSha256: createHash("sha256").update(JSON.stringify(command.args)).digest("hex") };
  emit("started", { ...invocation, deadlineMs: command.timeoutMs, killSignal: command.killSignal });
  let stdout = "", stderr = "", phaseBuffer = "", timedOut = false;
  const completion = Promise.withResolvers<{ error: ExecFileException | null; stdout: string; stderr: string }>();
  const child = execFile(command.executable, command.args, {
    encoding: "utf8", windowsHide: true, maxBuffer: outputLimit,
    ...(command.env === undefined ? {} : { env: command.env }),
  }, (error, output, errors) => completion.resolve({ error, stdout: output, stderr: errors }));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => {
    emit("close", { pid: child.pid, code, signal }); resolve({ code, signal });
  }));
  child.once("spawn", () => emit("spawn", { pid: child.pid }));
  child.once("exit", (code, signal) => emit("exit", { pid: child.pid, code, signal }));
  child.stdout!.on("data", (chunk: string) => { if (stdout.length < outputLimit) stdout += chunk.slice(0, outputLimit - stdout.length); });
  child.stderr!.on("data", (chunk: string) => {
    if (stderr.length < outputLimit) stderr += chunk.slice(0, outputLimit - stderr.length);
    phaseBuffer += chunk;
    let newline: number;
    while ((newline = phaseBuffer.indexOf("\n")) !== -1) {
      const line = phaseBuffer.slice(0, newline).trimEnd(); phaseBuffer = phaseBuffer.slice(newline + 1);
      if (line.startsWith(phasePrefix) && /^[a-z0-9-]{1,128}$/.test(line.slice(phasePrefix.length))) {
        lastPhase = line.slice(phasePrefix.length); emit("phase", { pid: child.pid, phase: lastPhase });
      }
    }
  });
  child.stdin!.end();
  const timer = setTimeout(() => {
    timedOut = true; emit("deadline", { pid: child.pid, lastPhase, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) });
    child.kill(command.killSignal);
  }, Math.max(0, command.timeoutMs - (performance.now() - started)));
  try {
    const result = await completion.promise, exit = await closed;
    if (result.error !== null || timedOut || exit.code !== 0 || exit.signal !== null || reporting.failure !== undefined) {
      const output = (value: string, redact = false) => ({ bytes: Buffer.byteLength(value), sha256: createHash("sha256").update(value).digest("hex"), ...(redact ? {} : { text: value.slice(0, 1024), truncated: value.length > 1024 }) });
      const commandError = result.error === null ? null : { code: result.error.code ?? null, signal: result.error.signal ?? null, killed: result.error.killed ?? null };
      const detail = { lastPhase, timedOut, commandError, exit, ...invocation, stdout: output(result.stdout, command.redactStdout), stderr: output(result.stderr), events };
      const message = `Windows oracle ${command.stage} failed after process close: ${JSON.stringify(detail)}`;
      if (reporting.failure !== undefined) {
        if (result.error !== null) throw new AggregateError([result.error, reporting.failure.cause], message, { cause: result.error });
        throw new Error(message, { cause: reporting.failure.cause });
      }
      throw new Error(message, { cause: result.error });
    }
    return { stdout: result.stdout, stderr: result.stderr };
  } finally { clearTimeout(timer); }
};
