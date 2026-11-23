import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../../src/cli/application.js";
import type { CliContext } from "../../../src/cli/context.js";
import { commands } from "../../../src/cli/commands.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";
import { runBotDeletionCommand, type BotDeletionCommandDependencies } from "../../../src/commands/bot/deletion-commands.js";
import { parseBotDeletionRecovery, type BotDeletionRecovery } from "../../../src/commands/bot/deletion-api.js";
const botId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", deletionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", operationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const version = "9007199254740993";
const state = (resolved = false): BotDeletionRecovery => ({ schemaVersion: 1, botId, workerId, hostingWorkerId: workerId, version: resolved ? "9007199254740995" : version, deletionId, requestedVersion: "3", requiresStopProof: true, recoveryRequired: !resolved,
  originalBinding: { sessionId: botId, testExecutionId: workerId, executionGeneration: "1", controllerId: deletionId, controllerInstanceId: operationId },
  workerCleanup: { state: "failed", code: "execution_evidence_missing" }, serverCleanup: { state: resolved ? "completed" : "pending", code: null },
  decision: resolved ? { operationId, requestedVersion: version, actorUserId: botId, reason: "Original evidence unavailable", acknowledgedAt: "2026-11-23T00:00:00Z", localDisposition: "unverified" } : null });
const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "Daynight-User-ID": botId } });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
const fixture = async (respond: (url: URL, init: RequestInit) => Response | Promise<Response>, local: Partial<BotDeletionCommandDependencies> = {}, failOutput = false) => {
  vi.stubEnv("DN_CONFIG_DIR", undefined);
  const root = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-deletion-command-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "home-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".daynight"));
  await writeFile(path.join(home, ".daynight/config.yml"), "serverUrl: http://127.0.0.1:8787\nserverToken: SECRET-PAT\n");
  let out = "", err = "";
  const requests: { url: URL; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => { const url = new URL(String(input)); requests.push({ url, init: init! }); return respond(url, init!); };
  const context = { version: "test", packageDirectory: "unused", homeDirectory: () => home, workingDirectory: () => home, stdout: (s: string) => { out += s; }, stdoutBytes: async (s: Uint8Array) => { if (failOutput) throw new Error("SECRET-PAT output failed"); out += Buffer.from(s).toString(); }, stderr: (s: string) => { err += s; } };
  const registry = commands.map(command => command.name !== "bot" ? command : { ...command, load: async () => ({ run: (args: readonly string[], ctx: CliContext) => runBotDeletionCommand(args.slice(1), ctx, { ...local, runServerCommand: (c, action, options) => runServerCommand(c, action, { ...options, fetch, signalEmitter: new EventEmitter() }) }) }) });
  return { requests, run: async (args: string[]) => ({ exit: await runCli(["bot", "deletion", ...args], context, registry), out, err }) };
};
const resolveArgs = ["resolve", botId, "--if-version", version, "--deletion-id", deletionId, "--operation-id", operationId, "--accept-local-unverified", "--reason", "Original evidence unavailable", "--json"];
const user = { id: botId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: workerId, kind: "personal", name: null } };

