import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../../src/cli/application.js";
import { runWorkerQuery } from "../../../src/commands/worker/query.js";
import { runWorkerCommand } from "../../../src/commands/worker/index.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";

const workerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const observedAt = "2026-11-04T10:00:00Z";
const summary = { workerId, machine: { id: secondId, name: "Machine" }, platform: "macos", lastReportedAt: "2026-11-04T09:59:30Z", taskObservationState: "unavailable", taskObservedAt: null, activeTaskCount: null };
const page = { observedAt, items: [summary], nextCursor: null };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const respond = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json", "Daynight-User-ID": userId });
  response.end(JSON.stringify(value));
};
const fixture = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer((request, response) => {
    if (request.url === "/api/v1/me") {
      respond(response, { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: secondId, kind: "personal", name: null } });
      return;
    }
    handler(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing HTTP server address");
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-query-http");
  await mkdir(temporary, { recursive: true });
  const config = await mkdtemp(path.join(temporary, "config-"));
  cleanups.push(() => rm(config, { force: true, recursive: true }));
  await writeFile(path.join(config, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
  vi.stubEnv("DN_CONFIG_DIR", config);
  const signals = new EventEmitter();
  const context = { version: "0.0.0", packageDirectory: "unused", homeDirectory: () => config, workingDirectory: vi.fn(() => { throw new Error("Remote queries must not inspect cwd"); }), stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async () => {}) };
  const dependencies = { runServerCommand: (current: Parameters<typeof runServerCommand>[0], command: Parameters<typeof runServerCommand>[1]) => runServerCommand(current, command, { signalEmitter: signals, operationLimits: { totalMs: 2000, requestMs: 1000 } }) };
  return { context, dependencies, signals };
};

describe("remote worker commands over HTTP", () => {
  it("prints all pages atomically with the final service observation time", async () => {
    const requests: string[] = [];
    const later = "2026-11-04T10:00:01Z";
    const second = { ...summary, workerId: secondId };
    const current = await fixture((request, response) => {
      requests.push(request.url!);
      expect(request.headers.authorization).toBe("Bearer fixture-token");
      expect(current.context.stdout).not.toHaveBeenCalled();
      respond(response, request.url!.includes("cursor=") ? { observedAt: later, items: [second], nextCursor: null } : { ...page, nextCursor: "second page" });
    });
    await runWorkerQuery({ kind: "list", json: true }, current.context, current.dependencies);
    expect(JSON.parse(current.context.stdout.mock.calls[0]![0])).toEqual({ observedAt: later, items: [summary, second] });
    expect(requests).toEqual(["/api/v1/me/workers?limit=100", "/api/v1/me/workers?limit=100&cursor=second+page"]);
    expect(current.context.workingDirectory).not.toHaveBeenCalled();
    expect(current.context.stdout.mock.calls[0]![0]).not.toContain("fixture-token");
    expect(current.signals.listenerCount("SIGINT")).toBe(0);
  });
  it.each([401, 403, 404, 409, 500])("preserves status %s without empty-list success", async status => {
    let requests = 0;
    const current = await fixture((_request, response) => { requests++; respond(response, { error: { code: "fixture_refusal", message: "Read failed", requestId: "query-refusal" } }, status); });
    await expect(runWorkerQuery({ kind: "list", json: true }, current.context, current.dependencies)).rejects.toMatchObject({ exitCode: 1, cause: { status, code: "fixture_refusal", requestId: "query-refusal" } });
    expect(current.context.stdout).not.toHaveBeenCalled();
    expect(requests).toBe(1);
    expect(current.signals.listenerCount("SIGINT")).toBe(0);
  });
  it.each(["later-failure", "repeated-cursor", "duplicate-worker", "missing-field", "credential-field", "disconnect"])("does not print a partial inventory after %s", async failure => {
    let requests = 0;
    const current = await fixture((_request, response) => {
      requests++;
      if (requests === 1) { respond(response, { ...page, nextCursor: "next" }); return; }
      if (failure === "later-failure") respond(response, { error: { code: "internal", message: "Later page unavailable", requestId: "later-page" } }, 500);
      else if (failure === "repeated-cursor") respond(response, { observedAt, items: [], nextCursor: "next" });
      else if (failure === "duplicate-worker") respond(response, page);
      else if (failure === "missing-field") respond(response, { items: [], nextCursor: null });
      else if (failure === "credential-field") respond(response, { observedAt, items: [{ ...summary, workerId: secondId, serverToken: "not-output" }], nextCursor: null });
      else response.destroy();
    });
    await expect(runWorkerQuery({ kind: "list", json: true }, current.context, current.dependencies)).rejects.toBeInstanceOf(Error);
    expect(requests).toBe(2);
    expect(current.context.stdout).not.toHaveBeenCalled();
    expect(current.signals.listenerCount("SIGINT")).toBe(0);
  });
  it.each(["missing", "changed"])("rejects a %s response principal without printing partial inventory", async failure => {
    let requests = 0;
    const current = await fixture((_request, response) => {
      requests++;
      if (failure === "changed" && requests === 1) { respond(response, { ...page, nextCursor: "next" }); return; }
      response.writeHead(200, { "Content-Type": "application/json", ...(failure === "missing" ? {} : { "Daynight-User-ID": secondId }) });
      response.end(JSON.stringify({ observedAt, items: [], nextCursor: null }));
    });
    await expect(runWorkerQuery({ kind: "list", json: true }, current.context, current.dependencies)).rejects.toBeInstanceOf(Error);
    expect(requests).toBe(failure === "missing" ? 1 : 2);
    expect(current.context.stdout).not.toHaveBeenCalled();
  });
  it.each([false, true])("prints only public refusal metadata with json=%s", async json => {
    const current = await fixture((_request, response) => respond(response, { error: { code: "unauthorized", message: "private-body fixture-token", requestId: "safe-request" } }, 401));
    const code = await runCli(["worker", "list", ...(json ? ["--json"] : [])], current.context);
    expect(code).toBe(1);
    expect(current.context.stdout).not.toHaveBeenCalled();
    const diagnostic = current.context.stderr.mock.calls.map(([text]) => text).join("");
    expect(diagnostic).not.toContain("private-body");
    expect(diagnostic).not.toContain("fixture-token");
    if (json) expect(JSON.parse(diagnostic)).toEqual({ error: { operation: "worker.list", phase: "response", status: 401, code: "unauthorized", serverRequestId: "safe-request", outcomeUnconfirmed: false } });
    else { expect(diagnostic).toContain("HTTP 401"); expect(diagnostic).toContain("unauthorized"); expect(diagnostic).toContain("daynight login"); }
  });
  it.each([false, true])("identifies missing local authentication with json=%s", async json => {
    let requests = 0;
    const current = await fixture((_request, response) => { requests++; respond(response, page); });
    await writeFile(path.join(current.context.homeDirectory(), "config.yml"), "serverUrl: https://daynight.cc\n");
    const code = await runCli(["worker", "list", ...(json ? ["--json"] : [])], current.context);
    expect(code).toBe(1);
    expect(requests).toBe(0);
    expect(current.context.stdout).not.toHaveBeenCalled();
    const diagnostic = current.context.stderr.mock.calls.map(([text]) => text).join("");
    if (json) expect(JSON.parse(diagnostic)).toEqual({ error: { operation: "worker.list", reason: "login_required", outcomeUnconfirmed: false } });
    else expect(diagnostic).toContain("Run daynight login to authenticate.");
  });
  it("prints the complete observed detail through the public show command", async () => {
    const probe = { state: "error", checkedAt: observedAt, code: "unavailable" };
    const telemetry = { machine: summary.machine, platform: "macos", workingDirectory: "/ordinary", sampledAt: observedAt, os: probe, cpu: probe, memory: probe, disk: probe, versions: { daynight: "0.41.0", herdr: { state: "not_running", checkedAt: observedAt }, codex: { state: "not_installed", checkedAt: observedAt }, copilot: probe } };
    const detail = { observedAt, worker: { ...summary, telemetry, inventoryObservedAt: null, tasks: [] } };
    const requests: string[] = [];
    const current = await fixture((request, response) => { requests.push(request.url!); respond(response, detail); });
    await runWorkerCommand(["show", workerId.toUpperCase(), "--json"], current.context);
    expect(requests).toEqual([`/api/v1/me/workers/${workerId}`]);
    expect(JSON.parse(current.context.stdout.mock.calls[0]![0])).toEqual(detail);
    expect(current.context.workingDirectory).not.toHaveBeenCalled();
  });
  it("canonicalizes show UUID and preserves a 404 through the public command without local Worker state", async () => {
    const requests: string[] = [];
    const current = await fixture((request, response) => { requests.push(request.url!); respond(response, { error: { code: "not_found", message: "Worker was not found", requestId: "show-404" } }, 404); });
    await expect(runWorkerCommand(["show", workerId.toUpperCase(), "--json"], current.context)).rejects.toMatchObject({ exitCode: 1, cause: { status: 404, code: "not_found" } });
    expect(requests).toEqual([`/api/v1/me/workers/${workerId}`]);
    expect(current.context.workingDirectory).not.toHaveBeenCalled();
    expect(current.context.stdout).not.toHaveBeenCalled();
  });
});
