import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeSync } from "node:fs";
import path from "node:path";
import type { Reporter, SerializedError, TestCase, TestModule, TestRunEndReason, TestSuite } from "vitest/node";

export const FAILURE_DIAGNOSTIC_LIMITS = {
  file: 2_048,
  test: 4_096,
  errorName: 256,
  message: 8_192,
  stack: 16_384,
  errors: 2,
  event: 65_536,
  run: 4_194_304,
  events: 1_024,
} as const;
const controlReserve = 4_096;
const truncation = "... [truncated]";
type FailureKind = "test-failed" | "suite-failed" | "module-failed" | "unhandled-error";
type DiagnosticError = { name: string; message: string; stack: string };
type Event = { version: 1; sequence: number; kind: string; file?: string; test?: string; errors?: DiagnosticError[]; omittedErrors?: number; truncated?: string[]; reason?: string; target?: string; message?: string };
type Options = { directory: string; writeConsole?: (text: string) => void };

const field = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  try { return (value as Record<string, unknown>)[key]; } catch { return undefined; }
};

/** Limits include JSON quoting and escaping, not only the original UTF-8 bytes. */
const bounded = (value: unknown, maximum: number): { text: string; truncated: boolean } => {
  if (typeof value !== "string") return { text: "", truncated: false };
  const candidate = value.slice(0, maximum).toWellFormed();
  if (value.length <= maximum && Buffer.byteLength(JSON.stringify(candidate)) <= maximum) return { text: candidate, truncated: false };
  let low = 0, high = candidate.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(candidate.slice(0, middle).toWellFormed() + truncation)) <= maximum) low = middle;
    else high = middle - 1;
  }
  return { text: candidate.slice(0, low).toWellFormed() + truncation, truncated: true };
};
const consoleText = (value: string): string => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, character => JSON.stringify(character).slice(1, -1));
const formatConsole = (event: Event): string => {
  const lines = [`[vitest-failure-diagnostic] ${event.kind}`, event.file, event.test];
  for (const error of event.errors ?? []) lines.push(`${error.name}: ${error.message}`, error.stack);
  if (event.omittedErrors) lines.push(`[truncated: ${event.omittedErrors} additional errors]`);
  if (event.truncated?.length) lines.push(`[truncated: ${event.truncated.join(", ")}]`);
  if (event.message) lines.push(event.message);
  if (event.target) lines.push(`Target: ${event.target}`);
  if (event.reason) lines.push(`Reason: ${event.reason}`);
  return lines.filter((line): line is string => !!line).map(consoleText).join("\n") + "\n";
};

/** Preserve errors delivered before a run is cancelled without changing its result. */
export default class ImmediateFailureReporter implements Reporter {
  private filename = "";
  private sequence = 0;
  private bytes = 0;
  private events = 0;
  private exhausted = false;
  private fileFailed = false;
  private consoleFailed = false;
  private unhandled = new WeakSet<object>();
  private readonly writeConsole: (text: string) => void;

