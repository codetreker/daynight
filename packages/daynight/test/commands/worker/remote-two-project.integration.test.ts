import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../../src/api/json.js";
import * as operations from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import type { Project, Task, WorkerClaim, WorkerClaimDescriptor } from "../../../src/api/types.js";
import type { WorkerCloudDesired } from "../../../src/api/worker-configuration.js";
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


it("retains identity and request order through two-project inventory, claim and report", async () => {
  const second = uuid(8), token = "fixture-worker-token";
  const desired: WorkerCloudDesired = { revision: "1", updatedAt: time, value: { maxConcurrent: 1, pollIntervalMs: 1000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex" as const, model: "current-model", args: [] }, projects: [projectId, second].map(projectId => ({ projectId, nativeOverrides: {} })) } };
  const account = { id: worker.userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: uuid(90), kind: "personal" as const, name: null } };
  const candidate = { ...task(), assignedTo: worker.userId };
  const claimed = { ...task(taskId, worker), assignedTo: worker.userId, version: 2n };
  const requests: { method: string; url: string; authorization: string | undefined; body: unknown }[] = [];
  const serverUrl = await listen((request, response, body) => {
    const url = new URL(request.url!, "http://localhost");
    requests.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization, body });
    if (url.pathname === "/api/v1/me") respond(response, account);
    else if (url.pathname.endsWith("/configuration")) { response.setHeader("Daynight-Worker-Configuration", "1"); respond(response, { desired, observationRevision: "0", observation: null }); }
    else if (url.pathname.endsWith("/report")) respond(response, { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime });
    else if (url.pathname.endsWith("/worker-claim")) respond(response, claimed);
    else if (url.pathname.endsWith("/tasks")) respond(response, { items: url.searchParams.has("assignedTo") && url.pathname.includes(projectId) ? [candidate] : [], nextCursor: null });
    else if (url.pathname === `/api/v1/projects/${projectId}`) respond(response, project());
    else if (url.pathname === `/api/v1/projects/${second}`) respond(response, project(second, "https://github.com/example/second.git"));
    else respond(response, { error: { code: "not_found", message: "Unexpected", requestId: "unexpected" } }, 404);
  }, { identity: false });
  const remote = createWorkerRemote({ serverUrl, serverToken: token });
  const operation = operations.createOperation();
  try {
    expect(await remote.currentUserId(signal())).toBe(worker.userId);
    await expect(remote.configuration(workerId, signal())).resolves.toMatchObject({ desired });
    await remote.project(projectId, signal()); await remote.project(second, signal());
    const inventory = await remote.ownInventory([{ projectId }, { projectId: second }], workerId, signal());
    expect(inventory).toEqual({ tasks: [], coveredProjectIds: [projectId, second], unavailableProjectIds: [] });
    const candidates = await Array.fromAsync(remote.candidates(projectId, "linux", signal()));
    expect(candidates).toEqual([candidate]);
    expect(await remote.claim(candidate, descriptor, signal())).toEqual(claimed);
    const report = { ...workerTelemetry, taskInventory: null };
    await expect(remote.report(workerId, report, operation)).resolves.toEqual({ observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime });
    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "/api/v1/me"], ["GET", `/api/v1/me/workers/${workerId}/configuration`],
      ["GET", `/api/v1/projects/${projectId}`], ["GET", `/api/v1/projects/${second}`],
      ["GET", `/api/v1/projects/${projectId}/tasks?workerId=${workerId}&limit=100`],
      ["GET", `/api/v1/projects/${second}/tasks?workerId=${workerId}&limit=100`],
      ["GET", `/api/v1/projects/${projectId}/tasks?assignedTo=me&ready=true&allowAgents=true&compatiblePlatform=linux&automaticCandidate=true&limit=100`],
      ["POST", `/api/v1/projects/${projectId}/tasks/${taskId}/worker-claim`], ["POST", `/api/v1/me/workers/${workerId}/report`],
    ]);
    expect(requests.every(({ authorization }) => authorization === `Bearer ${token}`)).toBe(true);
    expect(requests.at(-2)!.body).toEqual({ ...descriptor, version: 1n });
    expect(requests.at(-1)!.body).toEqual(report);
    expect(stringifyApiJson(requests.map(({ body }) => body))).not.toContain(token);
  } finally { operation.dispose(); }
}, 15_000);
