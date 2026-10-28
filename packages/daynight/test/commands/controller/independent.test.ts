import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const f = vi.hoisted(() => ({ spawn: vi.fn(), request: vi.fn(), stop: vi.fn(), record: vi.fn(), snapshot: vi.fn(), capture: vi.fn(), resume: vi.fn(), release: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: f.spawn }));
vi.mock("../../../src/config/server.js", async original => ({ ...await original<typeof import("../../../src/config/server.js")>(), loadServerConfiguration: async () => ({ serverUrl: "https://daynight.example", serverToken: "private-token" }) }));
vi.mock("../../../src/commands/controller/local-client.js", () => ({ requestController: f.request }));
vi.mock("../../../src/commands/controller/lifecycle-store.js", () => ({ readControllerSnapshot: f.snapshot, recordStoppedControllerGeneration: f.record }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureProcessProof: f.capture, stopControllerProcesses: f.stop }));
vi.mock("../../../src/commands/controller/resume.js", () => ({ acquireResume: f.resume }));
import { runIndependentController } from "../../../src/commands/controller/independent.js";
import { SESSION_PROTOCOL } from "../../../src/session/protocol.js";
import type { CliContext } from "../../../src/cli/context.js";
const id = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
beforeEach(() => vi.clearAllMocks());
const setup = async (prompt: string | null, archiveFailure = false) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/ct"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const out: string[] = [], err: string[] = [], requests: { url: string; body: any }[] = [];
  const context: CliContext = { version: "test", packageDirectory: "/package", homeDirectory: () => home, workingDirectory: () => home, stdout: text => out.push(text), stderr: text => err.push(text), stdoutBytes: async () => {} };
  let registration: any, session: any;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined; requests.push({ url, body });
    if (url.endsWith("capabilities")) return Response.json({ protocol: SESSION_PROTOCOL, schemaVersion: 1, projectionVersion: 1, providers: ["codex", "claude", "copilot"] });
    if (url.endsWith("/test-sessions")) {
      registration = body;
      session = { protocol: SESSION_PROTOCOL, schemaVersion: 1, projectionVersion: 1, sessionId: id, testExecutionId: body.testExecutionId, executionGeneration: "1", connectionEpoch: "0", identity: { ownerUserId: id, controllerId: body.controllerId, controllerInstanceId: body.controllerInstanceId, agentControlMode: "web", provider: "codex", nativeSessionId: null }, sessionRevision: "1", historyEpoch: id, lastEventSeq: "0", lastTimelineSeq: "0", initialInputState: prompt === null ? "not_required" : "not_submitted", synchronized: false, lifecycle: "active", connectionState: "disconnected", activity: "initializing", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, operations: { canSend: false, canCancel: false, canRespond: false } };
      return Response.json({ session });
    }
    if (url.endsWith("controller-grant")) return Response.json({ token: "controller-private-token", expiresAt: new Date(Date.now() + 900_000).toISOString(), sessionId: id, testExecutionId: registration.testExecutionId, executionGeneration: "1", controllerId: registration.controllerId, controllerInstanceId: registration.controllerInstanceId });
    if (url.endsWith("/stop")) return archiveFailure ? new Response("", { status: 401 }) : Response.json({ session: { ...session, lifecycle: "archived" } });
    throw new Error("Unexpected request");
  }));
  const proof = { pid: 987, processGroupId: 987, startedAt: "original", commandHash: "hash", parentPid: 1 };
  const child = Object.assign(new EventEmitter(), { pid: 987, exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn() });
  f.spawn.mockImplementation(() => { queueMicrotask(() => child.emit("spawn")); return child; });
  f.capture.mockResolvedValue(proof);
  f.snapshot.mockReturnValue({ controllerProcess: proof, nativeProcesses: [] });
  f.record.mockResolvedValue({ stoppedAt: new Date().toISOString() });
  f.stop.mockResolvedValue(undefined);
  f.request.mockImplementation(async (_ticket, action) => {
    if (action.kind === "stop") { child.exitCode = 0; child.emit("exit", 0); return {}; }
    if (action.kind === "observe") { if (prompt === null) process.emit("SIGINT", "SIGINT"); return { snapshot: { lifecycle: "ready", nativeSessionId: null } }; }
    if (action.kind === "submit_initial") { process.emit("SIGINT", "SIGINT"); return { snapshot: {}, operation: { state: "unknown" } }; }
    throw new Error("Unexpected IPC action");
  });
  return { home, context, out, err, requests, child };
};
test.each([null, "hello 中文"])("foreground Test lifecycle preserves registration and initial-input mode %s", async prompt => {
  const v = await setup(prompt);
  await runIndependentController({ provider: "codex", model: null, args: [], prompt }, v.context);
  expect(v.out.join("")).toContain(`https://daynight.example/test-sessions/${id}`);
  expect(v.out.join("")).not.toContain("token");
  expect(f.spawn).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(["controller", "codex", "--launch-id"]), expect.objectContaining({ cwd: v.home, detached: process.platform !== "win32" }));
  expect(f.request.mock.calls.filter(([, action]) => action.kind === "submit_initial")).toHaveLength(prompt === null ? 0 : 1);
  expect(v.requests.filter(r => r.url.endsWith("/test-sessions"))).toHaveLength(1);
  expect(v.requests.some(r => r.url.includes("/tasks") || r.url.includes("/workers"))).toBe(false);
  expect(v.requests.filter(r => r.url.endsWith("controller-grant")).map(r => r.body.kind)).toEqual(["bootstrap", "reconnect"]);
  expect(f.stop).toHaveBeenCalledOnce(); expect(f.record).toHaveBeenCalledOnce();
  const launch = (await readdir(path.join(v.home, ".daynight", "controller", "launches")))[0]!;
  const ticket = JSON.parse(await readFile(path.join(v.home, ".daynight", "controller", "launches", launch), "utf8"));
  expect(ticket).toMatchObject({ initialInput: prompt === null ? "none" : "prompt", initialPrompt: prompt ?? "" });
  for (const field of ["taskId", "claimId", "projectId", "workerId", "worktreeId"]) expect(ticket).not.toHaveProperty(field);
  expect(v.out.join("")).toContain("stopped and archived");
});
test("revoked archival credentials cannot prevent local process stop", async () => {
  const v = await setup(null, true);
  await runIndependentController({ provider: "codex", model: null, args: [], prompt: null }, v.context);
  expect(f.stop).toHaveBeenCalledOnce(); expect(f.record).toHaveBeenCalledOnce();
  expect(v.err.join("")).toContain("archival is unconfirmed");
  expect(v.out.join("")).not.toContain("stopped and archived");
});
test("an uncertain registration never spawns a native writer or invents a second registration", async () => {
  const v = await setup(null);
  const fetch = vi.mocked(globalThis.fetch), original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (...args) => { if (String(args[0]).endsWith("/test-sessions")) throw new Error("response lost"); return original(...args); });
  await expect(runIndependentController({ provider: "codex", model: null, args: [], prompt: null }, v.context)).rejects.toThrow("response lost");
  expect(f.spawn).not.toHaveBeenCalled();
  const directories = await readdir(path.join(v.home, ".daynight", "controller", "executions"));
  const saved = JSON.parse(await readFile(path.join(v.home, ".daynight", "controller", "executions", directories[0]!, "registration.json"), "utf8"));
  expect(saved.registration.testExecutionId).toBe(directories[0]);
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/test-sessions"))).toHaveLength(1);
});

