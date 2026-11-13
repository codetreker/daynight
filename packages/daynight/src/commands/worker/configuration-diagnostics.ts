import { ApiError } from "../../api/client.js";
import { OperationError } from "../../api/operation.js";
import { ProtocolError } from "../../api/parse.js";
import type { WorkerCloudFailure, WorkerCloudItemKey } from "../../api/worker-configuration.js";
import type { WorkerDiagnostic } from "./diagnostics.js";
import { classifyConfigurationFailure, ConfigurationFileOperationError } from "./configuration-failure.js";
import type { ConfigurationFailure, ConfigurationFailureReason } from "./configuration-failure.js";
import type { WorkerConfigurationExchangeEvent } from "./configuration-exchange.js";
import { WorkerConfigurationApplicationError, type WorkerConfigurationApplicationEvent } from "./configuration.js";
import type { ConfigurationPersistenceEvent } from "./configuration-persistence.js";

export type WorkerConfigurationDiagnosticSource = {
  readonly state: "unread" | "initialized" | "uninitialized";
  readonly generation: string | null;
  readonly desiredRevision: string | null;
  readonly observationRevision: string | null;
};
export type WorkerConfigurationDiagnosticMetadata = {
  readonly phase: "authority-read" | "bootstrap-prepare" | "telemetry-collect" | "observation-capture" | "report-send" | "receipt-accept" | "cache-persist" | "validate" | "prepare" | "apply" | "stop";
  readonly status: "started" | "succeeded" | "failed" | "discarded" | "recovered" | "summary" | "aligned";
  readonly reason?: ConfigurationFailureReason | WorkerCloudFailure["code"];
  readonly key?: WorkerCloudItemKey;
  readonly source: WorkerConfigurationDiagnosticSource;
  readonly previousSource?: WorkerConfigurationDiagnosticSource;
  readonly received?: { readonly desiredRevision: string | null; readonly observationRevision: string };
  readonly observationAccepted?: boolean;
  readonly storagePhase?: "read" | "directory" | "persist";
  readonly reportId?: string;
  readonly targetRevision?: string;
  readonly generation?: string;
  readonly recordId?: string;
  readonly recordIds?: readonly string[];
  readonly syncId?: string;
  readonly requestId?: string;
  readonly remote: "not_sent" | "confirmed" | "rejected" | "unknown";
  readonly local: "not_attempted" | "pending" | "persisted" | "ignored";
  readonly occurrences: number;
  readonly backoffStep?: number;
  readonly nextAttemptAt: string | null;
  readonly details?: Omit<ConfigurationFailure, "code" | "reason">;
};

const unread: WorkerConfigurationDiagnosticSource = { state: "unread", generation: null, desiredRevision: null, observationRevision: null };
const summaryIntervalMs = 5 * 60_000;
type FailureState = { signature: string; targetSignature: string; occurrences: number; lastEmittedAt: number; lastOccurrenceId?: string };
const itemKey = (key: WorkerCloudItemKey | undefined): string => key === undefined ? "worker" : `${key.kind}:${"projectId" in key ? key.projectId : ""}`;
const failureDetails = (failure: ConfigurationFailure): Omit<ConfigurationFailure, "code" | "reason"> => {
  const { code: _code, reason: _reason, ...details } = failure;
  return details;
};

const exchangeFailure = (error: unknown, phase: WorkerConfigurationDiagnosticMetadata["phase"]): ConfigurationFailure => {
  if (error instanceof WorkerConfigurationApplicationError) return { code: error.diagnostic.code, reason: error.diagnostic.code };
  if (error instanceof ApiError) {
    if (error.cause instanceof OperationError) return classifyConfigurationFailure(error.cause);
    if (error.phase === "response") {
      if (error.status === 401) return { code: "unavailable", reason: "authentication_required" };
      if (error.status === 403) return { code: "permission_denied", reason: "permission_denied" };
      if (error.status === 404) return { code: "not_found", reason: "not_found" };
      if (error.status === 408 || error.status === 504) return { code: "timeout", reason: "timeout" };
    }
    if (error.phase === "protocol" || error.phase === "pagination") return { code: "invalid_output", reason: "invalid_output" };
  }
  if (error instanceof ProtocolError || error instanceof TypeError || error instanceof RangeError) return phase === "bootstrap-prepare" || phase === "validate" || phase === "prepare" || phase === "apply"
    ? { code: "invalid_configuration", reason: "invalid_configuration" } : { code: "invalid_output", reason: "invalid_output" };
  return classifyConfigurationFailure(error);
};

