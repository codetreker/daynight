import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";
const fixture = vi.hoisted(() => ({ mode: "ready", requests: "" }));
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
import { createWorkerRemote } from "../../../src/commands/worker/remote.js";
import { parseCurrentSessionResponse } from "../../../src/session/controller-protocol.js";
import { STARTUP_REPORT_HEADER } from "../../../src/session/startup.js";
import type { WorkerGitManager } from "../../../src/commands/worker/execution.js";
const roots: string[] = [], stores: WebExecutionStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

type HttpFixtureInput = {
  serverUrl: string; serverToken: string; projectId: string; taskId: string; claimId: string;
  workerId: string; worktreeId: string; userId: string; sessionId: string;
  executionGeneration: string; controllerInstanceId: string; controllerId: string;
};
const setup = async (input?: HttpFixtureInput) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/startup-chain"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  fixture.requests = path.join(home, "requests.jsonl");
  const store = openWebExecutionStore(path.join(home, "worker.sqlite"), { onMigration: () => {} }); stores.push(store);
  const project = { serverOrigin: input?.serverUrl ?? "https://daynight.example", projectId: input?.projectId ?? randomUUID(), repoUrl: "https://example.test/repo.git", localPath: process.cwd() };
  let task = store.register({ ...project, project, taskId: input?.taskId ?? randomUUID(), claimId: input?.claimId ?? randomUUID(), workerId: input?.workerId ?? randomUUID(), worktreeId: input?.worktreeId ?? randomUUID(), userId: input?.userId ?? randomUUID(), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 } }, 1);
  task = store.initializeWebExecution(task, 2); task = store.updateWebExecution(task, { sessionId: input?.sessionId ?? randomUUID(), launchSubmission: "acknowledged" }, 3);
  if (input !== undefined) {
    // Bind this isolated fixture to the execution already registered by the HTTP service fixture.
    const db = new Database(path.join(home, "worker.sqlite"));
    try {
      const row = db.prepare("SELECT identity FROM executions").get() as { identity: string };
      const data = { ...task, webExecution: { ...task.webExecution!, controllerId: input.controllerId,
        controllerInstanceId: input.controllerInstanceId, executionGeneration: input.executionGeneration } };
      db.prepare("UPDATE executions SET data=? WHERE identity=?").run(JSON.stringify(data), row.identity);
    } finally { db.close(); }
    task = store.getTask(task)!;
  }
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
  try {
    await expect(runController({ homeDirectory: f.home, provider: "codex", launchId: f.ticket.launchId })).rejects.toThrow();
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
  } finally { log.mockRestore(); }
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


test.skipIf(process.env.DAYNIGHT_STARTUP_HTTP_INPUT === undefined)("startup HTTP acceptance", async () => {
  const inputPath = process.env.DAYNIGHT_STARTUP_HTTP_INPUT!;
  const input = JSON.parse(await readFile(inputPath, "utf8")) as HttpFixtureInput;
  fixture.mode = "reject"; const f = await setup(input);
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await expect(runController({ homeDirectory: f.home, provider: "codex", launchId: f.ticket.launchId })).rejects.toThrow();
    const paused = f.store.pauseRecovery(f.task, "No original native identity is available.", Date.now(), "native_identity_missing");
    const startupReport = f.backend.observeStartupReport(paused)!;
    expect(startupReport).toMatchObject({ startup: { state: "failed", reasonCode: "native_rejected" }, recovery: { state: "blocked", reasonCode: "native_identity_missing" } });
    const remote = createWorkerRemote({ serverUrl: input.serverUrl, serverToken: input.serverToken });
    const signal = AbortSignal.timeout(15_000);
    expect(await remote.currentUserId(signal)).toBe(input.userId);
    const task = await remote.readTask(input.projectId, input.taskId, signal);
    await remote.update(task, { phase: "waiting", nativeSessionId: null, herdr: null, startupReport }, signal);
    const response = await fetch(`${input.serverUrl}/api/v1/projects/${input.projectId}/tasks/${input.taskId}/sessions/current`, {
      headers: { authorization: `Bearer ${input.serverToken}`, [STARTUP_REPORT_HEADER]: "1" }, signal,
    });
    expect(response.status).toBe(200);
    const current = parseCurrentSessionResponse(await response.json());
    expect(current.status).toBe("registered");
    if (current.status !== "registered") throw new Error("The fixture Session is not registered.");
    expect(current.startupReport).toEqual(startupReport);
    expect(current.session.identity.nativeSessionId).toBeNull();
    expect(JSON.stringify(startupReport)).not.toContain("private");
    const requests = (await readFile(fixture.requests, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.map(request => request.method)).toEqual(["initialize"]);
    expect(f.store.getTask(f.task)?.recovery.count).toBe(0);
    await writeFile(path.join(path.dirname(inputPath), "result.json"), JSON.stringify(startupReport), { mode: 0o600 });
  } finally { log.mockRestore(); }
}, 30_000);