test("a post-registration grant failure retains the URL and archives a proven unstarted launch", async () => {
  const v = await setup(null);
  const fetch = vi.mocked(globalThis.fetch), original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (...args) => String(args[0]).endsWith("controller-grant") ? new Response("", { status: 401 }) : original(...args));
  await expect(runIndependentController({ provider: "codex", model: null, args: [], prompt: null }, v.context)).rejects.toThrow("401");
  expect(f.spawn).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
  expect(v.out.join("")).toContain(`https://daynight.example/test-sessions/${id}`);
  expect(v.out.join("")).toContain("archived; no controller process was started");
  expect(v.requests.find(r => r.url.endsWith("/stop"))?.body.stopProof.kind).toBe("never_started");
  expect(v.err.join("")).not.toContain("private-token");
});
test("Ctrl+C after registration still exposes the registered page and no-launch state", async () => {
  const v = await setup(null), stdout = v.context.stdout;
  v.context.stdout = text => { stdout(text); if (text.startsWith("Test Session:")) process.emit("SIGINT", "SIGINT"); };
  await runIndependentController({ provider: "codex", model: null, args: [], prompt: null }, v.context);
  expect(f.spawn).not.toHaveBeenCalled(); expect(v.out.join("")).toContain("archived; no controller process was started");
  expect(v.requests.find(r => r.url.endsWith("/stop"))?.body.stopProof.kind).toBe("never_started");
});

