import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const f = vi.hoisted(() => ({ spawn: vi.fn(), request: vi.fn(), stop: vi.fn(), record: vi.fn(), snapshot: vi.fn(), capture: vi.fn(), archive: vi.fn(), resume: vi.fn(), release: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: f.spawn }));
vi.mock("../../../src/config/server.js", async original => ({ ...await original<typeof import("../../../src/config/server.js")>(), loadServerConfiguration: async () => ({ serverUrl: "https://daynight.example", serverToken: "private-token" }) }));
vi.mock("../../../src/commands/controller/local-client.js", async original => ({ ...await original<typeof import("../../../src/commands/controller/local-client.js")>(), requestController: f.request }));
vi.mock("../../../src/commands/controller/lifecycle-store.js", () => ({ readControllerSnapshot: f.snapshot, recordStoppedControllerGeneration: f.record }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureProcessProof: f.capture, stopControllerProcesses: f.stop }));
vi.mock("../../../src/commands/controller/archive-upload.js", () => ({ uploadStoppedControllerArchive: f.archive }));
vi.mock("../../../src/commands/controller/resume.js", () => ({ acquireResume: f.resume }));
import { runIndependentController } from "../../../src/commands/controller/independent.js";
import { SESSION_PROTOCOL } from "../../../src/session/protocol.js";
import type { CliContext } from "../../../src/cli/context.js";
const id = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
beforeEach(() => vi.clearAllMocks());
const setup = async (prompt: string | null, archiveFailure = false) => {
  // Keep the native socket below the platform limit even inside a task worktree.
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(`${base}${path.sep}`); roots.push(home);
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
    if (url.endsWith("/archive")) return Response.json({ archive: { state: "pending", sha256: null, byteLength: null, errorCode: null } });
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
  f.archive.mockResolvedValue({ state: "ready" });
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
  await expect(runIndependentController({ provider: "codex", model: null, args: [], prompt: null }, v.context)).rejects.toThrow("connection failed");
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

const renewalSetup = async (failure: number | "reset" | "timeout" | "body-reset", failures = 1, clockStep = 1_000) => {
  const v = await setup("initial exactly once");
  let clock = Date.now(), renewals = 0, restored = false, stopped = false;
  const attempts: number[] = [];
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const fetch = vi.mocked(globalThis.fetch), originalFetch = fetch.getMockImplementation()!;
  const originalIpc = f.request.getMockImplementation()!;
  fetch.mockImplementation(async (...args) => {
    if (!String(args[0]).endsWith("controller-grant")) return originalFetch(...args);
    const requestNumber = v.requests.filter(request => request.url.endsWith("controller-grant")).length;
    if (requestNumber >= 2) {
      attempts.push(clock); renewals++;
      if (renewals <= failures) {
        if (failure === "reset") throw new TypeError("fetch failed: connection reset");
        if (failure === "timeout") throw new DOMException("Request timed out", "TimeoutError");
        if (failure === "body-reset") return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("body connection reset")); } }));
        return new Response("Service unavailable", { status: failure });
      }
      restored = true;
    }
    const response = await originalFetch(...args), body = await response.json() as Record<string, unknown>;
    return Response.json({ ...body, expiresAt: new Date(clock + (requestNumber === 1 ? 1_000 : 900_000)).toISOString() });
  });
  f.request.mockImplementation(async (...args) => {
    const action = args[1];
    if (action.kind === "observe") {
      clock += clockStep;
      if (restored) {
        expect(f.spawn).toHaveBeenCalledOnce(); expect(f.stop).not.toHaveBeenCalled();
        expect(v.child.exitCode).toBeNull(); process.emit("SIGINT", "SIGINT"); stopped = true;
      }
      return { snapshot: { lifecycle: "ready", nativeSessionId: "original-native" } };
    }
    if (action.kind === "submit_initial") return { snapshot: {}, operation: { state: "confirmed" } };
    return originalIpc(...args);
  });
  return { ...v, attempts, wasRestored: () => restored, requestedStop: () => stopped };
};

test.each([503, 429, 408, "reset", "timeout", "body-reset"] as const)("keeps the original native session and input across transient grant renewal failure %s", async failure => {
  const v = await renewalSetup(failure);
  await runIndependentController({ provider: "codex", model: null, args: [], prompt: "initial exactly once" }, v.context);
  expect(v.wasRestored()).toBe(true); expect(v.requestedStop()).toBe(true);
  expect(v.attempts).toHaveLength(2); expect(v.attempts[1]! - v.attempts[0]!).toBeGreaterThanOrEqual(1_000);
  expect(f.spawn).toHaveBeenCalledOnce(); expect(f.request.mock.calls.filter(([, action]) => action.kind === "submit_initial")).toHaveLength(1);
  expect(v.requests.filter(request => request.url.endsWith("/test-sessions"))).toHaveLength(1);
  expect(v.err.join("")).toContain("retry"); expect(v.err.join("")).not.toContain("private-token");
});

