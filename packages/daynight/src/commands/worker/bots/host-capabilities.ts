import { constants, existsSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createOperation, OperationError, type Operation } from "../../../api/operation.js";
import type { WorkerAgent, WorkerAssistantHost, WorkerAssistantHostReason, WorkerAssistantProvider } from "../../../api/types.js";
import { copilotExecutable } from "../../controller/providers/copilot-runtime.js";
import { parseProviderArguments } from "../../controller/providers/projection.js";
import { hasHerdrCommandCleanupFailure, HerdrCommandDeadlineError, HerdrCommandError, runHerdrCommand, spawnHerdrProcess, type HerdrCommand, type HerdrCommandResult } from "../herdr/command.js";
import { NativeVersionOutputError, parseNativeAgentVersion } from "../herdr/version-probe.js";
import type { ExecutionConfiguration } from "../types.js";

export type AssistantHostIssue = { provider: WorkerAgent; reason: WorkerAssistantHostReason; error: unknown };
export type AssistantHostSample = { assistantHost: WorkerAssistantHost; issues: readonly AssistantHostIssue[] };

const providers = ["codex", "claude", "copilot"] as const;
const validText = (value: string, bytes: number): boolean => value.trim() !== "" && value.isWellFormed() && !/\p{Cc}/u.test(value) && Buffer.byteLength(value) <= bytes;
const hasCode = (error: unknown, codes: readonly string[]): boolean => error instanceof Error && (("code" in error && codes.includes(String(error.code))) || hasCode(error.cause, codes));
const reasonOf = (error: unknown): WorkerAssistantHostReason => {
  if (hasHerdrCommandCleanupFailure(error)) return "unavailable";
  if (error instanceof OperationError || error instanceof HerdrCommandDeadlineError) return "timeout";
  if (hasCode(error, ["ENOENT", "ENOTDIR", "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"])) return "not_found";
  if (hasCode(error, ["EACCES", "EPERM"])) return "permission_denied";
  if (error instanceof NativeVersionOutputError) return "invalid_output";
  if (error instanceof HerdrCommandError) return "command_failed";
  return "unavailable";
};

