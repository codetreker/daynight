import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../../src/api/json.js";
import * as operations from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import type { Project, Task, WorkerClaim, WorkerClaimDescriptor } from "../../../src/api/types.js";
import { createWorkerRemote } from "../../../src/commands/worker/remote.js";
import { workerTelemetry, workerTelemetryTime } from "../../fixtures/worker-telemetry.js";

const uuid = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const projectId = uuid(1), workerId = uuid(2), taskId = uuid(3);
const time = "2026-10-27T00:00:00Z";
const descriptor: WorkerClaimDescriptor = { claimId: uuid(4), workerId, machine: { id: uuid(5), name: "test-machine" }, platform: "linux", agent: "codex", worktreeId: uuid(6) };
const worker: WorkerClaim = { ...descriptor, agentControlMode: descriptor.agentControlMode ?? "herdr", userId: uuid(7), state: "active", phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: time };
const task = (id = taskId, claim: WorkerClaim | undefined = undefined, project = projectId): Task => ({ type: "task", parentId: null,
  id, projectId: project, title: "Task", description: "", tags: [], status: claim?.state === "active" ? "in_progress" : "todo", allowAgents: true,
  assignedTo: null, requiredPlatform: null, startedAt: claim?.state === "active" ? time : null, completedAt: null, cancelledAt: null, version: 1n,
  properties: { ...(claim === undefined ? {} : { worker: claim }), pullRequests: [] }, createdAt: time, updatedAt: time,
  dependsOn: [], externalDependsOn: [], blockedBy: [], ready: claim?.state !== "active",
});
const project = (id = projectId, repoUrl = "https://github.com/example/repo.git"): Project => ({
  id, name: "Repository", repoUrl, settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: time, updatedAt: time,
});
const accessSources = { projectId, ownerTeam: { id: uuid(90), kind: "ordinary", name: "Team" }, ownership: { teamId: uuid(90), version: 9_007_199_254_740_995n }, teamRole: null, canTransfer: false };
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
      respond(response, { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "personal" as const, name: null } });
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
  it("publishes a failed native startup for the observed claim with authenticated HTTP and reads it back", async () => {
    const token = "fixture-startup-token";
    const report = { schemaVersion: 1 as const, source: "worker" as const, sessionId: uuid(30), claimId: descriptor.claimId,
      executionGeneration: "1", controllerInstanceId: uuid(31), revision: "1", observedAt: time,
      startup: { state: "failed" as const, reasonCode: "native_rejected" as const },
      recovery: { state: "blocked" as const, reasonCode: "native_identity_missing" as const } };
    const initial = task(taskId, { ...worker, agentControlMode: "web" });
    const updated = { ...initial, version: 2n, properties: { ...initial.properties, worker: { ...worker, agentControlMode: "web" as const, phase: "waiting" as const, herdr: null, nativeSessionId: null }, sessionStartup: report } };
    const requests: { method: string | undefined; url: string | undefined; authorization: string | undefined; protocol: string | string[] | undefined; body: unknown }[] = [];
    let saved = false;
    const serverUrl = await listen((request, response, body) => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, protocol: request.headers["daynight-worker-protocol"], body });
      if (request.url === "/api/v1/me") respond(response, { id: worker.userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: uuid(90), kind: "personal", name: null } });
      else if (request.method === "PATCH") { saved = true; respond(response, updated); }
      else respond(response, saved ? updated : initial);
    }, { identity: false });
    const remote = createWorkerRemote({ serverUrl, serverToken: token });
    expect(await remote.currentUserId(signal())).toBe(worker.userId);
    const observed = await remote.readTask(projectId, taskId, signal());
    await expect(remote.update(observed, { phase: "waiting", nativeSessionId: null, herdr: null, startupReport: report }, signal())).resolves.toEqual(updated);
    await expect(remote.readTask(projectId, taskId, signal())).resolves.toEqual(updated);
    const taskPath = `/api/v1/projects/${projectId}/tasks/${taskId}`;
    expect(requests.map(({ method, url }) => [method, url])).toEqual([["GET", "/api/v1/me"], ["GET", taskPath], ["PATCH", `${taskPath}/worker-claim`], ["GET", taskPath]]);
    expect(requests.every(({ authorization }) => authorization === `Bearer ${token}`)).toBe(true);
    expect(requests.slice(1).map(({ protocol }) => protocol)).toEqual(["2", "2", "2"]);
    expect(requests[2]!.body).toEqual({ version: 1n, claimId: descriptor.claimId, phase: "waiting", nativeSessionId: null, herdr: null, startupReport: report });
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it("exchanges configuration through the authenticated single report operation without affecting legacy reports", async () => {
    const requests: { method: string | undefined; url: string | undefined; capability: string | undefined; body: unknown }[] = [];
    const value = { maxConcurrent: 2, pollIntervalMs: 60_000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex" as const, model: null, args: [] }, projects: [] };
    const desired = { revision: "1", updatedAt: time, value };
    const configuration = { bootstrap: value, observation: null };
    const receipt = { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime };
    const serverUrl = await listen((request, response, body) => {
      const capability = request.headers["daynight-worker-configuration"] as string | undefined;
      requests.push({ method: request.method, url: request.url, capability, body });
      if (capability !== undefined) response.setHeader("Daynight-Worker-Configuration", "1");
      respond(response, request.method === "GET" ? { desired, observationRevision: "0", observation: null }
        : capability === "1" ? { ...receipt, configuration: { desired, observationRevision: "0", observationAccepted: false } } : receipt);
    });
    const remote = await verifiedRemote(serverUrl), operation = operations.createOperation();
    try {
      await expect(remote.configuration(workerId, signal())).resolves.toMatchObject({ desired });
      const opened = vi.spyOn(operations, "createOperation");
      await expect(remote.reportConfiguration(workerId, { ...workerTelemetry, taskInventory: null }, configuration, operation)).resolves.toMatchObject({ configuration: { desired } });
      await remote.report(workerId, { ...workerTelemetry, taskInventory: null }, operation);
      expect(opened).not.toHaveBeenCalled();
      expect(requests.map(({ method, capability }) => ({ method, capability }))).toEqual([{ method: "GET", capability: "1" }, { method: "POST", capability: "1" }, { method: "POST", capability: undefined }]);
      expect(requests[1]!.body).toMatchObject({ configuration, taskInventory: null });
      expect(requests[2]!.body).not.toHaveProperty("configuration");
    } finally { operation.dispose(); }
  });

  it("enables tool bootstrap only after authenticated configuration rediscovery on a mode-capable server", async () => {
    const requests: { method: string | undefined; url: string | undefined; authorization: string | undefined; mode: string | string[] | undefined; tools: string | string[] | undefined; body: unknown }[] = [];
    const value = { maxConcurrent: 2, pollIntervalMs: 60_000, recoveryLimit: 3, preferPlatformSpecificTasks: false, agentControlMode: "web" as const, native: { agent: "codex" as const, model: null, args: [] }, projects: [] };
    const tools = { codex: { kind: "path" as const, path: "/opt/codex" }, copilot: { kind: "auto" as const }, herdr: { kind: "auto" as const } };
    const configuration = { bootstrap: null, observation: null, controlModeBootstrap: "web" as const, toolPathsBootstrap: tools };
    let upgraded = false;
    const serverUrl = await listen((request, response, body) => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, mode: request.headers["daynight-worker-control-mode"], tools: request.headers["daynight-worker-tool-paths"], body });
      const selected = upgraded && request.headers["daynight-worker-tool-paths"] === "1";
      response.setHeader("Daynight-Worker-Configuration", "1");
      response.setHeader("Daynight-Worker-Control-Mode", "1");
      if (selected) response.setHeader("Daynight-Worker-Tool-Paths", "1");
      const desired = { revision: "1", updatedAt: time, value: { ...value, ...(selected ? { toolPaths: { codex: null, copilot: null, herdr: null } } : {}) } };
      respond(response, request.method === "GET" ? { desired, observationRevision: "0", observation: null }
        : { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired, observationRevision: "0", observationAccepted: false } });
    });
    const token = "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", remote = createWorkerRemote({ serverUrl, serverToken: token });
    await remote.currentUserId(signal());
    const operation = operations.createOperation();
    try {
      await remote.configuration(workerId, signal());
      upgraded = true;
      await remote.reportConfiguration(workerId, { ...workerTelemetry, taskInventory: null }, configuration, operation);
      await remote.configuration(workerId, operation.signal, operation);
      await remote.reportConfiguration(workerId, { ...workerTelemetry, taskInventory: null }, configuration, operation);
      expect(requests.map(({ method, mode, tools }) => ({ method, mode, tools }))).toEqual([
        { method: "GET", mode: "1", tools: "1" }, { method: "POST", mode: "1", tools: undefined },
        { method: "GET", mode: "1", tools: "1" }, { method: "POST", mode: "1", tools: "1" },
      ]);
      expect(requests.every(({ authorization }) => authorization === `Bearer ${token}`)).toBe(true);
      expect(requests.map(({ url }) => url)).toEqual(["configuration", "report", "configuration", "report"].map(suffix => `/api/v1/me/workers/${workerId}/${suffix}`));
      expect(requests[1]!.body).toMatchObject({ configuration: { bootstrap: null, observation: null, controlModeBootstrap: "web" } });
      expect(requests[1]!.body).not.toHaveProperty("configuration.toolPathsBootstrap");
      expect(requests[3]!.body).toMatchObject({ configuration });
    } finally { operation.dispose(); }
  });

  it("reports through the caller operation with verified identity and a 200 receipt", async () => {
    const requests: { method: string | undefined; url: string | undefined; body: unknown }[] = [];
    const receipt = { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime };
    const body = { ...workerTelemetry, taskInventory: null };
    const serverUrl = await listen((request, response, input) => {
      requests.push({ method: request.method, url: request.url, body: input }); respond(response, receipt);
    });
    const remote = await verifiedRemote(serverUrl);
    const operation = operations.createOperation({ limits: { totalMs: 15_000, requestMs: 10_000 } });
    const opened = vi.spyOn(operations, "createOperation");
    try {
      await expect(remote.report(workerId, body, operation)).resolves.toEqual(receipt);
      expect(opened).not.toHaveBeenCalled(); expect(() => operation.check()).not.toThrow();
      expect(requests).toEqual([{ method: "POST", url: `/api/v1/me/workers/${workerId}/report`, body }]);
    } finally { operation.dispose(); }
  });

  it("requires report identity and respects caller cancellation before dispatch", async () => {
    let requests = 0;
    const serverUrl = await listen((_request, response) => { requests++; respond(response, {}); });
    const remote = createWorkerRemote({ serverUrl });
    const operation = operations.createOperation();
    const body = { ...workerTelemetry, taskInventory: null };
    try {
      expect(() => remote.report(workerId, body, operation)).toThrow("verify its authenticated user");
      await remote.currentUserId(signal()); operation.dispose();
      expect(() => remote.report(workerId, body, operation)).toThrow("disposed");
      expect(requests).toBe(0);
    } finally { operation.dispose(); }
  });

  it("refuses changed report provenance and never replays an unconfirmed report", async () => {
    let requests = 0;
    const serverUrl = await listen((_request, response) => {
      requests++; response.setHeader("Daynight-User-ID", uuid(80));
      respond(response, { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime });
    });
    const remote = await verifiedRemote(serverUrl), operation = operations.createOperation();
    try {
      await expect(remote.report(workerId, { ...workerTelemetry, taskInventory: null }, operation)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
      expect(requests).toBe(1);
    } finally { operation.dispose(); }
  });

  it("requires a verified principal before project, inventory or claim requests", async () => {
    let requests = 0;
    const serverUrl = await listen((_request, response) => { requests++; respond(response, { items: [], nextCursor: null }); }, { identity: false });
    const remote = createWorkerRemote({ serverUrl });
    await expect(remote.resolveProject({ repoUrl: project().repoUrl, projectId }, signal())).rejects.toThrow("verify its authenticated user");
    await expect(remote.ownInventory([], workerId, signal())).rejects.toThrow("verify its authenticated user");
    await expect(remote.claim(task(), descriptor, signal())).rejects.toThrow("verify its authenticated user");
    await expect(remote.authorizeControl(projectId, worker.userId, signal())).rejects.toThrow("verify its authenticated user");
    await expect(Array.fromAsync(remote.candidates(projectId, "linux", signal()))).rejects.toThrow("verify its authenticated user");
    expect(requests).toBe(0);
  });

  it.each([
    { role: "member", originalUserId: worker.userId },
    { role: "admin", originalUserId: uuid(80) },
  ])("authorizes the current $role actor against project access for original owner $originalUserId", async ({ role, originalUserId }) => {
    const requests: string[] = [];
    const serverUrl = await listen((request, response) => {
      requests.push(request.url!);
      respond(response, { ...accessSources, effectiveRole: role, directGrant: {
        projectId, userId: worker.userId, role, version: 9_007_199_254_740_993n, createdAt: time, updatedAt: time,
      } });
    });
    const remote = await verifiedRemote(serverUrl);
    await expect(remote.authorizeControl(projectId, originalUserId, signal())).resolves.toBeUndefined();
    expect(requests).toEqual([`/api/v1/projects/${projectId}/access`]);
  });

  it("denies another execution's member operator using the effective access role", async () => {
    const requests: string[] = [];
    const serverUrl = await listen((request, response) => {
      requests.push(request.url!);
      respond(response, { ...accessSources, effectiveRole: "member", directGrant: {
        projectId, userId: worker.userId, role: "member", version: 1n, createdAt: time, updatedAt: time,
      } });
    });
    const remote = await verifiedRemote(serverUrl);
    await expect(remote.authorizeControl(projectId, uuid(80), signal())).rejects.toThrow("original owner or a current project administrator");
    expect(requests).toEqual([`/api/v1/projects/${projectId}/access`]);
  });

  it("requires current project access even for the original execution owner", async () => {
    let requests = 0;
    const serverUrl = await listen((_request, response) => {
      requests++;
      respond(response, { error: { code: "not_found", message: "No current project access.", requestId: "operator-access" } }, 404);
    });
    const remote = await verifiedRemote(serverUrl);
    await expect(remote.authorizeControl(projectId, worker.userId, signal())).rejects.toMatchObject({ operation: "project.access", status: 404 });
    expect(requests).toBe(1);
  });

  it("rejects an operator access response from a changed authenticated account", async () => {
    let requests = 0;
    const serverUrl = await listen((_request, response) => {
      requests++;
      response.setHeader("Daynight-User-ID", uuid(80));
      respond(response, { ...accessSources, effectiveRole: "admin", directGrant: null });
    });
    const remote = await verifiedRemote(serverUrl);
    await expect(remote.authorizeControl(projectId, uuid(80), signal())).rejects.toMatchObject({ operation: "project.access", phase: "protocol", outcomeUnconfirmed: false });
    expect(requests).toBe(1);
  });

  it("identifies different accounts even when both own inventories are empty", async () => {
    const headers: (string | undefined)[] = [];
    const serverUrl = await listen((request, response) => {
      headers.push(request.headers.authorization);
      const owner = request.headers.authorization === "Bearer test-account-a" ? worker.userId : uuid(80);
      response.setHeader("Daynight-User-ID", owner);
      respond(response, request.url === "/api/v1/me" ? { id: owner, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "personal" as const, name: null } } : { items: [], nextCursor: null });
    }, { identity: false });
    const first = createWorkerRemote({ serverUrl, serverToken: "test-account-a" });
    const second = createWorkerRemote({ serverUrl, serverToken: "test-account-b" });
    await expect(first.currentUserId(signal())).resolves.toBe(worker.userId);
    await expect(second.currentUserId(signal())).resolves.toBe(uuid(80));
    await expect(first.ownInventory([{ projectId }], workerId, signal())).resolves.toEqual({ tasks: [], coveredProjectIds: [projectId], unavailableProjectIds: [] });
    await expect(second.ownInventory([{ projectId }], workerId, signal())).resolves.toEqual({ tasks: [], coveredProjectIds: [projectId], unavailableProjectIds: [] });
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
      respond(response, request.url === "/api/v1/me" ? { id: worker.userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "personal" as const, name: null } } : { items: [], nextCursor: null });
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
      const item = { ...task(second ? uuid(9) : later ? uuid(10) : taskId, worker, second ? secondProject : projectId), allowAgents: false, requiredPlatform: "windows", assignedTo: later ? null : uuid(80) };
      respond(response, { items: [item], nextCursor: second || later ? null : "inventory cursor+/=" });
    });
    const remote = (await verifiedRemote(serverUrl));
    const result = await remote.ownInventory([{ projectId }, { projectId }, { projectId: secondProject }], workerId, signal());
    expect(result.tasks.map(({ id }) => id)).toEqual([taskId, uuid(10), uuid(9)]);
    expect(result.coveredProjectIds).toEqual([projectId, secondProject]);
    expect(result.unavailableProjectIds).toEqual([]);
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

  it.each(["forbidden", "malformed"] as const)("reports the original project inventory %s failure without letting the observer replace it", async kind => {
    const calls: string[] = [];
    const serverUrl = await listen((request, response) => {
      calls.push(request.url!);
      if (kind === "forbidden") respond(response, { error: { code: "forbidden", message: "no access", requestId: "inventory" } }, 403);
      else respond(response, { items: "invalid", nextCursor: null });
    });
    const remote = await verifiedRemote(serverUrl);
    const observerFailure = new Error("observer failed"), failure = vi.fn((_id: string, _error: unknown) => { throw observerFailure; });
    const unavailable = vi.fn();
    const actual = await remote.ownInventory([{ projectId }], workerId, signal(), unavailable, failure).catch((error: unknown) => error);
    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0]).toEqual([projectId, actual]);
    expect(actual).not.toBe(observerFailure);
    expect(actual).toMatchObject(kind === "forbidden" ? { phase: "response", status: 403 } : { phase: "protocol" });
    expect(unavailable).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("discards incomplete pages for an unavailable project while preserving healthy project claims", async () => {
    const other = uuid(8);
    const serverUrl = await listen((request, response) => {
      const url = new URL(request.url!, "http://localhost");
      if (url.pathname.includes(projectId)) {
        if (url.searchParams.has("cursor")) respond(response, { error: { code: "not_found", message: "not found", requestId: "missing" } }, 404);
        else respond(response, { items: [task(taskId, worker)], nextCursor: "next" });
      } else respond(response, { items: [task(uuid(9), worker, other)], nextCursor: null });
    });
    const unavailable = vi.fn(), failure = vi.fn();
    const result = await (await verifiedRemote(serverUrl)).ownInventory([{ projectId }, { projectId: other }], workerId, signal(), unavailable, failure);
    expect(result).toEqual({ tasks: [task(uuid(9), worker, other)], coveredProjectIds: [other], unavailableProjectIds: [projectId] });
    expect(unavailable).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(failure).not.toHaveBeenCalled();
  });

  it("invalidates as soon as a project returns 404 before waiting for another project", async () => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const serverUrl = await listen((request, response) => {
      if (request.url!.includes(projectId)) respond(response, { error: { code: "not_found", message: "not found", requestId: "missing" } }, 404);
      else { entered(); void held.then(() => respond(response, { items: [], nextCursor: null })); }
    });
    const invalidated = vi.fn();
    const pending = (await verifiedRemote(serverUrl)).ownInventory([{ projectId }, { projectId: uuid(8) }], workerId, signal(), invalidated);
    try { await waiting; expect(invalidated).toHaveBeenCalledOnce(); }
    finally { release(); }
    await pending;
  });

  it("does not mistake an identity mismatch on a 404 for an unavailable project", async () => {
    const serverUrl = await listen((_request, response) => {
      response.setHeader("Daynight-User-ID", uuid(80));
      respond(response, { error: { code: "not_found", message: "not found", requestId: "missing" } }, 404);
    });
    await expect((await verifiedRemote(serverUrl)).ownInventory([{ projectId }], workerId, signal())).rejects.toMatchObject({ phase: "protocol" });
    await expect((await verifiedRemote(serverUrl)).resolveProject({ repoUrl: project().repoUrl, projectId }, signal())).rejects.toMatchObject({ phase: "protocol" });
  });

  it("yields unowned candidates and later pages in service order", async () => {
    const urls: URL[] = [];
    const serverUrl = await listen((request, response) => {
      const url = new URL(request.url!, "http://localhost"); urls.push(url);
      const later = url.searchParams.has("cursor");
      const candidates = later ? [task(uuid(9)), task(uuid(8))] : [task(taskId), task(uuid(10))];
      respond(response, { items: candidates.map((candidate) => ({ ...candidate, assignedTo: worker.userId })), nextCursor: later ? null : "candidate cursor+/=" });
    });
    const result = await Array.fromAsync((await verifiedRemote(serverUrl)).candidates(projectId, "linux", signal()));
    expect(result.map(({ id }) => id)).toEqual([taskId, uuid(10), uuid(9), uuid(8)]);
    expect(urls.map(({ searchParams }) => Object.fromEntries(searchParams))).toEqual([
      { ready: "true", allowAgents: "true", automaticCandidate: "true", compatiblePlatform: "linux", assignedTo: "me", limit: "100" },
      { ready: "true", allowAgents: "true", automaticCandidate: "true", compatiblePlatform: "linux", assignedTo: "me", limit: "100", cursor: "candidate cursor+/=" },
    ]);
  });

  it.each([true, false])("preserves platformSpecific=%s on every candidate page", async (platformSpecific) => {
    const queries: URLSearchParams[] = [];
    const serverUrl = await listen((request, response) => {
      const query = new URL(request.url!, "http://localhost").searchParams; queries.push(query);
      const later = query.has("cursor");
      respond(response, { items: [{ ...task(later ? uuid(9) : taskId), assignedTo: worker.userId, requiredPlatform: platformSpecific ? "macos" : null }], nextCursor: later ? null : "next-tier" });
    });
    const result = await Array.fromAsync((await verifiedRemote(serverUrl)).candidates(projectId, "macos", signal(), platformSpecific));
    expect(result.map(({ id }) => id)).toEqual([taskId, uuid(9)]);
    expect(queries.map(query => query.get("automaticCandidate"))).toEqual(["true", "true"]);
    expect(queries.map(query => query.get("platformSpecific"))).toEqual([String(platformSpecific), String(platformSpecific)]);
    expect(queries.every(query => query.get("compatiblePlatform") === "macos" && query.get("assignedTo") === "me")).toBe(true);
  });

  it("rejects an active candidate as a protocol error", async () => {
    const serverUrl = await listen((_request, response) => respond(response, { items: [{ ...task(taskId, worker), assignedTo: worker.userId }], nextCursor: null }));
    await expect(Array.fromAsync((await verifiedRemote(serverUrl)).candidates(projectId, "linux", signal()))).rejects.toMatchObject({ phase: "protocol", cause: expect.objectContaining({ message: "Task does not match the requested filters." }) });
  });

  it("selects the authenticated account's candidates before the service page limit", async () => {
    const candidates = [
      ...Array.from({ length: 101 }, (_, index) => ({ ...task(uuid(index + 100)), assignedTo: index % 2 === 0 ? null : uuid(80) })),
      { ...task(uuid(201)), assignedTo: worker.userId },
      { ...task(uuid(202)), assignedTo: worker.userId },
    ];
    const requests: URL[] = [];
    const serverUrl = await listen((request, response) => {
      const url = new URL(request.url!, "http://localhost"); requests.push(url);
      const filtered = url.searchParams.get("assignedTo") === "me" ? candidates.filter(({ assignedTo }) => assignedTo === worker.userId) : candidates;
      const offset = Number(url.searchParams.get("cursor") ?? "0");
      const end = offset + Number(url.searchParams.get("limit"));
      respond(response, { items: filtered.slice(offset, end), nextCursor: end < filtered.length ? String(end) : null });
    });
    const result = await Array.fromAsync((await verifiedRemote(serverUrl)).candidates(projectId, "linux", signal()));
    expect(result.map(({ id }) => id)).toEqual([uuid(201), uuid(202)]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.get("assignedTo")).toBe("me");
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
    await expect(remote.ownInventory([{ projectId }], workerId, signal())).resolves.toEqual({ tasks: [task(taskId, worker)], coveredProjectIds: [projectId], unavailableProjectIds: [] });
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
