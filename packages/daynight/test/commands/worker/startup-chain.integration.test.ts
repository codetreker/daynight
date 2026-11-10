import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import { captureStartupDeadline, stopStartupChildren } from "../../helpers/startup-deadline.js";
const fixture = vi.hoisted(() => ({ mode: "ready", requests: "", children: [] as ChildProcess[] }));
vi.mock("node:net", () => ({ createServer: () => {
  const server = new EventEmitter() as EventEmitter & { listen: (endpoint: string, callback: () => void) => void; close: () => void };
  server.listen = (_endpoint, callback) => queueMicrotask(callback); server.close = () => {}; return server;
} }));
vi.mock("../../../src/config/agent-cli-aliases.js", () => ({ readAgentCliAliases: async () => ({}) }));
vi.mock("../../../src/cli/agent-cli-aliases.js", () => ({ prepareAgentCliAliases: async (options: { environment: NodeJS.ProcessEnv }) => ({ environment: options.environment, bindings: [], directory: null }) }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({
  captureControllerProcessProof: async () => ({ pid: process.pid, parentPid: process.ppid, processGroupId: null, startedAt: "fixture-controller", commandHash: "a".repeat(64) }),
  captureProcessProof: async (pid: number) => ({ pid, parentPid: process.pid, processGroupId: null, startedAt: "fixture-native", commandHash: "b".repeat(64) }),
}));
// The Controller never connects; the Worker must publish its durable local evidence.
vi.mock("../../../src/commands/controller/relay.js", () => ({ createControllerRelay: () => ({ flush: async () => {}, close: () => {}, connected: () => false, receipt: () => {} }) }));
vi.mock("../../../src/commands/controller/providers/codex.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/commands/controller/providers/codex.js")>();
  return { ...actual, openCodexProvider: (options: ProviderOptions) => actual.openCodexProvider({ ...options,
    executable: path.resolve(import.meta.dirname, "../controller/fixtures/codex-native.mjs"),
    env: { ...options.env, CODEX_TEST_INITIALIZE: fixture.mode, CODEX_TEST_REQUEST_LOG: fixture.requests },
    onSpawn: child => { fixture.children.push(child); options.onSpawn(child); },
  }) };
});
// A real IPC socket is unnecessary for this journal-to-Worker acceptance boundary.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, chmod: async (file: string, mode: number) => file.endsWith("controller.sock") ? undefined : actual.chmod(file, mode) };
});
import { runController } from "../../../src/commands/controller/runtime.js";
import { readControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openWebExecutionStore, type WebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { createWebExecutionBackend } from "../../../src/commands/worker/backends/web.js";
import type { WorkerGitManager } from "../../../src/commands/worker/execution.js";
const roots: string[] = [], stores: WebExecutionStore[] = [];
afterEach(async () => { await stopStartupChildren(fixture.children.splice(0)); vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const setup = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/startup-chain"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  fixture.requests = path.join(home, "requests.jsonl");
  const store = openWebExecutionStore(path.join(home, "worker.sqlite"), { onMigration: () => {} }); stores.push(store);
  const project = { serverOrigin: "https://daynight.example", projectId: randomUUID(), repoUrl: "https://example.test/repo.git", localPath: process.cwd() };
  let task = store.register({ ...project, project, taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 } }, 1);
  task = store.initializeWebExecution(task, 2); task = store.updateWebExecution(task, { sessionId: randomUUID(), launchSubmission: "acknowledged" }, 3);
  const e = task.webExecution!;
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: e.launchId, executionId: e.executionId, controllerId: e.controllerId, controllerInstanceId: e.controllerInstanceId, sessionId: e.sessionId!, executionGeneration: e.executionGeneration, serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, userId: task.userId!, provider: "codex", cwd: process.cwd(), nativeHome: path.join(home, "native"), configuration: task.configuration!, initialOperationId: e.initialOperationId, initialPrompt: "Never submit this fixture assignment", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  await writeLaunchTicket(home, ticket);
  const journal = path.join(controllerExecutionDirectory(home, e.executionId), "journal.sqlite");
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
  const backend = createWebExecutionBackend({ homeDirectory: home, store, git: {} as WorkerGitManager, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: Date.now });
  return { home, store, task, ticket, journal, backend, launcher };
};

test.each(["reject", "timeout"] as const)("real native initialize %s reaches the Worker while relay hello never succeeds", async mode => {
  fixture.mode = mode;
  const f = await setup(); const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const deadline = mode === "timeout" ? captureStartupDeadline() : undefined;
  const running = runController({ homeDirectory: f.home, provider: "codex", launchId: f.ticket.launchId });
  let settled = false;
  void running.finally(() => { settled = true; }).catch(() => {});
  try {
    if (deadline) await deadline.expireAfterRequest(fixture.requests, requests => requests.some(request => JSON.parse(request).method === "initialize"));
    await expect(running).rejects.toThrow();
    const expected = mode === "reject" ? { state: "failed", reasonCode: "native_rejected" } : { state: "unknown", reasonCode: "native_timeout" };
    expect(readControllerSnapshot(f.journal)).toMatchObject({ startup: expected, nativeSessionId: null, initialInputState: "not_submitted" });
    const paused = f.store.pauseRecovery(f.task, "No original native identity is available.", Date.now(), "native_identity_missing");
    const report = f.backend.observeStartupReport(paused)!;
    expect(report).toMatchObject({ startup: expected, recovery: { state: "blocked", reasonCode: "native_identity_missing" } });
    expect(JSON.stringify(report)).not.toContain("private");
    expect(f.backend.observeStartupReport(paused)).toEqual(report);
    expect(f.store.getTask(f.task)?.recovery.count).toBe(0);
    const requests = (await readFile(fixture.requests, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.map(request => request.method)).toEqual(["initialize"]);
    expect(f.launcher.launch).not.toHaveBeenCalled();
  } finally {
    try {
      if (!settled) process.emit("SIGTERM", "SIGTERM");
      await stopStartupChildren(fixture.children);
      await running.catch(() => {});
    } finally { deadline?.restore(); log.mockRestore(); }
  }
}, 40_000);

test("real healthy native startup is observed without sending the initial assignment", async () => {
  fixture.mode = "ready"; const f = await setup();
  const running = runController({ homeDirectory: f.home, provider: "codex", launchId: f.ticket.launchId });
  void running.catch(() => {});
  try {
    await vi.waitFor(() => expect(readControllerSnapshot(f.journal)?.startup).toEqual({ state: "ready", reasonCode: "ready" }));
    expect(f.backend.observeStartupReport(f.task)?.startup).toEqual({ state: "ready", reasonCode: "ready" });
  } finally { process.emit("SIGTERM", "SIGTERM"); await running; }
  expect(f.backend.observeStartupReport(f.task)?.startup.state).toBe("ready");
  const requests = (await readFile(fixture.requests, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(requests.some(request => request.method === "turn/start")).toBe(false);
});