  constructor(private readonly options: Options) {
    this.writeConsole = options.writeConsole ?? (text => {
      const bytes = Buffer.from(text); let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(2, bytes, offset, bytes.length - offset);
        if (written <= 0) throw Object.assign(new Error("Console write made no progress."), { code: "EIO" });
        offset += written;
      }
    });
  }

  onTestRunStart(): void {
    this.filename = path.join(this.options.directory, `${randomUUID()}.jsonl`);
    this.sequence = 0; this.bytes = 0; this.events = 0; this.exhausted = false;
    this.fileFailed = false; this.consoleFailed = false; this.unhandled = new WeakSet<object>();
    this.emit({ kind: "run-start" }, false);
  }

  onTestCaseResult(test: TestCase): void {
    const result = test.result();
    if (result.state === "failed") this.failure("test-failed", test.module.moduleId, test.fullName, result.errors);
  }

  onTestSuiteResult(suite: TestSuite): void {
    if (suite.state() === "failed" && suite.errors().length) this.failure("suite-failed", suite.module.moduleId, suite.fullName, suite.errors());
  }

  onTestModuleEnd(module: TestModule): void {
    if (module.state() === "failed" && module.errors().length) this.failure("module-failed", module.moduleId, "", module.errors());
  }

  // Vitest's public callback retains an error unless it explicitly returns false.
  readonly onUnhandledError = (error: unknown): void => {
    if (!this.filename) this.onTestRunStart();
    if (this.exhausted) return;
    if (error !== null && typeof error === "object") {
      if (this.unhandled.has(error)) return;
      this.unhandled.add(error);
    }
    this.failure("unhandled-error", "", "", [error]);
  };

  onTestRunEnd(_modules: ReadonlyArray<TestModule>, errors: ReadonlyArray<SerializedError>, reason: TestRunEndReason): void {
    for (const error of errors) { if (this.exhausted) break; this.onUnhandledError(error); }
    this.emit({ kind: "run-end", reason }, false);
  }

  private failure(kind: FailureKind, file: string, test: string, errors: readonly unknown[]): void {
    if (this.exhausted) return;
    const truncated: string[] = [];
    const text = (value: unknown, maximum: number, label: string) => {
      const result = bounded(value, maximum); if (result.truncated) truncated.push(label); return result.text;
    };
    const selected = errors.slice(0, FAILURE_DIAGNOSTIC_LIMITS.errors).map((error, index): DiagnosticError => ({
      name: text(field(error, "name"), FAILURE_DIAGNOSTIC_LIMITS.errorName, `errors[${index}].name`) || "Error",
      message: text(typeof error === "string" ? error : field(error, "message"), FAILURE_DIAGNOSTIC_LIMITS.message, `errors[${index}].message`) || "No error message was provided.",
      stack: text(field(error, "stack"), FAILURE_DIAGNOSTIC_LIMITS.stack, `errors[${index}].stack`),
    }));
    this.emit({ kind, file: text(file, FAILURE_DIAGNOSTIC_LIMITS.file, "file"), test: text(test, FAILURE_DIAGNOSTIC_LIMITS.test, "test"), errors: selected, omittedErrors: Math.max(0, errors.length - selected.length), truncated });
  }

  private emit(value: Omit<Event, "version" | "sequence">, console = true): void {
    if (this.exhausted) return;
    if (!this.filename) this.onTestRunStart();
    const event: Event = { version: 1, sequence: ++this.sequence, ...value };
    let json = JSON.stringify(event) + "\n", output = console ? formatConsole(event) : "";
    if (Buffer.byteLength(json) > FAILURE_DIAGNOSTIC_LIMITS.event || Buffer.byteLength(output) > FAILURE_DIAGNOSTIC_LIMITS.event) {
      event.errors = []; event.truncated = ["event-bytes"]; json = JSON.stringify(event) + "\n"; output = console ? formatConsole(event) : "";
    }
    if (this.events >= FAILURE_DIAGNOSTIC_LIMITS.events || this.bytes + Buffer.byteLength(json) + Buffer.byteLength(output) > FAILURE_DIAGNOSTIC_LIMITS.run - controlReserve) {
      this.exhausted = true;
      const limit: Event = { version: 1, sequence: event.sequence, kind: "diagnostics-truncated", message: "The run diagnostic budget is exhausted; later failure details are omitted. Vitest still owns the test result." };
      this.write(JSON.stringify(limit) + "\n", formatConsole(limit)); return;
    }
    this.events++; this.write(json, output);
  }

  private write(json: string, output: string): void {
    this.bytes += Buffer.byteLength(json) + Buffer.byteLength(output);
    let consoleError: { error: unknown } | undefined, fileError: { error: unknown } | undefined;
    if (!this.consoleFailed && output) {
      try { this.writeConsole(output); }
      catch (error) { this.consoleFailed = true; consoleError = { error }; }
    }
    if (!this.fileFailed) {
      try { mkdirSync(this.options.directory, { recursive: true }); appendFileSync(this.filename, json, { mode: 0o600 }); }
      catch (error) { this.fileFailed = true; fileError = { error }; }
    }
    if (consoleError) this.writerFailure("console", consoleError.error);
    if (fileError) this.writerFailure("jsonl", fileError.error);
  }

  private writerFailure(target: string, error: unknown): void {
    const code = bounded(field(error, "code"), 128).text;
    const event: Event = { version: 1, sequence: ++this.sequence, kind: "diagnostic-write-failed", target, message: `Failure diagnostics could not be written${code ? ` (${code})` : ""}. The test result is unchanged.` };
    const json = JSON.stringify(event) + "\n", output = formatConsole(event);
    this.bytes += Buffer.byteLength(json) + Buffer.byteLength(output);
    if (target === "jsonl" && !this.consoleFailed) {
      try { this.writeConsole(output); } catch { this.consoleFailed = true; }
    } else if (target === "console" && !this.fileFailed) {
      try { mkdirSync(this.options.directory, { recursive: true }); appendFileSync(this.filename, json, { mode: 0o600 }); } catch { this.fileFailed = true; }
    }
  }
}