test.each([401, 403])("stops the original native session on definitive renewal rejection HTTP %s", async status => {
  const v = await renewalSetup(status);
  await expect(runIndependentController({ provider: "codex", model: null, args: [], prompt: "initial exactly once" }, v.context)).rejects.toThrow(`HTTP ${status}`);
  expect(v.attempts).toHaveLength(1); expect(f.stop).toHaveBeenCalledOnce(); expect(v.wasRestored()).toBe(false);
});

test("keeps retrying beyond expired local credentials with bounded backoff and no new execution", async () => {
  const v = await renewalSetup(503, 8, 30_000);
  await runIndependentController({ provider: "codex", model: null, args: [], prompt: "initial exactly once" }, v.context);
  expect(v.wasRestored()).toBe(true); expect(v.attempts).toHaveLength(9);
  expect(v.attempts.at(-1)! - v.attempts[0]!).toBeGreaterThanOrEqual(240_000);
  const diagnostics = v.err.join("");
  expect(diagnostics).toContain("retry in 1s"); expect(diagnostics).toContain("retry in 30s"); expect(diagnostics).not.toContain("retry in 60s");
  expect(f.spawn).toHaveBeenCalledOnce(); expect(f.request.mock.calls.filter(([, action]) => action.kind === "submit_initial")).toHaveLength(1);
  expect(v.requests.filter(request => request.url.endsWith("/test-sessions"))).toHaveLength(1);
});

test("Ctrl+C aborts a pending renewal request and stops without waiting for its network timeout", async () => {
  const v = await renewalSetup(503), fetch = vi.mocked(globalThis.fetch), original = fetch.getMockImplementation()!;
  let renewalAborted = false;
  fetch.mockImplementation(async (...args) => {
    if (String(args[0]).endsWith("controller-grant") && v.requests.filter(request => request.url.endsWith("controller-grant")).length >= 2) {
      const signal = args[1]!.signal!;
      const pending = new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => { renewalAborted = true; reject(signal.reason); }, { once: true }));
      queueMicrotask(() => process.emit("SIGINT", "SIGINT"));
      return pending;
    }
    return original(...args);
  });
  await runIndependentController({ provider: "codex", model: null, args: [], prompt: "initial exactly once" }, v.context);
  expect(renewalAborted).toBe(true); expect(f.stop).toHaveBeenCalledOnce(); expect(f.spawn).toHaveBeenCalledOnce();
});

test("a definitive authorization response is not retried when its error body fails", async () => {
  const v = await renewalSetup(401), fetch = vi.mocked(globalThis.fetch), original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (...args) => String(args[0]).endsWith("controller-grant") && v.requests.filter(request => request.url.endsWith("controller-grant")).length >= 2
    ? new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("error body interrupted")); } }), { status: 401 }) : original(...args));
  await expect(runIndependentController({ provider: "codex", model: null, args: [], prompt: "initial exactly once" }, v.context)).rejects.toThrow("HTTP 401");
  expect(f.stop).toHaveBeenCalledOnce();
  expect(v.err.join("")).not.toContain("retry in");
});


test.each(["confirmed", "failed"] as const)("an initial IPC transport loss reconciles %s without replaying input", async finalState => {
  const v = await setup("initial exactly once");
  const { requestController: realRequest } = await vi.importActual<typeof import("../../../src/commands/controller/local-client.js")>("../../../src/commands/controller/local-client.js");
  const { createServer } = await import("node:net");
  const endpoint = process.platform === "win32" ? String.raw`\\.\pipe\daynight-loss-test-${randomUUID()}` : path.join(v.home, "loss.sock");
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {}); socket.once("data", () => socket.end());
  });
  let attempted = false, observations = 0;
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (ticket, action, options) => {
    if (action.kind === "submit_initial") { attempted = true; return realRequest({ ...ticket, ipcEndpoint: endpoint }, action, options); }
    if (action.kind === "observe") {
      if (attempted) {
        expect(f.stop).not.toHaveBeenCalled(); expect(v.child.exitCode).toBeNull();
        observations++;
        if (observations === 1) return realRequest({ ...ticket, ipcEndpoint: endpoint }, action, options);
        if (observations === (finalState === "failed" ? 4 : 3)) process.emit("SIGINT", "SIGINT");
      }
      // A stale snapshot is not evidence that the input was never submitted.
      return { snapshot: { lifecycle: "ready", initialInputState: observations > 2 ? finalState : "not_submitted", nativeSessionId: "same-native" } };
    }
    return original(ticket, action, options);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => { server.off("error", reject); resolve(); });
    });
    const running = runIndependentController({ provider: "codex", model: null, args: [], prompt: "initial exactly once" }, v.context);
    if (finalState === "failed") await expect(running).rejects.toThrow("Initial input failed; the same operation remains recorded.");
    else await running;
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
  expect(observations).toBe(3);
  expect(f.request.mock.calls.filter(([, action]) => action.kind === "submit_initial")).toHaveLength(1);
  expect(f.spawn).toHaveBeenCalledOnce(); expect(f.stop).toHaveBeenCalledOnce();
  expect(v.err.join("")).toContain("unknown");
  expect(v.err.join("")).toContain("observation recovered");
});

