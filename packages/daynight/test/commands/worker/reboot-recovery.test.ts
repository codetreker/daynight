import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { ApiClient } from "../../../src/api/index.js";
import type { CliContext } from "../../../src/cli/context.js";
import type { ServerCommand, KnownSessionOperationOutput } from "../../../src/commands/server/runtime.js";
import { runWorkerRebootRecovery } from "../../../src/commands/worker/reboot-recovery.js";
import { recoverControllerAfterWindowsReboot } from "../../../src/commands/controller/reboot-recovery.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../../src/commands/server/runtime.js", () => ({ runServerCommand: mocks.run }));
vi.mock("../../../src/commands/controller/reboot-recovery.js", () => ({ recoverControllerAfterWindowsReboot: vi.fn() }));
const roots: string[] = [], platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); mocks.run.mockReset(); vi.mocked(recoverControllerAfterWindowsReboot).mockReset(); Object.defineProperty(process, "platform", platform); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/reboot-command-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home); vi.stubEnv("DN_CONFIG_DIR", path.join(home, "config"));
  const target = { taskId: randomUUID(), projectId: randomUUID(), claimId: randomUUID(), sessionId: randomUUID(), worktreeId: randomUUID(), prepare: true };
  const workerId = randomUUID(), userId = randomUUID(), nativeSessionId = randomUUID(), serverUrl = "https://daynight.example", nativeHome = path.join(home, ".codex");
  const paths = resolveWorkerPaths(home); await mkdir(paths.workerDirectory, { recursive: true }); await writeFile(paths.configFile, `workerId: ${workerId}\n`);
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  const store = openWebExecutionStore(path.join(paths.workerDirectory, "web-executions.sqlite"), { onMigration: () => {} });
  let local;
  try {
    store.register({ ...target, project: { projectId: target.projectId, repoUrl: "https://example.test/repo.git", localPath: home }, serverOrigin: serverUrl, workerId, userId, configuration }, 1);
    store.initializeWebExecution(target, 2);
    store.updateWebExecution(target, { sessionId: target.sessionId, nativeHome }, 3);
    store.bindWorktree(target, { repositoryPath: home, commonDirectory: home, worktreePath: home, branch: "fixture" }, 4);
    local = store.bindNativeSession(target, { source: "controller", sessionId: nativeSessionId }, 5);
  } finally { store.close(); }
  const execution = local.webExecution!;
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, sessionId: target.sessionId, executionGeneration: execution.executionGeneration, serverOrigin: serverUrl, projectId: target.projectId, taskId: target.taskId, claimId: target.claimId, workerId, worktreeId: target.worktreeId, userId, provider: "codex", cwd: home, nativeHome, configuration, initialOperationId: execution.initialOperationId, initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "e".repeat(64), createdAt: new Date().toISOString() };
  await writeLaunchTicket(home, ticket);
  const file = path.join(controllerExecutionDirectory(home, ticket.executionId), "journal.sqlite"); await mkdir(path.dirname(file), { recursive: true });
  const journal = openControllerLifecycleStore(file, ticket);
  journal.patchSnapshot({ nativeSessionId, initialInputState: "confirmed" }); journal.close();
  const task = { status: "in_progress", properties: { worker: { claimId: target.claimId, state: "active", userId, workerId, machine: { id: randomUUID(), name: "fixture" }, platform: "windows", agent: "codex", agentControlMode: "web", worktreeId: target.worktreeId, phase: "preparing", herdr: null, nativeSessionId, claimedAt: new Date().toISOString() } } };
  const api = { getTask: vi.fn(async () => task), getCurrentUser: vi.fn(async () => ({ id: userId })) };
  let output: KnownSessionOperationOutput | undefined;
  mocks.run.mockImplementation(async (_context: CliContext, command: ServerCommand) => {
    const operation = createOperation({ limits: { totalMs: 30_000 } });
    try { output = await command({ api: api as unknown as ApiClient, operation, serverUrl, serverConfiguration: { serverUrl, serverToken: "fixture" } }) as KnownSessionOperationOutput; } finally { operation.dispose(); }
  });
  vi.mocked(recoverControllerAfterWindowsReboot).mockImplementation(async options => { await options.beforeWrite(); return "prepared"; });
  const context: CliContext = { version: "1.0.0", packageDirectory: home, homeDirectory: () => home, workingDirectory: () => home, stdout: () => {}, stderr: () => {}, stdoutBytes: async () => {} };
  return { target, context, task, api, file, ticket, paths, output: () => output };
};

test("uses the exact local execution and rechecks the owner and active claim before persistence", async () => {
  const f = await fixture(); await runWorkerRebootRecovery(f.target, f.context);
  expect(recoverControllerAfterWindowsReboot).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ file: f.file, ticket: f.ticket, prepare: true }));
  expect(f.api.getTask).toHaveBeenCalledTimes(2);
  expect(JSON.parse(f.output()!.output)).toMatchObject({ ...f.target, result: "prepared", executionGeneration: "1" });
});

test.each(["claim", "owner", "native", "worktree", "session"])("rejects a conflicting original %s without preparing recovery", async kind => {
  const f = await fixture();
  if (kind === "claim") f.task.properties.worker.claimId = randomUUID();
  if (kind === "owner") f.task.properties.worker.userId = randomUUID();
  if (kind === "native") f.task.properties.worker.nativeSessionId = randomUUID();
  if (kind === "worktree") f.target.worktreeId = randomUUID();
  if (kind === "session") f.target.sessionId = randomUUID();
  await expect(runWorkerRebootRecovery(f.target, f.context)).rejects.toThrow();
  expect(recoverControllerAfterWindowsReboot).not.toHaveBeenCalled();
});

test("a claim change in flight is refused by the prewrite guard", async () => {
  const f = await fixture();
  vi.mocked(recoverControllerAfterWindowsReboot).mockImplementation(async options => { f.task.properties.worker.claimId = randomUUID(); await options.beforeWrite(); return "prepared"; });
  await expect(runWorkerRebootRecovery(f.target, f.context)).rejects.toThrow("active original claim");
});

test.each(["shutdown", "terminal"] as const)("preserves an original %s cleanup and admits only shutdown stop confirmation", async kind => {
  const f = await fixture(), database = path.join(f.paths.workerDirectory, "web-executions.sqlite");
  let store = openWebExecutionStore(database, { onMigration: () => {} });
  let cleanup;
  try { cleanup = store.beginCleanup(f.target, { kind, deadline: 1000 }, 6).cleanup; } finally { store.close(); }
  if (kind === "shutdown") {
    await runWorkerRebootRecovery(f.target, f.context);
    expect(recoverControllerAfterWindowsReboot).toHaveBeenCalledOnce();
  } else {
    await expect(runWorkerRebootRecovery(f.target, f.context)).rejects.toThrow("original active Web claim");
    expect(recoverControllerAfterWindowsReboot).not.toHaveBeenCalled();
  }
  store = openWebExecutionStore(database, { onMigration: () => {} });
  try { expect(store.getTask(f.target)!.cleanup).toEqual(cleanup); } finally { store.close(); }
});
