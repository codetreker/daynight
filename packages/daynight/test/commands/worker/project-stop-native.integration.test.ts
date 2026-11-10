import { scanFromList } from "../../helpers/worker-git-scan.js";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import { createWorkerHerdr } from "../../../src/commands/worker/herdr.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { createWebExecutionBackend } from "../../../src/commands/worker/backends/web.js";
import { writeLaunchTicket, controllerExecutionDirectory, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore, readControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { captureProcessProof, confirmControllerProcessesStopped } from "../../../src/commands/controller/process-proof.js";
import type { WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import type { WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";

// This opt-in test runs real local daemons and process groups in an isolated worker home.
const enabled = process.platform === "linux" && process.env.DAYNIGHT_TEST_PROJECT_STOP_NATIVE === "1";
const origin = "https://daynight.example";
const config = { agent: "codex" as const, model: null, args: [], recoveryLimit: 2 };
const gitCommand = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });

const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/project-stop-native");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "run-"));
  // Unix sockets use this short alias; the directory and all bytes remain in the worktree.
  const descriptor = await open(root, "r");
  const alias = `/proc/${process.pid}/fd/${descriptor.fd}`;
  const home = path.join(alias, "home"), repository = path.join(alias, "repo");
  await mkdir(home, { recursive: true }); await mkdir(repository, { recursive: true });
  gitCommand(repository, "init", "-q");
  gitCommand(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "fixture");
  const owner = { projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() };
  const project = { projectId: owner.projectId, repoUrl: "https://example.test/fixture.git", localPath: repository };
  const worktreePath = path.join(repository, ".worktrees", "daynight", owner.taskId);
  gitCommand(repository, "worktree", "add", "-qb", `daynight/${owner.taskId}`, worktreePath);
  const sentinel = path.join(worktreePath, "uncommitted.txt"); await writeFile(sentinel, "retained\n");
  const store = openWorkerStore(path.join(alias, "worker.sqlite")); store.registerProject(project);
  const git = { removeWorktree: vi.fn(), scanWorktrees: scanFromList, listWorktrees: vi.fn(async () => []) } as unknown as WorkerGitManager;
  const workerId = randomUUID();
  const common = { store, git, remote: {} as WorkerRemote, serverOrigin: origin, workerId, platform: "linux" as const, machine: { id: randomUUID(), name: "test" }, repositories: [{ project, configuration: config }], targetProjectIds: [owner.projectId], readyProjectIds: [owner.projectId], globalConfiguration: config, maxConcurrent: 2, preferPlatformSpecificTasks: false, buildPrompt: () => "test", emit: () => {} };
  const exclude = { repositories: [], targetProjectIds: [], readyProjectIds: [], globalConfiguration: config, maxConcurrent: 2, preferPlatformSpecificTasks: false };
  const verify = async () => {
    expect(await readFile(sentinel, "utf8")).toBe("retained\n");
    expect(gitCommand(repository, "worktree", "list", "--porcelain")).toContain(owner.taskId);
    expect(store.getTask(owner)).toMatchObject({ claimId: owner.claimId, status: "active" });
    expect(git.removeWorktree).not.toHaveBeenCalled();
  };
  return { root, descriptor, alias, home, repository, owner, project, worktreePath, store, git, workerId, common, exclude, verify };
};

it.skipIf(!enabled)("stops a real isolated Herdr workspace through project removal and retains the original worktree", async () => {
  const f = await fixture();
  const paths = resolveWorkerPaths(f.home);
  const environment = { ...process.env, HOME: f.home, USERPROFILE: f.home, XDG_CONFIG_HOME: path.join(f.home, "config"), XDG_STATE_HOME: path.join(f.home, "state") };
  const herdr = createWorkerHerdr({ paths, homeDirectory: f.home, environment, isolatedRun: true });
  const operation = createOperation({ limits: { totalMs: 30_000 } });
  try {
    f.store.activateTask(f.store.registerPending({ ...f.owner, agent: "codex" }));
    await herdr.ensureInstance(operation);
    const context = { ...f.owner, cwd: f.worktreePath, agent: "codex" as const };
    const binding = await herdr.tasks.prepareWorkspace(context, "Project stop test", operation);
    const before = await herdr.tasks.processInfo(context, binding, operation);
    expect(before.shellPid).toBeGreaterThan(1);
    expect((await herdr.tasks.listResources(operation)).some(resource => resource.owner.claimId === f.owner.claimId)).toBe(true);
    const coordinator = createWorkerCoordinator({ ...f.common, herdr });
    coordinator.updateConfiguration(f.exclude);
    await coordinator.stopProject(f.owner.projectId);
    expect((await herdr.tasks.listResources(operation)).some(resource => resource.owner.claimId === f.owner.claimId)).toBe(false);
    expect(() => process.kill(before.shellPid, 0)).toThrow();
    await f.verify();
  } finally {
    try { await herdr.stopInstance(operation); } finally { operation.dispose(); f.store.close(); await f.descriptor.close(); await rm(f.root, { recursive: true, force: true }); }
  }
}, 90_000);