// Match the locked Claude SDK's native optional-package lookup, including its libc fallback.
const claudeExecutable = (): string => {
  const require = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
  const report = process.platform === "linux" ? process.report.getReport() as { header?: { glibcVersionRuntime?: string } } : null;
  const suffixes = process.platform === "linux" ? report?.header?.glibcVersionRuntime === undefined ? ["-musl", ""] : ["", "-musl"] : [""];
  for (const suffix of suffixes) {
    try {
      const executable = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/claude${process.platform === "win32" ? ".exe" : ""}`);
      if (existsSync(executable)) return executable;
    } catch { /* Try the SDK's next supported platform package. */ }
  }
  throw Object.assign(new Error("The Claude SDK native package is unavailable."), { code: "MODULE_NOT_FOUND" });
};

export const assistantProviderExecutable = (provider: WorkerAgent): string => provider === "codex" ? "codex" : provider === "claude" ? claudeExecutable() : copilotExecutable();

const helpArguments = (provider: WorkerAgent): readonly string[] => provider === "codex" ? ["app-server", "--stdio", "--help"]
  : provider === "claude" ? ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--permission-prompt-tool", "stdio", "--include-partial-messages", "--help"]
  : ["--headless", "--no-auto-update", "--help"];
const supportsWeb = (provider: WorkerAgent, output: string): boolean => (provider === "codex" ? ["app-server", "--stdio"]
  : provider === "claude" ? ["--input-format", "--output-format", "--include-partial-messages"] : ["--no-auto-update"]).every(flag => output.includes(flag));

const observe = <T>(pending: Promise<T>, operation: Operation): Promise<T> => new Promise((resolve, reject) => {
  const abort = (): void => { operation.signal.removeEventListener("abort", abort); reject(operation.signal.reason); };
  operation.signal.addEventListener("abort", abort, { once: true });
  if (operation.signal.aborted) abort();
  pending.then(value => { operation.signal.removeEventListener("abort", abort); resolve(value); }, error => { operation.signal.removeEventListener("abort", abort); reject(error); });
});

/** Read-only prerequisite observations; availability does not establish authentication or future launch success. */
export const createAssistantHostCollector = (options: {
  workingDirectory: string;
  configuration: ExecutionConfiguration | (() => ExecutionConfiguration);
  environment: NodeJS.ProcessEnv;
  resolveExecutable?: (provider: WorkerAgent) => string;
  runCommand?: (command: HerdrCommand, operation: Operation) => Promise<HerdrCommandResult>;
}) => {
  if (!path.isAbsolute(options.workingDirectory) || !validText(options.workingDirectory, 4096)) throw new TypeError("Assistant host startup directory must be a valid absolute path of at most 4096 bytes.");
  const configuration = typeof options.configuration === "function" ? options.configuration : (() => {
    const snapshot = { ...options.configuration, args: [...options.configuration.args] };
    return () => snapshot;
  })();
  const environment = { ...options.environment };
  for (const key of ["CODEX_THREAD_ID", "CODEX_TURN_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "DAYNIGHT_CONTROLLER_TOKEN"]) delete environment[key];
  const resolveExecutable = options.resolveExecutable ?? assistantProviderExecutable;
  const runCommand = options.runCommand ?? ((command, operation) => runHerdrCommand(command, operation, spawnHerdrProcess, { cleanupWithinDeadline: true }));
  const cleanupFailures = new Map<WorkerAgent, unknown>();
  let pendingDirectory = false;
  const directory = async (operation: Operation): Promise<string> => {
    if (pendingDirectory) throw new OperationError("deadline");
    pendingDirectory = true;
    const request = (async () => {
      const resolved = await realpath(options.workingDirectory);
      if (!path.isAbsolute(resolved) || !validText(resolved, 4096) || !(await stat(resolved)).isDirectory()) throw new Error("Assistant host startup path is not an accessible directory.");
      await access(resolved, constants.R_OK | constants.X_OK);
      return resolved;
    })();
    void request.then(() => { pendingDirectory = false; }, () => { pendingDirectory = false; });
    return observe(request, operation);
  };
  return {
    collect: async (operation: Operation): Promise<AssistantHostSample> => {
      operation.check();
      const current = configuration();
      const configured = { ...current, args: [...current.args] };
      const collection = createOperation({ signal: operation.signal, limits: { ...operation.limits, totalMs: Math.max(1, Math.floor(Math.min(5_000, operation.remainingMs()))), requestMs: Math.min(5_000, operation.limits.requestMs) } });
      const observedAt = new Date().toISOString();
      const issues: AssistantHostIssue[] = [];
      let cwd = options.workingDirectory, directoryError: unknown;
      try {
        try { cwd = await directory(collection); } catch (error) { directoryError = error; }
        const entries = await Promise.all(providers.map(async (provider): Promise<WorkerAssistantProvider> => {
          const model = provider === configured.agent ? configured.model : null;
          const args = provider === configured.agent ? [...configured.args] : [];
          const fail = (reason: WorkerAssistantHostReason, error: unknown, hideConfiguration = false): WorkerAssistantProvider => {
            issues.push({ provider, reason, error });
            return { provider, available: false, reason, model: hideConfiguration ? null : model, args: hideConfiguration ? [] : args };
          };
          try {
            if ((model !== null && !validText(model, 256)) || args.length > 128 || args.some(arg => !validText(arg, 4096))) throw new Error("Assistant provider configuration exceeds the supported report bounds.");
            parseProviderArguments(provider, args);
          } catch (error) { return fail("unsupported_arguments", error, true); }
          if (directoryError !== undefined) return fail(directoryError instanceof OperationError ? "timeout" : "invalid_cwd", directoryError);
          if (cleanupFailures.has(provider)) return fail("unavailable", cleanupFailures.get(provider));
          try {
            collection.check();
            const file = resolveExecutable(provider);
            const version = await runCommand({ file, args: provider === "copilot" ? ["--no-auto-update", "--version"] : ["--version"], environment, cwd }, collection);
            parseNativeAgentVersion(provider, version.stdout);
            const help = await runCommand({ file, args: helpArguments(provider), environment, cwd }, collection);
            if (!supportsWeb(provider, help.stdout)) return fail("unavailable", new Error("The native executable does not advertise the required Web transport options."));
            collection.check();
            return { provider, available: true, reason: null, model, args };
          } catch (error) {
            if (hasHerdrCommandCleanupFailure(error)) cleanupFailures.set(provider, error);
            return fail(reasonOf(error), error);
          }
        }));
        try { operation.check(); } catch (error) {
          if (cleanupFailures.size > 0) throw new AggregateError([error, ...cleanupFailures.values()], "Assistant host observation was cancelled with unconfirmed process cleanup.", { cause: error });
          throw error;
        }
        return { assistantHost: { protocolVersion: 1, observedAt, defaultCwd: cwd, defaultProvider: configured.agent, providers: entries }, issues };
      } finally { collection.dispose(); }
    },
  };
};