describe("Bot deletion recovery commands", () => {
  it("reads an authoritative decision on another machine without opening local state", async () => {
    const inspectLocal = vi.fn();
    const { run, requests } = await fixture(() => jsonResponse(state(true)), { inspectLocal });
    const result = await run(["inspect", botId, "--server-only", "--json"]);
    expect(result.exit).toBe(0); expect(JSON.parse(result.out)).toEqual({ recovery: state(true), local: null });
    expect(inspectLocal).not.toHaveBeenCalled(); expect(requests.map(r => r.init.method)).toEqual(["GET"]);
    expect(requests[0]!.url.pathname).toBe(`/api/v1/me/bots/${botId}/deletion-recovery`);
  });
  it.each(["plain", "json"])("keeps a %s recovery 404 as a failure with an actionable server compatibility hint", async kind => {
    const { run, requests } = await fixture(() => kind === "plain"
      ? new Response("404 page not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } })
      : jsonResponse({ error: { code: "not_found", message: "not found", requestId: "missing" } }, 404));
    const result = await run(["inspect", botId, "--server-only", "--json"]);
    expect(result.exit).toBe(1); expect(result.out).toBe(""); expect(requests).toHaveLength(1);
    expect(JSON.parse(result.err).error).toMatchObject({ status: 404, phase: kind === "plain" ? "protocol" : "response", outcomeUnconfirmed: false,
      hint: expect.stringContaining("upgrade the server") });
    expect(JSON.parse(result.err).error.hint).toContain("HTTP 404 does not confirm Bot cleanup");
  });
  it("renders a plain recovery 404 with its original status and phase", async () => {
    const { run } = await fixture(() => new Response("404 page not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }));
    const result = await run(["inspect", botId, "--server-only"]);
    expect(result.exit).toBe(1); expect(result.out).toBe("");
    expect(result.err).toContain("HTTP 404 (protocol)"); expect(result.err).toContain("may not support deletion recovery");
  });
  it.each(["unauthorized", "principal"])("does not classify %s as unsupported recovery", async failure => {
    const { run } = await fixture(() => {
      if (failure === "unauthorized") return jsonResponse({ error: { code: "unauthenticated", message: "login required", requestId: "refused" } }, 401);
      const response = jsonResponse(state()); response.headers.delete("Daynight-User-ID"); return response;
    });
    const result = await run(["inspect", botId, "--server-only", "--json"]);
    expect(result.exit).toBe(1); expect(result.out).toBe(""); expect(JSON.parse(result.err).error).not.toHaveProperty("hint");
    expect(JSON.parse(result.err).error.status).toBe(failure === "unauthorized" ? 401 : 200);
  });
  it("submits one explicit decision with the exact observed version and original operation", async () => {
    const { run, requests } = await fixture(() => jsonResponse(state(true)));
    const result = await run(resolveArgs);
    expect(result.exit).toBe(0); expect(JSON.parse(result.out)).toEqual(state(true));
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ action: "accept_unverified", ifVersion: version, deletionId, operationId, acknowledgeLocalUnverified: true, reason: "Original evidence unavailable" });
  });
  it("binds local inspection to the authenticated owner and original deletion", async () => {
    const inspection = { botId, workerId, localWorkerId: workerId, originalWorkerMatched: true, storage: "available", evidence: "missing", canRecover: false, localCompleted: true, checks: [] };
    const inspectLocal = vi.fn().mockResolvedValue(inspection);
    const { run, requests } = await fixture(url => jsonResponse(url.pathname === "/api/v1/me" ? user : state()), { inspectLocal });
    const result = await run(["inspect", botId, "--json"]);
    expect(result.exit).toBe(0); expect(JSON.parse(result.out)).toEqual({ recovery: state(), local: inspection });
    expect(inspectLocal).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: botId, botId, serverUrl: "http://127.0.0.1:8787", recovery: state() }));
    expect(requests.map(r => r.init.method)).toEqual(["GET", "GET"]);
  });
  it("does not invoke local recovery when the observed deletion differs", async () => {
    const recoverLocal = vi.fn();
    const { run } = await fixture(url => jsonResponse(url.pathname === "/api/v1/me" ? user : state()), { recoverLocal });
    const result = await run(["recover", botId, "--deletion-id", operationId, "--json"]);
    expect(result.exit).toBe(1); expect(recoverLocal).not.toHaveBeenCalled();
  });
  it("preserves a confirmed local receipt when its subsequent read fails", async () => {
    let reads = 0;
    const recoverLocal = vi.fn().mockResolvedValue({ receiptConfirmed: true });
    const { run, requests } = await fixture(url => {
      if (url.pathname === "/api/v1/me") return jsonResponse(user);
      if (++reads === 2) throw new Error("SECRET-PAT read failed");
      return jsonResponse(state());
    }, { recoverLocal });
    const result = await run(["recover", botId, "--deletion-id", deletionId, "--json"]);
    expect(result.exit).toBe(1); expect(recoverLocal).toHaveBeenCalledOnce();
    expect(JSON.parse(result.err).error).toMatchObject({ confirmed: true, outcomeUnconfirmed: false, deletionId });
    expect(requests.map(r => r.init.method)).toEqual(["GET", "GET", "GET"]); expect(result.err).not.toContain("SECRET-PAT");
  });
  it("preserves a confirmed receipt across local storage close failure", async () => {
    const recoverLocal = vi.fn().mockRejectedValue(Object.assign(new Error("SECRET-PAT local close"), { code: "local_cleanup_failed", receiptConfirmed: true }));
    const { run } = await fixture(url => jsonResponse(url.pathname === "/api/v1/me" ? user : state()), { recoverLocal });
    const result = await run(["recover", botId, "--deletion-id", deletionId, "--json"]);
    expect(JSON.parse(result.err).error).toMatchObject({ confirmed: true, outcomeUnconfirmed: false, reason: "local_cleanup_failed" });
    expect(result.err).not.toContain("SECRET-PAT");
  });
  it.each([true, false])("reports a stopped original generation without confirming deletion (JSON=%s)", async json => {
    const stopped = Object.assign(new Error("SECRET-PAT original journal"), { code: "evidence_missing", generationStopped: true });
    const recoverLocal = vi.fn().mockRejectedValue(new AggregateError([new Error("Local inspection failed", { cause: stopped })]));
    const { run, requests } = await fixture(url => jsonResponse(url.pathname === "/api/v1/me" ? user : state()), { recoverLocal });
    const result = await run(["recover", botId, "--deletion-id", deletionId, ...(json ? ["--json"] : [])]);
    expect(result.exit).toBe(1); expect(result.out).toBe(""); expect(recoverLocal).toHaveBeenCalledOnce();
    expect(requests.map(request => request.init.method)).toEqual(["GET", "GET"]);
    if (json) {
      const error = JSON.parse(result.err).error;
      expect(error).toMatchObject({ reason: "evidence_missing", outcomeUnconfirmed: false });
      expect(error).not.toHaveProperty("confirmed"); expect(error).not.toHaveProperty("receiptConfirmed");
      expect(error.hint).toContain("The original generation is stopped; historical cleanup evidence is missing");
    }
    expect(result.err).toContain("Deletion remains incomplete");
    expect(result.err).toContain(`Inspect locally with daynight bot deletion inspect ${botId} --json`);
    expect(result.err).not.toContain("The submitted receipt is confirmed"); expect(result.err).not.toContain("SECRET-PAT");
  });
  it.each(["lost", "malformed", "wrong-operation", "wrong-deletion", "wrong-owner", "wrong-reason"])("retains decision identity after %s without replay", async failure => {
    const { run, requests } = await fixture(() => {
      if (failure === "lost") throw new Error("SECRET-PAT response lost");
      if (failure === "malformed") return jsonResponse({});
      const value = state(true);
      return jsonResponse({ ...value, ...(failure === "wrong-deletion" ? { deletionId: operationId } : {}), decision: { ...value.decision!, ...(failure === "wrong-operation" ? { operationId: deletionId } : {}), ...(failure === "wrong-owner" ? { actorUserId: workerId } : {}), ...(failure === "wrong-reason" ? { reason: "Other decision" } : {}) } });
    });
    const result = await run(resolveArgs);
    expect(result.exit).toBe(1); expect(result.out).toBe(""); expect(requests).toHaveLength(1);
    expect(JSON.parse(result.err).error).toMatchObject({ operationId, deletionId, botId, outcomeUnconfirmed: true, reconcile: `daynight bot deletion inspect ${botId} --server-only --json` });
    expect(result.err).not.toContain("SECRET-PAT");
  });
  it("retains a confirmed decision when output fails", async () => {
    const { run, requests } = await fixture(() => jsonResponse(state(true)), {}, true);
    const result = await run(resolveArgs);
    expect(result.exit).toBe(1); expect(requests).toHaveLength(1);
    expect(JSON.parse(result.err).error).toMatchObject({ operationId, confirmed: true, outcomeUnconfirmed: false, phase: "output" });
  });
  it.each(["--accept-local-unverified", "--operation-id", "--if-version", "--deletion-id"])("requires %s before any request", async flag => {
    const args = [...resolveArgs], index = args.indexOf(flag); args.splice(index, flag === "--accept-local-unverified" ? 1 : 2);
    const { run, requests } = await fixture(() => jsonResponse(state(true)));
    expect((await run(args)).exit).toBe(2); expect(requests).toHaveLength(0);
  });
  it("does not convert a version conflict into a new decision", async () => {
    const { run, requests } = await fixture(() => jsonResponse({ error: { code: "version_conflict", message: "changed", requestId: "refused" } }, 409));
    const result = await run(resolveArgs);
    expect(result.exit).toBe(1); expect(requests).toHaveLength(1); expect(JSON.parse(result.err).error).toMatchObject({ code: "version_conflict", outcomeUnconfirmed: false });
  });
  it("retries only server cleanup using an existing operation and the current version", async () => {
    const { run, requests } = await fixture(() => jsonResponse(state(true)));
    const result = await run(["retry-cleanup", botId, "--if-version", version, "--deletion-id", deletionId, "--operation-id", operationId, "--json"]);
    expect(result.exit).toBe(0); expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ action: "retry_cleanup", ifVersion: version, deletionId, operationId });
  });
  it("prints server completion without claiming verified local cleanup", async () => {
    const { run } = await fixture(() => jsonResponse(state(true)));
    const result = await run(["inspect", botId, "--server-only"]);
    expect(result.out).toContain("closed; server cleanup completed, local execution and files remain unverified");
    expect(result.out).toContain("Worker cleanup: failed");
  });
  it("rejects incompatible recovery versions and unknown fields", () => {
    expect(() => parseBotDeletionRecovery({ ...state(), schemaVersion: 2 })).toThrow();
    expect(() => parseBotDeletionRecovery({ ...state(), secret: "unexpected" })).toThrow();
    expect(() => parseBotDeletionRecovery({ ...state(), version: 9007199254740993 })).toThrow();
    expect(() => parseBotDeletionRecovery({ ...state(), originalBinding: null })).toThrow();
    expect(() => parseBotDeletionRecovery({ ...state(), recoveryRequired: false })).toThrow();
    expect(() => parseBotDeletionRecovery({ ...state(true), workerCleanup: { state: "completed", code: null } })).toThrow();
  });
  it("reads and safely renders a decision reason containing line breaks and tabs", async () => {
    const value = state(true), reason = "Original evidence unavailable\nInspected machine\tmanually";
    const { run } = await fixture(() => jsonResponse({ ...value, decision: { ...value.decision!, reason } }));
    const result = await run(["inspect", botId, "--server-only"]);
    expect(result.exit).toBe(0);
    expect(result.out).toContain("Reason:");
    expect(result.out).not.toContain("\t");
  });
});
