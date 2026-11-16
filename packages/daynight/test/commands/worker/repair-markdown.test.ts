import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { ApiClient } from "../../../src/api/index.js";
import type { CliContext } from "../../../src/cli/context.js";
import type { ServerCommand, KnownSessionOperationOutput } from "../../../src/commands/server/runtime.js";
import { runWorkerMarkdownRepair } from "../../../src/commands/worker/repair-markdown.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
import { manifestPath } from "../../../src/commands/worker/worktrees/paths.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { writeLaunchTicket, controllerExecutionDirectory, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { repairStoppedMarkdownProjections } from "../../../src/commands/controller/stopped-markdown-repair.js";
import { resolveStoppedMarkdownImage } from "../../../src/commands/controller/stopped-markdown-images.js";
import { runRepositoryGit } from "../../../src/repository/git.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), repair: vi.fn<typeof repairStoppedMarkdownProjections>(), upload: vi.fn() }));
vi.mock("../../../src/commands/server/runtime.js", () => ({ runServerCommand: mocks.run }));
vi.mock("../../../src/commands/controller/stopped-markdown-repair.js", () => ({ repairStoppedMarkdownProjections: mocks.repair }));
vi.mock("../../../src/commands/controller/archive-upload.js", () => ({ uploadStoppedControllerArchive: mocks.upload }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); mocks.run.mockReset(); mocks.repair.mockReset(); mocks.upload.mockReset(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/mr"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home); vi.stubEnv("DN_CONFIG_DIR", path.join(home, "config"));
  const target = { projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), sessionId: randomUUID(), worktreeId: randomUUID() };
  const userId = randomUUID(), workerId = randomUUID(), nativeSessionId = randomUUID(), serverUrl = "https://daynight.example";
  const repositoryPath = path.join(home, "r"), worktreePath = path.join(repositoryPath, ".worktrees", "daynight", target.worktreeId), branch = `daynight/${target.taskId}`;
  await mkdir(repositoryPath, { recursive: true });
  const git = async (cwd: string, args: string[]) => {
    const operation = createOperation({ limits: { totalMs: 30_000 } });
    try { return await runRepositoryGit(cwd, args, operation); } finally { operation.dispose(); }
  };
  await git(repositoryPath, ["init", "-b", "main"]);
  await git(repositoryPath, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Initial fixture"]);
  await git(repositoryPath, ["worktree", "add", "-b", branch, worktreePath]);
  const commonDirectory = (await git(repositoryPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const binding = { repositoryPath, commonDirectory, worktreePath, branch };
  createWorktreeManifestStore(commonDirectory).publish({ schemaVersion: 1, projectId: target.projectId, taskId: target.taskId, claimId: target.claimId, worktreeId: target.worktreeId, directoryName: target.worktreeId });
  const paths = resolveWorkerPaths(home); await mkdir(paths.workerDirectory, { recursive: true }); await writeFile(paths.configFile, `workerId: ${workerId}\n`, { mode: 0o600 });
  const store = openWebExecutionStore(path.join(paths.workerDirectory, "web-executions.sqlite"), { onMigration: () => {} });
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  let local;
  try {
    store.register({ ...target, project: { projectId: target.projectId, serverOrigin: serverUrl, repoUrl: "https://example.test/repository.git", localPath: repositoryPath }, serverOrigin: serverUrl, workerId, userId, configuration }, 1);
    store.initializeWebExecution(target, 2);
    store.updateWebExecution(target, { sessionId: target.sessionId }, 3);
    store.bindWorktree(target, binding, 4);
    store.bindNativeSession(target, { source: "controller", sessionId: nativeSessionId }, 5);
    local = store.beginCleanup(target, { kind: "terminal", deadline: 1000 }, 6);
  } finally { store.close(); }
  const execution = local.webExecution!;
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, sessionId: target.sessionId, executionGeneration: execution.executionGeneration, serverOrigin: serverUrl, projectId: target.projectId, taskId: target.taskId, claimId: target.claimId, workerId, worktreeId: target.worktreeId, userId, provider: "codex", cwd: worktreePath, nativeHome: path.join(home, ".codex"), configuration, initialOperationId: execution.initialOperationId, initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  await writeLaunchTicket(home, ticket);
  const journalPath = path.join(controllerExecutionDirectory(home, execution.executionId), "journal.sqlite"); await mkdir(path.dirname(journalPath), { recursive: true });
  const journal = openControllerLifecycleStore(journalPath, ticket, { contentOwnedLocally: true, onMigration: () => {} });
  journal.patchSnapshot({ nativeSessionId, lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString() }); journal.close();
  const claim = { claimId: target.claimId, state: "completed", userId, workerId, machine: { id: randomUUID(), name: "fixture" }, platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux", agent: "codex", agentControlMode: "web", worktreeId: target.worktreeId, phase: "completing", herdr: null, nativeSessionId, claimedAt: new Date().toISOString() };
  const task = { status: "done", properties: { worker: claim, paused: false } };
  const session = { fence: { claimId: target.claimId, executionGeneration: "1" }, session: { nativeSessionId, lifecycle: "archived" } };
  const api = { getTask: vi.fn(async () => task), getCurrentUser: vi.fn(async () => ({ id: userId })), inspectTaskSession: vi.fn(async () => session) };
  let output: KnownSessionOperationOutput | undefined;
  mocks.run.mockImplementation(async (_context: CliContext, command: ServerCommand) => {
    const operation = createOperation({ limits: { totalMs: 120_000 } });
    try { output = await command({ api: api as unknown as ApiClient, operation, serverUrl, serverConfiguration: { serverUrl, serverToken: "fixture-token" } }) as KnownSessionOperationOutput; } finally { operation.dispose(); }
  });
  mocks.repair.mockImplementation(async options => { await options.beforeWrite?.(); return { repaired: ["entry"], failures: [] }; });
  mocks.upload.mockResolvedValue({ state: "ready", schemaVersion: 3, completeness: "complete" });
  const context: CliContext = { version: "1.0.0", packageDirectory: path.resolve("package"), homeDirectory: () => home, workingDirectory: () => worktreePath, stdout: () => {}, stderr: () => {}, stdoutBytes: async () => {} };
  return { home, target, ticket, journalPath, task, session, api, context, local, paths, binding, git, output: () => output };
};

test("passes the exact original execution and verifies it again before archive upload", async () => {
  const f = await fixture();
  await runWorkerMarkdownRepair(f.target, f.context);
  expect(mocks.repair).toHaveBeenCalledOnce(); expect(mocks.repair.mock.calls[0]![0]).toMatchObject({ journalPath: f.journalPath, ticket: f.ticket, stateDirectory: f.paths.stateDirectory, resolveImage: resolveStoppedMarkdownImage });
  expect(mocks.upload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ journalPath: f.journalPath, ticket: f.ticket, serverToken: "fixture-token" }));
  expect(f.api.getTask.mock.calls.length).toBe(3); expect(f.output()).toMatchObject({ exitCode: 0 }); expect(JSON.parse(f.output()!.output)).toMatchObject({ ...f.target, repaired: ["entry"], archive: { state: "ready" }, cleanup: "owned-by-worker" });
});

test.each(["native", "claim", "paused", "platform", "manifest", "branch"])("refuses changed %s evidence before calling repair or upload", async kind => {
  const f = await fixture(), before = await readFile(f.journalPath);
  if (kind === "native") { f.task.properties.worker.nativeSessionId = randomUUID(); f.session.session.nativeSessionId = f.task.properties.worker.nativeSessionId; }
  if (kind === "claim") f.task.properties.worker.claimId = randomUUID();
  if (kind === "paused") f.task.properties.paused = true;
  if (kind === "platform") f.task.properties.worker.platform = process.platform === "win32" ? "linux" : "windows";
  if (kind === "manifest") await unlink(manifestPath(f.binding.commonDirectory, f.target.worktreeId));
  if (kind === "branch") await f.git(f.binding.worktreePath, ["checkout", "-b", "changed-branch"]);
  await expect(runWorkerMarkdownRepair(f.target, f.context)).rejects.toThrow();
  expect(mocks.repair).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled(); expect(await readFile(f.journalPath)).toEqual(before);
});

test("a claim change during repair is refused by the supplied prewrite hook", async () => {
  const f = await fixture();
  mocks.repair.mockImplementation(async options => { f.task.properties.worker.claimId = randomUUID(); await options.beforeWrite?.(); return { repaired: [], failures: [] }; });
  await expect(runWorkerMarkdownRepair(f.target, f.context)).rejects.toThrow("original claim"); expect(mocks.upload).not.toHaveBeenCalled();
});

test("a branch change after repair prevents archive upload", async () => {
  const f = await fixture();
  mocks.repair.mockImplementation(async () => { await f.git(f.binding.worktreePath, ["checkout", "-b", "changed-after-repair"]); return { repaired: ["entry"], failures: [] }; });
  await expect(runWorkerMarkdownRepair(f.target, f.context)).rejects.toThrow("actual worktree"); expect(mocks.upload).not.toHaveBeenCalled();
});

test("reports retained repair failures with an actionable result and never archives", async () => {
  const f = await fixture();
  mocks.repair.mockResolvedValue({ repaired: [], failures: [{ entryId: "entry", code: "source_not_found" }] });
  await runWorkerMarkdownRepair(f.target, f.context);
  expect(mocks.upload).not.toHaveBeenCalled(); expect(f.output()).toMatchObject({ exitCode: 1 });
  expect(JSON.parse(f.output()!.output)).toMatchObject({ ...f.target, archive: "not-started", failures: [{ code: "source_not_found" }], nextAction: expect.stringContaining("Restore") });
});
