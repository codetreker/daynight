import { describe, expect, it, vi } from "vitest";
import { createExecutionCapacity } from "../../../src/commands/worker/execution-capacity.js";
import { ExecutionSourceConflictError } from "../../../src/commands/worker/execution-stop.js";
import type { CleanupAttempt, ExecutionRef, StopObservation } from "../../../src/commands/worker/execution-stop.js";

const owner = { projectId: "project", taskId: "task", claimId: "claim", worktreeId: "worktree" };
const attempt: CleanupAttempt = { owner, attemptId: "first" };
const execution: ExecutionRef = { owner, backend: "web", runKey: "run-1" };
const running = (ref = execution): StopObservation => ({ kind: "running", execution: ref, observedAt: 1 });
const stopped = (ref = execution) => ({ kind: "stopped" as const, execution: ref, observedAt: 2 });
const unknown = (error = new Error("Unavailable")): StopObservation => ({ kind: "unknown", target: owner, error, observedAt: 3 });

describe("runtime execution capacity facts", () => {
  it("requires current terminal intent and rejects other owners and attempts", () => {
    const wake = vi.fn(), view = createExecutionCapacity(wake);
    expect(view.beginObservation(owner)).toBeNull();
    expect(view.notify({ attempt, observation: stopped() })).toBe(false);
    view.beginAttempt(attempt);
    expect(view.notify({ attempt: { ...attempt, attemptId: "old" }, observation: stopped() })).toBe(false);
    expect(view.notify({ attempt, observation: stopped({ ...execution, owner: { ...owner, worktreeId: "other" } }) })).toBe(false);
    const ticket = view.beginObservation(owner)!;
    expect(view.commitObservation(ticket, stopped({ ...execution, owner: { ...owner, claimId: "other" } }))).toBe(false);
    expect(view.isStopped(owner)).toBe(false);
    expect(wake).not.toHaveBeenCalled();
  });

  it("rejects earlier reads after a stop notice, including late running and unknown results", () => {
    for (const late of [running(), unknown()]) {
      const wake = vi.fn(), view = createExecutionCapacity(wake);
      view.beginAttempt(attempt);
      const ticket = view.beginObservation(owner)!;
      expect(view.notify({ attempt, observation: stopped() })).toBe(true);
      expect(view.commitObservation(ticket, late)).toBe(false);
      expect(view.isStopped(owner)).toBe(true);
      expect(wake).toHaveBeenCalledTimes(1);
    }
  });

  it("accepts only the latest read and keeps a same-source stop on a later read failure", () => {
    const wake = vi.fn(), view = createExecutionCapacity(wake), error = new Error("Read failed");
    view.beginAttempt(attempt);
    const old = view.beginObservation(owner)!, latest = view.beginObservation(owner)!;
    expect(view.commitObservation(latest, stopped())).toBe(true);
    expect(view.commitObservation(old, running())).toBe(false);
    const failure = view.beginObservation(owner)!;
    expect(view.commitObservation(failure, unknown(error))).toBe(true);
    expect(view.isStopped(owner)).toBe(true);
    expect(view.getObservation(owner)).toMatchObject({ kind: "stopped" });
    expect(view.getDiagnostic(owner)).toMatchObject({ kind: "unknown", error });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("keeps stopped evidence across retries while fencing old callbacks and reads", () => {
    const wake = vi.fn(), view = createExecutionCapacity(wake);
    view.beginAttempt(attempt); view.notify({ attempt, observation: stopped() });
    const priorRead = view.beginObservation(owner)!;
    const retry = { ...attempt, attemptId: "retry" };
    view.beginAttempt(retry);
    expect(view.isStopped(owner)).toBe(true);
    expect(view.notify({ attempt, observation: stopped() })).toBe(false);
    expect(view.commitObservation(priorRead, running())).toBe(false);
    expect(view.notify({ attempt: retry, observation: { ...stopped(), observedAt: 20 } })).toBe(true);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("revokes the exact attempt's stopped fact on a synchronous source conflict", () => {
    const wake = vi.fn(), view = createExecutionCapacity(wake);
    view.beginAttempt(attempt); view.notify({ attempt, observation: stopped() });
    const pending = view.beginObservation(owner)!;
    const error = new ExecutionSourceConflictError("Commit identified another source");
    expect(view.notifyConflict({ attempt: { ...attempt, attemptId: "old" }, execution, error, observedAt: 3 })).toBe(false);
    expect(view.notifyConflict({ attempt, execution: { ...execution, runKey: "other" }, error, observedAt: 3 })).toBe(false);
    expect(view.isStopped(owner)).toBe(true);
    expect(view.notifyConflict({ attempt, execution, error, observedAt: 3 })).toBe(true);
    expect(view.isStopped(owner)).toBe(false);
    expect(view.getDiagnostic(owner)).toMatchObject({ error });
    expect(view.commitObservation(pending, stopped())).toBe(false);
    expect(view.commitObservation(view.beginObservation(owner)!, unknown())).toBe(true);
    expect(view.getDiagnostic(owner)).toMatchObject({ error });
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it.each(["running", "stopped", "not-started"] as const)("treats a conflicting %s source as unknown until explicit invalidation", kind => {
    const wake = vi.fn(), view = createExecutionCapacity(wake);
    view.beginAttempt(attempt); view.notify({ attempt, observation: stopped() });
    const other = { ...execution, runKey: "run-2" };
    const conflict = kind === "not-started" ? { kind, owner, observedAt: 4 } : { kind, execution: other, observedAt: 4 };
    expect(view.commitObservation(view.beginObservation(owner)!, conflict)).toBe(true);
    expect(view.isStopped(owner)).toBe(false);
    expect(view.getObservation(owner)).toMatchObject({ kind: "unknown", error: expect.any(Error) });
    view.commitObservation(view.beginObservation(owner)!, stopped());
    expect(view.isStopped(owner)).toBe(false);
    view.invalidate(owner); view.beginAttempt({ ...attempt, attemptId: "new" });
    view.commitObservation(view.beginObservation(owner)!, stopped(other));
    expect(view.isStopped(owner)).toBe(true);
    expect(wake).toHaveBeenCalledTimes(3);
  });

  it("retains the original source through an unknown result so a replacement cannot be mistaken for it", () => {
    const view = createExecutionCapacity(() => {});
    view.beginAttempt(attempt);
    view.commitObservation(view.beginObservation(owner)!, running());
    view.commitObservation(view.beginObservation(owner)!, unknown());
    expect(view.getObservation(owner)).toMatchObject({ kind: "unknown" });
    view.commitObservation(view.beginObservation(owner)!, stopped({ ...execution, backend: "herdr-native" }));
    expect(view.isStopped(owner)).toBe(false);
    expect(view.getDiagnostic(owner)?.error).toMatchObject({ message: "Conflicting original execution observations." });
  });

  it("revokes prior stop eligibility when a later read establishes source conflict", () => {
    const wake = vi.fn(), view = createExecutionCapacity(wake);
    view.beginAttempt(attempt); view.notify({ attempt, observation: stopped() });
    const conflict = new ExecutionSourceConflictError("Journal identifies a different run");
    view.commitObservation(view.beginObservation(owner)!, unknown(conflict));
    expect(view.isStopped(owner)).toBe(false);
    expect(view.getObservation(owner)).toMatchObject({ kind: "unknown", error: conflict });
    view.commitObservation(view.beginObservation(owner)!, stopped());
    expect(view.isStopped(owner)).toBe(false);
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it("only wakes on a change in effective occupancy, not observation timestamps", () => {
    const wake = vi.fn(), view = createExecutionCapacity(wake);
    view.beginAttempt(attempt);
    view.commitObservation(view.beginObservation(owner)!, running());
    view.notify({ attempt, observation: stopped() });
    view.notify({ attempt, observation: { ...stopped(), observedAt: 100 } });
    view.commitObservation(view.beginObservation(owner)!, unknown());
    expect(wake).toHaveBeenCalledOnce();
    view.invalidate(owner);
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it("fences an old query after invalidation and a new generation", () => {
    const view = createExecutionCapacity(() => {});
    view.beginAttempt(attempt);
    const old = view.beginObservation(owner)!;
    view.invalidate(owner); view.beginAttempt({ ...attempt, attemptId: "new" });
    expect(view.commitObservation(old, stopped())).toBe(false);
    expect(view.notify({ attempt, observation: stopped() })).toBe(false);
    expect(view.isStopped(owner)).toBe(false);
  });
});
