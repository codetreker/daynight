import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { ControllerIpcFrameLimitError, ControllerIpcIdentityConflictError, encodeControllerLocalRequest, requestController, validateControllerLocalRequest, type ControllerLocalRequest, type WorkerInputAction } from "../../../src/commands/controller/local-client.js";

const servers: Server[] = [], paths: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(paths.splice(0).map(path => unlink(path).catch(() => {})));
});

const ticket = (): ControllerLaunchTicket => ({ schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", claimId: randomUUID(), projectId: randomUUID(), taskId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: process.cwd(), nativeHome: process.cwd(), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "initial", resumeNativeSessionId: null, credentialFile: "grant", ipcEndpoint: "unused", ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() });
const action = (): WorkerInputAction => ({ kind: "submit_worker_input", operationId: randomUUID(), prompt: "hello 😀", deadline: Date.now() + 30_000 });
const request = (t: ControllerLaunchTicket, a: unknown) => ({ requestId: randomUUID(), executionId: t.executionId, claimId: t.claimId, executionGeneration: t.executionGeneration, controllerInstanceId: t.controllerInstanceId, secret: t.ipcSecret, action: a });
const snapshot = (t: ControllerLaunchTicket) => ({ executionId: t.executionId, claimId: t.claimId, executionGeneration: t.executionGeneration, controllerInstanceId: t.controllerInstanceId, sessionId: t.sessionId });

async function listen(t: ControllerLaunchTicket, response: (request: ControllerLocalRequest) => unknown): Promise<ControllerLaunchTicket> {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp");
  const endpoint = process.platform === "win32" ? String.raw`\\.\pipe\daynight-client-${randomUUID()}` : path.relative(process.cwd(), path.join(scratch, `client-${randomUUID()}.sock`));
  if (process.platform !== "win32") { await mkdir(scratch, { recursive: true }); paths.push(endpoint); }
  const server = createServer(socket => {
    let data = ""; socket.setEncoding("utf8");
    socket.on("data", chunk => { data += chunk; if (data.includes("\n")) socket.end(`${JSON.stringify(response(JSON.parse(data)))}\n`); });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  return { ...t, ipcEndpoint: endpoint };
}

test("worker input validates complete identity, fields, Unicode, deadline and both size limits", () => {
  const t = ticket(), a = action(), valid = request(t, a);
  expect(validateControllerLocalRequest(valid, t)).toEqual(valid);
  for (const invalid of [
    { ...a, operationId: "bad" }, { ...a, operationId: a.operationId.toUpperCase() },
    { ...a, prompt: "   " }, { ...a, prompt: "\ud800" }, { ...a, prompt: "x".repeat(4 * 1024 * 1024 + 1) },
    { ...a, deadline: -1 }, { ...a, deadline: 1.5 }, { ...a, extra: true },
  ]) expect(() => validateControllerLocalRequest(request(t, invalid), t)).toThrow();
  const { claimId: _claimId, projectId: _projectId, taskId: _taskId, workerId: _workerId, worktreeId: _worktreeId, userId: _userId, ...common } = t;
  const testTicket = { ...common, testExecutionId: randomUUID(), ownerUserId: randomUUID(), initialInput: "prompt" as const } as ControllerLaunchTicket;
  const { claimId: _unused, ...testRequest } = request(testTicket, a);
  expect(() => validateControllerLocalRequest({ ...testRequest, testExecutionId: testTicket.testExecutionId }, testTicket)).toThrow(/Worker claim/);
  const escaping = request(t, { ...a, prompt: "\u0001".repeat(900_000) });
  expect(() => validateControllerLocalRequest(escaping, t)).toThrow(ControllerIpcFrameLimitError);
  expect(() => encodeControllerLocalRequest(escaping as ControllerLocalRequest)).toThrow(ControllerIpcFrameLimitError);
  expect(() => validateControllerLocalRequest(request(t, { ...a, prompt: "x".repeat(4 * 1024 * 1024) }), t)).not.toThrow();
  const empty = request(t, { ...a, prompt: "" });
  const overhead = Buffer.byteLength(JSON.stringify(empty) + "\n"), escaped = "\u0001".repeat(800_000);
  const exact = { ...a, prompt: escaped + "x".repeat(5 * 1024 * 1024 - overhead - escaped.length * 6) };
  expect(Buffer.byteLength(JSON.stringify(request(t, exact)) + "\n")).toBe(5 * 1024 * 1024);
  expect(() => validateControllerLocalRequest(request(t, exact), t)).not.toThrow();
  expect(() => validateControllerLocalRequest(request(t, { ...exact, prompt: exact.prompt + "x" }), t)).toThrow(ControllerIpcFrameLimitError);
});

test("socket client requires the result and checks operation identity and content", async () => {
  const base = ticket(), a = action(), payload = { content: [{ type: "text", text: a.prompt }], expectedTurnId: null, origin: "daynight" };
  const operation = { operationId: a.operationId, kind: "worker_input", payload, payloadHash: controllerPayloadHash({ kind: "worker_input", payload }), executionGeneration: base.executionGeneration, state: "confirmed", result: { disposition: "started" }, error: null, createdAt: 1, updatedAt: 2 };
  let inputResult: unknown = { kind: "operation", operation };
  const t = await listen(base, req => ({ requestId: req.requestId, ok: true, snapshot: snapshot(base), ...(inputResult === undefined ? {} : { inputResult }) }));
  expect((await requestController(t, a)).inputResult).toEqual(inputResult);
  inputResult = { kind: "waiting", reason: "task_paused" };
  expect((await requestController(t, a)).inputResult).toEqual(inputResult);
  for (const bad of [undefined, { kind: "waiting", reason: "other" }, { kind: "waiting", reason: "working", extra: true }, { kind: "operation", operation: { ...operation, operationId: randomUUID() } }, { kind: "operation", operation: { ...operation, payloadHash: "wrong" } }, { kind: "operation", operation: { ...operation, executionGeneration: "2" } }]) {
    inputResult = bad;
    await expect(requestController(t, a)).rejects.toBeInstanceOf(ControllerIpcIdentityConflictError);
  }
});

test("observe accepts legacy capability absence and rejects unsupported declarations", async () => {
  const base = ticket(); let capability: unknown = undefined;
  const t = await listen(base, req => ({ requestId: req.requestId, ok: true, snapshot: snapshot(base), ...(capability === undefined ? {} : { workerInputProtocol: capability }) }));
  expect((await requestController(t, { kind: "observe" })).workerInputProtocol).toBeUndefined();
  capability = 1; expect((await requestController(t, { kind: "observe" })).workerInputProtocol).toBe(1);
  capability = 2; await expect(requestController(t, { kind: "observe" })).rejects.toBeInstanceOf(ControllerIpcIdentityConflictError);
});

test("observe identifies recovered initial input separately from the legacy Worker input capability", async () => {
  const base = ticket(); let recovery: unknown = undefined;
  const t = await listen(base, req => ({ requestId: req.requestId, ok: true, snapshot: snapshot(base), workerInputProtocol: 1, ...(recovery === undefined ? {} : { recoveredInitialInputProtocol: recovery }) }));
  expect((await requestController(t, { kind: "observe" })).recoveredInitialInputProtocol).toBeUndefined();
  recovery = 1;
  expect((await requestController(t, { kind: "observe" })).recoveredInitialInputProtocol).toBe(1);
  recovery = 2;
  await expect(requestController(t, { kind: "observe" })).rejects.toBeInstanceOf(ControllerIpcIdentityConflictError);
});

test("version two tickets require the persistent lifecycle capability on every successful IPC result", async () => {
  const base = { ...ticket(), schemaVersion: 2 as const }; let capability: unknown;
  const t = await listen(base, req => ({ requestId: req.requestId, ok: true, snapshot: snapshot(base), ...(capability === undefined ? {} : { workerLifecycleProtocol: capability }) }));
  await expect(requestController(t, { kind: "observe" })).rejects.toBeInstanceOf(ControllerIpcIdentityConflictError);
  capability = 2;
  await expect(requestController(t, { kind: "stop", deadline: Date.now() + 1000 })).rejects.toBeInstanceOf(ControllerIpcIdentityConflictError);
  capability = 1;
  expect((await requestController(t, { kind: "observe" })).workerLifecycleProtocol).toBe(1);
});
