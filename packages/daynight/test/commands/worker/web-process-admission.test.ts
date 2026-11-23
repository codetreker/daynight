import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { frozenToolLaunch } from "../../helpers/tool-launch.js";
import { ConfigurationAdmissionWaiting } from "../../../src/commands/worker/configuration-admission.js";
import { createWebControllerLauncher } from "../../../src/commands/worker/backends/web-process.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { WorkerSessionApi } from "../../../src/commands/worker/backends/session-api.js";

const resources: { directory: string; store: ReturnType<typeof openWebExecutionStore> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { directory, store } of resources.splice(0)) { store.close(); await rm(directory, { recursive: true, force: true }); }
});
const fixture = async (selected = true) => {
  const root = path.resolve(import.meta.dirname, "../../../../../.tmp/task-admission/web-process");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "r-"));
  const store = openWebExecutionStore(createMemoryDatabase()); resources.push({ directory, store });
  const project = { projectId: randomUUID(), repoUrl: "https://example.test/repo.git", localPath: directory };
  let task = store.register({ project, projectId: project.projectId, taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID(),
    serverOrigin: "https://daynight.example", workerId: randomUUID(), userId: randomUUID(),
    configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2, ...(selected ? { toolLaunch: frozenToolLaunch("codex") } : {}) } }, 1);
  task = store.bindWorktree(task, { repositoryPath: directory, commonDirectory: path.join(directory, ".git"), worktreePath: directory, branch: "daynight/task" }, 2);
  task = store.initializeWebExecution(task, 3);
  const sessionId = randomUUID();
  const register = vi.fn(async () => ({ sessionId }) as Awaited<ReturnType<WorkerSessionApi["register"]>>);
  const grant = vi.fn<WorkerSessionApi["grant"]>(async (input, execution) => ({ claimId: input.claimId, sessionId, executionGeneration: execution.executionGeneration,
    token: "fixture-grant", expiresAt: new Date(Date.now() + 60_000).toISOString(), controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId }));
  const sessionApi = { register, grant } as unknown as WorkerSessionApi;
  return { directory, store, task, sessionApi, register, grant };
};

it("does not freeze tool intent or register after readiness changes during tool preparation", async () => {
  const f = await fixture(false); let complete = true;
  const launcher = createWebControllerLauncher({ homeDirectory: f.directory, packageDirectory: f.directory, store: f.store, sessionApi: f.sessionApi, now: Date.now,
    selectToolLaunch: async () => { await Promise.resolve(); complete = false; return frozenToolLaunch("codex"); } });
  await expect(launcher.prepare(f.task, "assignment", new AbortController().signal, () => complete)).rejects.toBeInstanceOf(ConfigurationAdmissionWaiting);
  expect(f.register).not.toHaveBeenCalled();
  expect(f.store.getTask(f.task)!.configuration!.toolLaunch).toBeUndefined();
  expect(f.store.getTask(f.task)!.webExecution).toMatchObject({ launchSubmission: "not-submitted", sessionId: null, ticketPath: null });
});

it("does not mark submission or spawn after readiness changes during launch grant preparation", async () => {
  const f = await fixture(); let complete = true;
  const launcher = createWebControllerLauncher({ homeDirectory: f.directory, packageDirectory: f.directory, store: f.store, sessionApi: f.sessionApi, now: Date.now });
  const signal = new AbortController().signal;
  const ticket = await launcher.prepare(f.task, "assignment", signal, () => complete);
  const grant = f.grant.getMockImplementation()!;
  f.grant.mockImplementation(async (...args) => { const result = await grant(...args); complete = false; return result; });
  await expect(launcher.launch(f.store.getTask(f.task)!, ticket, signal, () => complete)).rejects.toBeInstanceOf(ConfigurationAdmissionWaiting);
  expect(f.store.getTask(f.task)!.webExecution).toMatchObject({ launchSubmission: "not-submitted", controllerProcess: null, nativeProcesses: [] });
  expect(f.store.getTask(f.task)!.webExecution!.startupReport).toBeUndefined();
});
