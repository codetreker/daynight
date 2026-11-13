import { expect, it, vi } from "vitest";
import { ApiError } from "../../../src/api/client.js";
import { OperationError } from "../../../src/api/operation.js";
import { ToolSelectionError } from "../../../src/platform/tool-executables.js";
import { createWorkerConfigurationDiagnostics } from "../../../src/commands/worker/configuration-diagnostics.js";
import type { WorkerConfigurationApplicationEvent } from "../../../src/commands/worker/configuration.js";
import type { WorkerConfigurationExchangeEvent } from "../../../src/commands/worker/configuration-exchange.js";
import type { ConfigurationPersistenceEvent } from "../../../src/commands/worker/configuration-persistence.js";
import type { WorkerDiagnostic } from "../../../src/commands/worker/diagnostics.js";

const source = { state: "initialized" as const, generation: "current-generation", desiredRevision: "5", observationRevision: "0" };
const application = (input: Partial<WorkerConfigurationApplicationEvent> = {}): WorkerConfigurationApplicationEvent => ({
  kind: "failed", phase: "validate", attemptId: "attempt-1", key: { kind: "native" }, recordId: "original-record", generation: "original-generation", revision: "10",
  target: { agent: "codex", model: null, args: [] }, source, local: "pending", error: new ToolSelectionError("codex", "web", "probe", "probe_timeout"), nextAttemptAt: "2026-11-13T04:00:00.000Z", backoffStep: 5, ...input,
});
const exchange = (input: Partial<WorkerConfigurationExchangeEvent> = {}): WorkerConfigurationExchangeEvent => ({
  syncId: "sync-1", phase: "report-send", status: "failed", source, remoteOutcome: "unknown", localOutcome: "not_attempted", error: new OperationError("request_timeout"), ...input,
});
const report = { reportId: "report-1", generation: source.generation, baseRevision: "0", recordIds: ["record-1"], failures: [{ sourceRecordId: "record-1", failureId: 7 }], items: [{ key: { kind: "native" as const }, recordId: "record-1", targetRevision: "5" }] };

it("counts actual failed attempts past capped backoff and emits at most one five-minute summary", () => {
  let time = 0;
  const events: WorkerDiagnostic[] = [], diagnostics = createWorkerConfigurationDiagnostics({ emit: event => events.push(event), now: () => time });
  for (let attempt = 1; attempt <= 8; attempt++) {
    time = (attempt - 1) * 60_000;
    diagnostics.application(application({ attemptId: `attempt-${attempt}` }));
    diagnostics.application(application({ attemptId: `attempt-${attempt}`, local: "persisted" }));
  }
  const failures = events.filter(event => event.kind === "worker-configuration-failed" || event.kind === "worker-configuration-summary");
  expect(failures.map(event => event.configuration)).toMatchObject([
    { status: "failed", occurrences: 1, backoffStep: 5, reason: "probe_timeout" },
    { status: "summary", occurrences: 6, backoffStep: 5, reason: "probe_timeout" },
  ]);
  expect(events.filter(event => event.kind === "worker-configuration-checkpoint")).toHaveLength(8);
  diagnostics.application(application({ kind: "succeeded", attemptId: "attempt-9", error: undefined, nextAttemptAt: null, backoffStep: 0 }));
  expect(events.filter(event => event.kind === "worker-configuration-recovered")).toMatchObject([{ configuration: { occurrences: 8, local: "pending" } }]);
  expect(events[0]?.configuration).toMatchObject({ generation: "original-generation", targetRevision: "10", source: { generation: "current-generation", desiredRevision: "5", observationRevision: "0" }, details: { tool: "codex", context: "web", stage: "probe" } });
});

it("ignores dynamic request, sync, report, generation and retry values when grouping a stable failure", () => {
  let time = 0;
  const events: WorkerDiagnostic[] = [], diagnostics = createWorkerConfigurationDiagnostics({ emit: event => events.push(event), now: () => time });
  for (let attempt = 1; attempt <= 7; attempt++) {
    time = (attempt - 1) * 60_000;
    const error = new ApiError({ operation: "worker.configuration.report" }, "request", { cause: new OperationError("request_timeout"), outcomeUnconfirmed: true, serverError: { code: "server_error", message: "secret output", requestId: `request-${attempt}` } });
    diagnostics.exchange(exchange({ syncId: `sync-${attempt}`, report: { ...report, reportId: `report-${attempt}` }, source: { ...source, generation: `generation-${attempt}` }, error, requestId: `request-${attempt}` }));
  }
  const failures = events.filter(event => event.kind === "worker-configuration-failed" || event.kind === "worker-configuration-summary");
  expect(failures).toHaveLength(2);
  expect(failures[1]?.configuration).toMatchObject({ occurrences: 6, syncId: "sync-6", reportId: "report-6", requestId: "request-6", remote: "unknown", reason: "timeout" });
  expect(JSON.stringify(events)).not.toContain("secret output");
});