const diagnosticError = (error: unknown, phase: WorkerConfigurationDiagnosticMetadata["phase"], seen = new Set<unknown>(), depth = 0): Error => {
  if (depth >= 6 || seen.has(error)) return new Error("truncated");
  seen.add(error);
  const reason = exchangeFailure(error, phase).reason;
  const cause = error instanceof Error && error.cause !== undefined ? { cause: diagnosticError(error.cause, phase, seen, depth + 1) } : undefined;
  return error instanceof AggregateError
    ? new AggregateError(error.errors.map((item: unknown) => diagnosticError(item, phase, seen, depth + 1)), reason, cause)
    : new Error(reason, cause);
};

export const createWorkerConfigurationDiagnostics = (options: { emit(event: WorkerDiagnostic): void; now?: () => number }) => {
  const now = options.now ?? Date.now;
  const failures = new Map<string, FailureState>();
  const applicationProgress = new Map<string, { attemptId: string; kind: string; local: string }>();
  const errors: unknown[] = [];
  const emit = (kind: string, metadata: WorkerConfigurationDiagnosticMetadata, error?: unknown, attemptId?: string): void => {
    try { options.emit({ kind, component: "configuration", phase: metadata.phase, message: `Worker configuration ${metadata.phase}: ${metadata.status}.`, configuration: metadata,
      ...(error === undefined ? {} : { error: diagnosticError(error, metadata.phase) }), ...(attemptId === undefined ? {} : { attemptId }) }); }
    catch (failure) { errors.push(failure); }
  };
  const fail = (metadata: WorkerConfigurationDiagnosticMetadata, error: unknown, target?: unknown, occurrenceId?: string, attemptId?: string, kind = "worker-configuration-failed"): void => {
    const stream = `${metadata.phase}:${itemKey(metadata.key)}`;
    const signature = JSON.stringify([metadata.phase, metadata.storagePhase, itemKey(metadata.key), metadata.reason, metadata.targetRevision, metadata.source.desiredRevision, target]);
    const previous = failures.get(stream);
    if (previous?.signature === signature) {
      if (occurrenceId === undefined || occurrenceId !== previous.lastOccurrenceId) previous.occurrences++;
      if (occurrenceId !== undefined) previous.lastOccurrenceId = occurrenceId;
      if (now() - previous.lastEmittedAt < summaryIntervalMs) return;
      previous.lastEmittedAt = now();
      emit("worker-configuration-summary", { ...metadata, status: "summary", occurrences: previous.occurrences }, error, attemptId);
      return;
    }
    failures.set(stream, { signature, targetSignature: JSON.stringify([metadata.targetRevision, metadata.source.desiredRevision, target]), occurrences: 1, lastEmittedAt: now(), ...(occurrenceId === undefined ? {} : { lastOccurrenceId: occurrenceId }) });
    emit(kind, { ...metadata, occurrences: 1 }, error, attemptId);
  };
  const recover = (metadata: WorkerConfigurationDiagnosticMetadata, attemptId?: string, kind = "worker-configuration-recovered", target?: { readonly value: unknown }): boolean => {
    const stream = `${metadata.phase}:${itemKey(metadata.key)}`, previous = failures.get(stream);
    if (previous === undefined) return false;
    failures.delete(stream);
    if (target !== undefined && previous.targetSignature !== JSON.stringify([metadata.targetRevision, metadata.source.desiredRevision, target.value])) return false;
    emit(kind, { ...metadata, status: "recovered", occurrences: previous.occurrences }, undefined, attemptId);
    return true;
  };
  return {
    exchange: (event: WorkerConfigurationExchangeEvent): void => {
      const source = event.source ?? unread;
      const reportId = event.report?.reportId;
      const failure = event.status === "failed" ? exchangeFailure(event.error, event.phase) : undefined;
      const metadata: WorkerConfigurationDiagnosticMetadata = {
        phase: event.phase, status: event.status, source, syncId: event.syncId,
        ...(event.previousSource === undefined ? {} : { previousSource: event.previousSource }),
        ...(event.received === undefined ? {} : { received: event.received }),
        ...(event.observationAccepted === undefined ? {} : { observationAccepted: event.observationAccepted }),
        ...(reportId === undefined ? {} : { reportId }),
        ...(event.report === undefined ? {} : { recordIds: event.report.recordIds }),
        ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
        remote: event.remoteOutcome === "success" ? "confirmed" : event.remoteOutcome,
        local: event.localOutcome, occurrences: 0, nextAttemptAt: event.nextAttemptAt ?? null,
        ...(event.backoffStep === undefined ? {} : { backoffStep: event.backoffStep }),
        ...(failure === undefined ? {} : { reason: failure.reason, details: failureDetails(failure) }),
      };
      if (event.status === "failed") { fail(metadata, event.error); return; }
      if (event.status === "succeeded") recover(metadata);
      const aligned = event.phase === "authority-read" && event.status === "succeeded" && event.previousSource !== undefined
        && (event.previousSource.state !== source.state || event.previousSource.desiredRevision !== source.desiredRevision || event.previousSource.observationRevision !== source.observationRevision);
      emit(aligned ? "worker-configuration-aligned" : "worker-configuration-stage", aligned ? { ...metadata, status: "aligned" } : metadata);
    },
    application: (event: WorkerConfigurationApplicationEvent): void => {
      const stream = `${event.phase}:${itemKey(event.key)}`, previous = applicationProgress.get(stream);
      const duplicate = previous?.attemptId === event.attemptId && previous.kind === event.kind;
      applicationProgress.set(stream, { attemptId: event.attemptId, kind: event.kind, local: event.local });
      const failure = event.kind === "failed" ? exchangeFailure(event.error, event.phase) : undefined;
      const metadata: WorkerConfigurationDiagnosticMetadata = {
        phase: event.phase, status: event.kind === "cancelled" ? "discarded" : event.kind,
        key: event.key, source: event.source, generation: event.generation,
        recordId: event.recordId, targetRevision: event.revision, remote: "not_sent", local: event.local,
        occurrences: 0, backoffStep: event.backoffStep, nextAttemptAt: event.nextAttemptAt,
        ...(failure === undefined ? {} : { reason: failure.reason, details: failureDetails(failure) }),
      };
      if (duplicate) {
        if (previous.local !== event.local) emit("worker-configuration-checkpoint", { ...metadata, occurrences: failures.get(stream)?.occurrences ?? 0 }, undefined, event.attemptId);
        return;
      }
      if (event.kind === "failed") { fail(metadata, event.error, event.target, event.attemptId, event.attemptId); return; }
      if (event.kind === "succeeded" && recover(metadata, event.attemptId, "worker-configuration-recovered", { value: event.target })) return;
      emit("worker-configuration-application", metadata, undefined, event.attemptId);
    },
    storage: (event: ConfigurationPersistenceEvent): void => {
      const context = event.context, report = context?.report, syncId = context?.syncId;
      const wrapped = event.error === undefined ? undefined : new ConfigurationFileOperationError(event.phase, event.error);
      const failure = wrapped === undefined ? undefined : classifyConfigurationFailure(wrapped);
      const metadata: WorkerConfigurationDiagnosticMetadata = {
        phase: "cache-persist", storagePhase: event.phase, status: event.kind === "blocked" ? "failed" : "succeeded", source: context?.source ?? unread,
        ...(report === undefined ? {} : { reportId: report.reportId }), ...(syncId === undefined ? {} : { syncId }), recordIds: event.recordIds,
        remote: context?.kind === "receipt-accept" || context?.kind === "authority-read" ? "confirmed" : "not_sent", local: event.kind === "blocked" ? "pending" : "persisted",
        occurrences: event.attempts, backoffStep: Math.min(event.attempts, 5), nextAttemptAt: event.nextAttemptAt,
        ...(failure === undefined ? {} : { reason: failure.reason, details: failureDetails(failure) }),
      };
      if (event.kind === "blocked") { fail(metadata, wrapped, context?.kind, `${report?.reportId ?? "checkpoint"}:${event.attempts}`, undefined, "worker-configuration-storage-blocked"); return; }
      recover(metadata, undefined, "worker-configuration-storage-recovered");
    },
    errors: (): readonly unknown[] => errors,
  };
};
