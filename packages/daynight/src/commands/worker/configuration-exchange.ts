import { randomUUID } from "node:crypto";
import { ApiError } from "../../api/client.js";
import type { Operation } from "../../api/operation.js";
import { parseWorkerCloudReport } from "../../api/worker-configuration.js";
import type { WorkerCloudDesired, WorkerCloudReceipt, WorkerCloudReport, WorkerCloudReportReceipt, WorkerCloudResource, WorkerCloudValue, WorkerPromptSelector, WorkerPromptResults } from "../../api/worker-configuration.js";
import type { WorkerReport } from "../../api/types.js";
import type { WorkerPromptSource } from "./prompt-source.js";
import { waitForConfigurationOperation } from "./configuration-persistence.js";
import type { WorkerConfigurationReportContext } from "./configuration-model.js";

export type WorkerConfigurationExchangeSource = {
  readonly state: "unread" | "initialized" | "uninitialized";
  readonly generation: string;
  readonly desiredRevision: string | null;
  readonly observationRevision: string;
};
export type WorkerConfigurationReceivedAuthority = { readonly desiredRevision: string | null; readonly observationRevision: string };
export type WorkerConfigurationExchangePhase = "authority-read" | "bootstrap-prepare" | "telemetry-collect" | "observation-capture" | "report-send" | "receipt-accept";
export type WorkerConfigurationExchangeEvent = {
  readonly syncId: string;
  readonly phase: WorkerConfigurationExchangePhase;
  readonly status: "started" | "succeeded" | "failed" | "discarded";
  readonly source: WorkerConfigurationExchangeSource | null;
  readonly remoteOutcome: "not_sent" | "success" | "rejected" | "unknown";
  readonly localOutcome: "not_attempted" | "pending" | "persisted" | "ignored";
  readonly previousSource?: WorkerConfigurationExchangeSource;
  readonly received?: WorkerConfigurationReceivedAuthority;
  readonly report?: WorkerConfigurationReportContext;
  readonly observationAccepted?: boolean;
  readonly requestId?: string;
  readonly nextAttemptAt?: string | null;
  readonly backoffStep?: number;
  readonly error?: unknown;
};

export type WorkerConfigurationExchange = {
  waitReady?(operation: Operation): Promise<void>;
  prepare?(operation: Operation, syncId?: string): Promise<void>;
  source?(): WorkerConfigurationExchangeSource;
  capture(report: WorkerReport): WorkerCloudReport;
  reportContext?(report: WorkerCloudReport): WorkerConfigurationReportContext | undefined;
  isCurrent?(report: WorkerCloudReport): boolean;
  send(report: WorkerReport, configuration: WorkerCloudReport, operation: Operation, selectors?: readonly WorkerPromptSelector[]): Promise<WorkerCloudReportReceipt & { readonly prompts?: WorkerPromptResults }>;
  accept(sent: WorkerCloudReport, receipt: WorkerCloudReceipt, operation: Operation, syncId?: string): Promise<"persisted" | "ignored" | void>;
  acceptanceOutcome?(sent: WorkerCloudReport): "persisted" | "ignored" | undefined;
  markNeedsRead?(): void;
  observe?(event: WorkerConfigurationExchangeEvent): void;
  prompts?: WorkerPromptSource;
};

type ExchangeManager = {
  current(): { readonly generation: string; readonly desired: WorkerCloudDesired | null; readonly observationRevision: string; readonly synchronized: boolean };
  hasAuthority(): boolean;
  waitReady(signal?: AbortSignal): Promise<void>;
  receive(desired: WorkerCloudDesired | null, revision?: string, signal?: AbortSignal, syncId?: string): Promise<void>;
  report(bootstrap?: WorkerCloudValue | null, report?: WorkerReport): WorkerCloudReport;
  isCurrentReport(report: WorkerCloudReport): boolean;
  reportContext(report: WorkerCloudReport): WorkerConfigurationReportContext | undefined;
  acknowledge(report: WorkerCloudReport, receipt: WorkerCloudReceipt, signal?: AbortSignal, syncId?: string): Promise<"persisted" | "ignored">;
};

