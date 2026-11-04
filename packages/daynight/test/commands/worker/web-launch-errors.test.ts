import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
const native = vi.hoisted(() => ({ spawn: vi.fn(), observe: vi.fn(), capture: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: native.spawn }));
vi.mock("../../../src/commands/controller/local-client.js", () => ({ requestController: native.observe }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureProcessProof: native.capture, confirmControllerProcessesStopped: vi.fn() }));
import { createWebControllerLauncher } from "../../../src/commands/worker/backends/web-process.js";
import { openWebExecutionStore, type WebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { WorkerSessionApi } from "../../../src/commands/worker/backends/session-api.js";
import { controllerExecutionDirectory, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
const roots: string[] = [], stores: WebExecutionStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/web-launch-errors"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const store = openWebExecutionStore(path.join(home, "state.sqlite"), { onMigration: () => {} }); stores.push(store);
  const project = { serverOrigin: "https://daynight.example", projectId: randomUUID(), repoUrl: "https://example.test/repo.git", localPath: home };
  let task = store.register({ ...project, project, taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 } }, 1);
  task = store.bindWorktree(task, { repositoryPath: home, commonDirectory: home, worktreePath: home, branch: "task" }, 2); task = store.initializeWebExecution(task, 3);
  task = store.updateWebExecution(task, { sessionId: randomUUID(), initialPrompt: "original" }, 4);
  const e = task.webExecution!, directory = controllerExecutionDirectory(home, e.executionId); await mkdir(directory, { recursive: true });
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: e.launchId, executionId: e.executionId, controllerId: e.controllerId, controllerInstanceId: e.controllerInstanceId, sessionId: e.sessionId!, executionGeneration: e.executionGeneration, serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, userId: task.userId!, provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: task.configuration!, initialOperationId: e.initialOperationId, initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(directory, "credential.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const child = Object.assign(new EventEmitter(), { pid: 987, exitCode: null, signalCode: null, unref: vi.fn() });
  native.spawn.mockImplementation(() => { queueMicrotask(() => child.emit("spawn")); return child; });
  native.capture.mockResolvedValue({ pid: 987, parentPid: 1, processGroupId: 987, startedAt: "original", commandHash: "a".repeat(64) });
  native.observe.mockResolvedValue({ snapshot: { nativeProcesses: [] } });
  const grant = { token: "controller-token", expiresAt: new Date(Date.now() + 900_000).toISOString(), sessionId: ticket.sessionId, testExecutionId: undefined, claimId: task.claimId, executionGeneration: "1", controllerId: e.controllerId, controllerInstanceId: e.controllerInstanceId };
  const sessionApi = { grant: vi.fn(async () => grant) } as unknown as WorkerSessionApi;
  const launcher = createWebControllerLauncher({ homeDirectory: home, packageDirectory: home, store, sessionApi, now: () => 5 });
  return { store, task, ticket, launcher, child };
};

test("launch acknowledgment database failure is not retried as IPC uncertainty", async () => {
  const { store, task, ticket, launcher } = await fixture();
  const failure = new Error("local acknowledgment persistence failed"), update = store.updateWebExecution.bind(store);
  vi.spyOn(store, "updateWebExecution").mockImplementation((identity, patch, now) => { if (patch.launchSubmission === "acknowledged") throw failure; return update(identity, patch, now); });
  await expect(launcher.launch(task, ticket, new AbortController().signal)).rejects.toBe(failure);
  await launcher.launch(task, ticket, new AbortController().signal);
  expect(native.observe).toHaveBeenCalledOnce(); expect(native.spawn).toHaveBeenCalledOnce();
  expect(store.getTask(task)?.webExecution).toMatchObject({ launchSubmission: "unknown", controllerProcess: { pid: 987 } });
});


test.each(["event", "synchronous"] as const)("persists a definite pre-hello controller spawn rejection (%s)", async kind => {
  const { store, task, ticket, launcher, child } = await fixture();
  const failure = new Error("spawn rejected /private/path token=private-value");
  if (kind === "event") native.spawn.mockImplementation(() => { queueMicrotask(() => child.emit("error", failure)); return child; });
  else native.spawn.mockImplementation(() => { throw failure; });
  await expect(launcher.launch(task, ticket, new AbortController().signal)).rejects.toThrow();
  const result = store.getTask(task)!;
  expect(result.webExecution?.startupReport?.startup).toEqual({ state: "failed", reasonCode: "controller_launch_failed" });
  expect(JSON.stringify(result.webExecution?.startupReport)).not.toContain("private");
  expect(result.recovery.count).toBe(0); expect(native.observe).not.toHaveBeenCalled();
});

test("retains uncertainty when the controller exits before authenticated initialization", async () => {
  const { store, task, ticket, launcher, child } = await fixture();
  child.exitCode = 1 as never;
  native.observe.mockRejectedValue(new Error("No authenticated response"));
  await expect(launcher.launch(task, ticket, new AbortController().signal)).rejects.toThrow("before its authenticated initialization");
  expect(store.getTask(task)?.webExecution?.startupReport?.startup).toEqual({ state: "unknown", reasonCode: "controller_start_unknown" });
  expect(store.getTask(task)?.recovery.count).toBe(0);
});


test("log preparation failure retains an unsubmitted launch without manufacturing an unknown native start", async () => {
  const { store, task, ticket, launcher } = await fixture();
  await mkdir(path.join(controllerExecutionDirectory(ticket.cwd, ticket.executionId), "controller.log"));
  await expect(launcher.launch(task, ticket, new AbortController().signal)).rejects.toThrow();
  expect(store.getTask(task)?.webExecution?.launchSubmission).toBe("not-submitted");
  expect(store.getTask(task)?.webExecution?.startupReport).toBeUndefined();
  expect(native.spawn).not.toHaveBeenCalled();
});
