import { describe, expect, it, vi } from "vitest";
import { createExecutionCapacity } from "../../../src/commands/worker/execution-capacity.js";
import { ExecutionSourceConflictError } from "../../../src/commands/worker/execution-stop.js";
import type { ExecutionRef, StopObservation } from "../../../src/commands/worker/execution-stop.js";

const owner = { projectId: "project", taskId: "task", claimId: "claim", worktreeId: "worktree" };
const ref = (runKey: string): ExecutionRef => ({ owner, backend: "web", runKey });
const stopped = (runKey: string): StopObservation & { kind: "stopped" } => ({ kind: "stopped", execution: ref(runKey), observedAt: 1 });

describe("execution capacity facts", () => {
  it("rejects stale reads and stale attempts, and deduplicates wakeups", () => {
    const wake = vi.fn(), view = createExecutionCapacity(wake);
    const attempt = { owner, attemptId: "one" };
    view.beginAttempt(attempt);
    const stale = view.beginObservation(owner);
    view.notice({ attempt, observation: stopped("one") });
    view.observe(owner, stale, { kind: "running", execution: ref("one"), observedAt: 2 });
    expect(view.stopped(owner)).toBe(true);
    view.notice({ attempt, observation: stopped("one") });
    expect(wake).toHaveBeenCalledTimes(1);
    view.beginAttempt({ owner, attemptId: "two" });
    view.notice({ attempt, observation: stopped("other") });
    expect(view.stopped(owner)).toBe(true);
    view.invalidate(owner);
    view.notice({ attempt, observation: stopped("one") });
    expect(view.stopped(owner)).toBe(false);
    expect(wake).toHaveBeenCalledTimes(2);
  });
  it("retains proof through transient reads but invalidates source conflicts and rejects old run notices", () => {
    const view = createExecutionCapacity(() => {}), attempt = { owner, attemptId: "attempt" };
    view.beginAttempt(attempt);
    view.observe(owner, view.beginObservation(owner), { kind: "running", execution: ref("new"), observedAt: 1 });
    view.notice({ attempt, observation: stopped("old") });
    expect(view.stopped(owner)).toBe(false);
    view.notice({ attempt, observation: stopped("new") });
    view.observe(owner, view.beginObservation(owner), { kind: "unknown", target: owner, error: new Error("temporary"), observedAt: 3 });
    expect(view.stopped(owner)).toBe(true);
    view.observe(owner, view.beginObservation(owner), { kind: "unknown", target: owner, error: new ExecutionSourceConflictError("replacement"), observedAt: 4 });
    expect(view.stopped(owner)).toBe(false);
  });
});