export type WorkerConfigurationBootstrapProvider = {
  prepare(operation: Operation): Promise<WorkerCloudValue | null>;
  invalidate(): void;
  clear(): Promise<void>;
};

const diagnosticFailures = new WeakMap<WorkerConfigurationExchange, unknown[]>();
const observe = (configuration: WorkerConfigurationExchange, event: WorkerConfigurationExchangeEvent): void => {
  try { configuration.observe?.(event); }
  catch (error) {
    const failures = diagnosticFailures.get(configuration);
    if (failures === undefined) diagnosticFailures.set(configuration, [error]);
    else if (!failures.includes(error)) failures.push(error);
  }
};
export const workerConfigurationDiagnosticFailures = (configuration: WorkerConfigurationExchange): readonly unknown[] => Object.freeze([...(diagnosticFailures.get(configuration) ?? [])]);
const requestIdFor = (error: unknown): string | undefined => error instanceof ApiError && error.requestId !== undefined && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(error.requestId) ? error.requestId : undefined;

export const failedConfigurationRequestOutcome = (error: unknown): WorkerConfigurationExchangeEvent["remoteOutcome"] => {
  if (!(error instanceof ApiError) || error.outcomeUnconfirmed) return "unknown";
  if (error.confirmedRefusal) return "rejected";
  if (error.phase === "prepare") return "not_sent";
  if (error.phase === "response" && error.status !== undefined && error.status >= 400 && error.status <= 599) return "rejected";
  return "unknown";
};

const requiresAuthorityRead = (error: unknown): boolean => !(error instanceof ApiError) || error.outcomeUnconfirmed || error.status === 400 || error.phase === "protocol";
const immutable = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
};

