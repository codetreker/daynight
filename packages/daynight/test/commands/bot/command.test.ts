import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../../../src/cli/context.js";
import { runCli } from "../../../src/cli/application.js";
import { commands } from "../../../src/cli/commands.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";
import * as api from "../../../src/api/index.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const now = "2026-11-04T10:00:00Z";
const bot = { id, workerId, ownerUserId: id, version: "9007199254740993", creationOrder: "9007199254740994", name: "助手", requestedOverrides: {}, resolvedConfiguration: { workerId, cwd: "/ordinary", provider: "codex", model: null, args: [] }, roleConfiguration: null, sessionId: null, testExecutionId: null, startupResult: { state: "pending", code: null }, deletion: null, createdAt: now, updatedAt: now };
const deleted = (worker = "pending", server = "pending") => ({ id, workerId, version: "9007199254740994", deletion: { deletionId: requestId, requestedVersion: bot.version, workerCleanup: { state: worker, code: worker === "failed" ? "stop_failed" : null }, serverCleanup: { state: server, code: null } } });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const fixture = async (respond: (url: URL, init: RequestInit) => Response | Promise<Response>, failCleanup = false) => {
  vi.stubEnv("DN_CONFIG_DIR", undefined);
  const root = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "home-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".daynight"));
  await writeFile(path.join(home, ".daynight/config.yml"), "serverUrl: http://127.0.0.1:8787\nserverToken: SECRET-PAT\n");
  let out = "", err = "";
  const context = { version: "test", packageDirectory: "unused", homeDirectory: () => home, workingDirectory: () => { throw new Error("Must not discover a project"); }, closeStdoutBytes: async () => { if (failCleanup) throw new Error("local cleanup failed SECRET-PAT"); }, stdout: (s: string) => { out += s; }, stdoutBytes: async (s: Uint8Array) => { out += Buffer.from(s).toString(); }, stderr: (s: string) => { err += s; } };
  const signals = new EventEmitter();
  const requests: { url: URL; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => { const url = new URL(String(input)); requests.push({ url, init: init! }); return respond(url, init!); };
  const run = async (args: string[]) => {
    const registered = commands.find((c) => c.name === "bot");
    const registry = commands.map((c) => c.name !== "bot" ? c : { ...c, load: async () => {
      const module = await import("../../../src/commands/bot/commands.js");
      return { run: (args: readonly string[], current: CliContext) => module.runBotCommand(args, current, { runServerCommand: (ctx, action, options) => runServerCommand(ctx, action, { ...options, fetch, signalEmitter: signals }) }) };
    } });
    const exit = await runCli(["bot", ...args], context, registered === undefined ? commands : registry);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    return { exit, out, err };
  };
  return { run, requests };
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "Daynight-User-ID": id } });

