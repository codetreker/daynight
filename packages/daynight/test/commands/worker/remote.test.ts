import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../../src/api/json.js";
import * as operations from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import type { Project, Task, WorkerClaim, WorkerClaimDescriptor } from "../../../src/api/types.js";
import { createWorkerRemote } from "../../../src/commands/worker/remote.js";

const uuid = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const projectId = uuid(1), workerId = uuid(2), taskId = uuid(3);
const time = "2026-10-27T00:00:00Z";
const descriptor: WorkerClaimDescriptor = { claimId: uuid(4), workerId, machine: { id: uuid(5), name: "test-machine" }, platform: "linux", agent: "codex", worktreeId: uuid(6) };
const worker: WorkerClaim = { ...descriptor, agentControlMode: descriptor.agentControlMode ?? "herdr", userId: uuid(7), state: "active", phase: "preparing", herdr: null, nativeSessionId: null, signaling: "", claimedAt: time };
const task = (id = taskId, claim: WorkerClaim | null = null, project = projectId): Task => ({
  id, projectId: project, title: "Task", description: "", status: claim?.state === "active" ? "in_progress" : "todo", allowAgents: true,
  requiredPlatform: null, startedAt: claim?.state === "active" ? time : null, completedAt: null, version: 1n,
  properties: { worker: claim, pullRequests: [] }, createdAt: time, updatedAt: time,
  dependsOn: [], externalDependsOn: [], blockedBy: [], ready: claim?.state !== "active",
});
const project = (id = projectId, repoUrl = "https://github.com/example/repo.git"): Project => ({
  id, name: "Repository", repoUrl, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time,
});
const cleanup: (() => void | Promise<void>)[] = [];
const respond = (response: ServerResponse, value: unknown, status = 200): void => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(stringifyApiJson(value));
};
const listen = async (handler: (request: IncomingMessage, response: ServerResponse, body: unknown) => void, options: { userId?: string; identity?: boolean } = {}): Promise<string> => {
  const userId = options.userId === undefined ? worker.userId : options.userId;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("Daynight-User-ID", userId);
    if (request.url === "/api/v1/me" && options.identity !== false) {
      respond(response, { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null });
      return;
    }
    handler(request, response, chunks.length === 0 ? null : parseApiJson(Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
    server.closeAllConnections();
  }));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing worker API fixture address.");
  return `http://127.0.0.1:${address.port}`;
};
const signal = (): AbortSignal => new AbortController().signal;
const verifiedRemote = async (serverUrl: string) => {
  const remote = createWorkerRemote({ serverUrl });
  await remote.currentUserId(signal());
  return remote;
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe("worker remote API", () => {
  it("requires a verified principal before project, inventory or claim requests", async () => {
    let requests = 0;
    const serverUrl = await listen((_request, response) => { requests++; respond(response, { items: [], nextCursor: null }); }, { identity: false });
    const remote = createWorkerRemote({ serverUrl });
    await expect(remote.resolveProject({ repoUrl: project().repoUrl, projectId }, signal())).rejects.toThrow("verify its authenticated user");
    await expect(remote.ownInventory([], workerId, signal())).rejects.toThrow("verify its authenticated user");
    await expect(remote.claim(task(), descriptor, signal())).rejects.toThrow("verify its authenticated user");
    await expect(Array.fromAsync(remote.candidates(projectId, "linux", signal()))).rejects.toThrow("verify its authenticated user");
    expect(requests).toBe(0);
  });

  it("identifies different accounts even when both own inventories are empty", async () => {
    const headers: (string | undefined)[] = [];
    const serverUrl = await listen((request, response) => {
      headers.push(request.headers.authorization);
      const owner = request.headers.authorization === "Bearer test-account-a" ? worker.userId : uuid(80);
      response.setHeader("Daynight-User-ID", owner);
      respond(response, request.url === "/api/v1/me" ? { id: owner, email: null, emailVerified: null, name: null, avatarUrl: null } : { items: [], nextCursor: null });
    }, { identity: false });
    const first = createWorkerRemote({ serverUrl, serverToken: "test-account-a" });
    const second = createWorkerRemote({ serverUrl, serverToken: "test-account-b" });
    await expect(first.currentUserId(signal())).resolves.toBe(worker.userId);
    await expect(second.currentUserId(signal())).resolves.toBe(uuid(80));
    await expect(first.ownInventory([{ projectId }], workerId, signal())).resolves.toEqual([]);
    await expect(second.ownInventory([{ projectId }], workerId, signal())).resolves.toEqual([]);
    expect(headers).toEqual(["Bearer test-account-a", "Bearer test-account-b", "Bearer test-account-a", "Bearer test-account-b"]);
  });

  it.each(["different", "missing", "malformed"])("refuses %s principal provenance on an empty inventory page", async (kind) => {
    const serverUrl = await listen((_request, response) => {
      if (kind === "missing") response.removeHeader("Daynight-User-ID");
      else response.setHeader("Daynight-User-ID", kind === "different" ? uuid(80) : "invalid");
      respond(response, { items: [], nextCursor: null });
    });
    const remote = await verifiedRemote(serverUrl);
    await expect(remote.ownInventory([{ projectId }], workerId, signal())).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    await expect(remote.currentUserId(signal())).resolves.toBe(worker.userId);
  });

  it("does not bind an incomplete identity or send a subsequent ownership request", async () => {
    const urls: string[] = [];
    const serverUrl = await listen((request, response) => { urls.push(request.url!); respond(response, { id: worker.userId }); }, { identity: false });
    const remote = createWorkerRemote({ serverUrl });
    await expect(remote.currentUserId(signal())).rejects.toMatchObject({ operation: "auth.me", phase: "protocol" });
    await expect(remote.ownInventory([{ projectId }], workerId, signal())).rejects.toThrow("verify its authenticated user");
    expect(urls).toEqual(["/api/v1/me"]);
  });

  it("rejects the complete inventory when a later empty page changes principal", async () => {
    const serverUrl = await listen((request, response) => {
      const later = new URL(request.url!, "http://localhost").searchParams.has("cursor");
      if (later) response.setHeader("Daynight-User-ID", uuid(80));
      respond(response, { items: later ? [] : [task(taskId, worker)], nextCursor: later ? null : "next" });
    });
    const remote = await verifiedRemote(serverUrl);
    await expect(remote.ownInventory([{ projectId }], workerId, signal())).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
  });

  it("rejects a mismatched claim owner even when response provenance matches", async () => {
    const serverUrl = await listen((_request, response) => respond(response, { items: [task(taskId, { ...worker, userId: uuid(80) })], nextCursor: null }));
    const remote = await verifiedRemote(serverUrl);
    await expect(remote.ownInventory([{ projectId }], workerId, signal())).rejects.toThrow("different authenticated user");
  });

  it("freezes credentials, caches their verified identity and never forwards a principal assertion", async () => {
    const requests: { authorization: string | undefined; principal: string | string[] | undefined }[] = [];
    let identityQueries = 0;
    const serverUrl = await listen((request, response) => {
      requests.push({ authorization: request.headers.authorization, principal: request.headers["daynight-user-id"] });
      if (request.url === "/api/v1/me") identityQueries++;
      respond(response, request.url === "/api/v1/me" ? { id: worker.userId, email: null, emailVerified: null, name: null, avatarUrl: null } : { items: [], nextCursor: null });
    }, { identity: false });
    const options = { serverUrl, serverToken: "test-account-a" };
    const remote = createWorkerRemote(options);
    await remote.currentUserId(signal());
    options.serverToken = "test-account-b";
    await remote.currentUserId(signal());
    await remote.ownInventory([{ projectId }], workerId, signal());
    expect(identityQueries).toBe(1);
    expect(requests).toEqual([{ authorization: "Bearer test-account-a", principal: undefined }, { authorization: "Bearer test-account-a", principal: undefined }]);
  });

  it("keeps a successful claim with the wrong returned owner uncertain", async () => {
    const serverUrl = await listen((_request, response) => respond(response, { ...task(taskId, { ...worker, userId: uuid(80) }), version: 2n }));
    const remote = await verifiedRemote(serverUrl);
    await expect(remote.claim(task(), descriptor, signal())).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
  });

  it("verifies an explicit project's repository identity", async () => {
    const urls: string[] = [];
    const serverUrl = await listen((request, response) => { urls.push(request.url!); respond(response, project()); });
    const remote = (await verifiedRemote(serverUrl));
    await expect(remote.resolveProject({ repoUrl: "git@github.com:example/repo.git", projectId }, signal())).resolves.toEqual(project());
    await expect(remote.resolveProject({ repoUrl: "https://github.com/example/other", projectId }, signal())).rejects.toThrow("does not match");
    expect(urls).toEqual([`/api/v1/projects/${projectId}`, `/api/v1/projects/${projectId}`]);
  });

  it("discovers by repository identity and rechecks the selected project", async () => {
    const urls: string[] = [];
    const serverUrl = await listen((request, response) => {
      urls.push(request.url!);
      respond(response, request.url!.includes("/projects?") ? { items: [project(uuid(9), "https://github.com/example/other"), project()], nextCursor: null } : project());
    });
    await expect((await verifiedRemote(serverUrl)).resolveProject({ repoUrl: "git@github.com:example/repo" }, signal())).resolves.toEqual(project());
    expect(urls).toEqual(["/api/v1/projects?limit=100", `/api/v1/projects/${projectId}`]);
  });

  it.each(["missing", "ambiguous", "changed"])("rejects %s project discovery", async (kind) => {
    const serverUrl = await listen((request, response) => {
      if (!request.url!.includes("/projects?")) { respond(response, project(projectId, "https://github.com/example/changed")); return; }
      respond(response, { items: kind === "missing" ? [] : kind === "ambiguous" ? [project(), project(uuid(9))] : [project()], nextCursor: null });
    });
    await expect((await verifiedRemote(serverUrl)).resolveProject({ repoUrl: project().repoUrl }, signal())).rejects.toThrow(kind === "missing" ? "does not exist" : kind === "ambiguous" ? "Multiple projects" : "does not match");
  });

  it("reads all union-project inventory pages with ownership filters only and disposes each request", async () => {
    const calls: URL[] = [];
    const opened: Operation[] = [];
    const original = operations.createOperation;
    vi.spyOn(operations, "createOperation").mockImplementation((options) => {
      const operation = original(options); opened.push(operation); return operation;
    });
    const secondProject = uuid(8);
    const serverUrl = await listen((request, response) => {
      const url = new URL(request.url!, "http://localhost"); calls.push(url);
      const second = url.pathname.includes(secondProject);
      const later = url.searchParams.has("cursor");
      const item = { ...task(second ? uuid(9) : later ? uuid(10) : taskId, worker, second ? secondProject : projectId), allowAgents: false, requiredPlatform: "windows" };
      respond(response, { items: [item], nextCursor: second || later ? null : "inventory cursor+/=" });
    });
    const remote = (await verifiedRemote(serverUrl));
    const result = await remote.ownInventory([{ projectId }, { projectId }, { projectId: secondProject }], workerId, signal());
    expect(result.map(({ id }) => id)).toEqual([taskId, uuid(10), uuid(9)]);
    expect(calls.map(({ searchParams }) => Object.fromEntries(searchParams))).toEqual([
      { workerId, limit: "100" }, { workerId, limit: "100", cursor: "inventory cursor+/=" }, { workerId, limit: "100" },
    ]);
    expect(opened).toHaveLength(4);
    expect(new Set(opened).size).toBe(4);
    for (const operation of opened) expect(() => operation.check()).toThrow("disposed");
  });


  it.each(["later failure", "duplicate", "cursor loop", "wrong worker"])("rejects a whole inventory after %s", async (kind) => {
    const serverUrl = await listen((request, response) => {
      const later = new URL(request.url!, "http://localhost").searchParams.has("cursor");
      if (later && kind === "later failure") { respond(response, { error: { code: "internal_error", message: "failed", requestId: "inventory" } }, 500); return; }
      const item = task(later && kind !== "duplicate" ? uuid(8) : taskId, later && kind === "wrong worker" ? { ...worker, workerId: uuid(9) } : worker);
      respond(response, { items: [item], nextCursor: !later || kind === "cursor loop" ? "next" : null });
    });
    await expect((await verifiedRemote(serverUrl)).ownInventory([{ projectId }], workerId, signal())).rejects.toBeInstanceOf(Error);
  });

  it("does not return earlier project inventory when a later project fails", async () => {
    const serverUrl = await listen((request, response) => {
      if (request.url!.includes(uuid(8))) { respond(response, { error: { code: "forbidden", message: "no access", requestId: "later" } }, 403); return; }
      respond(response, { items: [task(taskId, worker)], nextCursor: null });
    });
    await expect((await verifiedRemote(serverUrl)).ownInventory([{ projectId }, { projectId: uuid(8) }], workerId, signal())).rejects.toMatchObject({ status: 403 });
  });

  it("skips released candidates through later pages while preserving service order", async () => {
    const urls: URL[] = [];
    const serverUrl = await listen((request, response) => {
      const url = new URL(request.url!, "http://localhost"); urls.push(url);
      const later = url.searchParams.has("cursor");
      respond(response, { items: later ? [task(uuid(9)), task(uuid(8))] : [task(taskId, { ...worker, state: "released" })], nextCursor: later ? null : "candidate cursor+/=" });
    });
    const result = await Array.fromAsync((await verifiedRemote(serverUrl)).candidates(projectId, "linux", signal()));
    expect(result.map(({ id }) => id)).toEqual([uuid(9), uuid(8)]);
    expect(urls.map(({ searchParams }) => Object.fromEntries(searchParams))).toEqual([
      { ready: "true", allowAgents: "true", compatiblePlatform: "linux", limit: "100" },
      { ready: "true", allowAgents: "true", compatiblePlatform: "linux", limit: "100", cursor: "candidate cursor+/=" },
    ]);
  });

  it("never repeats an uncertain claim and lets the next own inventory observe it", async () => {
    const requests: { method: string; body: unknown }[] = [];
    const serverUrl = await listen((request, response, body) => {
      requests.push({ method: request.method!, body });
      if (request.method === "POST") { request.socket.destroy(); return; }
      respond(response, { items: [task(taskId, worker)], nextCursor: null });
    });
    const remote = (await verifiedRemote(serverUrl));
    await expect(remote.claim(task(), descriptor, signal())).rejects.toMatchObject({ outcomeUnconfirmed: true });
    await expect(remote.ownInventory([{ projectId }], workerId, signal())).resolves.toEqual([task(taskId, worker)]);
    expect(requests).toEqual([{ method: "POST", body: { ...descriptor, version: 1n } }, { method: "GET", body: null }]);
  });

  it("preserves exact-version summary no-ops and does not retry a confirmed refusal", async () => {
    const bodies: unknown[] = [];
    const serverUrl = await listen((_request, response, body) => {
      bodies.push(body);
      if (bodies.length === 1) respond(response, task(taskId, worker));
      else respond(response, { error: { code: "version_conflict", message: "changed", requestId: "update" } }, 409);
    });
    const remote = (await verifiedRemote(serverUrl));
    await expect(remote.update(task(taskId, worker), { phase: "preparing" }, signal())).resolves.toHaveProperty("version", 1n);
    await expect(remote.update(task(taskId, worker), { phase: "waiting" }, signal())).rejects.toMatchObject({ confirmedRefusal: true, outcomeUnconfirmed: false });
    expect(bodies).toEqual([{ version: 1n, claimId: descriptor.claimId, phase: "preparing" }, { version: 1n, claimId: descriptor.claimId, phase: "waiting" }]);
  });

  it("cancels before dispatch and disposes the request operation", async () => {
    let requests = 0;
    const opened: Operation[] = [];
    const original = operations.createOperation;
    vi.spyOn(operations, "createOperation").mockImplementation((options) => {
      const operation = original(options); opened.push(operation); return operation;
    });
    const serverUrl = await listen((_request, response) => { requests++; respond(response, project()); });
    const controller = new AbortController(); controller.abort();
    await expect((await verifiedRemote(serverUrl)).resolveProject({ repoUrl: project().repoUrl, projectId }, controller.signal)).rejects.toMatchObject({ outcomeUnconfirmed: false });
    expect(requests).toBe(0);
    expect(opened).toHaveLength(2);
    expect(() => opened[1]!.check()).toThrow();
    expect(opened[1]!.signal.aborted).toBe(true);
  });

  it("keeps working after the ordinary command's five-minute lifetime has passed", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const serverUrl = await listen((_request, response) => respond(response, project()));
    const remote = (await verifiedRemote(serverUrl));
    await expect(remote.resolveProject({ repoUrl: project().repoUrl, projectId }, signal())).resolves.toEqual(project());
    clock.mockReturnValue(6 * 60_000);
    await expect(remote.resolveProject({ repoUrl: project().repoUrl, projectId }, signal())).resolves.toEqual(project());
  });

  it("does not publish a partial inventory when cancelled between pages", async () => {
    let requests = 0;
    const controller = new AbortController();
    const serverUrl = await listen((_request, response) => {
      requests++;
      respond(response, { items: [task(taskId, worker)], nextCursor: "next" });
    });
    const original = operations.createOperation;
    let operationsOpened = 0;
    vi.spyOn(operations, "createOperation").mockImplementation((options) => {
      if (++operationsOpened === 3) controller.abort();
      return original(options);
    });
    await expect((await verifiedRemote(serverUrl)).ownInventory([{ projectId }], workerId, controller.signal)).rejects.toMatchObject({ outcomeUnconfirmed: false });
    expect(requests).toBe(1);
  });
});