export const createWorkerConfigurationExchange = (options: {
  manager: ExchangeManager;
  read(operation: Operation): Promise<WorkerCloudResource>;
  send: WorkerConfigurationExchange["send"];
  bootstrap?: WorkerConfigurationBootstrapProvider;
  prompts?: WorkerPromptSource;
  needsRead?: boolean;
  onStage?(event: WorkerConfigurationExchangeEvent): void;
}): WorkerConfigurationExchange & { markNeedsRead(): void; close(): Promise<void> } => {
  const { manager } = options;
  let needsRead = options.needsRead ?? true;
  let bootstrap: WorkerCloudValue | null = null;
  const acknowledgements = new WeakMap<WorkerCloudReport, "persisted" | "ignored">();
  const source = (): WorkerConfigurationExchangeSource => {
    const current = manager.current();
    return Object.freeze({ state: !manager.hasAuthority() ? "unread" : current.desired === null ? "uninitialized" : "initialized", generation: current.generation, desiredRevision: current.desired?.revision ?? null, observationRevision: current.observationRevision });
  };
  const prepareStage = async (syncId: string, phase: WorkerConfigurationExchangePhase, action: () => Promise<void>, received?: () => WorkerConfigurationReceivedAuthority | undefined): Promise<void> => {
    const previousSource = source();
    const event = (status: WorkerConfigurationExchangeEvent["status"], error?: unknown): void => {
      const requestId = requestIdFor(error), authority = received?.();
      const localOutcome = phase === "authority-read" && authority !== undefined ? status === "succeeded" ? "persisted" : "pending" : "not_attempted";
      const remoteOutcome = phase !== "authority-read" ? "not_sent" : authority !== undefined ? "success" : status === "failed" ? failedConfigurationRequestOutcome(error) : "not_sent";
      observe(exchange, { syncId, phase, status, source: source(), previousSource, ...(authority === undefined ? {} : { received: authority }), remoteOutcome, localOutcome, ...(requestId === undefined ? {} : { requestId }), ...(error === undefined ? {} : { error }) });
    };
    event("started");
    try { await action(); event("succeeded"); }
    catch (error) { event("failed", error); throw error; }
  };
  const exchange: WorkerConfigurationExchange & { markNeedsRead(): void; close(): Promise<void> } = {
    ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
    ...(options.onStage === undefined ? {} : { observe: options.onStage }),
    source,
    waitReady: operation => manager.waitReady(operation.signal),
    prepare: async (operation, syncId = randomUUID()) => {
      if (needsRead || !manager.current().synchronized || manager.current().desired === null) {
        needsRead = true;
        let received: WorkerConfigurationReceivedAuthority | undefined;
        await prepareStage(syncId, "authority-read", async () => {
          const resource = await options.read(operation);
          received = Object.freeze({ desiredRevision: resource.desired?.revision ?? null, observationRevision: resource.observationRevision });
          await manager.receive(resource.desired, resource.observationRevision, operation.signal, syncId);
          needsRead = false;
        }, () => received);
      }
      if (manager.current().desired !== null) {
        bootstrap = null;
        if (options.bootstrap !== undefined) await waitForConfigurationOperation(options.bootstrap.clear(), operation.signal);
      } else if (options.bootstrap !== undefined) {
        await prepareStage(syncId, "bootstrap-prepare", async () => { bootstrap = await options.bootstrap!.prepare(operation); });
      }
    },
    capture: report => manager.report(manager.current().desired === null ? bootstrap : null, report),
    reportContext: report => manager.reportContext(report),
    isCurrent: report => manager.isCurrentReport(report),
    send: async (report, captured, operation, selectors) => {
      try { return await options.send(report, captured, operation, selectors); }
      catch (error) {
        if (requiresAuthorityRead(error)) needsRead = true;
        if (captured.bootstrap !== null && error instanceof ApiError && !error.outcomeUnconfirmed && error.phase === "response") options.bootstrap?.invalidate();
        throw error;
      }
    },
    accept: async (captured, receipt, operation, syncId) => {
      let outcome: "persisted" | "ignored";
      try { outcome = await manager.acknowledge(captured, receipt, operation.signal, syncId); acknowledgements.set(captured, outcome); }
      catch (error) { if (requiresAuthorityRead(error)) needsRead = true; throw error; }
      const current = manager.current();
      if (current.desired !== null) {
        bootstrap = null;
        if (options.bootstrap !== undefined) await waitForConfigurationOperation(options.bootstrap.clear(), operation.signal);
      }
      if (current.desired?.value.agentControlMode === undefined || current.desired?.value.toolPaths === undefined) needsRead = true;
      return outcome;
    },
    acceptanceOutcome: sent => acknowledgements.get(sent),
    markNeedsRead: () => { needsRead = true; },
    close: async () => {
      bootstrap = null;
      const errors = [...workerConfigurationDiagnosticFailures(exchange)];
      try { await options.bootstrap?.clear(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Worker configuration exchange diagnostics and shutdown failed.", { cause: errors[0] });
    },
  };
  return exchange;
};

export const syncWorkerConfigurationOnce = async (options: {
  configuration: WorkerConfigurationExchange;
  report(): WorkerReport | Promise<WorkerReport>;
  operation: Operation;
}): Promise<{ more: boolean; promptError: boolean; stopCatchup: boolean; dropped?: true }> => {
  const { configuration, operation } = options;
  const syncId = randomUUID();
  let phase: WorkerConfigurationExchangePhase = "authority-read";
  let ownsPhase = false;
  let exchangeSource: WorkerConfigurationExchangeSource | null = null;
  let remoteOutcome: WorkerConfigurationExchangeEvent["remoteOutcome"] = "not_sent";
  let localOutcome: WorkerConfigurationExchangeEvent["localOutcome"] = "not_attempted";
  let capturedContext: WorkerConfigurationReportContext | undefined, observationAccepted: boolean | undefined, received: WorkerConfigurationReceivedAuthority | undefined;
  const emit = (status: WorkerConfigurationExchangeEvent["status"], error?: unknown): void => {
    const requestId = requestIdFor(error);
    observe(configuration, { syncId, phase, status, source: exchangeSource ?? configuration.source?.() ?? null, remoteOutcome, localOutcome,
      ...(capturedContext === undefined ? {} : { report: capturedContext }), ...(received === undefined ? {} : { received }), ...(observationAccepted === undefined ? {} : { observationAccepted }),
      ...(requestId === undefined ? {} : { requestId }), ...(error === undefined ? {} : { error }) });
  };
  const dropped = (): { more: false; promptError: false; stopCatchup: true; dropped: true } => {
    emit("discarded");
    return { more: false, promptError: false, stopCatchup: true, dropped: true };
  };
  try {
    await configuration.waitReady?.(operation);
    await configuration.prepare?.(operation, syncId);
    operation.check();
    exchangeSource = configuration.source?.() ?? null;
    const preparedGeneration = exchangeSource?.generation;
    ownsPhase = true;
    phase = "telemetry-collect"; emit("started");
    const report = await options.report();
    operation.check(); emit("succeeded");
    if (preparedGeneration !== configuration.source?.().generation) return dropped();
    phase = "observation-capture"; emit("started");
    const captured = configuration.capture(report);
    capturedContext = configuration.reportContext?.(captured);
    let sent: WorkerCloudReport;
    try { sent = immutable(parseWorkerCloudReport(captured, { controlMode: Object.hasOwn(captured, "controlModeBootstrap"), toolPaths: Object.hasOwn(captured, "toolPathsBootstrap") })); }
    catch (error) { configuration.markNeedsRead?.(); throw error; }
    emit("succeeded");
    if (configuration.isCurrent?.(captured) === false) return dropped();
    phase = "report-send"; emit("started");
    operation.check();
    if (configuration.isCurrent?.(captured) === false) return dropped();
    const source = configuration.prompts;
    const promptCapture = source?.captureBatch() ?? null;
    let receipt: WorkerCloudReportReceipt & { readonly prompts?: WorkerPromptResults };
    try { receipt = await configuration.send(report, sent, operation, source === undefined ? undefined : promptCapture?.selectors ?? []); }
    catch (error) {
      remoteOutcome = failedConfigurationRequestOutcome(error);
      throw error;
    }
    remoteOutcome = "success"; observationAccepted = receipt.configuration.observationAccepted;
    received = Object.freeze({ desiredRevision: receipt.configuration.desired?.revision ?? null, observationRevision: receipt.configuration.observationRevision }); emit("succeeded");
    phase = "receipt-accept"; localOutcome = "pending"; emit("started");
    let acceptance: "persisted" | "ignored" | void;
    try { acceptance = await configuration.accept(captured, receipt.configuration, operation, syncId); }
    catch (error) { localOutcome = configuration.acceptanceOutcome?.(captured) ?? localOutcome; throw error; }
    if (acceptance !== undefined) localOutcome = acceptance;
    emit("succeeded");
    if (source === undefined) return { more: false, promptError: false, stopCatchup: false };
    if (receipt.prompts === undefined || !receipt.prompts.ok) {
      source.failCycle();
      return { more: false, promptError: true, stopCatchup: true };
    }
    if (promptCapture === null) return { more: false, promptError: false, stopCatchup: false };
    try {
      const results = receipt.prompts.results;
      const more = source.accept(promptCapture, results);
      if (results.length > 0 && results.every(result => result.status === "error")) { source.failCycle(); return { more: false, promptError: false, stopCatchup: true }; }
      return { more, promptError: false, stopCatchup: false };
    } catch {
      source.failCycle();
      return { more: false, promptError: true, stopCatchup: true };
    }
  } catch (error) {
    if (ownsPhase) emit("failed", error);
    configuration.prompts?.failCycle();
    throw error;
  }
};
