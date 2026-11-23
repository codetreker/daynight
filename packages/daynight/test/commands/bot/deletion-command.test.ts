import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../src/api/client.js";
import { runCli } from "../../../src/cli/application.js";
import type { CliContext } from "../../../src/cli/context.js";
import { commands } from "../../../src/cli/commands.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";
import { runBotCommand } from "../../../src/commands/bot/commands.js";
import type { BotRecoveryCommandDependencies } from "../../../src/commands/bot/recover.js";
import type { Bot } from "../../../src/commands/bot/api.js";
import { createBotSessionApi, type BotDeletionReceipt } from "../../../src/commands/worker/bots/session-api.js";
import type { BotRecord } from "../../../src/commands/worker/bots/types.js";

const botId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", deletionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", otherId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const state = (completed = false): Bot => ({ id: botId, workerId, version: completed ? "9007199254740995" : "9007199254740993", deletion: {
  deletionId, requestedVersion: "3", workerCleanup: completed ? { state: "completed", code: null } : { state: "failed", code: "execution_evidence_missing" }, serverCleanup: { state: completed ? "completed" : "pending", code: null },
} });
const user = { id: botId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: workerId, kind: "personal", name: null } };
const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "Daynight-User-ID": botId } });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
const fixture = async (respond: (url: URL, init: RequestInit) => Response | Promise<Response>, local: Partial<BotRecoveryCommandDependencies> = {}, failOutput = false, serverUrl = "http://127.0.0.1:8787") => {
  vi.stubEnv("DN_CONFIG_DIR", undefined);
  const root = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-recover-command-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "home-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".daynight"));
  await writeFile(path.join(home, ".daynight/config.yml"), `serverUrl: ${serverUrl}\nserverToken: SECRET-PAT\n`);
  let out = "", err = "";
  const requests: { url: URL; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => { const url = new URL(String(input)); requests.push({ url, init: init! }); return respond(url, init!); };
  const context = { version: "test", packageDirectory: "unused", homeDirectory: () => home, workingDirectory: () => home, stdout: (s: string) => { out += s; }, stdoutBytes: async (s: Uint8Array) => { if (failOutput) throw new Error("SECRET-PAT output failed"); out += Buffer.from(s).toString(); }, stderr: (s: string) => { err += s; } };
  const dependencies: BotRecoveryCommandDependencies = { ...local, runServerCommand: (c, action, options) => runServerCommand(c, action, { ...options, fetch, signalEmitter: new EventEmitter() }) };
  const registry = commands.map(command => command.name !== "bot" ? command : { ...command, load: async () => ({ run: (args: readonly string[], ctx: CliContext) => runBotCommand(args, ctx, dependencies) }) });
  return { requests, run: async (args: string[]) => ({ exit: await runCli(["bot", ...args], context, registry), out, err }) };
};
const recoverArgs = ["recover", botId, "--deletion-id", deletionId, "--json"];
const initial = (url: URL) => jsonResponse(url.pathname === "/api/v1/me" ? user : state());

describe("Bot local deletion recovery command", () => {
  it("uses ordinary Bot reads, binds the account and returns actual cleanup state", async () => {
    let reads = 0;
    const recoverLocal = vi.fn().mockResolvedValue({ receiptConfirmed: true });
    const { run, requests } = await fixture(url => jsonResponse(url.pathname === "/api/v1/me" ? user : state(++reads === 2)), { recoverLocal });
    const result = await run(recoverArgs);
    expect(result.exit).toBe(0); expect(JSON.parse(result.out)).toEqual(state(true));
    expect(recoverLocal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ownerUserId: botId, botId, serverUrl: "http://127.0.0.1:8787", bot: state() }));
    expect(requests.map(r => `${r.init.method} ${r.url.pathname}`)).toEqual(["GET /api/v1/me", `GET /api/v1/me/bots/${botId}`, `GET /api/v1/me/bots/${botId}`]);
    expect(result.err).toBe(""); expect(result.out).not.toContain("SECRET-PAT");
  });
  it("renders server cleanup failure without claiming complete deletion", async () => {
    let reads = 0;
    const completed = state(true);
    if (completed.deletion === null) throw new Error("Expected deletion fixture.");
    const failed = { ...completed, deletion: { ...completed.deletion, serverCleanup: { state: "failed", code: "archive_cleanup_failed" } } };
    const { run } = await fixture(url => jsonResponse(url.pathname === "/api/v1/me" ? user : ++reads === 2 ? failed : state()), { recoverLocal: vi.fn().mockResolvedValue({ receiptConfirmed: true }) });
    const result = await run(recoverArgs.slice(0, -1));
    expect(result.exit).toBe(0); expect(result.out).toContain("Worker cleanup: completed"); expect(result.out).toContain("Server cleanup: failed");
    expect(result.out).toContain("Deletion: failed"); expect(result.out).toContain("archive_cleanup_failed");
  });
  it("refuses a changed deletion before touching local execution", async () => {
    const recoverLocal = vi.fn();
    const { run, requests } = await fixture(initial, { recoverLocal });
    const result = await run(["recover", botId, "--deletion-id", otherId, "--json"]);
    expect(result.exit).toBe(1); expect(recoverLocal).not.toHaveBeenCalled(); expect(requests).toHaveLength(2);
    expect(JSON.parse(result.err).error).toMatchObject({ reason: "deletion_changed", reconcile: `daynight bot show ${botId} --json` });
  });
  it.each(["active", "pending", "other-failure", "completed"])("refuses %s Bots before local recovery", async kind => {
    const recoverLocal = vi.fn(), deleted = state();
    if (deleted.deletion === null) throw new Error("Expected deletion fixture.");
    const active = { id: botId, workerId, version: "7", deletion: null, ownerUserId: botId, name: "Bot", creationOrder: "1", requestedOverrides: {},
      resolvedConfiguration: { workerId, cwd: "/ordinary", provider: "codex", model: null, args: [] }, roleConfiguration: null, sessionId: null, testExecutionId: null,
      startupResult: { state: "pending", code: null }, createdAt: "2026-11-23T00:00:00Z", updatedAt: "2026-11-23T00:00:00Z" };
    const value = kind === "active" ? active : { ...deleted, deletion: { ...deleted.deletion, workerCleanup: kind === "other-failure"
      ? { state: "failed", code: "private_cleanup_failed" } : { state: kind, code: null } } };
    const { run, requests } = await fixture(url => jsonResponse(url.pathname === "/api/v1/me" ? user : value), { recoverLocal });
    const result = await run(recoverArgs);
    expect(result.exit).toBe(1); expect(result.out).toBe(""); expect(recoverLocal).not.toHaveBeenCalled(); expect(requests).toHaveLength(2);
    expect(JSON.parse(result.err).error).toMatchObject({ reason: "recovery_not_required", outcomeUnconfirmed: false });
  });
  it.each(["worker_running", "wrong_worker", "storage_unreadable", "evidence_missing", "stop_unproven"])("preserves the local %s refusal without submitting or retrying", async code => {
    const recoverLocal = vi.fn().mockRejectedValue(Object.assign(new Error("SECRET-PAT local refusal"), { code }));
    const { run, requests } = await fixture(initial, { recoverLocal });
    const result = await run(recoverArgs);
    expect(result.exit).toBe(1); expect(result.out).toBe(""); expect(recoverLocal).toHaveBeenCalledOnce();
    expect(requests.map(r => r.init.method)).toEqual(["GET", "GET"]);
    const error = JSON.parse(result.err).error;
    expect(error).toMatchObject({ operation: "bot.recover", botId, deletionId, reason: code, outcomeUnconfirmed: false });
    expect(error).not.toHaveProperty("confirmed"); expect(result.err).not.toContain("SECRET-PAT");
  });
  it.each([true, false])("reports a stopped generation without confirming deletion (JSON=%s)", async json => {
    const stopped = Object.assign(new Error("SECRET-PAT original journal"), { code: "evidence_missing", generationStopped: true });
    const recoverLocal = vi.fn().mockRejectedValue(new AggregateError([new Error("Local inspection failed", { cause: stopped })]));
    const { run, requests } = await fixture(initial, { recoverLocal });
    const result = await run(json ? recoverArgs : recoverArgs.slice(0, -1));
    expect(result.exit).toBe(1); expect(result.out).toBe(""); expect(recoverLocal).toHaveBeenCalledOnce();
    expect(requests.map(r => r.init.method)).toEqual(["GET", "GET"]);
    if (json) {
      const error = JSON.parse(result.err).error;
      expect(error).toMatchObject({ reason: "evidence_missing", outcomeUnconfirmed: false });
      expect(error).not.toHaveProperty("confirmed"); expect(error).not.toHaveProperty("receiptConfirmed");
    }
    expect(result.err).toContain("The original generation is stopped; historical cleanup evidence is missing");
    expect(result.err).toContain("Deletion remains incomplete"); expect(result.err).toContain("Inspect the retained local files");
    expect(result.err).toContain(`daynight bot show ${botId} --json`); expect(result.err).not.toContain("SECRET-PAT");
  });
  it("retains an unknown ordinary receipt outcome without another recovery attempt", async () => {
    const failure = new ApiError({ operation: "worker.bots.deletion" }, "request", { outcomeUnconfirmed: true, cause: new Error("SECRET-PAT lost receipt") });
    const recoverLocal = vi.fn().mockRejectedValue(new Error("Local recovery failed", { cause: failure }));
    const { run, requests } = await fixture(initial, { recoverLocal });
    const result = await run(recoverArgs);
    expect(result.exit).toBe(1); expect(recoverLocal).toHaveBeenCalledOnce(); expect(requests).toHaveLength(2);
    const error = JSON.parse(result.err).error;
    expect(error).toMatchObject({ deletionId, outcomeUnconfirmed: true, reconcile: `daynight bot show ${botId} --json` });
    expect(error).not.toHaveProperty("confirmed"); expect(result.err).not.toContain("SECRET-PAT");
  });
  it.each(["disconnect", "truncated", "unauthenticated-after-receipt", "confirmed-output"])("propagates %s from the real completion client and HTTP socket to CLI output", async outcome => {
    const received: { method: string; url: string; body: unknown }[] = [];
    let accepted = false;
    const server = createServer((request, response) => {
      let text = "";
      request.setEncoding("utf8"); request.on("data", chunk => { text += chunk; });
      request.on("end", () => {
        received.push({ method: request.method!, url: request.url!, body: text === "" ? null : JSON.parse(text) });
        response.setHeader("Content-Type", "application/json"); response.setHeader("Daynight-User-ID", botId);
        if (request.method === "GET" && request.url === "/api/v1/me") { response.end(JSON.stringify(user)); return; }
        if (request.method === "GET" && request.url === `/api/v1/me/bots/${botId}`) { response.end(JSON.stringify(state(accepted))); return; }
        if (request.method === "POST" && request.url === `/api/v1/me/workers/${workerId}/bots/${botId}/deletion-complete`) {
          accepted = true;
          if (outcome === "disconnect") { request.socket.destroy(); return; }
          if (outcome === "truncated") {
            response.setHeader("Content-Length", "4096"); response.setHeader("Connection", "close"); response.end('{"id":'); return;
          }
          if (outcome === "unauthenticated-after-receipt") {
            response.statusCode = 401;
            response.end(JSON.stringify({ error: { code: "unauthenticated", message: "Cleanup credential expired", requestId: "cleanup-auth" } })); return;
          }
          response.end(JSON.stringify(state(true))); return;
        }
        response.statusCode = 404; response.end(JSON.stringify({ error: { code: "not_found", message: "Unexpected fixture route", requestId: "unexpected" } }));
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing fixture address.");
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const completion: BotDeletionReceipt = { deletionId, result: { state: "completed", code: null }, stop: {
      protocol: "daynight.session.v1", sessionId: botId, testExecutionId: workerId, executionGeneration: "1", controllerId: deletionId, controllerInstanceId: otherId,
      stopProof: { recordId: otherId, previousControllerInstanceId: otherId, stoppedAt: "2026-01-01T00:00:00Z" },
    } };
    const originalReceipt = structuredClone(completion);
    const recoverLocal = vi.fn<NonNullable<BotRecoveryCommandDependencies["recoverLocal"]>>(async input => {
      // Native stopping is outside this HTTP boundary; the retained cleanup
      // receipt is the production client's unchanged submission input.
      const owner = { serverOrigin: input.serverUrl, ownerUserId: input.ownerUserId, workerId };
      const record: BotRecord = { owner, botId, observed: input.bot, definition: null, intent: null, observedAt: 1,
        cleanup: { deletionId, requestedVersion: input.bot.deletion.requestedVersion, localCompleted: true, stop: completion.stop, targets: [] } };
      const original = structuredClone(record);
      try {
        await createBotSessionApi({ owner, serverToken: input.serverToken }).completeDeletion(record, completion, input.signal);
        return { receiptConfirmed: true };
      } finally { expect(record).toEqual(original); expect(completion).toEqual(originalReceipt); }
    });
    const { run } = await fixture((url, init) => fetch(url, init), { recoverLocal }, outcome === "confirmed-output", serverUrl);
    const result = await run(recoverArgs), error = JSON.parse(result.err).error;
    expect(result.exit).toBe(1); expect(result.out).toBe(""); expect(recoverLocal).toHaveBeenCalledOnce();
    expect(received.filter(request => request.method === "POST")).toEqual([{ method: "POST", url: `/api/v1/me/workers/${workerId}/bots/${botId}/deletion-complete`, body: originalReceipt }]);
    expect(error).toMatchObject({ botId, deletionId, reconcile: `daynight bot show ${botId} --json`, outcomeUnconfirmed: outcome !== "confirmed-output" });
    if (outcome === "confirmed-output") expect(error).toMatchObject({ confirmed: true, phase: "output" });
    else {
      expect(error).not.toHaveProperty("confirmed"); expect(error).not.toHaveProperty("reason", "stop_unproven");
      expect(error.phase).toBe(outcome === "disconnect" ? "request" : "response");
      if (outcome === "unauthenticated-after-receipt") expect(error).toMatchObject({ status: 401, code: "unauthenticated" });
      expect(received.map(request => request.method)).toEqual(["GET", "GET", "POST"]);
    }
    expect(result.err).not.toContain("SECRET-PAT");
  });
  it("retains a confirmed receipt when the following ordinary Bot read fails", async () => {
    let reads = 0;
    const recoverLocal = vi.fn().mockResolvedValue({ receiptConfirmed: true });
    const { run, requests } = await fixture(url => {
      if (url.pathname === "/api/v1/me") return jsonResponse(user);
      if (++reads === 2) throw new Error("SECRET-PAT read failed");
      return jsonResponse(state());
    }, { recoverLocal });
    const result = await run(recoverArgs);
    expect(result.exit).toBe(1); expect(recoverLocal).toHaveBeenCalledOnce(); expect(requests).toHaveLength(3);
    expect(JSON.parse(result.err).error).toMatchObject({ confirmed: true, outcomeUnconfirmed: false, deletionId });
  });
  it.each(["local-close", "output"])("retains confirmation after %s fails", async failure => {
    let reads = 0;
    const recoverLocal = failure === "local-close"
      ? vi.fn().mockRejectedValue(Object.assign(new Error("SECRET-PAT close"), { code: "local_cleanup_failed", receiptConfirmed: true }))
      : vi.fn().mockResolvedValue({ receiptConfirmed: true });
    const { run } = await fixture(url => jsonResponse(url.pathname === "/api/v1/me" ? user : state(++reads === 2)), { recoverLocal }, failure === "output");
    const result = await run(recoverArgs);
    expect(result.exit).toBe(1); expect(JSON.parse(result.err).error).toMatchObject({ confirmed: true, outcomeUnconfirmed: false });
    expect(result.err).not.toContain("SECRET-PAT");
  });
  it.each(["unauthorized", "principal"])("refuses %s before local recovery", async failure => {
    const recoverLocal = vi.fn();
    const { run } = await fixture(url => {
      if (failure === "unauthorized") return jsonResponse({ error: { code: "unauthenticated", message: "login required", requestId: "refused" } }, 401);
      const response = initial(url); response.headers.set("Daynight-User-ID", otherId); return response;
    }, { recoverLocal });
    const result = await run(recoverArgs);
    expect(result.exit).toBe(1); expect(recoverLocal).not.toHaveBeenCalled(); expect(result.out).toBe("");
    expect(JSON.parse(result.err).error.status).toBe(failure === "unauthorized" ? 401 : 200);
  });
  it.each([["recover", botId], ["recover", "invalid", "--deletion-id", deletionId], ["recover", botId, "--deletion-id", "invalid"], ["deletion", "recover", botId], ["inspect", botId], ["resolve", botId], ["retry-cleanup", botId]].map(args => ({ args })))("rejects invalid or unsupported arguments before network: $args", async ({ args }) => {
    const { run, requests } = await fixture(initial);
    expect((await run(args)).exit).toBe(2); expect(requests).toHaveLength(0);
  });
  it("exposes only the local recovery command help without authentication", async () => {
    const { run, requests } = await fixture(initial);
    const result = await run(["recover", "--help"]);
    expect(result.exit).toBe(0); expect(requests).toHaveLength(0);
    expect(result.out).toContain("Usage: daynight bot recover"); expect(result.out).not.toContain("--accept-local-unverified");
  });
});
