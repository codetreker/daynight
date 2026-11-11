import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { ArchiveRepairRequiredError } from "../../../../src/commands/controller/archive-error.js";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../src/api/client.js";
import { createOperation, OperationError } from "../../../../src/api/operation.js";
import { ProtocolError } from "../../../../src/api/parse.js";
import { RepositoryGitError, runRepositoryGit } from "../../../../src/repository/git.js";
import { WorkerCleanupError } from "../../../../src/commands/worker/cleanup-error.js";
import { WorktreePreconditionError } from "../../../../src/commands/worker/worktrees.js";
import { NativeVersionOutputError } from "../../../../src/commands/worker/herdr/version-probe.js";
import { HerdrCommandCleanupError, HerdrCommandDeadlineError, HerdrCommandError } from "../../../../src/commands/worker/herdr/command.js";
import { classifyFailure, diagnostic, MonitoringRecoveryEvidence } from "../../../../src/commands/worker/monitoring/diagnostics.js";
import { createMonitoringObserver, goJsonBytes } from "../../../../src/commands/worker/monitoring/observer.js";
import type { DiagnosticCode } from "../../../../src/commands/worker/monitoring/types.js";

const runId = "11111111-1111-4111-8111-111111111111";
const identity = (index: number) => ({ projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", claimId: `cccccccc-cccc-4ccc-8ccc-${index.toString(16).padStart(12, "0")}` });
const secret = "secret /private/path prompt $(command output)";

describe("worker monitoring observer", () => {
  it("keeps worker and project native failures independent and suppresses stale idle evidence", () => {
    const observer = createMonitoringObserver({ runId, now: () => 1_000 }), observedAt = new Date(1_000).toISOString(), nextAttemptAt = new Date(6_000).toISOString();
    const worker = { kind: "worker" } as const, project = { kind: "project", projectId: identity(1).projectId } as const;
    observer.setAdmission("complete", [{ code: "no-ready-tasks", scope: worker, observedAt, nextAttemptAt: null }]);
    observer.setNativeConfigurationReason(worker, { observedAt, nextAttemptAt });
    observer.setNativeConfigurationReason(project, { observedAt, nextAttemptAt });
    observer.setAdmission("complete", [{ code: "configuration-incomplete", scope: worker, observedAt, nextAttemptAt: null }]);
    const snapshot = observer.capture("1");
    expect(snapshot.admission.coverage).toBe("partial");
    expect(snapshot.admission.reasons).toHaveLength(2);
    expect(snapshot.admission.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: "configuration-incomplete", scope: worker, nextAttemptAt }), expect.objectContaining({ code: "configuration-incomplete", scope: project, nextAttemptAt })]));
    observer.setNativeConfigurationReason(worker, null);
    expect(observer.capture("2").admission.reasons).toContainEqual(expect.objectContaining({ code: "configuration-incomplete", scope: project }));
    observer.setNativeConfigurationReason(project, null);
    expect(observer.capture("3").admission.coverage).toBe("partial");
  });

  it("retains independent project preparation reasons across scheduler admission updates", () => {
    const observer = createMonitoringObserver({ runId, now: () => 1_000 });
    const projectId = identity(1).projectId, observedAt = new Date(1_000).toISOString(), nextAttemptAt = new Date(6_000).toISOString();
    observer.setProjectPreparationReason(projectId, { observedAt, nextAttemptAt });
    observer.setAdmission("complete", [{ code: "no-ready-tasks", scope: { kind: "worker" }, observedAt, nextAttemptAt: null }]);
    expect(observer.capture("1").admission).toMatchObject({ coverage: "partial", reasons: [{ code: "project-preparation-failed", scope: { kind: "project", projectId }, observedAt, nextAttemptAt }] });
    observer.setAdmission("complete", [{ code: "capacity-full", scope: { kind: "worker" }, observedAt, nextAttemptAt: null }]);
    expect(observer.capture("2").admission.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: "capacity-full" }), expect.objectContaining({ code: "project-preparation-failed" })]));
    observer.setProjectPreparationReason(projectId, null);
    expect(observer.capture("3").admission).toMatchObject({ coverage: "partial", reasons: [{ code: "capacity-full" }] });
    observer.setAdmission("complete", [{ code: "no-ready-tasks", scope: { kind: "worker" }, observedAt, nextAttemptAt: null }]);
    observer.setProjectPreparationUnknown(true);
    expect(observer.capture("4").admission).toMatchObject({ coverage: "partial", reasons: [] });
    observer.setProjectPreparationUnknown(false);
    expect(observer.capture("5").admission).toMatchObject({ coverage: "unknown", reasons: [] });
    observer.setAdmission("complete", [{ code: "no-ready-tasks", scope: { kind: "worker" }, observedAt, nextAttemptAt: null }]);
    expect(observer.capture("6").admission).toMatchObject({ coverage: "complete", reasons: [{ code: "no-ready-tasks" }] });
  });

  it("keeps scheduler success and idle evidence from advancing during preparation", () => {
    let now = 1_000;
    const observer = createMonitoringObserver({ runId, now: () => now });
    observer.startCycle("claim-search"); observer.markCycleSuccessful(); observer.endCycle("completed", "complete");
    observer.setAdmission("complete", [{ code: "no-ready-tasks", scope: { kind: "worker" }, observedAt: new Date(now).toISOString(), nextAttemptAt: null }]);
    const previousSuccess = observer.capture("1").scheduler.lastSuccessfulAt;
    now = 2_000; observer.setProjectPreparationIncomplete(true);
    observer.startCycle("claim-search"); observer.markCycleSuccessful(); observer.endCycle("completed", "complete");
    observer.setAdmission("complete", [{ code: "no-ready-tasks", scope: { kind: "worker" }, observedAt: new Date(now).toISOString(), nextAttemptAt: null }]);
    expect(observer.capture("2")).toMatchObject({ scheduler: { coverage: "partial", lastSuccessfulAt: previousSuccess }, admission: { coverage: "partial", reasons: [] } });
    observer.setAdmission("complete", [{ code: "no-projects-selected", scope: { kind: "worker" }, observedAt: new Date(now).toISOString(), nextAttemptAt: null }]);
    expect(observer.capture("2").admission).toMatchObject({ coverage: "partial", reasons: [] });
    observer.setProjectPreparationIncomplete(false);
    expect(observer.capture("3")).toMatchObject({ scheduler: { coverage: "partial", lastSuccessfulAt: previousSuccess }, admission: { coverage: "partial", reasons: [] } });
    now = 3_000; observer.startCycle("claim-search"); observer.markCycleSuccessful(); observer.endCycle("completed", "complete");
    observer.setAdmission("complete", [{ code: "no-ready-tasks", scope: { kind: "worker" }, observedAt: new Date(now).toISOString(), nextAttemptAt: null }]);
    expect(observer.capture("4")).toMatchObject({ scheduler: { coverage: "complete", lastSuccessfulAt: new Date(now).toISOString() }, admission: { coverage: "complete", reasons: [{ code: "no-ready-tasks" }] } });
  });

  it("retains unknown capacity, true counts, deduplicated roles and stable run-local reservations", () => {
    let now = 0;
    const observer = createMonitoringObserver({ runId, now: () => now, reservationKey: new Uint8Array(32).fill(1) });
    expect(observer.capture("1").capacity).toBeNull();
    observer.setCapacity({ limit: 1, occupied: 2, reservations: [{ identity: identity(1), roles: ["cleanup"] }, { identity: identity(1), roles: ["active-task", "cleanup"] }, { identity: identity(2), roles: ["resource-owner"] }] });
    const first = observer.capture("2");
    expect(first.capacity).toMatchObject({ occupied: 2, available: 0, quality: "current", detailCoverage: "complete" });
    expect(first.reservations).toHaveLength(2);
    expect(first.reservations.find(item => item.roles.includes("cleanup"))?.roles).toEqual(["active-task", "cleanup"]);
    expect(first.reservations[0]!.reservationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    now = 1_000;
    observer.setCapacity({ limit: 2, occupied: 2, reservations: [{ identity: identity(2), roles: ["resource-owner"] }, { identity: identity(1), roles: ["cleanup"] }] });
    expect(observer.capture("3").reservations.map(item => item.reservationId).sort()).toEqual(first.reservations.map(item => item.reservationId).sort());
    observer.staleCapacity();
    expect(observer.capture("4").capacity).toMatchObject({ quality: "stale", occupied: 2 });
    observer.setCapacity({ limit: 1, occupied: 3, reservations: [{ identity: identity(1), roles: ["cleanup"] }], partial: true });
    expect(observer.capture("5").capacity).toMatchObject({ occupied: 3, available: 0, detailCoverage: "partial" });
  });

  it("omits all colliding identities before truncation without changing capacity", () => {
    const observer = createMonitoringObserver({ runId, reservationKey: new Uint8Array(32), reservationDigest: () => new Uint8Array(32) });
    observer.setCapacity({ limit: 1, occupied: 2, reservations: [{ identity: identity(1), roles: ["cleanup"] }, { identity: identity(2), roles: ["active-task"] }] });
    expect(observer.capture("1")).toMatchObject({ capacity: { occupied: 2, available: 0, detailCoverage: "partial" }, reservations: [], detailCoverage: "partial" });
  });

  it("caps detail without hiding exact occupancy and preserves the global cleanup reason", () => {
    const observer = createMonitoringObserver({ runId, now: () => 1_000, reservationKey: new Uint8Array(32) });
    observer.setCapacity({ limit: 64, occupied: 140, reservations: Array.from({ length: 140 }, (_, i) => ({ identity: identity(i), roles: ["resource-owner"] })) });
    const scope = { kind: "worker" } as const;
    for (let i = 0; i < 130; i++) observer.startActivity({ kind: "execution", phase: "executing", scope });
    for (let i = 0; i < 34; i++) { const id = observer.startActivity({ kind: "execution", phase: "waiting", scope }); observer.fail({ operationId: id, component: "execution", phase: "waiting", scope, error: new Error(secret) }); }
    observer.setAdmission("complete", [...Array.from({ length: 17 }, () => ({ code: "capacity-full" as const, scope, observedAt: new Date(0).toISOString(), nextAttemptAt: null })), { code: "cleanup-capacity-blocked", scope, observedAt: new Date(0).toISOString(), nextAttemptAt: null }]);
    const captured = observer.capture("1");
    expect(captured.capacity).toMatchObject({ occupied: 140, available: 0, detailCoverage: "partial" });
    expect(captured.reservations).toHaveLength(128); expect(captured.activities).toHaveLength(128); expect(captured.currentFailures).toHaveLength(32);
    expect(captured.detailCoverage).toBe("partial"); expect(captured.admission.coverage).toBe("partial");
    expect(captured.admission.reasons).toHaveLength(16); expect(captured.admission.reasons[0]).toMatchObject({ code: "cleanup-capacity-blocked", observedAt: captured.admission.observedAt, nextAttemptAt: null });
    expect(JSON.stringify(captured)).not.toContain(secret);
    expect(goJsonBytes({ expectedRevision: runId, observation: captured })).toBeLessThanOrEqual(256 * 1024);
    expect(goJsonBytes({ s: "<>&\u2028\u2029" })).toBe(Buffer.byteLength('{"s":"\\u003c\\u003e\\u0026\\u2028\\u2029"}\n'));
  });

  it("clears completed activities without fabricating progress or recovery", () => {
    const dirty = vi.fn();
    const observer = createMonitoringObserver({ runId, onDirty: dirty });
    const scope = { kind: "worker" } as const;
    observer.startActivity({ kind: "execution", phase: "executing", scope });
    observer.startActivity({ kind: "cleanup", phase: "agent-stop", scope });
    observer.clearActivities();
    const snapshot = observer.capture("1");
    expect(snapshot.activities).toEqual([]);
    expect(snapshot.lastRecovery).toBeNull();
    const before = dirty.mock.calls.length;
    observer.clearActivities();
    expect(dirty).toHaveBeenCalledTimes(before);
  });

  it("discards a failure without inventing a recovery", () => {
    const observer = createMonitoringObserver({ runId });
    const scope = { kind: "claim", ...identity(1) } as const;
    const id = observer.startActivity({ kind: "execution", phase: "executing", scope });
    observer.fail({ operationId: id, component: "execution", phase: "executing", scope, error: new Error(secret) });
    observer.discardFailure(id);
    expect(observer.capture("1")).toMatchObject({ currentFailures: [], lastRecovery: null });
  });

  it("updates retry state without inventing a new failure or changing its observed times", () => {
    let time = 1_000;
    const observer = createMonitoringObserver({ runId, now: () => time });
    const scope = { kind: "claim", ...identity(1) } as const;
    const id = observer.startActivity({ kind: "cleanup", phase: "archive", scope });
    observer.fail({ operationId: id, component: "cleanup", phase: "archive", scope, error: new Error(secret), retryState: "scheduled", nextAttemptAt: new Date(6_000).toISOString() });
    const before = observer.capture("1").currentFailures[0]!;
    time = 6_000; observer.updateFailureRetry(id, "running");
    const running = observer.capture("2").currentFailures[0]!;
    expect(running).toEqual({ ...before, retryState: "running", nextAttemptAt: null });
    expect(observer.capture("2").lastRecovery).toBeNull();
    expect(() => observer.updateFailureRetry(id, "scheduled")).toThrow();
    expect(observer.capture("3").currentFailures[0]).toEqual(running);
  });

  it("only records actual progress and matching recovery, and delivery does not signal dirty", () => {
    let time = 0, mono = 0;
    const dirty = vi.fn();
    const observer = createMonitoringObserver({ runId, now: () => time, monotonic: () => mono, onDirty: dirty });
    const scope = { kind: "claim", ...identity(1) } as const;
    observer.startCycle("inventory"); observer.endCycle("completed", "partial");
    expect(observer.capture("1").scheduler.lastSuccessfulAt).toBeNull();
    const id = observer.startActivity({ kind: "execution", phase: "agent-start", scope });
    mono = 2_500; time = 5_000;
    observer.updateActivity(id, { status: "waiting", waitReason: "native-input" });
    expect(observer.capture("2").activities[0]).toMatchObject({ elapsedMs: 2500, lastProgressAt: null });
    observer.updateActivity(id, { phase: "agent-observation", progress: true });
    observer.fail({ operationId: id, component: "execution", phase: "agent-observation", scope, error: new Error(secret) });
    time = 6_000;
    observer.fail({ operationId: id, component: "execution", phase: "agent-observation", scope, error: new Error(secret) });
    expect(observer.capture("3").currentFailures[0]).toMatchObject({ occurrencesInRun: 2, firstObservedAt: new Date(5_000).toISOString(), lastObservedAt: new Date(6_000).toISOString() });
    observer.recover(runId); expect(observer.capture("4").currentFailures).toHaveLength(1);
    observer.recover(id); observer.markCycleSuccessful();
    expect(observer.capture("5")).toMatchObject({ currentFailures: [], lastRecovery: { operationId: id, explanation: "The operation recovered.", explanationTruncated: false }, scheduler: { lastSuccessfulAt: new Date(6_000).toISOString() } });
    const before = dirty.mock.calls.length;
    observer.deliveryFailure("write", new Error(secret), secret); observer.deliverySuccess();
    expect(dirty).toHaveBeenCalledTimes(before);
    expect(observer.capture("6").delivery.lastFailure).toMatchObject({ requestId: null, error: { code: "unknown" } });
  });
});