test("an unstarted launch with revoked stop credentials keeps an explicit unarchived identity", async () => {
  const v = await setup(null, true), stdout = v.context.stdout;
  v.context.stdout = text => { stdout(text); if (text.startsWith("Test Session:")) process.emit("SIGINT", "SIGINT"); };
  await runIndependentController({ provider: "codex", model: null, args: [], prompt: null }, v.context);
  expect(f.spawn).not.toHaveBeenCalled();
  expect(v.err.join("")).toContain(`Test Session ${id} remains unarchived. No controller process was started.`);
});
test("a failed spawn never supplies never_started proof or claims known launch outcome", async () => {
  const v = await setup(null);
  f.spawn.mockImplementation(() => { throw new Error("spawn outcome unknown"); });
  await expect(runIndependentController({ provider: "codex", model: null, args: [], prompt: null }, v.context)).rejects.toThrow("spawn outcome unknown");
  expect(v.requests.some(r => r.url.endsWith("/stop"))).toBe(false);
  expect(v.err.join("")).toContain("Controller launch outcome is unconfirmed");
});

test.each([false, true])('resume binds old native context without replay and releases after local stop (archive failure %s)', async archiveFailure => {
  const v = await setup(null, archiveFailure);
  const native = '22222222-2222-4222-8222-222222222222';
  f.resume.mockResolvedValue({ nativeSessionId: native, ticket: { sessionId: native, nativeHome: v.home, configuration: { args: ['--ask-for-approval', 'on-request'] } }, release: f.release });
  await runIndependentController({ provider: 'codex', model: null, args: [], prompt: null, resume: { sessionId: native } }, v.context);
  const launch = (await readdir(path.join(v.home, '.daynight', 'controller', 'launches')))[0]!;
  const ticket = JSON.parse(await readFile(path.join(v.home, '.daynight', 'controller', 'launches', launch), 'utf8'));
  expect(ticket).toMatchObject({ resumeNativeSessionId: native, nativeHome: v.home, initialInput: 'none', initialPrompt: '', configuration: { model: null, args: ['--ask-for-approval', 'on-request'] } });
  expect(f.request.mock.calls.some(([, action]) => action.kind === 'submit_initial')).toBe(false);
  expect(f.release).toHaveBeenCalledOnce();
});
test('resume retains its native lease when complete stop cannot be proved', async () => {
  const v = await setup(null);
  f.resume.mockResolvedValue({ nativeSessionId: id, ticket: { sessionId: id, nativeHome: v.home, configuration: { args: [] } }, release: f.release });
  f.record.mockRejectedValue(new Error('Stop evidence unavailable'));
  await expect(runIndependentController({ provider: 'codex', model: null, args: [], prompt: null, resume: { sessionId: id } }, v.context)).rejects.toThrow('Stop evidence unavailable');
  expect(f.release).not.toHaveBeenCalled();
});

test('cancellation after writing a resume ticket retires its never-started launch before releasing the lease', async () => {
  const v = await setup(null);
  f.resume.mockResolvedValue({ nativeSessionId: id, ticket: { sessionId: id, nativeHome: v.home, configuration: { args: [] } }, release: f.release });
  const stdout = v.context.stdout;
  v.context.stdout = text => { stdout(text); if (text.startsWith('Provider:')) process.emit('SIGINT', 'SIGINT'); };
  await runIndependentController({ provider: 'codex', model: null, args: [], prompt: null, resume: { sessionId: id } }, v.context);
  expect(f.spawn).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
  expect(await readdir(path.join(v.home, '.daynight', 'controller', 'launches'))).toEqual([]);
  const execution = (await readdir(path.join(v.home, '.daynight', 'controller', 'executions')))[0]!;
  const retired = JSON.parse(await readFile(path.join(v.home, '.daynight', 'controller', 'executions', execution, 'unstarted-launch.json'), 'utf8'));
  expect(retired.resumeNativeSessionId).toBe(id);
  expect(v.requests.find(r => r.url.endsWith('/stop'))?.body.stopProof.kind).toBe('never_started');
});
