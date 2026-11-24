import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { cleanupRetiredClaim } from "../../../src/commands/worker/retired-claim-cleanup.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { RetiredClaimNativeCleanup, ClaimNativeClearance } from "../../../src/commands/worker/backends/retired-claim-native.js";

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const roots: string[] = [], stores: ReturnType<typeof openWorkerStore>[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const parent = path.resolve("../../.tmp/retired-claim-cleanup-tests"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "r-")); roots.push(root);
  const store = openWorkerStore(createMemoryDatabase()); stores.push(store);
  const project = store.registerProject({ projectId: uuid(1), repoUrl: "https://example.test/owner/repo.git", localPath: path.join(root, "repo") });
  const owner = { projectId: project.projectId, taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(4) };
  store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
  const clearance: ClaimNativeClearance = { target: owner, owners: [owner], inventoryComplete: true, resourcesCleared: true, stoppedExecutions: [], observedAt: 1 };
  const native = { stop: vi.fn(async () => clearance) } as unknown as RetiredClaimNativeCleanup;
  const git = { prepareRepository: vi.fn(async () => {}), scanWorktrees: vi.fn(), resolveWorktreeBinding: vi.fn(async () => null), removeWorktree: vi.fn(), removeUnregisteredReservation: vi.fn(async () => {}) } as unknown as WorkerGitManager;
  const options = { target: owner, located: Promise.resolve({ target: owner, controllers: [] }), native, project, store, git, signal: new AbortController().signal, deadline: Date.now() + 5000,
    now: () => 1, onOwner: vi.fn(), onCleared: vi.fn(), onEffectError: vi.fn() };
  return { root, owner, project, store, native, git, options };
};

it("publishes exact native clearance before Git fails and retains durable cleanup responsibility", async () => {
  const f = await fixture(); await mkdir(f.project.localPath);
  const failure = new Error("Original Git inventory is unavailable.");
  vi.mocked(f.git.prepareRepository).mockImplementation(async () => {
    expect(f.options.onCleared).toHaveBeenCalledExactlyOnceWith(f.owner, 1);
    expect(f.store.getCleanupSchedule(f.owner)).not.toBeNull();
    throw failure;
  });
  await expect(cleanupRetiredClaim(f.options)).rejects.toMatchObject({ stage: "worktree-removal", cause: failure });
  expect(f.store.getTask(f.owner)?.status).toBe("pending");
  expect(f.git.removeUnregisteredReservation).not.toHaveBeenCalled();
});

it("retains a known worktree when its repository is missing after native clearance", async () => {
  const f = await fixture();
  await expect(cleanupRetiredClaim(f.options)).rejects.toMatchObject({ stage: "worktree-removal", cause: { code: "ENOENT" } });
  expect(f.options.onCleared).toHaveBeenCalledExactlyOnceWith(f.owner, 1);
  expect(f.store.getCleanupSchedule(f.owner)?.worktreeId).toBe(f.owner.worktreeId);
  expect(f.git.prepareRepository).not.toHaveBeenCalled();
});

it("keeps native stop failures separate from Git work and capacity settlement", async () => {
  const f = await fixture(), failure = new Error("Original native boundary remains running.");
  vi.mocked(f.native.stop).mockRejectedValue(failure);
  await expect(cleanupRetiredClaim(f.options)).rejects.toMatchObject({ stage: "agent-stop", cause: failure });
  expect(f.options.onCleared).not.toHaveBeenCalled();
  expect(f.git.prepareRepository).not.toHaveBeenCalled();
  expect(f.store.getCleanupSchedule(f.owner)).toBeNull();
});

it("retains a registered worktree when stop is known but the original worktree identity is missing", async () => {
  const f = await fixture(); await mkdir(f.project.localPath);
  const { projectId, taskId, claimId } = f.owner;
  const target = { projectId, taskId, claimId };
  const binding = { repositoryPath: f.project.localPath, commonDirectory: path.join(f.project.localPath, ".git"), worktreePath: path.join(f.project.localPath, ".worktrees", "daynight", f.owner.worktreeId), branch: `daynight/${taskId}` };
  vi.mocked(f.native.stop).mockResolvedValue({ target, owners: [], inventoryComplete: true, resourcesCleared: true, stoppedExecutions: [], observedAt: 1 });
  vi.mocked(f.git.scanWorktrees).mockResolvedValue({ enumerationComplete: true, validated: [{ taskId, binding }], quarantined: [], unknown: [] });
  await expect(cleanupRetiredClaim({ ...f.options, target, located: Promise.resolve({ target, controllers: [] }) })).rejects.toMatchObject({ stage: "worktree-removal", cause: { message: expect.stringContaining("no confirmed original claim identity") } });
  expect(f.git.removeWorktree).not.toHaveBeenCalled();
  expect(f.git.removeUnregisteredReservation).not.toHaveBeenCalled();
});
