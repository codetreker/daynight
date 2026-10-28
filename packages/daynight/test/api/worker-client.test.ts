import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../src/api/index.js";
import type { ApiClient, ClaimWorkerTaskInput, Task, WorkerClaim, WorkerState } from "../../src/api/index.js";

const projectId = "11111111-1111-1111-1111-111111111111";
const taskId = "22222222-2222-2222-2222-222222222222";
const claimId = "33333333-3333-3333-3333-333333333333";
const workerId = "44444444-4444-4444-4444-444444444444";
const machineId = "55555555-5555-5555-5555-555555555555";
const worktreeId = "66666666-6666-6666-6666-666666666666";
const userId = "77777777-7777-7777-7777-777777777777";
const newClaimId = "88888888-8888-8888-8888-888888888888";
const newWorktreeId = "99999999-9999-9999-9999-999999999999";
const time = "2026-10-24T12:34:56.123456789Z";
const descriptor = { claimId, workerId, machine: { id: machineId, name: "Build machine" }, platform: "linux", agent: "codex", worktreeId } as const;
const claim = (state: WorkerState = "active"): WorkerClaim => ({ ...descriptor, agentControlMode: "herdr", userId, state, phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: time });
const task = (worker: WorkerClaim | null, version = 2n): Task => ({
  id: taskId, projectId, title: "Claimed task", description: "", properties: { pullRequests: [{ url: "opaque\0url", title: "PR" }], worker },
  status: worker?.state === "active" ? "in_progress" : worker?.state === "completed" ? "done" : "todo",
  allowAgents: true, requiredPlatform: null, version, startedAt: worker?.state === "active" ? time : null,
  completedAt: worker?.state === "completed" ? time : null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: worker === null || worker.state === "released",
});
const cleanups: (() => void | Promise<void>)[] = [];
const api = (serverUrl: string): ApiClient => {
  const operation = createOperation({ limits: { totalMs: 5_000, requestMs: 2_000 } });
  cleanups.push(() => operation.dispose());
  return createApiClient({ serverUrl, operation });
};
const listen = async (handler: (request: IncomingMessage, response: ServerResponse, body: unknown) => void): Promise<string> => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length === 0 ? null : parseApiJson(Buffer.concat(chunks).toString("utf8"));
    handler(request, response, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
    server.closeAllConnections();
  }));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}`;
};
const respond = (response: ServerResponse, value: unknown, status = 200): void => {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(stringifyApiJson(value));
};
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

describe("in-process worker task API", () => {
  it("sends exact version-bound worker actions and accepts their 200 responses", async () => {
    const requests: { method: string; path: string; body: unknown }[] = [];
    const max = 9_223_372_036_854_775_807n;
    const responses = [task(claim(), max), task({ ...claim(), phase: "executing", herdr: { session: "w", workspaceId: "ws", paneId: "p" }, nativeSessionId: "native" }), task(claim("completed")), task(claim("released")), task({ ...claim(), claimId: newClaimId, worktreeId: newWorktreeId, agent: "copilot" }), task({ ...claim(), claimId: newClaimId, worktreeId: newWorktreeId, agent: "copilot" })];
    const origin = await listen((request, response, body) => {
      requests.push({ method: request.method!, path: request.url!, body });
      const result = responses.shift();
      if (result === undefined) throw new Error("Unexpected additional worker request");
      respond(response, result);
    });
    const client = api(origin);
    const initial: ClaimWorkerTaskInput = { ...descriptor, version: max - 1n };
    await expect(client.claimWorkerTask(projectId, taskId, initial)).resolves.toMatchObject({ version: max, properties: { worker: claim() } });
    const update = { version: 1n, claimId, phase: "executing", herdr: { paneId: "p", session: "w", workspaceId: "ws" }, nativeSessionId: "native" } as const;
    await client.updateWorkerClaim(projectId, taskId, update);
    await client.completeWorkerTask(projectId, taskId, { version: 1n, claimId });
    await client.releaseWorkerClaim(projectId, taskId, { version: 1n, claimId, stoppedConfirmed: true });
    const target = { userId, workerId, machine: descriptor.machine, platform: descriptor.platform, agent: "copilot" } as const;
    await client.transferWorkerClaim(projectId, taskId, { version: 1n, claimId, newClaimId, target, worktreeId: newWorktreeId, stoppedConfirmed: true });
    await client.resumeWorkerTask(projectId, taskId, { ...descriptor, claimId: newClaimId, worktreeId: newWorktreeId, agent: "copilot", version: 1n, previousClaimId: claimId });
    const prefix = `/api/v1/projects/${projectId}/tasks/${taskId}`;
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ["POST", `${prefix}/worker-claim`], ["PATCH", `${prefix}/worker-claim`], ["PUT", `${prefix}/status`],
      ["POST", `${prefix}/worker-claim/release`], ["POST", `${prefix}/worker-claim/transfer`], ["POST", `${prefix}/worker-claim/resume`],
    ]);
    expect(requests[0]!.body).toEqual({ ...initial, agentControlMode: "herdr" });
    expect(requests[1]!.body).toEqual(update);
    expect(requests[2]!.body).toEqual({ version: 1n, claimId, status: "done" });
    expect(requests[4]!.body).toEqual({ version: 1n, claimId, newClaimId, target: { ...target, agentControlMode: "herdr" }, worktreeId: newWorktreeId, stoppedConfirmed: true });
    expect(requests[5]!.body).toEqual({ ...descriptor, agentControlMode: "herdr", claimId: newClaimId, worktreeId: newWorktreeId, agent: "copilot", version: 1n, previousClaimId: claimId });
  });

  it.each([true, false, undefined, null])("rejects deprecated continuityConfirmed=%s before any worker write", (continuityConfirmed) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const operation = createOperation();
    cleanups.push(() => operation.dispose());
    const client = createApiClient({ serverUrl: "http://localhost", fetch, operation });
    const target = { userId, workerId, machine: descriptor.machine, platform: descriptor.platform, agent: descriptor.agent };
    expect(() => client.claimWorkerTask(projectId, taskId, { ...descriptor, version: 1n, continuityConfirmed } as never)).toThrow("continuityConfirmed is no longer accepted");
    expect(() => client.transferWorkerClaim(projectId, taskId, { version: 1n, claimId, newClaimId, target, worktreeId: newWorktreeId, stoppedConfirmed: true, continuityConfirmed } as never)).toThrow("continuityConfirmed is no longer accepted");
    expect(() => client.resumeWorkerTask(projectId, taskId, { ...descriptor, claimId: newClaimId, worktreeId: newWorktreeId, version: 1n, previousClaimId: claimId, continuityConfirmed } as never)).toThrow("continuityConfirmed is no longer accepted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("matches canonical server UUIDs when worker action inputs use uppercase UUIDs", async () => {
    const lower = { claimId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", workerId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", machine: { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", name: "Build machine" }, worktreeId: "dddddddd-dddd-dddd-dddd-dddddddddddd", userId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" };
    const upper = { ...descriptor, claimId: lower.claimId.toUpperCase(), workerId: lower.workerId.toUpperCase(), machine: { ...lower.machine, id: lower.machine.id.toUpperCase() }, worktreeId: lower.worktreeId.toUpperCase() };
    const replacementId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const active = { ...claim(), ...lower };
    const responses = [task(active), task(active), task({ ...active, state: "completed" }), task({ ...active, state: "released" }), task({ ...active, claimId: replacementId }), task({ ...active, claimId: replacementId })];
    const origin = await listen((_request, response) => respond(response, responses.shift()));
    const client = api(origin);
    await expect(client.claimWorkerTask(projectId, taskId, { ...upper, version: 1n })).resolves.toHaveProperty("properties.worker.claimId", lower.claimId);
    await client.updateWorkerClaim(projectId, taskId, { version: 1n, claimId: upper.claimId, phase: "preparing" });
    await client.completeWorkerTask(projectId, taskId, { version: 1n, claimId: upper.claimId });
    await client.releaseWorkerClaim(projectId, taskId, { version: 1n, claimId: upper.claimId, stoppedConfirmed: true });
    const target = { userId: lower.userId.toUpperCase(), workerId: upper.workerId, machine: upper.machine, platform: upper.platform, agent: upper.agent };
    await client.transferWorkerClaim(projectId, taskId, { version: 1n, claimId: upper.claimId, newClaimId: replacementId.toUpperCase(), target, worktreeId: upper.worktreeId, stoppedConfirmed: true });
    await client.resumeWorkerTask(projectId, taskId, { ...upper, version: 1n, claimId: replacementId.toUpperCase(), previousClaimId: upper.claimId });
  });

  it("leaves uncertain claim writes for a direct known-task read without repeating the mutation", async () => {
    const methods: string[] = [];
    const origin = await listen((request, response) => {
      methods.push(request.method!);
      if (request.method === "POST") request.socket.destroy();
      else respond(response, task(claim()));
    });
    const client = api(origin);
    await expect(client.claimWorkerTask(projectId, taskId, { ...descriptor, version: 1n })).rejects.toMatchObject({ outcomeUnconfirmed: true });
    await expect(client.getTask(projectId, taskId)).resolves.toMatchObject({ properties: { worker: claim() } });
    expect(methods).toEqual(["POST", "GET"]);
  });

  it.each(["version_conflict", "claim_conflict"])("preserves a confirmed %s refusal without retrying", async (code) => {
    let count = 0;
    const origin = await listen((_request, response) => {
      count++;
      respond(response, { error: { code, message: "The claim is no longer current.", requestId: "claim-test" } }, 409);
    });
    await expect(api(origin).updateWorkerClaim(projectId, taskId, { version: 1n, claimId, phase: "executing" })).rejects.toMatchObject({ status: 409, code, confirmedRefusal: true, outcomeUnconfirmed: false });
    expect(count).toBe(1);
  });

  it("refuses a successful-looking response for another claim", async () => {
    let count = 0;
    const origin = await listen((_request, response) => { count++; respond(response, task({ ...claim(), claimId: newClaimId })); });
    await expect(api(origin).claimWorkerTask(projectId, taskId, { ...descriptor, version: 1n })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(count).toBe(1);
  });

  it("retains the candidate cursor so an unavailable released task does not hide later work", async () => {
    const urls: URL[] = [];
    const availableId = "99999999-9999-9999-9999-999999999999";
    const released = task(claim("released"));
    const available = { ...task(null), id: availableId };
    const origin = await listen((request, response) => {
      const url = new URL(request.url!, "http://localhost");
      urls.push(url);
      respond(response, url.searchParams.has("cursor") ? { items: [available], nextCursor: null } : { items: [released], nextCursor: "next+/=" });
    });
    const client = api(origin);
    const filters = { limit: 1, ready: true, allowAgents: true, compatiblePlatform: "linux" } as const;
    const first = await client.listTaskPage(projectId, filters);
    expect(first).toEqual({ items: [released], nextCursor: "next+/=" });
    if (first.nextCursor === null) throw new Error("Missing candidate continuation");
    const second = await client.listTaskPage(projectId, { ...filters, cursor: first.nextCursor });
    expect(second).toEqual({ items: [available], nextCursor: null });
    expect(urls.map((url) => [url.searchParams.get("ready"), url.searchParams.get("allowAgents"), url.searchParams.get("compatiblePlatform"), url.searchParams.get("limit")])).toEqual([["true", "true", "linux", "1"], ["true", "true", "linux", "1"]]);
    expect(urls[1]!.searchParams.get("cursor")).toBe("next+/=");
  });

  it("reads every worker inventory page without adding candidate eligibility filters", async () => {
    const canonicalWorkerId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const first = { ...task({ ...claim(), workerId: canonicalWorkerId }), allowAgents: false, requiredPlatform: "windows" } as const;
    const second = { ...first, id: newClaimId, properties: { ...first.properties, pullRequests: [{ url: "opaque\0url", title: "\ud800" }] } };
    const urls: URL[] = [];
    const origin = await listen((request, response) => {
      const url = new URL(request.url!, "http://localhost");
      urls.push(url);
      respond(response, url.searchParams.has("cursor") ? { items: [second], nextCursor: null } : { items: [first], nextCursor: "inventory cursor+/=" });
    });

    await expect(api(origin).listTasks(projectId, { workerId: canonicalWorkerId.toUpperCase() })).resolves.toEqual([first, second]);
    expect(urls.map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { workerId: canonicalWorkerId, limit: "100" },
      { workerId: canonicalWorkerId, limit: "100", cursor: "inventory cursor+/=" },
    ]);
  });

  it("keeps a bounded worker page explicit and combines only caller-supplied filters", async () => {
    const value = { ...task(claim()), allowAgents: false, requiredPlatform: "windows" } as const;
    const urls: URL[] = [];
    const origin = await listen((request, response) => {
      urls.push(new URL(request.url!, "http://localhost"));
      respond(response, { items: [value], nextCursor: "partial inventory" });
    });

    await expect(api(origin).listTaskPage(projectId, { workerId, status: "in_progress", ready: false, allowAgents: false, compatiblePlatform: "windows", limit: 1 })).resolves.toEqual({ items: [value], nextCursor: "partial inventory" });
    expect(urls.map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { status: "in_progress", ready: "false", allowAgents: "false", compatiblePlatform: "windows", workerId, limit: "1" },
    ]);
  });

  it.each([
    { name: "no claim", value: task(null) },
    { name: "released claim", value: task(claim("released")) },
    { name: "completed claim", value: task(claim("completed")) },
    { name: "another worker", value: task({ ...claim(), workerId: newClaimId }) },
    { name: "malformed worker ID", value: { ...task(claim()), properties: { pullRequests: [], worker: { ...claim(), workerId: "not-a-worker-id" } } } },
  ])("rejects a worker-filtered response containing $name", async ({ value }) => {
    let count = 0;
    const origin = await listen((_request, response) => {
      count++;
      respond(response, { items: [value], nextCursor: null });
    });
    const client = api(origin);

    await expect(client.listTasks(projectId, { workerId })).rejects.toMatchObject({ operation: "task.list", phase: "protocol", projectId, outcomeUnconfirmed: false });
    await expect(client.listTaskPage(projectId, { workerId, limit: 1 })).rejects.toMatchObject({ operation: "task.list-page", phase: "protocol", projectId, outcomeUnconfirmed: false });
    expect(count).toBe(2);
  });

  it.each(["cursor loop", "duplicate task", "later failure", "later wrong worker"])("rejects an inventory %s without returning earlier pages", async (failure) => {
    const first = task(claim());
    const second = { ...first, id: newClaimId };
    const urls: URL[] = [];
    const origin = await listen((request, response) => {
      const url = new URL(request.url!, "http://localhost");
      urls.push(url);
      if (!url.searchParams.has("cursor")) {
        respond(response, { items: [first], nextCursor: "inventory-next" });
        return;
      }
      if (failure === "later failure") {
        respond(response, { error: { code: "internal_error", message: "Inventory unavailable.", requestId: "inventory-failure" } }, 500);
        return;
      }
      const value = failure === "duplicate task" ? first : failure === "later wrong worker" ? { ...second, properties: { ...second.properties, worker: { ...claim(), workerId: newClaimId } } } : second;
      respond(response, { items: [value], nextCursor: failure === "cursor loop" ? "inventory-next" : null });
    });

    await expect(api(origin).listTasks(projectId, { workerId })).rejects.toMatchObject({ operation: "task.list", projectId, outcomeUnconfirmed: false });
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.searchParams.get("workerId") === workerId)).toBe(true);
  });

  it.each(["", "invalid", "44444444444444444444444444444444", ` ${workerId}`, null, false, 1, {}, []])("rejects invalid worker inventory filter %s before dispatch", (invalidWorkerId) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const operation = createOperation();
    cleanups.push(() => operation.dispose());
    const client = createApiClient({ serverUrl: "http://localhost", fetch, operation });

    expect(() => client.listTasks(projectId, { workerId: invalidWorkerId } as never)).toThrow("Worker ID filter must be a hyphenated UUID.");
    expect(() => client.listTaskPage(projectId, { workerId: invalidWorkerId, limit: 1 } as never)).toThrow("Worker ID filter must be a hyphenated UUID.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a candidate page that violates its filters or requested bound", async () => {
    const origin = await listen((_request, response) => respond(response, { items: [task(claim())], nextCursor: null }));
    await expect(api(origin).listTaskPage(projectId, { limit: 1, ready: true })).rejects.toMatchObject({ phase: "protocol" });
  });

  it("accepts current-version worker update and completion no-ops", async () => {
    const responses = [task(claim(), 1n), task(claim("completed"), 1n)];
    const origin = await listen((_request, response) => respond(response, responses.shift()));
    const client = api(origin);
    await expect(client.updateWorkerClaim(projectId, taskId, { version: 1n, claimId, phase: "preparing" })).resolves.toHaveProperty("version", 1n);
    await expect(client.completeWorkerTask(projectId, taskId, { version: 1n, claimId })).resolves.toHaveProperty("version", 1n);
  });

  it("rejects a page larger than its requested bound", async () => {
    const origin = await listen((_request, response) => respond(response, { items: [task(null), { ...task(null), id: newClaimId }], nextCursor: null }));
    await expect(api(origin).listTaskPage(projectId, { limit: 1 })).rejects.toMatchObject({ phase: "protocol" });
  });

  it("validates page limits, cursors and filters before dispatch", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const operation = createOperation();
    cleanups.push(() => operation.dispose());
    const client = createApiClient({ serverUrl: "http://localhost", fetch, operation });
    for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: 1, cursor: "" }, { limit: 1, ready: 1 }, { limit: 1, allowAgents: "true" }, { limit: 1, compatiblePlatform: "win32" }, { limit: 1, status: "proposed" }]) {
      expect(() => client.listTaskPage(projectId, query as never)).toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects protected properties on ordinary mutation inputs before dispatch", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const operation = createOperation();
    cleanups.push(() => operation.dispose());
    const client = createApiClient({ serverUrl: "http://localhost", fetch, operation });
    for (const worker of [null, claim()]) {
      const properties = { pullRequests: [], worker } as never;
      expect(() => client.createTask(projectId, { title: "Task", properties })).toThrow("Worker ownership");
      expect(() => client.updateTask(projectId, taskId, { version: 1n, properties })).toThrow("Worker ownership");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe("worker execution mode requests", () => {
  it.each(["claude", "copilot"] as const)("carries the frozen mode through claim, resume and transfer", async (agent) => {
    const bodies: Record<string, unknown>[] = [];
    const origin = await listen((_request, response, body) => {
      bodies.push(body as Record<string, unknown>);
      respond(response, task({ ...claim(), agent, agentControlMode: "web" } as WorkerClaim));
    });
    const client = api(origin);
    const web = { ...descriptor, agent, agentControlMode: "web" } as const;
    await client.claimWorkerTask(projectId, taskId, { ...web, version: 1n });
    await client.resumeWorkerTask(projectId, taskId, { ...web, version: 1n, previousClaimId: newClaimId });
    await client.transferWorkerClaim(projectId, taskId, { version: 1n, claimId: newClaimId, newClaimId: claimId, target: { userId, workerId, machine: descriptor.machine, platform: descriptor.platform, agent: web.agent, agentControlMode: web.agentControlMode }, worktreeId, stoppedConfirmed: true });
    expect(bodies[0]).toMatchObject({ agentControlMode: "web", agent });
    expect(bodies[1]).toMatchObject({ agentControlMode: "web", agent });
    expect(bodies[2]).toMatchObject({ target: { agentControlMode: "web", agent } });
  });
  it.each([null, "other", undefined])("rejects explicit invalid mode %j before dispatch", (agentControlMode) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const operation = createOperation(); cleanups.push(() => operation.dispose());
    const client = createApiClient({ serverUrl: "http://localhost", fetch, operation });
    expect(() => client.claimWorkerTask(projectId, taskId, { ...descriptor, version: 1n, agentControlMode } as never)).toThrow(/mode/i);
    expect(() => client.resumeWorkerTask(projectId, taskId, { ...descriptor, version: 1n, previousClaimId: newClaimId, agentControlMode } as never)).toThrow(/mode/i);
    expect(() => client.transferWorkerClaim(projectId, taskId, { version: 1n, claimId, newClaimId, worktreeId, stoppedConfirmed: true, target: { ...descriptor, userId, agentControlMode } } as never)).toThrow(/mode/i);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects unsupported Web providers before dispatch", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const operation = createOperation(); cleanups.push(() => operation.dispose());
    const client = createApiClient({ serverUrl: "http://localhost", fetch, operation });
    expect(() => client.claimWorkerTask(projectId, taskId, { ...descriptor, version: 1n, agent: "unsupported", agentControlMode: "web" } as never)).toThrow(/agent/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});


it("rejects a claim response whose mode differs from the frozen request", async () => {
  const origin = await listen((_request, response) => respond(response, task(claim())));
  await expect(api(origin).claimWorkerTask(projectId, taskId, { ...descriptor, version: 1n, agentControlMode: "web" })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
});