test("a definitive initial IPC rejection still stops its supervised controller", async () => {
  const v = await setup("initial once"), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (ticket, action, options) => action.kind === "submit_initial" ? Promise.reject(new Error("Controller IPC authentication or identity mismatch.")) : original(ticket, action, options));
  await expect(runIndependentController({ provider: "codex", model: null, args: [], prompt: "initial once" }, v.context)).rejects.toThrow("authentication");
  expect(f.stop).toHaveBeenCalledOnce();
});

test.each(["lost-response", "unknown-receipt"] as const)("reconciles terminal initial failure after %s and preserves all nonterminal or successful states", async outcome => {
  const { ControllerIpcOutcomeUnknownError } = await vi.importActual<typeof import("../../../src/commands/controller/local-client.js")>("../../../src/commands/controller/local-client.js");
  for (const state of ["failed", "not_submitted", "dispatching", "unknown", "provider_accepted", "confirmed"] as const) {
    vi.clearAllMocks();
    const v = await setup("one initial operation"), original = f.request.getMockImplementation()!;
    let attempted = false, observations = 0;
    f.request.mockImplementation(async (ticket, action, options) => {
      if (action.kind === "submit_initial") {
        attempted = true;
        if (outcome === "lost-response") throw new ControllerIpcOutcomeUnknownError("Controller IPC outcome is unknown after its deadline.");
        return { snapshot: {}, operation: { state: "unknown" } };
      }
      if (action.kind === "observe") {
        if (attempted) {
          expect(f.stop).not.toHaveBeenCalled(); expect(v.child.exitCode).toBeNull();
          observations++;
          // Bound the failing pre-fix case without waiting for a test timeout.
          if (observations === 2) process.emit("SIGINT", "SIGINT");
        }
        return { snapshot: { lifecycle: "ready", initialInputState: attempted ? state : "not_submitted", nativeSessionId: "same-native" } };
      }
      return original(ticket, action, options);
    });
    const running = runIndependentController({ provider: "codex", model: null, args: [], prompt: "one initial operation" }, v.context);
    if (state === "failed") {
      await expect(running).rejects.toThrow("Initial input failed; the same operation remains recorded.");
      expect(observations).toBe(1);
    } else {
      await expect(running).resolves.toBeUndefined();
      expect(observations).toBe(2);
    }
    expect(f.request.mock.calls.filter(([, action]) => action.kind === "submit_initial")).toHaveLength(1);
    expect(f.spawn).toHaveBeenCalledOnce(); expect(f.stop).toHaveBeenCalledOnce(); expect(f.record).toHaveBeenCalledOnce();
  }
});


test("history upload failure reports stopped execution and a native-free retry command", async () => {
  const v = await setup(null);
  f.archive.mockRejectedValueOnce(new Error("network unavailable"));
  await runIndependentController({ provider: "codex", model: null, args: [], prompt: null }, v.context);
  expect(f.stop).toHaveBeenCalledOnce(); expect(f.record).toHaveBeenCalledOnce();
  expect(f.archive).toHaveBeenCalledOnce();
  expect(v.err.join("")).toContain("Native execution stopped; session history upload is pending");
  expect(v.err.join("")).toContain(`daynight controller codex archive ${id}`);
  expect(v.err.join("")).not.toContain("stop could not be fully confirmed");
  expect(v.out.join("")).not.toContain("stopped and archived");
  const call = f.archive.mock.calls[0]![0];
  expect(call.serverToken).toBe("private-token");
  expect(call.signal).toBeUndefined();
});
test("unconfirmed server stop never publishes completed content", async () => {
  const v = await setup(null, true);
  await runIndependentController({ provider: "codex", model: null, args: [], prompt: null }, v.context);
  expect(f.archive).not.toHaveBeenCalled();
  expect(v.err.join("")).toContain(`daynight controller codex archive ${id}`);
});