describe("public Bot commands", () => {
  it.each([undefined, 0, 3])("accepts legacy and attention-aware Bot responses with count %s", async attentionCount => {
    const value = { ...bot, ...(attentionCount === undefined ? {} : { attentionCount }) };
    const { run } = await fixture((url, init) => json(url.pathname === "/api/v1/me/bots" && init.method === "GET" ? { items: [value], nextCursor: null } : value));
    const shown = await run(["show", id, "--json"]);
    expect(shown.exit).toBe(0); expect(JSON.parse(shown.out)).toEqual(value);
    const created = await run(["create", "--name", "助手", "--request-id", id, "--json"]);
    expect(created.exit).toBe(0); expect(JSON.parse(created.out.slice(shown.out.length))).toEqual(value);
    const listed = await run(["list", "--json"]);
    expect(listed.exit).toBe(0); expect(JSON.parse(listed.out.slice(created.out.length))).toEqual([value]);
  });
  it.each([-1, 0.5, "1", null, Number.MAX_SAFE_INTEGER + 1])("rejects malformed attention count %s", async attentionCount => {
    const { run, requests } = await fixture(() => json({ ...bot, attentionCount }));
    const result = await run(["show", id, "--json"]);
    expect(result.exit).toBe(1); expect(result.out).toBe(""); expect(requests).toHaveLength(1);
  });
  it.each([{}, { model: "native-model" }, { reasoningEffort: "none" }, { model: "native-model", reasoningEffort: "none" }])("preserves explicit native choices %j through the creation receipt", async (native) => {
    const overrides = { workerId, ...native };
    const config = { ...bot.resolvedConfiguration, model: native.model ?? null, reasoningEffort: native.reasoningEffort ?? null, selection: { schemaVersion: 1, modelSource: native.model ? "explicit" : "native", reasoningEffortSource: native.reasoningEffort ? "explicit" : "native" } };
    const { run, requests } = await fixture(() => json({ ...bot, requestedOverrides: overrides, resolvedConfiguration: config }));
    const result = await run(["create", "--name", "助手", "--worker", workerId, "--request-id", id, "--json", ...(native.model ? ["--model", native.model] : []), ...(native.reasoningEffort ? ["--reasoning-effort", native.reasoningEffort] : [])]);
    expect(result.exit).toBe(0);
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({ id, name: "助手", overrides });
    expect(JSON.parse(result.out).resolvedConfiguration).toEqual(config);
  });
  it.each([["--model", ""], ["--model", "x".repeat(257)], ["--reasoning-effort", "x".repeat(65)], ["--reasoning-effort", "high\n"]])("rejects invalid native choice %j without HTTP", async (flag, value) => {
    const { run, requests } = await fixture(() => json(bot));
    expect((await run(["create", "--name", "助手", flag, value])).exit).toBe(2);
    expect(requests).toHaveLength(0);
  });
  it.each(["missing", "different", "source"])("retains the original identity after a %s native selection receipt without replay", async failure => {
    const overrides = { workerId, model: "chosen", reasoningEffort: "none" };
    const config = { ...bot.resolvedConfiguration, model: "chosen", reasoningEffort: "none", selection: { schemaVersion: 1, modelSource: failure === "source" ? "cloud" : "explicit", reasoningEffortSource: "explicit" } };
    const response = { ...bot, requestedOverrides: failure === "missing" ? { workerId } : failure === "different" ? { ...overrides, model: "other" } : overrides, resolvedConfiguration: config };
    const { run, requests } = await fixture(() => json(response));
    const result = await run(["create", "--name", "助手", "--worker", workerId, "--model", "chosen", "--reasoning-effort", "none", "--request-id", id, "--json"]);
    expect(result.exit).toBe(1);
    expect(JSON.parse(result.err).error).toMatchObject({ botId: id, outcomeUnconfirmed: true });
    expect(requests).toHaveLength(1);
  });
  it("creates with only a name and a pre-generated identity, preserving pending and exact decimal strings", async () => {
    const { run, requests } = await fixture((_url, init) => json({ ...bot, id: JSON.parse(init.body as string).id }));
    const result = await run(["create", "--name", "助手", "--json"]);
    expect(result.exit).toBe(0);
    const body = JSON.parse(requests[0]!.init.body as string);
    expect(body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "助手" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe("/api/v1/me/bots");
    expect(JSON.parse(result.out)).toMatchObject({ id: body.id, version: "9007199254740993", startupResult: { state: "pending" } });
    expect(result.out + result.err).not.toContain("SECRET-PAT");
  });
  it("maps explicit overrides and request ID without resolving defaults locally", async () => {
    const overrides = { workerId, cwd: "C:\\work", provider: "claude" };
    const { run, requests } = await fixture(() => json({ ...bot, requestedOverrides: overrides, resolvedConfiguration: { ...bot.resolvedConfiguration, cwd: overrides.cwd, provider: overrides.provider } }));
    expect((await run(["create", "--name", "助手", "--worker", workerId, "--cwd", overrides.cwd, "--agent", "claude", "--request-id", id])).exit).toBe(0);
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({ id, name: "助手", overrides });
  });
  it("prints the unchanged active Bot on a creation replay using its original identity", async () => {
    const { run, requests } = await fixture(() => json(bot));
    const first = await run(["create", "--name", "助手", "--request-id", id, "--json"]);
    const second = await run(["create", "--name", "助手", "--request-id", id, "--json"]);
    expect(first.exit).toBe(0); expect(second.exit).toBe(0);
    expect(JSON.parse(first.out)).toEqual(bot);
    expect(JSON.parse(second.out.slice(first.out.length))).toEqual(bot);
    expect(requests.map(({ init }) => JSON.parse(String(init.body)))).toEqual([{ id, name: "助手" }, { id, name: "助手" }]);
    expect(second.err).toBe("");
  });
  it("prints every returned field of an active Bot on show", async () => {
    const { run, requests } = await fixture(() => json(bot));
    const result = await run(["show", id, "--json"]);
    expect(result.exit).toBe(0); expect(JSON.parse(result.out)).toEqual(bot);
    expect(requests.map(({ url, init }) => `${init.method} ${url.pathname}`)).toEqual([`GET /api/v1/me/bots/${id}`]);
    expect(result.err).toBe("");
  });

  it("prints the exact Bot returned by list after a refused creation", async () => {
    let creates = 0;
    const { run, requests } = await fixture((_url, init) => init.method === "POST"
      ? ++creates === 1 ? json(bot) : json({ error: { code: "resource_conflict", message: "rejected", requestId: "refused" } }, 409)
      : json({ items: [bot], nextCursor: null }));
    const created = await run(["create", "--name", "助手", "--request-id", id, "--json"]);
    expect(created.exit).toBe(0); expect(JSON.parse(created.out)).toEqual(bot);
    const rejected = await run(["create", "--name", "changed", "--request-id", id, "--json"]);
    expect(rejected.exit).toBe(1); expect(rejected.out).toBe(created.out);
    const listed = await run(["list", "--json"]);
    expect(listed.exit).toBe(0); expect(JSON.parse(listed.out.slice(rejected.out.length))).toEqual([bot]);
    expect(requests.map(({ init }) => init.method)).toEqual(["POST", "POST", "GET"]);
  });

  it("prints completed deletion replays and the exact remaining Bot list", async () => {
    const other = { ...bot, id: requestId, name: "Keep me" };
    const completed = deleted("completed", "completed");
    const { run, requests } = await fixture((_url, init) => init.method === "DELETE" ? json(completed) : json({ items: [other], nextCursor: null }));
    const args = ["delete", id, "--if-version", bot.version, "--request-id", requestId, "--json"];
    const first = await run(args);
    const replay = await run(args);
    expect(first.exit).toBe(0); expect(replay.exit).toBe(0);
    expect(JSON.parse(first.out)).toEqual(completed);
    expect(JSON.parse(replay.out.slice(first.out.length))).toEqual(completed);
    const listed = await run(["list", "--json"]);
    expect(listed.exit).toBe(0); expect(JSON.parse(listed.out.slice(replay.out.length))).toEqual([other]);
    expect(requests.map(({ init }) => init.method)).toEqual(["DELETE", "DELETE", "GET"]);
    for (const { init } of requests.slice(0, 2)) expect(JSON.parse(String(init.body))).toEqual({ ifVersion: bot.version, deletionId: requestId });
    expect(listed.err).toBe("");
  });
  it("prints both completed cleanup phases on Bot show", async () => {
    const tombstone = deleted("completed", "completed");
    const { run, requests } = await fixture(() => json(tombstone));
    const result = await run(["show", id, "--json"]);
    expect(result.exit).toBe(0); expect(JSON.parse(result.out)).toEqual(tombstone);
    expect(requests.map(({ init }) => init.method)).toEqual(["GET"]);
    expect(result.err).toBe("");
  });
  it.each([
    [["create", "--name", "changed", "--request-id", id, "--json"], "resource_conflict"],
    [["create", "--name", "Legacy", "--worker", workerId, "--json"], "resource_conflict"],
    [["create", "--name", "Unavailable", "--worker", workerId, "--agent", "claude", "--json"], "resource_conflict"],
    [["create", "--name", "Offline", "--worker", workerId, "--json"], "resource_conflict"],
    [["delete", id, "--if-version", "1", "--json"], "version_conflict"],
  ])("exposes the definite refusal for %j without success output", async (args, code) => {
    const { run, requests } = await fixture(() => json({ error: { code, message: "rejected", requestId: "refused" } }, 409));
    const result = await run(args);
    expect(result.exit).toBe(1); expect(result.out).toBe("");
    expect(JSON.parse(result.err).error).toMatchObject({ code, outcomeUnconfirmed: false });
    expect(requests).toHaveLength(1);
  });
  it.each(["pending", "completed"])("accepts a creation replay with a %s deletion tombstone", async (state) => {
    const tombstone = deleted(state, state);
    const { run, requests } = await fixture(() => json(tombstone));
    const result = await run(["create", "--name", "助手", "--worker", workerId, "--cwd", "/ordinary", "--agent", "codex", "--request-id", id, "--json"]);
    expect(result.exit).toBe(0);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out)).toEqual(tombstone);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.init.method).toBe("POST");
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({ id, name: "助手", overrides: { workerId, cwd: "/ordinary", provider: "codex" } });
  });
  it("renders a deleted creation replay without claiming a new definition or startup", async () => {
    const { run } = await fixture(() => json(deleted("completed", "completed")));
    const result = await run(["create", "--name", "助手", "--request-id", id]);
    expect(result.exit).toBe(0);
    expect(result.out).toContain("Deletion: completed");
    expect(result.out).not.toContain("Startup:");
    expect(result.out).not.toContain("Name:");
    expect(result.err).toBe("");
  });
  it.each(["wrong-id", "wrong-worker", "invalid-version", "missing-principal"])("rejects a creation tombstone with %s", async (failure) => {
    const tombstone = { ...deleted(), ...(failure === "wrong-id" ? { id: requestId } : {}), ...(failure === "wrong-worker" ? { workerId: requestId } : {}), ...(failure === "invalid-version" ? { version: bot.version } : {}) };
    const { run, requests } = await fixture(() => failure === "missing-principal" ? new Response(JSON.stringify(tombstone), { status: 200, headers: { "content-type": "application/json" } }) : json(tombstone));
    const result = await run(["create", "--name", "助手", "--worker", workerId, "--request-id", id, "--json"]);
    expect(result.exit).toBe(1);
    expect(result.out).toBe("");
    expect(JSON.parse(result.err).error.outcomeUnconfirmed).toBe(true);
    expect(requests).toHaveLength(1);
  });
  it.each(["name", "overrides"])("still rejects an active creation response with different %s", async (field) => {
    const response = field === "name" ? { ...bot, name: "Another assistant" } : { ...bot, requestedOverrides: { provider: "codex" } };
    const { run } = await fixture(() => json(response));
    const result = await run(["create", "--name", "助手", "--request-id", id, "--json"]);
    expect(result.exit).toBe(1);
    expect(result.out).toBe("");
    expect(JSON.parse(result.err).error.outcomeUnconfirmed).toBe(true);
  });
  it("prints no partial list on a later-page failure", async () => {
    const { run } = await fixture((url) => url.searchParams.has("cursor") ? json({ error: { code: "internal", message: "unavailable", requestId: "page-2" } }, 500) : json({ items: [bot], nextCursor: "opaque next" }));
    const result = await run(["list", "--json"]);
    expect(result.exit).toBe(1); expect(result.out).toBe(""); expect(result.err).toContain("internal");
  });
  it("collects all pages and passes opaque cursors unchanged", async () => {
    const { run, requests } = await fixture((url) => json(url.searchParams.has("cursor") ? { items: [{ ...bot, id: requestId }], nextCursor: null } : { items: [bot], nextCursor: "opaque /+?" }));
    const result = await run(["list", "--json"]);
    expect(result.exit).toBe(0); expect(JSON.parse(result.out)).toHaveLength(2);
    expect(requests[1]!.url.searchParams.get("cursor")).toBe("opaque /+?");
  });
  it.each([false, true])("reads count-based Bot pages within the aggregate budget (total exceeded: %s)", async exceedsTotal => {
    const createOperation = api.createOperation;
    vi.spyOn(api, "createOperation").mockImplementation(options => createOperation({ ...options, limits: { responseBytes: 1024, totalBytes: 4096, ...options?.limits } }));
    const large = { ...bot, resolvedConfiguration: { ...bot.resolvedConfiguration, args: ["--add-dir", "/" + "x".repeat(1800)] } };
    const second = { ...(exceedsTotal ? large : bot), id: requestId };
    const { run, requests } = await fixture(url => json(url.searchParams.has("cursor") ? { items: [second], nextCursor: null } : { items: [large], nextCursor: "next" }));
    const result = await run(["list", "--json"]);
    expect(requests.map(({ url }) => url.searchParams.get("limit"))).toEqual(["100", "100"]);
    expect(requests[1]!.url.searchParams.get("cursor")).toBe("next");
    if (exceedsTotal) {
      expect(result.exit).toBe(1);
      expect(result.out).toBe("");
      expect(JSON.parse(result.err).error).toMatchObject({ operation: "bot.list", phase: "response", outcomeUnconfirmed: false });
    } else {
      expect(result.exit).toBe(0);
      expect(JSON.parse(result.out)).toEqual([large, second]);
    }
  });
  it.each([401, 403, 404, 409])("preserves HTTP %s refusal and stable IDs without retry", async (status) => {
    const { run, requests } = await fixture(() => json({ error: { code: "version_conflict", message: "rejected", requestId: "server-request" } }, status));
    const result = await run(["delete", id, "--if-version", bot.version, "--request-id", requestId, "--json"]);
    expect(result.exit).toBe(1); expect(result.out).toBe(""); expect(result.err).toContain(String(status)); expect(result.err).toContain("version_conflict"); expect(requests).toHaveLength(1);
  });
  it.each(["disconnect", "malformed", "wrong-id", "server-error"])("retains the original create identity after %s without another POST", async (failure) => {
    const { run, requests } = await fixture(() => { if (failure === "disconnect") throw new Error("network SECRET-PAT"); if (failure === "malformed") return json({ id }); if (failure === "server-error") return json({ error: { code: "internal", message: "failed", requestId: "server-request" } }, 500); return json(bot); });
    const result = await run(["create", "--name", "助手", "--json"]);
    const sent = JSON.parse(requests[0]!.init.body as string).id;
    expect(result.exit).toBe(1); expect(result.err).toContain(sent); expect(result.err).toContain(`daynight bot show ${sent}`); expect(JSON.parse(result.err).error.outcomeUnconfirmed).toBe(true); expect(result.out + result.err).not.toContain("SECRET-PAT"); expect(requests).toHaveLength(1);
  });
  it.each([["pending", "completed", "pending"], ["completed", "completed", "completed"], ["failed", "pending", "failed"]])("renders cleanup %s/%s as %s", async (worker, server, state) => {
    const { run, requests } = await fixture(() => json(deleted(worker, server)));
    const result = await run(["delete", id, "--if-version", bot.version, "--request-id", requestId]);
    expect(result.exit).toBe(0); expect(result.out).toContain(`Deletion: ${state}`);
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({ ifVersion: "9007199254740993", deletionId: requestId });
  });
  it("reads a deletion tombstone without fabricating a definition", async () => {
    const tombstone = deleted(); const { run } = await fixture(() => json(tombstone));
    const result = await run(["show", id, "--json"]);
    expect(result.exit).toBe(0); expect(JSON.parse(result.out)).toEqual(tombstone);
  });
  it.each([["create", "--name", ""], ["create", "--name", "a\n"], ["create", "--name", "x".repeat(41)], ["create", "--name", "a", "--agent", "other"], ["show", "bad"], ["delete", id], ["delete", id, "--if-version", "9223372036854775808"]])("rejects bad arguments without network: %j", async (...args) => {
    const { run, requests } = await fixture(() => json(bot)); const result = await run(args);
    expect(result.exit).toBe(2); expect(requests).toHaveLength(0);
  });
  it("renders help without authentication or repository access", async () => {
    const { run, requests } = await fixture(() => { throw new Error("No HTTP for help"); });
    expect((await run(["create", "--help"])).exit).toBe(0); expect(requests).toHaveLength(0);
  });
});

