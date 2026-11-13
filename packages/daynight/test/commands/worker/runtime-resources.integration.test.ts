import path from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkerResources } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { createHerdrRecordingArchive } from "../../../src/commands/worker/herdr/recording-archive.js";
import { createHerdrRecordingResources } from "../../../src/commands/worker/herdr/recording-resources.js";
import type { HerdrArchiveApi } from "../../../src/commands/worker/herdr/archive-api.js";
import type { HerdrLifecycleRecord } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import type { Task } from "../../../src/api/types.js";
import archiveFixture from "../../session/fixtures/v2/valid-archive.json" with { type: "json" };

const mocks = vi.hoisted(() => ({ durable: vi.fn(), remote: vi.fn(), git: vi.fn() }));
vi.mock("../../../src/commands/worker/herdr/durable.js", () => ({ createDurableWorkerHerdr: mocks.durable }));
vi.mock("../../../src/commands/worker/remote.js", () => ({ createWorkerRemote: mocks.remote }));
vi.mock("../../../src/commands/worker/worktrees.js", async original => ({ ...await original<object>(), createWorkerGitManager: mocks.git }));
const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
const fixture = () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-resources-runtime-tests"); mkdirSync(base, { recursive: true });
  const homeDirectory = mkdtempSync(path.join(base, "home-")); roots.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory), doc = structuredClone(archiveFixture);
  mkdirSync(paths.workerDirectory, { recursive: true });
  writeFileSync(paths.configFile, `serverUrl: ${doc.owner.serverOrigin}\nserverToken: dn_pat_abcdefghijklmnopqrstuvwxyz1234567890\nworkerId: ${doc.owner.workerId}\n`);
  writeFileSync(path.join(paths.workerDirectory, "herdr-executions.sqlite"), "fixture-owned lifecycle");
  const localPath = path.join(homeDirectory, "repo"), cwd = path.join(localPath, ".worktrees", "daynight", doc.owner.taskId);
  mkdirSync(cwd, { recursive: true });
  const store = openWorkerStore(paths.databaseFile);
  store.registerProject({ projectId: doc.owner.projectId, repoUrl: "https://example.test/org/repo.git", localPath });
  store.activateTask(store.registerPending({ ...doc.owner, claimId: doc.claimId, agent: "codex" }));
  store.saveCleanupSchedule({ ...doc.owner, claimId: doc.claimId }, { deadline: 10000, failures: 0, nextAttemptAt: 0, stage: "worktree-removal", lastError: null }); store.close();
  const directory = path.join(paths.workerDirectory, "recordings"), source = path.join(directory, doc.sessionId);
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "manifest.json"), JSON.stringify({ schemaVersion: 1, owner: doc.owner, sessionId: doc.sessionId, claimId: doc.claimId }));
  const record = { owner: doc.owner, sessionId: doc.sessionId, claimId: doc.claimId, cwd, preparation: null,
    runs: doc.runs.map(run => ({ run, phase: "stopped_confirmed", stopReason: "shutdown" })), segments: doc.segments.map(segment => ({ ...segment, gap: null })) } as HerdrLifecycleRecord;
  let active = false;
  const readTask = vi.fn(async () => ({ id: doc.owner.taskId, projectId: doc.owner.projectId, status: active ? "in_progress" : "done", properties: active ? { worker: { claimId: doc.claimId, state: "active", userId: doc.owner.ownerUserId, workerId: doc.owner.workerId, worktreeId: doc.owner.worktreeId, machine: { id: doc.owner.workerId, name: "test" }, platform: "macos", agent: "codex", agentControlMode: "herdr", phase: "executing", herdr: null, nativeSessionId: null, claimedAt: "2026-11-03T10:00:00Z" } } : {} } as Task));
  const remote = { readTask, currentUserId: async () => doc.owner.ownerUserId }; mocks.remote.mockReturnValue(remote);
  const archive = createHerdrRecordingArchive({ directory: path.join(paths.workerDirectory, "archives"), api: {} as HerdrArchiveApi });
  const resource = createHerdrRecordingResources({ directory, archive, list: () => [record], get: () => record, source: () => { throw new Error("Disposal cannot collect a new recording."); }, publishStopped: async () => {}, ...remote });
  mocks.durable.mockReturnValue({ lifecycle: { archive: resource, close: vi.fn() } });
  const removeWorktree = vi.fn(async () => { rmSync(cwd, { force: true, recursive: true }); return { kind: "absent" as const, effectErrors: [] as unknown[] }; });
  const binding = { repositoryPath: localPath, commonDirectory: path.join(localPath, ".git"), worktreePath: cwd, branch: `daynight/${doc.owner.taskId}` };
  const findWorktree = vi.fn(async (): Promise<typeof binding | null> => null);
  const retireWorktreeManifest = vi.fn(async () => {});
  const disposeGit = vi.fn(async () => {});
  mocks.git.mockReturnValue({ prepareRepository: async () => {}, resolveWorktreeBinding: async () => binding, removeWorktree, findWorktree, retireWorktreeManifest, dispose: disposeGit });
  const request = { kind: "dispose" as const, projectId: doc.owner.projectId, taskId: doc.owner.taskId, claimId: doc.claimId, worktreeId: doc.owner.worktreeId, sessionId: doc.sessionId, operationId: "00000000-0000-4000-8000-000000000099", confirmed: true as const };
  return { homeDirectory, request, resource, readTask, removeWorktree, findWorktree, retireWorktreeManifest, disposeGit, cwd, binding, active: () => { active = true; } };
};