test("archive-only retry reuses saved stop proof without starting a process or requiring the old directory", async () => {
  const v = await setup(null);
  f.archive.mockRejectedValueOnce(new Error("offline"));
  await runIndependentController({ provider: "codex", model: null, args: [], prompt: null }, v.context);
  const oldProof = v.requests.find(request => request.url.endsWith("/stop"))!.body;
  const { retryIndependentArchive } = await import("../../../src/commands/controller/independent-archive.js");
  v.context.workingDirectory = () => { throw new Error("Old worktree no longer exists"); };
  await retryIndependentArchive({ provider: "codex", sessionId: id }, v.context);
  expect(f.spawn).toHaveBeenCalledOnce();
  expect(f.archive).toHaveBeenCalledTimes(2);
  expect(v.requests.filter(request => request.url.endsWith("/stop")).map(request => request.body)).toEqual([oldProof, oldProof]);
  expect(v.out.join("")).toContain(`Test Session history archived: https://daynight.example/test-sessions/${id}`);
});

test("publishes pending history only after native stop and before closing the server session", async () => {
  const v = await setup(null), fetch = vi.mocked(globalThis.fetch), original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (...args) => {
    if (String(args[0]).endsWith("/archive")) {
      expect(f.record).toHaveBeenCalledOnce();
      expect(v.requests.some(request => request.url.endsWith("/stop"))).toBe(false);
    }
    return original(...args);
  });
  await runIndependentController({ provider: "codex", model: null, args: [], prompt: null }, v.context);
  const requests = v.requests.filter(request => /\/(archive|stop)$/.test(request.url));
  expect(requests.map(request => request.url.split("/").at(-1))).toEqual(["archive", "stop"]);
  const stopped = requests[1]!.body;
  expect(requests[0]!.body).toEqual({ sessionId: stopped.sessionId, testExecutionId: stopped.testExecutionId, executionGeneration: stopped.executionGeneration, controllerId: stopped.controllerId, controllerInstanceId: stopped.controllerInstanceId, state: "pending", errorCode: null });
});
test.each(["http", "network"])("pending metadata %s failure cannot block server stop or history upload", async failure => {
  const v = await setup(null), fetch = vi.mocked(globalThis.fetch), original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (...args) => {
    if (String(args[0]).endsWith("/archive")) {
      if (failure === "network") throw new Error("offline");
      return new Response(null, { status: 503 });
    }
    return original(...args);
  });
  await runIndependentController({ provider: "codex", model: null, args: [], prompt: null }, v.context);
  expect(v.requests.some(request => request.url.endsWith("/stop"))).toBe(true);
  expect(f.archive).toHaveBeenCalledOnce();
  expect(v.out.join("")).toContain("stopped and archived");
});
test("never-started sessions do not announce a pending history archive", async () => {
  const v = await setup(null), stdout = v.context.stdout;
  v.context.stdout = text => { stdout(text); if (text.startsWith("Test Session:")) process.emit("SIGINT", "SIGINT"); };
  await runIndependentController({ provider: "codex", model: null, args: [], prompt: null }, v.context);
  expect(v.requests.some(request => request.url.endsWith("/archive"))).toBe(false);
  expect(f.archive).not.toHaveBeenCalled();
});
test("archive-only retry marks pending before stop and tolerates metadata publication failure", async () => {
  const v = await setup(null);
  await runIndependentController({ provider: "codex", model: null, args: [], prompt: null }, v.context);
  const { retryIndependentArchive } = await import("../../../src/commands/controller/independent-archive.js");
  const fetch = vi.mocked(globalThis.fetch), original = fetch.getMockImplementation()!, order: string[] = [];
  fetch.mockImplementation(async (...args) => {
    const url = String(args[0]);
    if (url.endsWith("/archive")) {
      expect(f.record).toHaveBeenCalledTimes(2);
      order.push("pending"); throw new Error("offline");
    }
    if (url.endsWith("/stop")) order.push("stop");
    return original(...args);
  });
  await retryIndependentArchive({ provider: "codex", sessionId: id }, v.context);
  expect(order).toEqual(["pending", "stop"]);
  expect(f.archive).toHaveBeenCalledTimes(2);
  expect(f.spawn).toHaveBeenCalledOnce();
});