describe("Bot failure reasons and reconciliation", () => {
  it.each(["no_available_worker", "offline", "provider_timeout", "invalid_cwd"])("keeps the actionable configuration failure %s", async (reason) => {
    const { run } = await fixture(() => json({ error: { code: "resource_conflict", message: `Bot configuration is unavailable: ${reason}. Read current defaults before submitting a new request.`, requestId: "configuration-failure" } }, 409));
    const result = await run(["create", "--name", "助手", "--json"]);
    expect(result.exit).toBe(1); expect(JSON.parse(result.err).error.reason).toBe(reason);
  });
  it("retains bound-session deletion refusal without exposing arbitrary server text", async () => {
    const { run } = await fixture(() => json({ error: { code: "resource_conflict", message: "A bound Bot requires the Session deletion barrier.", requestId: "bound" } }, 409));
    const result = await run(["delete", id, "--if-version", bot.version, "--json"]);
    expect(JSON.parse(result.err).error.reason).toBe("session_deletion_barrier_required");
  });
  it("keeps deletion identity after a lost response and supports authoritative show", async () => {
    let body: { deletionId: string; ifVersion: string } | undefined;
    const { run, requests } = await fixture((_url, init) => { if (init.method === "DELETE") { body = JSON.parse(init.body as string); throw new Error("lost response"); } return json({ ...deleted(), deletion: { ...deleted().deletion, deletionId: body!.deletionId } }); });
    const result = await run(["delete", id, "--if-version", bot.version, "--json"]);
    expect(JSON.parse(result.err).error).toMatchObject({ botId: id, requestId: body!.deletionId, outcomeUnconfirmed: true });
    const observed = await run(["show", id, "--json"]);
    expect(observed.exit).toBe(0); expect(JSON.parse(observed.out).deletion.deletionId).toBe(body!.deletionId);
    expect(requests.map(r => r.init.method)).toEqual(["DELETE", "GET"]);
  });
  it.each(["duplicate", "cursor", "principal", "secret"])("rejects invalid complete list: %s", async (failure) => {
    let page = 0;
    const { run } = await fixture(() => {
      page++;
      if (failure === "secret") return json({ items: [{ ...bot, serverToken: "SECRET-PAT" }], nextCursor: null });
      const response = json({ items: page === 1 ? [bot] : failure === "duplicate" ? [bot] : [], nextCursor: page === 1 || failure === "cursor" ? "next" : null });
      if (page === 2 && failure === "principal") response.headers.set("Daynight-User-ID", workerId);
      return response;
    });
    const result = await run(["list", "--json"]);
    expect(result.exit).toBe(1); expect(result.out).toBe(""); expect(result.err).not.toContain("SECRET-PAT");
  });
});