describe.skipIf(process.platform !== "darwin")("retained-resource runtime authorization", () => {
  it.each(["abandon", "delete"] as const)("observes a terminal claim after shutdown before %s", async action => {
    const f = fixture(), output: string[] = [];
    expect(f.resource.resources()[0]!.terminal).toBe(false);
    await runWorkerResources({ homeDirectory: f.homeDirectory, request: { ...f.request, action }, output: message => { output.push(message); } });
    expect(f.readTask).toHaveBeenCalledOnce();
    expect(JSON.parse(output[0]!)).toMatchObject({ disposition: { operationId: f.request.operationId, action, completed: true } });
    expect(f.removeWorktree).toHaveBeenCalledTimes(action === "delete" ? 1 : 0);
    const store = openWorkerStore(resolveWorkerPaths(f.homeDirectory).databaseFile);
    try {
      expect(store.getTask(f.request)?.status).toBe(action === "delete" ? "done" : "active");
      expect(store.getCleanupSchedule(f.request) === null).toBe(action === "delete");
    } finally { store.close(); }
  });
  it("retains shutdown resources while the same original claim remains active", async () => {
    const f = fixture(); f.active();
    await expect(runWorkerResources({ homeDirectory: f.homeDirectory, request: { ...f.request, action: "delete" }, output: () => {} })).rejects.toThrow("original claim is still active");
    expect(f.readTask).toHaveBeenCalledOnce(); expect(f.removeWorktree).not.toHaveBeenCalled(); expect(f.resource.resources()[0]!.disposition).toBeNull();
  });
  it.each([true, false])("retains independent disposal failures when diagnostic stderr is available=%s", async stderrAvailable => {
    const f = fixture(), diagnosticPath = resolveWorkerPaths(f.homeDirectory).logsDirectory, retirement = new Error("metadata retirement failed"), teardown = new Error("Git disposal failed"), reporting = new Error("diagnostic stderr failed");
    writeFileSync(diagnosticPath, "not a directory");
    f.removeWorktree.mockImplementationOnce(async () => { rmSync(f.cwd, { force: true, recursive: true }); return { kind: "absent", effectErrors: [new Error("effect failed")] }; });
    f.retireWorktreeManifest.mockRejectedValueOnce(retirement);
    f.disposeGit.mockRejectedValueOnce(teardown);
    const notices: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((...args) => {
      notices.push(String(args[0]));
      const callback = args.at(-1);
      if (typeof callback === "function") callback(stderrAvailable ? null : reporting);
      if (!stderrAvailable) queueMicrotask(() => { process.stderr.emit("error", reporting); });
      return true;
    });
    let error: AggregateError;
    try { error = await runWorkerResources({ homeDirectory: f.homeDirectory, request: { ...f.request, action: "delete" }, output: () => {} }).catch(value => value); }
    finally { stderr.mockRestore(); }
    expect(error).toBeInstanceOf(AggregateError);
    expect(notices.join("")).toContain("diagnostic-sink-blocked");
    if (stderrAvailable) {
      expect(error.cause).toBe(retirement);
      expect(error.errors).toContain(retirement);
    } else {
      expect(error.cause).toBeInstanceOf(AggregateError);
      const combined = error.cause as AggregateError;
      expect(combined.cause).toBe(retirement);
      expect(combined.errors).toContain(retirement);
      expect(combined.errors).toHaveLength(2);
      expect(combined.errors[1]).toBeInstanceOf(AggregateError);
      const causes = new Set<unknown>();
      const include = (cause: unknown): void => {
        if (causes.has(cause)) return;
        causes.add(cause);
        if (cause instanceof AggregateError) cause.errors.forEach(include);
        if (cause instanceof Error && cause.cause !== undefined) include(cause.cause);
      };
      include(combined.errors[1]);
      expect(causes.has(reporting)).toBe(true);
    }
    expect(error.errors).toContain(teardown);
    expect(error.errors).toHaveLength(2);
    expect(f.resource.resources()[0]?.disposition?.completed).toBe(true);
  });
  it("does not remove a later checkout when retrying a completed disposal", async () => {
    const f = fixture(), request = { ...f.request, action: "delete" as const };
    f.retireWorktreeManifest.mockRejectedValueOnce(new Error("metadata retirement failed"));
    await expect(runWorkerResources({ homeDirectory: f.homeDirectory, request, output: () => {} })).rejects.toThrow("metadata retirement failed");
    mkdirSync(f.cwd, { recursive: true });
    writeFileSync(path.join(f.cwd, "successor"), "keep");
    f.findWorktree.mockClear();
    await runWorkerResources({ homeDirectory: f.homeDirectory, request, output: () => {} });
    expect(f.removeWorktree).toHaveBeenCalledOnce();
    expect(f.findWorktree).not.toHaveBeenCalled();
    expect(f.retireWorktreeManifest).toHaveBeenCalledTimes(2);
    expect(readFileSync(path.join(f.cwd, "successor"), "utf8")).toBe("keep");
  });
  it("accepts the original worktree through an equivalent repository alias", async () => {
    const f = fixture(), alias = path.join(f.homeDirectory, "repo-alias");
    symlinkSync(f.binding.repositoryPath, alias, "dir");
    f.binding.worktreePath = path.join(alias, ".worktrees", "daynight", f.request.taskId);
    await runWorkerResources({ homeDirectory: f.homeDirectory, request: { ...f.request, action: "delete" }, output: () => {} });
    expect(f.removeWorktree).toHaveBeenCalledOnce();
    expect(f.retireWorktreeManifest).toHaveBeenCalledOnce();
  });
});