it.skipIf(!enabled)("stops a real Web process group through project removal and retains the original worktree and journal", async () => {
  const f = await fixture();
  const webStore = openWebExecutionStore(path.join(f.alias, "web.sqlite"));
  let child: ChildProcess | undefined;
  try {
    f.store.activateTask(f.store.registerPending({ ...f.owner, agent: "codex", agentControlMode: "web" }));
    const nativeSessionId = randomUUID(), webConfig = { ...config, agentControlMode: "web" as const };
    let task = webStore.register({ ...f.owner, project: f.project, serverOrigin: origin, workerId: f.workerId, userId: randomUUID(), configuration: webConfig }, 1);
    const binding = { repositoryPath: f.repository, commonDirectory: path.join(f.repository, ".git"), worktreePath: f.worktreePath, branch: `daynight/${f.owner.taskId}` };
    task = webStore.bindWorktree(task, binding, 2);
    task = webStore.bindNativeSession(task, { source: "controller", sessionId: nativeSessionId }, 3);
    task = webStore.initializeWebExecution(task, 4);
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", reject); });
    const proof = await captureProcessProof(child.pid!);
    task = webStore.updateWebExecution(task, { sessionId: randomUUID(), initialPrompt: "managed", launchSubmission: "acknowledged", controllerProcess: proof }, 5);
    const e = task.webExecution!;
    const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: e.launchId, executionId: e.executionId, controllerId: e.controllerId, controllerInstanceId: e.controllerInstanceId, sessionId: e.sessionId!, executionGeneration: e.executionGeneration, serverOrigin: origin, projectId: f.owner.projectId, taskId: f.owner.taskId, claimId: f.owner.claimId, workerId: f.workerId, worktreeId: f.owner.worktreeId, userId: task.userId!, provider: "codex", cwd: f.worktreePath, nativeHome: path.join(f.home, ".native"), configuration: webConfig, initialOperationId: e.initialOperationId, initialPrompt: "managed", resumeNativeSessionId: nativeSessionId, credentialFile: path.join(f.home, "grant.json"), ipcEndpoint: path.join(f.home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date(0).toISOString() };
    task = webStore.updateWebExecution(task, { ticketPath: await writeLaunchTicket(f.home, ticket) }, 6);
    const journalPath = path.join(controllerExecutionDirectory(f.home, e.executionId), "journal.sqlite");
    await mkdir(path.dirname(journalPath), { recursive: true });
    const journal = openControllerLifecycleStore(journalPath, ticket);
    journal.patchSnapshot({ controllerProcess: proof, lifecycle: "working", activity: "working", nativeStopped: false, stoppedAt: null }); journal.close();
    const webBackend = createWebExecutionBackend({ homeDirectory: f.home, store: webStore, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "test", emit: () => {}, now: () => 20, request: vi.fn().mockRejectedValue(new Error("Original IPC endpoint is unavailable.")) });
    const herdr = { ensureInstance: async () => {}, tasks: { listResources: async () => [], pendingStops: () => [] } } as unknown as WorkerHerdrAdapter;
    const coordinator = createWorkerCoordinator({ ...f.common, herdr, webStore, webBackend, now: () => 20 });
    expect(await confirmControllerProcessesStopped(proof, [])).toBe(false);
    coordinator.updateConfiguration(f.exclude);
    await coordinator.stopProject(f.owner.projectId);
    expect(await confirmControllerProcessesStopped(proof, [])).toBe(true);
    expect(readControllerSnapshot(journalPath)).toMatchObject({ lifecycle: "stopped", nativeStopped: true, controllerProcess: proof });
    expect(webStore.getTask(f.owner)?.resources.nativeSession?.sessionId).toBe(nativeSessionId);
    await access(journalPath); await f.verify();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise<void>(resolve => child!.once("exit", () => resolve())); }
    webStore.close(); f.store.close(); await f.descriptor.close(); await rm(f.root, { recursive: true, force: true });
  }
}, 90_000);