it("preserves an unconfirmed mutation when local cleanup also fails", async () => {
  const { run, requests } = await fixture(() => { throw new Error("response lost"); }, true);
  const result = await run(["create", "--name", "助手", "--json"]);
  expect(result.exit).toBe(1);
  expect(JSON.parse(result.err).error).toMatchObject({ outcomeUnconfirmed: true, phase: "request", requestId: JSON.parse(requests[0]!.init.body as string).id });
  expect(result.err).not.toContain("SECRET-PAT");
});

it("retains deletion identity and exact version across pending and completed receipts", async () => {
  let count = 0;
  const { run, requests } = await fixture(() => json(deleted(++count === 1 ? "pending" : "completed", count === 1 ? "pending" : "completed")));
  const first = await run(["delete", id, "--if-version", bot.version, "--request-id", requestId, "--json"]);
  expect(first.exit).toBe(0);
  expect(JSON.parse(first.out)).toEqual(deleted());
  const second = await run(["delete", id, "--if-version", bot.version, "--request-id", requestId, "--json"]);
  expect(second.exit).toBe(0);
  expect(JSON.parse(second.out.slice(first.out.length))).toEqual(deleted("completed", "completed"));
  expect(requests.map(({ init }) => init.method)).toEqual(["DELETE", "DELETE"]);
  for (const { url, init } of requests) {
    expect(url.pathname).toBe(`/api/v1/me/bots/${id}`);
    expect(JSON.parse(String(init.body))).toEqual({ ifVersion: bot.version, deletionId: requestId });
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer SECRET-PAT");
  }
  expect(first.out + first.err + second.out + second.err).not.toContain("SECRET-PAT");
});
