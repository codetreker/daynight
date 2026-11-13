import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync, renameSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { createWorkerRemote, type WorkerRemote } from "../../../src/commands/worker/remote.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
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
const setup = (remote?: Pick<WorkerRemote, "readTask" | "currentUserId">) => {
  mkdirSync("../../.tmp/herdr-resources-test", { recursive: true });
  const root = realpathSync(mkdtempSync(path.resolve("../../.tmp/herdr-resources-test/run-"))); roots.push(root);
  const doc = JSON.parse(readFileSync(new URL("../../session/fixtures/v2/valid-archive.json", import.meta.url), "utf8")) as SessionV2Archive;
  const directory = path.join(root, "recordings"), source = path.join(directory, doc.sessionId), cwd = path.join(root, "worktree"); mkdirSync(source, { recursive: true }); mkdirSync(cwd);
  writeFileSync(path.join(source, "manifest.json"), JSON.stringify({ schemaVersion: 1, owner: doc.owner, sessionId: doc.sessionId, claimId: doc.claimId })); writeFileSync(path.join(source, "frame.json"), "persisted-frame");
  const record: HerdrLifecycleRecord = { owner: doc.owner, sessionId: doc.sessionId, claimId: doc.claimId, cwd, registrationId: doc.finalizationId, connectionEpoch: "1", registrationRequest: null, ledgerRequest: null, publishedLedgerHash: "a".repeat(64), controlEpoch: "1", initialAssignment: "transport_completed", initialPrompt: null, automationBlocked: true, preparation: null, runs: doc.runs.map(run => ({ run, phase: "stopped_confirmed", nativeLaunch: "observed", instanceDirectory: root, daemon: null, processes: [], stopOperationId: run.stopProof!.recordId, stopReason: "terminal", error: null, admission: null })), segments: doc.segments.map(segment => ({ ...segment, gap: null })), version: 1 };
  const owner = { projectId: doc.owner.projectId, taskId: doc.owner.taskId, claimId: doc.claimId, worktreeId: doc.owner.worktreeId }, target = { ...owner, sessionId: doc.sessionId };
  const archive = createHerdrRecordingArchive({ directory: path.join(root, "archives"), api: { state: async () => { throw new Error("offline"); } } as unknown as HerdrArchiveApi });
  let user = doc.owner.ownerUserId, readFailure: unknown, publishFailure: unknown, active = false, published = 0;
  const resource = createHerdrRecordingResources({ directory, archive, list: () => [record], get: () => record, source: () => { throw new Error("not recording a new source"); }, publishStopped: async () => { published++; if (publishFailure) throw publishFailure; }, currentUserId: async () => user, readTask: async () => { if (readFailure) throw readFailure; return { id: owner.taskId, projectId: owner.projectId, status: active ? "in_progress" : "done", properties: active ? { worker: { claimId: owner.claimId, state: "active", userId: user, workerId: doc.owner.workerId, worktreeId: owner.worktreeId, machine: { id: "00000000-0000-4000-8000-000000000033", name: "test" }, platform: "macos", agent: "codex", agentControlMode: "herdr", phase: "executing", herdr: null, nativeSessionId: null, claimedAt: "2026-11-03T10:00:00Z" } } : {} } as Task; }, ...remote });
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
  it("settles the source with a fresh budget after worktree cleanup outlives authorization", async () => {
    const s = setup(), authorization = new AbortController(), outer = new AbortController();
    const op = createOperation({ signal: authorization.signal });
    const request = { ...s.target, operationId: "00000000-0000-4000-8000-000000000090", action: "delete" as const, confirmed: true as const };
    try {
      const result = await s.resource.dispose(request, op, async () => { rmSync(s.cwd, { recursive: true }); authorization.abort(new Error("authorization budget expired")); }, { signal: outer.signal });
      expect(result.disposition?.completed).toBe(true); expect(existsSync(s.source)).toBe(false);
    } finally { op.dispose(); }
  });
  it("retains source and intent if the outer signal cancels after worktree cleanup", async () => {
    const s = setup(), outer = new AbortController(), op = createOperation({ signal: outer.signal });
    const request = { ...s.target, operationId: "00000000-0000-4000-8000-000000000090", action: "delete" as const, confirmed: true as const };
    const cancelled = new Error("outer cancellation");
    try {
      await expect(s.resource.dispose(request, op, async () => { rmSync(s.cwd, { recursive: true }); outer.abort(cancelled); }, { signal: outer.signal })).rejects.toMatchObject({ kind: "cancelled", cause: cancelled });
      expect(s.archive.inspect(s.record)?.disposition?.phase).toBe("intent"); expect(existsSync(s.source)).toBe(true);
    } finally { op.dispose(); }
  });
  it("retains the disposal intent if the source budget expires during data removal", async () => {
    const s = setup(), op = createOperation(); let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const original = s.archive.removeSourceData.bind(s.archive);
    vi.spyOn(s.archive, "removeSourceData").mockImplementation((...args) => { original(...args); clock = 300_001; });
    const request = { ...s.target, operationId: "00000000-0000-4000-8000-000000000090", action: "delete" as const, confirmed: true as const };
    try {
      await expect(s.resource.dispose(request, op, async () => rmSync(s.cwd, { recursive: true }), {})).rejects.toMatchObject({ kind: "deadline" });
      expect(s.archive.inspect(s.record)?.disposition?.phase).toBe("intent");
    } finally { now.mockRestore(); op.dispose(); }
  });
  it("distinguishes real task deletion from an unverified 404-like error", async () => {
    const s = setup(), op = createOperation();
    try {
      s.failure({ status: 404 }); await expect(s.resource.advance(s.owner, op)).rejects.toEqual({ status: 404 }); expect(s.published()).toBe(0);
      s.failure(new ApiError({ operation: "task.show", projectId: s.owner.projectId, taskId: s.owner.taskId }, "response", { status: 410, serverError: { code: "task_deleted", message: "Task was deleted.", requestId: "deleted" }, cause: new Error("deleted") }));
      expect(await s.resource.advance(s.owner, op)).toBe(false); expect(s.published()).toBe(1);
    } finally { op.dispose(); }
  });
  it.each(["advance", "retry", "abandon", "delete"] as const)("refuses %s after the original user loses project access while its claim remains active", async action => {
    let projectAccess = true;
    let s: ReturnType<typeof setup>;
    const userId = "00000000-0000-4000-8000-000000000005";
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json"); response.setHeader("Daynight-User-ID", userId);
      if (request.url === "/api/v1/me") {
        response.end(JSON.stringify({ id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: s.owner.projectId, kind: "personal", name: null } })); return;
      }
      if (request.url !== `/api/v1/projects/${s.owner.projectId}/tasks/${s.owner.taskId}`) { response.writeHead(500); response.end(); return; }
      // Tasks.Get checks RequireProjectRead before loading the task. A revoked
      // grant is deliberately hidden as not_found; the active claim is unchanged.
      if (!projectAccess) { response.writeHead(404); response.end(JSON.stringify({ error: { code: "not_found", message: "Project was not found.", requestId: "revoked-access" } })); return; }
      const time = "2026-11-03T10:00:00Z";
      response.end(JSON.stringify({ type: "task", parentId: null, id: s.owner.taskId, projectId: s.owner.projectId, title: "Retained execution", description: "", tags: [], status: "in_progress", allowAgents: true, assignedTo: userId, requiredPlatform: "macos", startedAt: time, completedAt: null, cancelledAt: null, version: 1, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false,
        properties: { pullRequests: [], worker: { claimId: s.owner.claimId, state: "active", userId, workerId: s.record.owner.workerId, worktreeId: s.owner.worktreeId, machine: { id: s.record.owner.workerId, name: "test" }, platform: "macos", agent: "codex", agentControlMode: "herdr", phase: "executing", herdr: null, nativeSessionId: null, claimedAt: time } } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing fixture address");
    const remote = createWorkerRemote({ serverUrl: `http://127.0.0.1:${address.port}`, serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890" });
    s = setup(remote); s.record.runs.forEach(run => { run.stopReason = "shutdown"; });
    const op = createOperation(); let removals = 0;
    try {
      expect(await remote.currentUserId(op.signal)).toBe(userId);
      expect((await remote.readTask(s.owner.projectId, s.owner.taskId, op.signal)).properties.worker).toMatchObject({ claimId: s.owner.claimId, state: "active" });
      projectAccess = false;
      expect(await remote.currentUserId(op.signal)).toBe(userId);
      const denied = { status: 404, code: "not_found", projectId: s.owner.projectId, taskId: s.owner.taskId };
      const result = action === "advance" ? s.resource.advance(s.owner, op) : action === "retry" ? s.resource.retry(s.target, op)
        : s.resource.dispose({ ...s.target, operationId: "00000000-0000-4000-8000-000000000090", action, confirmed: true }, op, async () => { removals++; rmSync(s.cwd, { recursive: true }); });
      await expect(result).rejects.toMatchObject(denied);
      expect(removals).toBe(0); expect(s.published()).toBe(0); expect(s.archive.inspect(s.record)).toBeNull();
      expect(existsSync(s.source)).toBe(true); expect(existsSync(s.cwd)).toBe(true);
      projectAccess = true;
      expect((await remote.readTask(s.owner.projectId, s.owner.taskId, op.signal)).properties.worker).toMatchObject({ claimId: s.owner.claimId, state: "active" });
    } finally { op.dispose(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it.each([
    { status: 404, code: "not_found", uncertain: false },
    { status: 404, code: "task_deleted", uncertain: false },
    { status: 410, code: "not_found", uncertain: false },
    { status: 410, code: "task_deleted", uncertain: true },
  ])("rejects ambiguous deletion evidence $status/$code/uncertain=$uncertain", async ({ status, code, uncertain }) => {
    const s = setup(), op = createOperation();
    const error = new ApiError({ operation: "task.show", projectId: s.owner.projectId, taskId: s.owner.taskId }, "response", { status, serverError: { code, message: "Task unavailable.", requestId: "unavailable" }, outcomeUnconfirmed: uncertain, cause: new Error("unavailable") });
    s.failure(error);
    try { await expect(s.resource.advance(s.owner, op)).rejects.toBe(error); expect(s.published()).toBe(0); expect(s.archive.inspect(s.record)).toBeNull(); }
    finally { op.dispose(); }
  });

  it("allows explicit deletion only with the original task's confirmed tombstone", async () => {
    const s = setup(), op = createOperation(); s.record.runs.forEach(run => { run.stopReason = "shutdown"; });
    const deletion = (taskId: string) => new ApiError({ operation: "task.show", projectId: s.owner.projectId, taskId }, "response", { status: 410, serverError: { code: "task_deleted", message: "Task was deleted.", requestId: "deleted" }, cause: new Error("deleted") });
    const request = { ...s.target, operationId: "00000000-0000-4000-8000-000000000090", action: "delete" as const, confirmed: true as const };
    let removals = 0;
    const remove = async () => { removals++; rmSync(s.cwd, { recursive: true }); };
    try {
      const unrelated = deletion("00000000-0000-4000-8000-000000000099"); s.failure(unrelated);
      await expect(s.resource.dispose(request, op, remove)).rejects.toBe(unrelated);
      expect(removals).toBe(0); expect(s.archive.inspect(s.record)).toBeNull();
      s.failure(deletion(s.owner.taskId));
      expect(await s.resource.dispose(request, op, remove)).toMatchObject({ worktreeDeleted: true, disposition: { action: "delete", completed: true } });
      expect(removals).toBe(1); expect(existsSync(s.source)).toBe(false); expect(existsSync(s.cwd)).toBe(false);
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
