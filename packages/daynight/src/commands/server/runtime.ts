import type { EventEmitter } from "node:events";
import { createApiClient, createOperation } from "../../api/index.js";
import type { ApiClient, Operation, OperationLimits } from "../../api/index.js";
import type { CliContext } from "../../cli/context.js";
import { resolveConfigurationPaths } from "../../config/paths.js";
import { loadServerConfiguration } from "../../config/server.js";
import type { ServerConfiguration } from "../../config/server.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";

export type ServerSession = {
  readonly api: ApiClient;
  readonly operation: Operation;
  readonly serverUrl: string;
  readonly serverConfiguration: ServerConfiguration;
};

export type ConfirmedMutationOutput = {
  readonly kind: "confirmed-mutation";
  readonly output: string;
  readonly failureText: (phase: "output" | "cleanup") => string;
  readonly containsSecret?: boolean;
};
export type ServerCommand = (session: ServerSession) => Promise<string | void | ConfirmedMutationOutput>;

export type ServerCommandOptions = {
  readonly signalEmitter?: Pick<EventEmitter, "on" | "off">;
  readonly platform?: NodeJS.Platform;
  readonly operationLimits?: Partial<OperationLimits>;
  readonly fetch?: typeof globalThis.fetch;
};

// Output and cleanup failures may quote the bytes they were asked to write.
// Retain the shape and broad class of the error chain without retaining text
// supplied by an output stream or another cleanup participant.
export const protectSecretDiagnostic = (failure: unknown): Error => {
  const seen = new Set<object>();
  const safe = (value: unknown, depth: number): Error => {
    if (depth >= 16 || typeof value !== "object" || value === null || seen.has(value)) return new Error("Sensitive failure details withheld.");
    seen.add(value);
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, "cause");
      const cause = descriptor !== undefined && "value" in descriptor ? safe(descriptor.value, depth + 1) : undefined;
      const options = cause === undefined ? undefined : { cause };
      const message = "Sensitive failure details withheld.";
      if (value instanceof AggregateError) {
        const errors = Object.getOwnPropertyDescriptor(value, "errors");
        const children = errors !== undefined && "value" in errors && Array.isArray(errors.value) ? errors.value.map((item: unknown) => safe(item, depth + 1)) : [];
        return new AggregateError(children, message, options);
      }
      if (value instanceof TypeError) return new TypeError(message, options);
      if (value instanceof RangeError) return new RangeError(message, options);
      return new Error(message, options);
    } catch { return new Error("Sensitive failure details withheld."); }
  };
  return safe(failure, 0);
};

export const runServerCommand = async (
  context: CliContext,
  command: ServerCommand,
  options: ServerCommandOptions = {},
): Promise<void> => {
  const cancellation = new AbortController();
  const operation = createOperation({ signal: cancellation.signal, ...(options.operationLimits === undefined ? {} : { limits: options.operationLimits }) });
  const emitter = options.signalEmitter ?? process;
  const signals: NodeJS.Signals[] = (options.platform ?? process.platform) === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  const listeners: [NodeJS.Signals, () => void][] = [];
  let failed = false;
  let failure: unknown;
  let confirmed: ConfirmedMutationOutput | undefined;
  const confirmedFailure = (phase: "output" | "cleanup", cause: unknown): PublicDiagnosticError => new PublicDiagnosticError(confirmed!.failureText(phase), 1, { cause: confirmed!.containsSecret === true ? protectSecretDiagnostic(cause) : cause });
  try {
    for (const signal of signals) {
      const cancel = (): void => cancellation.abort(new Error(`Received ${signal}.`));
      emitter.on(signal, cancel);
      listeners.push([signal, cancel]);
    }
    operation.check();
    const paths = resolveConfigurationPaths(context.homeDirectory());
    const { serverUrl, serverToken } = await loadServerConfiguration(paths, operation.signal);
    if (serverToken === undefined) throw new Error("You are not logged in. Run daynight login to authenticate.");
    operation.check();
    const api = createApiClient({ serverUrl, serverToken, operation, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
    const output = await command({ api, operation, serverUrl, serverConfiguration: { serverUrl, serverToken } });
    if (typeof output === "object" && output.kind === "confirmed-mutation") {
      confirmed = output;
      const receipt = createOperation({ limits: { totalMs: 5_000 } });
      try { await context.stdoutBytes(Buffer.from(output.output, "utf8"), receipt.signal); }
      finally { receipt.dispose(); }
    } else {
      operation.check();
      if (typeof output === "string") context.stdout(output);
    }
  } catch (cause) {
    failed = true;
    failure = confirmed === undefined ? cause : confirmedFailure("output", cause);
    throw failure;
  } finally {
    const cleanup: unknown[] = [];
    try { await context.closeStdoutBytes?.(); }
    catch (cause) { cleanup.push(cause); }
    for (const [signal, listener] of listeners) {
      try { emitter.off(signal, listener); }
      catch (cause) { cleanup.push(cause); }
    }
    try { operation.dispose(); }
    catch (cause) { cleanup.push(cause); }
    if (cleanup.length !== 0) {
      const cause = new AggregateError(failed ? [failure, ...cleanup] : cleanup, "Server command or cancellation cleanup failed.");
      throw confirmed === undefined ? cause : confirmedFailure("cleanup", cause);
    }
  }
};