it("records reason and target changes immediately without claiming a different target recovered", () => {
  const events: WorkerDiagnostic[] = [], diagnostics = createWorkerConfigurationDiagnostics({ emit: event => events.push(event), now: () => 1 });
  diagnostics.application(application());
  diagnostics.application(application({ attemptId: "attempt-2", error: new ToolSelectionError("codex", "web", "verify", "permission_denied") }));
  diagnostics.application(application({ attemptId: "attempt-3", target: { agent: "codex", model: "other", args: [] } }));
  diagnostics.application(application({ attemptId: "attempt-4", kind: "succeeded", target: { agent: "codex", model: "third", args: [] }, error: undefined }));
  expect(events.filter(event => event.kind === "worker-configuration-failed")).toHaveLength(3);
  expect(events.filter(event => event.kind === "worker-configuration-recovered")).toHaveLength(0);
  expect(events.at(-1)?.configuration).toMatchObject({ status: "succeeded" });
});

it("keeps confirmed report, rejected observation and pending local checkpoint as separate facts", () => {
  const events: WorkerDiagnostic[] = [], diagnostics = createWorkerConfigurationDiagnostics({ emit: event => events.push(event) });
  diagnostics.exchange(exchange({ status: "succeeded", phase: "report-send", remoteOutcome: "success", report, received: { desiredRevision: "3", observationRevision: "0" }, observationAccepted: false, error: undefined }));
  diagnostics.exchange(exchange({ status: "started", phase: "receipt-accept", remoteOutcome: "success", localOutcome: "pending", report, received: { desiredRevision: "3", observationRevision: "0" }, observationAccepted: false, error: undefined }));
  const blocked: ConfigurationPersistenceEvent = { kind: "blocked", phase: "persist", attempts: 1, nextAttemptAt: "2026-11-13T04:00:00.000Z", recordIds: report.recordIds,
    error: Object.assign(new Error("secret disk path"), { code: "EACCES" }), context: { kind: "receipt-accept", source, report, syncId: "sync-1" } };
  diagnostics.storage(blocked);
  expect(events.at(-1)).toMatchObject({ kind: "worker-configuration-storage-blocked", configuration: { phase: "cache-persist", storagePhase: "persist", reason: "permission_denied", remote: "confirmed", local: "pending", syncId: "sync-1", reportId: "report-1", recordIds: ["record-1"], details: { systemCode: "EACCES" } } });
  expect(events[1]?.configuration).toMatchObject({ source: { desiredRevision: "5", observationRevision: "0" }, received: { desiredRevision: "3", observationRevision: "0" }, observationAccepted: false, remote: "confirmed", local: "pending" });
  diagnostics.storage({ ...blocked, kind: "recovered", error: undefined, nextAttemptAt: null });
  expect(events.at(-1)).toMatchObject({ kind: "worker-configuration-storage-recovered", configuration: { remote: "confirmed", local: "persisted", occurrences: 1 } });
  expect(JSON.stringify(events)).not.toContain("secret disk path");
});

it("distinguishes unread cached zero, confirmed uninitialized zero and stale receipt ignored", () => {
  const events: WorkerDiagnostic[] = [], diagnostics = createWorkerConfigurationDiagnostics({ emit: event => events.push(event) });
  diagnostics.exchange(exchange({ phase: "authority-read", status: "succeeded", source: { ...source, state: "uninitialized", desiredRevision: null }, previousSource: { ...source, state: "unread" }, received: { desiredRevision: null, observationRevision: "0" }, remoteOutcome: "success", localOutcome: "persisted", error: undefined }));
  diagnostics.exchange(exchange({ phase: "receipt-accept", status: "succeeded", remoteOutcome: "success", localOutcome: "ignored", report, error: undefined }));
  expect(events[0]).toMatchObject({ kind: "worker-configuration-aligned", configuration: { previousSource: { state: "unread", observationRevision: "0" }, source: { state: "uninitialized", desiredRevision: null, observationRevision: "0" } } });
  expect(events.at(-1)?.configuration).toMatchObject({ remote: "confirmed", local: "ignored" });
});

it("retains diagnostic failures without throwing into application or acknowledgement callbacks", () => {
  const original = new Error("formatter failure", { cause: new Error("original cause") });
  const emit = vi.fn(() => { throw original; }), diagnostics = createWorkerConfigurationDiagnostics({ emit });
  expect(() => diagnostics.application(application())).not.toThrow();
  expect(() => diagnostics.exchange(exchange())).not.toThrow();
  expect(diagnostics.errors()).toEqual([original, original]);
  expect((diagnostics.errors()[0] as Error).cause).toBe(original.cause);
});
