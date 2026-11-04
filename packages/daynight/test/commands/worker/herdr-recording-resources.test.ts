import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync, renameSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { ApiError } from "../../../src/api/client.js";
import type { Task } from "../../../src/api/types.js";
import { createHerdrRecordingArchive } from "../../../src/commands/worker/herdr/recording-archive.js";
import { createHerdrRecordingResources } from "../../../src/commands/worker/herdr/recording-resources.js";
import type { HerdrArchiveApi } from "../../../src/commands/worker/herdr/archive-api.js";
import type { HerdrLifecycleRecord } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import type { SessionV2Archive } from "../../../src/session/v2/types.js";
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { force: true, recursive: true })); });
const setup = () => {
  mkdirSync("../../.tmp/herdr-resources-test", { recursive: true });
  const root = realpathSync(mkdtempSync(path.resolve("../../.tmp/herdr-resources-test/run-"))); roots.push(root);
  const doc = JSON.parse(readFileSync(new URL("../../session/fixtures/v2/valid-archive.json", import.meta.url), "utf8")) as SessionV2Archive;
  const directory = path.join(root, "recordings"), source = path.join(directory, doc.sessionId), cwd = path.join(root, "worktree"); mkdirSync(source, { recursive: true }); mkdirSync(cwd);
  writeFileSync(path.join(source, "manifest.json"), JSON.stringify({ schemaVersion: 1, owner: doc.owner, sessionId: doc.sessionId, claimId: doc.claimId })); writeFileSync(path.join(source, "frame.json"), "persisted-frame");
  const record: HerdrLifecycleRecord = { owner: doc.owner, sessionId: doc.sessionId, claimId: doc.claimId, cwd, registrationId: doc.finalizationId, connectionEpoch: "1", registrationRequest: null, ledgerRequest: null, publishedLedgerHash: "a".repeat(64), controlEpoch: "1", initialAssignment: "transport_completed", initialPrompt: null, automationBlocked: true, preparation: null, runs: doc.runs.map(run => ({ run, phase: "stopped_confirmed", instanceDirectory: root, daemon: null, processes: [], stopOperationId: run.stopProof!.recordId, stopReason: "terminal", error: null, admission: null })), segments: doc.segments.map(segment => ({ ...segment, gap: null })), version: 1 };
  const owner = { projectId: doc.owner.projectId, taskId: doc.owner.taskId, claimId: doc.claimId, worktreeId: doc.owner.worktreeId }, target = { ...owner, sessionId: doc.sessionId };
  const archive = createHerdrRecordingArchive({ directory: path.join(root, "archives"), api: { state: async () => { throw new Error("offline"); } } as unknown as HerdrArchiveApi });
  let user = doc.owner.ownerUserId, readFailure: unknown, publishFailure: unknown, active = false, published = 0;
  const resource = createHerdrRecordingResources({ directory, archive, list: () => [record], get: () => record, source: () => { throw new Error("not recording a new source"); }, publishStopped: async () => { published++; if (publishFailure) throw publishFailure; }, currentUserId: async () => user, readTask: async () => { if (readFailure) throw readFailure; return { id: owner.taskId, projectId: owner.projectId, status: active ? "in_progress" : "done", properties: active ? { worker: { claimId: owner.claimId, state: "active", userId: user, workerId: doc.owner.workerId, worktreeId: owner.worktreeId, machine: { id: "00000000-0000-4000-8000-000000000033", name: "test" }, platform: "macos", agent: "codex", agentControlMode: "herdr", phase: "executing", herdr: null, nativeSessionId: null, claimedAt: "2026-11-03T10:00:00Z" } } : {} } as Task; } });
  return { root, directory, source, cwd, record, owner, target, archive, resource, active: (value: boolean) => { active = value; }, user: (value: string) => { user = value; }, failure: (value: unknown) => { readFailure = value; }, publishFailure: (value: unknown) => { publishFailure = value; }, published: () => published };
};
describe("Herdr retained recording resources", () => {
  it("reports actual source bytes and stop evidence without restarting an execution", () => {
    const s = setup(), item = s.resource.resources()[0]!;
    expect(BigInt(item.sourceBytes)).toBeGreaterThan(15n); expect(item.stopped).toBe(true); expect(item.stopEvidence).toHaveLength(1); expect(item.worktreePath).toBe(s.cwd); expect(item.worktreeDeleted).toBe(false);
    rmSync(s.source, { recursive: true }); expect(s.resource.resources()[0]).toMatchObject({ state: "failed", sourceBytes: "0" });
  });
  it("refuses active claims, another owner and unknown stopping before any disposal", async () => {
    const s = setup(), op = createOperation(); const request = { ...s.target, operationId: "00000000-0000-4000-8000-000000000090", action: "delete" as const, confirmed: true as const }; let removals = 0;
    try {
      s.active(true); await expect(s.resource.dispose(request, op, async () => { removals++; })).rejects.toThrow();
      s.active(false); s.user("00000000-0000-4000-8000-000000000099"); await expect(s.resource.dispose(request, op, async () => { removals++; })).rejects.toThrow();
      s.user(s.record.owner.ownerUserId); s.record.runs[0]!.phase = "stop_unknown"; await expect(s.resource.dispose(request, op, async () => { removals++; })).rejects.toThrow();
      expect(removals).toBe(0); expect(existsSync(s.source)).toBe(true);
    } finally { op.dispose(); }
  });
  it("persists an original disposal intent across interruption and keeps archive history truthful", async () => {
    const s = setup(), op = createOperation(), request = { ...s.target, operationId: "00000000-0000-4000-8000-000000000090", action: "delete" as const, confirmed: true as const };
    try {
      await expect(s.resource.dispose(request, op, async () => { throw new Error("deletion interrupted"); })).rejects.toThrow("deletion interrupted");
      expect(s.archive.inspect(s.record)?.disposition?.phase).toBe("intent"); expect(existsSync(s.source)).toBe(true);
      const result = await s.resource.dispose(request, op, async () => rmSync(s.cwd, { recursive: true }));
      expect(result.disposition?.completed).toBe(true); expect(result.worktreeDeleted).toBe(true); expect(existsSync(s.source)).toBe(false); expect(s.archive.inspect(s.record)?.receipt).toBeNull();
    } finally { op.dispose(); }
  });
  it("distinguishes real task deletion from an unverified 404-like error", async () => {
    const s = setup(), op = createOperation();
    try {
      s.failure({ status: 404 }); await expect(s.resource.advance(s.owner, op)).rejects.toEqual({ status: 404 }); expect(s.published()).toBe(0);
      s.failure(new ApiError({ operation: "get task" }, "response", { status: 410, cause: new Error("deleted") }));
      expect(await s.resource.advance(s.owner, op)).toBe(false); expect(s.published()).toBe(1);
    } finally { op.dispose(); }
  });
  it("persists a bounded retry for failed stop-ledger publication before finalization", async () => {
    const s = setup(), op = createOperation(); s.publishFailure(new Error("ledger network failure"));
    try { const before = Date.now(); expect(await s.resource.advance(s.owner, op)).toBe(false); const state = s.archive.inspect(s.record)!; expect(state.state).toBe("pending"); expect(state.nextAttemptAt).toBeGreaterThanOrEqual(before + 5000); expect(state.finalization).toBeNull(); }
    finally { op.dispose(); }
  });
  it("rejects replacement source directories after an interrupted original disposal", async () => {
    const s = setup(), op = createOperation(), request = { ...s.target, operationId: "00000000-0000-4000-8000-000000000090", action: "delete" as const, confirmed: true as const };
    try {
      await expect(s.resource.dispose(request, op, async () => { throw new Error("interrupted"); })).rejects.toThrow();
      renameSync(s.source, `${s.source}.original`); mkdirSync(s.source); writeFileSync(path.join(s.source, "replacement"), "unrelated");
      await expect(s.resource.dispose(request, op, async () => rmSync(s.cwd, { recursive: true }))).rejects.toThrow("replaced");
      expect(readFileSync(path.join(s.source, "replacement"), "utf8")).toBe("unrelated"); expect(existsSync(s.cwd)).toBe(true);
    } finally { op.dispose(); }
  });
  it("records explicit abandonment while retaining source and worktree", async () => {
    const s = setup(), op = createOperation(), request = { ...s.target, operationId: "00000000-0000-4000-8000-000000000090", action: "abandon" as const, confirmed: true as const };
    try {
      const result = await s.resource.dispose(request, op, async () => { throw new Error("abandon must not delete"); });
      expect(result.state).toBe("abandoned"); expect(result.worktreeDeleted).toBe(false); expect(existsSync(s.source)).toBe(true); expect(existsSync(s.cwd)).toBe(true); expect(s.archive.inspect(s.record)?.receipt).toBeNull();
    } finally { op.dispose(); }
  });
});
