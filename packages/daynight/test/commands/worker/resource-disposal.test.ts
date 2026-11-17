import { describe, expect, it } from "vitest";
import { assertHerdrResourceBudget, assertHerdrDisposalTarget } from "../../../src/commands/worker/resource-disposal.js";
import type { HerdrRetainedResource } from "../../../src/commands/worker/herdr/resource-types.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const resource = (n = 1): HerdrRetainedResource => ({ owner: { projectId: uuid(1), taskId: uuid(n + 10), claimId: uuid(n + 20), worktreeId: uuid(n + 30) }, sessionId: uuid(n + 40), stopped: true, stoppedLedgerPending: false, stopEvidence: [{ recordId: uuid(70), executionGeneration: "1", binding: { instanceId: "instance", sessionId: "native", workspaceId: "workspace", paneId: "pane", terminalId: "terminal", nativeSessionId: null }, bootId: "boot", stoppedAt: "2026-11-04T00:00:00Z", method: "instances_exited", terminalStopped: true, processes: [] }], terminal: true, worktreePath: `/worktrees/${n}`, sourcePath: `/recordings/${n}`, sourceBytes: "100", state: "failed", error: "source_corrupt", nextAttemptAt: null, worktreeDeleted: false, disposition: null });
describe("Herdr retained resources", () => {
  it("blocks new acquisition at each independent resource budget and accepts the boundary below it", () => {
    expect(() => assertHerdrResourceBudget(Array.from({ length: 19 }, (_, i) => resource(i)), 1073741824n)).not.toThrow();
    expect(() => assertHerdrResourceBudget(Array.from({ length: 20 }, (_, i) => resource(i)), 1073741824n)).toThrow(/worktree/);
    expect(() => assertHerdrResourceBudget([{ ...resource(), sourceBytes: "2147483648" }], 1073741824n)).toThrow(/source/);
    expect(() => assertHerdrResourceBudget([], 1073741823n)).toThrow(/disk/);
    expect(() => assertHerdrResourceBudget([{ ...resource(), sourceBytes: "2147483647" }], 1073741824n)).not.toThrow();
  });
  it("keeps ready local bytes visible but does not count them as pending upload bytes", () => {
    expect(() => assertHerdrResourceBudget([{ ...resource(), sourceBytes: "2147483648", state: "ready", worktreeDeleted: true }], 1073741824n)).not.toThrow();
    expect(() => assertHerdrResourceBudget([{ ...resource(), sourceBytes: "2147483648", state: "ready", worktreeDeleted: true }], 100n)).toThrow(/disk/);
  });
  it("rejects disposal without exact identity, explicit choice and confirmed terminal stop", () => {
    const value = resource(), target = { ...value.owner, sessionId: value.sessionId, operationId: uuid(90), action: "delete" as const, confirmed: true as const };
    expect(() => assertHerdrDisposalTarget(value, target)).not.toThrow();
    for (const key of ["sessionId", "claimId", "worktreeId", "projectId", "taskId"] as const) expect(() => assertHerdrDisposalTarget(value, { ...target, [key]: uuid(99) })).toThrow(/identity/);
    expect(() => assertHerdrDisposalTarget({ ...value, stopEvidence: [] }, target)).toThrow(/stop/);
    expect(() => assertHerdrDisposalTarget({ ...value, stopped: false }, target)).toThrow(/stop/);
    expect(() => assertHerdrDisposalTarget({ ...value, terminal: false }, target)).toThrow(/terminal/);
    expect(() => assertHerdrDisposalTarget(value, { ...target, confirmed: false } as never)).toThrow(/explicit/);
  });
});