describe("safe monitoring diagnostics", () => {
  it("uses the complete fixed diagnostic vocabulary", () => {
    const expected: readonly [DiagnosticCode, string][] = [
      ["cancelled", "The operation was cancelled."],
      ["timeout", "The operation timed out."],
      ["authentication-required", "Authentication is required."],
      ["limit-exceeded", "An operation limit was exceeded."],
      ["rate-limited", "The operation was rate limited."],
      ["permission-denied", "Permission was denied."],
      ["not-found-or-inaccessible", "A required resource was not found or is inaccessible."],
      ["not-found", "A required resource was not found."],
      ["conflict", "The operation encountered a conflict."],
      ["unavailable", "A required service or resource is unavailable."],
      ["invalid-response", "The response was invalid."],
      ["resource-exhausted", "A required resource was exhausted."],
      ["configuration-missing", "Required configuration is missing."],
      ["configuration-invalid", "The configuration is invalid."],
      ["command-failed", "A required command failed."],
      ["io-error", "A required I/O operation failed."],
      ["invalid-output", "A required operation produced invalid output."],
      ["recovery-limit", "The recovery limit was reached."],
      ["native-identity-missing", "The original native execution identity is missing."],
      ["worktree-validation-failed", "The worktree failed ownership validation."],
      ["branch-mismatch", "The worktree branch does not match the recorded owner."],
      ["recovery-blocked", "Recovery is blocked and needs attention."],
      ["outcome-unknown", "The operation outcome is unknown."],
      ["unknown", "The operation failed; inspect local Worker diagnostics for details."],
    ];
    expect(expected).toHaveLength(24);
    for (const [code, cause] of expected) expect(diagnostic(code)).toEqual({ type: "operation", code, cause, causeTruncated: false });
  });

  it("maps only controlled evidence and never copies exception contents", () => {
    const unknownWrite = new ApiError({ operation: "write" }, "request", { cause: new OperationError("deadline"), outcomeUnconfirmed: true });
    const cases: [unknown, DiagnosticCode][] = [
      [unknownWrite, "outcome-unknown"], [new OperationError("cancelled"), "cancelled"], [new OperationError("request_timeout"), "timeout"], [new OperationError("total_limit"), "limit-exceeded"],
      ...([[401, "authentication-required"], [403, "permission-denied"], [404, "not-found-or-inaccessible"], [409, "conflict"], [413, "limit-exceeded"], [429, "rate-limited"], [503, "unavailable"]] as const).map(([status, code]) => [new ApiError({ operation: "read" }, "response", { status, cause: new Error(secret) }), code] as [unknown, DiagnosticCode]),
      [new MonitoringRecoveryEvidence("native_identity_missing"), "native-identity-missing"], [new MonitoringRecoveryEvidence("recovery_limit"), "recovery-limit"], [new MonitoringRecoveryEvidence("recovery_blocked"), "recovery-blocked"],
      [{ reasonCode: "recovery_limit", message: secret }, "unknown"], [new ProtocolError(secret), "invalid-response"], [new WorkerCleanupError("worktree-removal", new WorktreePreconditionError("branch_mismatch", secret)), "branch-mismatch"],
      [new AggregateError([unknownWrite, new Error(secret)], secret), "unknown"], [new Error(secret, { cause: new OperationError("deadline") }), "unknown"],
    ];
    for (const [error, code] of cases) expect(classifyFailure(error)).toEqual(diagnostic(code));
    expect(JSON.stringify(cases.map(([error]) => classifyFailure(error)))).not.toContain(secret);
  });

  it("prioritizes known unknown outcomes and controlled operation limits over response status", () => {
    expect(classifyFailure(new AggregateError([new OperationError("deadline")], secret), true)).toEqual(diagnostic("outcome-unknown"));
    const unknownWrite = new ApiError({ operation: "write" }, "response", { status: 401, cause: new OperationError("cancelled"), outcomeUnconfirmed: true });
    expect(classifyFailure(unknownWrite)).toEqual(diagnostic("outcome-unknown"));
    for (const kind of ["deadline", "request_timeout"] as const) expect(classifyFailure(new OperationError(kind))).toEqual(diagnostic("timeout"));
    for (const kind of ["request_limit", "response_limit", "total_limit"] as const) expect(classifyFailure(new OperationError(kind))).toEqual(diagnostic("limit-exceeded"));
    expect(classifyFailure(new ApiError({ operation: "read" }, "response", { status: 503, cause: new OperationError("request_limit") }))).toEqual(diagnostic("limit-exceeded"));
    expect(classifyFailure(new OperationError("disposed"))).toEqual(diagnostic("unknown"));
    expect(classifyFailure(new ApiError({ operation: "read" }, "response", { status: 500, cause: new Error(secret) }))).toEqual(diagnostic("unknown"));
    expect(classifyFailure(new ApiError({ operation: "read" }, "pagination", { cause: new Error(secret) }))).toEqual(diagnostic("invalid-response"));
    expect(classifyFailure(new WorktreePreconditionError("validation_failed", secret))).toEqual(diagnostic("worktree-validation-failed"));
  });

  it("classifies trusted native probe failures without exposing command data or guessing aggregate causes", () => {
    const output = new NativeVersionOutputError("codex"); output.message = secret;
    const deadline = new HerdrCommandDeadlineError(); deadline.message = secret;
    const command = new HerdrCommandError(secret, 17, null, secret, { cause: new Error(secret) });
    const spawn = new HerdrCommandError(secret, null, null, secret, { cause: new Error(secret) });
    const signalOnly = new HerdrCommandError(secret, null, "SIGTERM", secret);
    const cases: [unknown, DiagnosticCode][] = [
      [output, "invalid-output"], [deadline, "timeout"], [command, "command-failed"],
      [spawn, "unknown"], [signalOnly, "unknown"], [new HerdrCommandError(secret, 0, null, secret), "unknown"],
      [new WorkerCleanupError("observation", command), "command-failed"],
      [new AggregateError([output, command], secret), "unknown"],
      [new HerdrCommandCleanupError([deadline], command), "unknown"],
      [{ name: "HerdrCommandError", exitCode: 17, stderr: secret }, "unknown"],
    ];
    for (const [error, code] of cases) expect(classifyFailure(error)).toEqual(diagnostic(code));
    expect(classifyFailure(command, true)).toEqual(diagnostic("outcome-unknown"));
    expect(classifyFailure(new ApiError({ operation: "write" }, "request", { cause: command, outcomeUnconfirmed: true }))).toEqual(diagnostic("outcome-unknown"));
    expect(classifyFailure(new ApiError({ operation: "read" }, "response", { status: 403, cause: command }))).toEqual(diagnostic("permission-denied"));
    const observer = createMonitoringObserver({ runId });
    const scope = { kind: "project", projectId: identity(1).projectId } as const;
    for (const [error] of cases) {
      const operationId = observer.startActivity({ kind: "maintenance", phase: "configuration", scope });
      observer.fail({ operationId, component: "configuration", phase: "configuration", scope, error });
    }
    expect(JSON.stringify(observer.capture("1"))).not.toContain(secret);
  });

  it("classifies trusted Git exits through cleanup wrappers without exposing repository diagnostics", () => {
    const statuses: readonly [number | null, NodeJS.Signals | null, DiagnosticCode][] = [
      [23, null, "command-failed"], [null, null, "unknown"], [null, "SIGTERM", "unknown"],
      [0, null, "unknown"], [-1, null, "unknown"], [-2, null, "unknown"],
      [1.5, null, "unknown"], [NaN, null, "unknown"],
      [Infinity, null, "unknown"], [Number.MAX_SAFE_INTEGER + 1, null, "unknown"],
    ];
    const observer = createMonitoringObserver({ runId });
    const scope = { kind: "claim", ...identity(1) } as const;
    for (const [exitCode, signal, code] of statuses) {
      const command = new RepositoryGitError(secret, exitCode, signal, secret, { cause: new Error(secret) });
      for (const error of [command, new WorkerCleanupError("worktree-removal", command)]) {
        expect(classifyFailure(error)).toEqual(diagnostic(code));
        const operationId = observer.startActivity({ kind: "cleanup", phase: "worktree-removal", scope });
        observer.fail({ operationId, component: "cleanup", phase: "worktree-removal", scope, error });
      }
    }
    const command = new RepositoryGitError(secret, 23, null, secret);
    for (const error of [
      { name: "RepositoryGitError", exitCode: 23, stderr: secret },
      new Error(secret, { cause: command }), new AggregateError([command], secret),
    ]) expect(classifyFailure(error)).toEqual(diagnostic("unknown"));
    expect(classifyFailure(command, true)).toEqual(diagnostic("outcome-unknown"));
    expect(classifyFailure(new ApiError({ operation: "write" }, "request", { cause: command, outcomeUnconfirmed: true }))).toEqual(diagnostic("outcome-unknown"));
    expect(classifyFailure(new ApiError({ operation: "read" }, "response", { status: 403, cause: command }))).toEqual(diagnostic("permission-denied"));
    const snapshot = observer.capture("1");
    expect(snapshot.currentFailures).toContainEqual(expect.objectContaining({ error: diagnostic("command-failed") }));
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  it("keeps an actual Git spawn failure unknown through its cleanup wrapper", async () => {
    const scratch = path.resolve(import.meta.dirname, "../../../../../../.tmp/monitoring-diagnostics-tests");
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(path.join(scratch, "missing-git-"));
    const operation = createOperation({ limits: { totalMs: 5_000 } });
    try {
      const error: unknown = await runRepositoryGit(directory, ["version"], operation, {
        timeoutMs: 1_000, environment: { PATH: directory, Path: undefined },
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(RepositoryGitError);
      expect(error).toMatchObject({ cause: { code: "ENOENT" } });
      const diagnostics = [error, new WorkerCleanupError("worktree-removal", error)].map(failure => classifyFailure(failure));
      expect(diagnostics).toEqual([diagnostic("unknown"), diagnostic("unknown")]);
      expect(JSON.stringify(diagnostics)).not.toContain(directory);
    } finally {
      operation.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never copies secrets, paths, prompts or command output from error chains into snapshots", () => {
    const parts = ["fixture-token-482", "/home/private/worktree", "prompt-content-729", "command-output-819"];
    const error = new ApiError({ operation: parts[0]! }, "response", { status: 503, cause: new Error(parts[1], { cause: new Error(parts[2], { cause: new Error(parts[3]) }) }), serverError: { code: parts[0]!, message: parts.join(" "), requestId: parts[2]! } });
    const observer = createMonitoringObserver({ runId });
    const scope = { kind: "claim", ...identity(1) } as const;
    const operationId = observer.startActivity({ kind: "execution", phase: "executing", scope });
    observer.fail({ operationId, component: "execution", phase: "executing", scope, error });
    observer.deliveryFailure("write", error, parts[0]!);
    const snapshot = JSON.stringify(observer.capture("1"));
    for (const part of parts) expect(snapshot).not.toContain(part);
    expect(observer.capture("2").currentFailures[0]!.error).toEqual(diagnostic("unavailable"));
    expect(observer.capture("2").delivery.lastFailure?.requestId).toBeNull();
  });
});


it.each(["archive_incomplete", "projection_gap"] as const)("reports typed archive repair %s without exposing its diagnostic text", code => {
  const error = new ArchiveRepairRequiredError(code); error.message = secret;
  expect(classifyFailure(new WorkerCleanupError("archive", error))).toEqual(diagnostic("recovery-blocked"));
  expect(classifyFailure(new Error("archive_incomplete"))).toEqual(diagnostic("unknown"));
});

describe("failure worktree snapshots", () => {
  it("copies locations and preserves them through retry-only updates", () => {
    const observer = createMonitoringObserver({ runId });
    const scope = { kind: "claim", ...identity(1) } as const;
    const id = observer.startActivity({ kind: "execution", phase: "executing", scope });
    const worktree = { kind: "project-relative" as const, path: ".worktrees/a" };
    observer.fail({ operationId: id, component: "execution", phase: "executing", scope, error: new Error(secret), worktree });
    worktree.path = "changed";
    const first = observer.capture("1");
    expect(first.currentFailures[0]?.worktree).toEqual({ kind: "project-relative", path: ".worktrees/a" });
    if (first.currentFailures[0]?.worktree?.kind === "project-relative") first.currentFailures[0].worktree.path = "mutated";
    observer.updateFailureRetry(id, "running");
    expect(observer.capture("2").currentFailures[0]?.worktree).toEqual({ kind: "project-relative", path: ".worktrees/a" });
  });
  it("reduces largest Go-encoded paths before discarding failures and restores later snapshots", () => {
    const observer = createMonitoringObserver({ runId });
    for (let i = 0; i < 32; i++) {
      const scope = { kind: "claim", ...identity(i) } as const;
      const id = observer.startActivity({ kind: "execution", phase: "executing", scope });
      observer.fail({ operationId: id, component: "execution", phase: "executing", scope, error: new Error(secret), worktree: { kind: "project-relative", path: "<".repeat(4096) } });
    }
    const captured = observer.capture("1");
    expect(captured.currentFailures).toHaveLength(32);
    expect(captured.detailCoverage).toBe("partial");
    expect(captured.currentFailures.some(f => f.worktree?.kind === "unavailable")).toBe(true);
    expect(goJsonBytes({ expectedRevision: runId, observation: captured })).toBeLessThanOrEqual(256 * 1024);
    for (const f of captured.currentFailures.slice(1)) observer.discardFailure(f.operationId);
    expect(observer.capture("2").currentFailures[0]?.worktree).toEqual({ kind: "project-relative", path: "<".repeat(4096) });
  });
});
