import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWebhookCommand } from "../../../src/commands/webhook/command.js";

// Transport fault injection does not establish a production commit.
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", personalTeam = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const endpoint = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", operation = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const delivery = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", other = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const owner = { kind: "personal", id: actor };
const me = { id: actor, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: personalTeam, kind: "personal", name: null } };
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const reply = (value: unknown, status = 200, principal = actor) => new Response(typeof value === "string" ? value : JSON.stringify(value), { status, headers: { "content-type": "application/json", "Daynight-User-ID": principal } });
const refusal = (code: string, status: number) => reply({ error: { code, message: "injected fault", requestId: operation } }, status);
const diagnostic = (error: unknown) => JSON.parse((error as Error).message).error as Record<string, unknown>;
const receipt = (at: string, sha: string, overrides: Record<string, unknown> = {}) => ({ operationId: operation, kind: "endpoint.patch", issuedAt: at, requestSha256: sha, actorUserId: actor, owner, endpointId: endpoint, effect: "applied", configVersionAfter: "2", destinationRevisionAfter: "1", deliveryId: null, generationAfter: null, keyId: null, recordedAt: at, expiresAt: "2099-01-01T00:00:00Z", ...overrides });
const body = (at: string) => JSON.stringify({ operationId: operation, issuedAt: at, expectedUserId: actor, ifVersion: "1", enabled: true });
const prepared = (at: string, overrides: Record<string, unknown> = {}) => ({ formatVersion: 1, serverOrigin: "http://localhost:8787", actorUserId: actor, owner, kind: "endpoint.patch", operationId: operation, issuedAt: at, endpointId: endpoint, deliveryId: null, ifVersion: "1", ifGeneration: null, requestSha256: hash(body(at)), ...overrides });
const freshArgs = (at: string) => ["enable", endpoint, "--personal", "--if-version", "1", "--confirm", "--json", "--operation-id", operation, "--issued-at", at];
const resumeArgs = (file: string) => ["enable", endpoint, "--personal", "--if-version", "1", "--confirm", "--json", "--resume-operation", file];
const makeFixture = async () => {
  const base = path.resolve("../../.tmp"); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "webhook-faults-")); dirs.push(dir);
  vi.stubEnv("DN_CONFIG_DIR", dir); await writeFile(path.join(dir, "config.yml"), "serverUrl: http://localhost:8787\nserverToken: test-token\n");
  const calls: { method: string; path: string; body: string | null }[] = [], chunks: Buffer[] = [];
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => dir, workingDirectory: () => dir, stdout: vi.fn(), stderr: vi.fn(), stdoutBytes: async (bytes: Uint8Array) => { chunks.push(Buffer.from(bytes)); } };
  let response = (_url: URL, _init?: RequestInit): Response | Promise<Response> => { throw new Error("Unexpected request"); };
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url)); calls.push({ method: init?.method ?? "GET", path: parsed.pathname, body: typeof init?.body === "string" ? init.body : null });
    if (parsed.pathname === "/api/v1/me") return reply(me);
    return response(parsed, init);
  }));
  return { dir, calls, chunks, context, setResponse: (fn: typeof response) => { response = fn; } };
};

describe("Webhook transport fault boundaries", () => {
  it.skipIf(process.platform === "win32").each(["offset", "long fraction"])("keeps the original %s issuedAt through prepared and receipt reconciliation", async (kind) => {
    const f = await makeFixture();
    const now = new Date().toISOString();
    const at = kind === "offset" ? now.replace("Z", "+00:00") : `${now.slice(0, -1)}${"0".repeat(10_000)}Z`;
    const file = path.join(f.dir, "prepared.json");
    f.setResponse((_url, init) => {
      if (init?.method === "PATCH") throw new Error("lost response");
      return reply(receipt(at, hash(body(at)), { recordedAt: now }));
    });
    await runWebhookCommand([...freshArgs(at), "--operation-out", file], f.context);
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "PATCH", "GET"]);
    expect(f.calls[1]!.body).toBe(body(at));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(prepared(at));
    expect(JSON.parse(Buffer.concat(f.chunks).toString()).operation.issuedAt).toBe(at);
    f.chunks.length = 0;
    const before = f.calls.length;
    await runWebhookCommand(resumeArgs(file), f.context);
    expect(f.calls.slice(before).map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(JSON.parse(Buffer.concat(f.chunks).toString()).operation.issuedAt).toBe(at);
  });
  it("keeps a caller-supplied original operation unknown when this invocation is refused", async () => {
    const f = await makeFixture(); const at = new Date().toISOString();
    f.setResponse(() => refusal("forbidden", 403));
    const error = await runWebhookCommand(freshArgs(at), f.context).catch((e: unknown) => e);
    expect(diagnostic(error)).toMatchObject({ code: "forbidden", invocationOutcome: "rejected", operationOutcome: "unknown" });
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
  });
  it("keeps a caller-supplied original operation unknown when preparation fails before dispatch", async () => {
    const f = await makeFixture(); const at = new Date().toISOString(), file = path.join(f.dir, "already-exists.json");
    await writeFile(file, "unchanged");
    const error = await runWebhookCommand([...freshArgs(at), "--operation-out", file], f.context).catch((e: unknown) => e);
    expect(diagnostic(error)).toMatchObject({ invocationOutcome: "not_submitted", operationOutcome: "unknown" });
    expect(f.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(await readFile(file, "utf8")).toBe("unchanged");
  });
  it("reports a definite refusal for a newly generated operation", async () => {
    const f = await makeFixture();
    f.setResponse(() => refusal("forbidden", 403));
    const error = await runWebhookCommand(["enable", endpoint, "--personal", "--if-version", "1", "--confirm", "--json"], f.context).catch((e: unknown) => e);
    expect(diagnostic(error)).toMatchObject({ code: "forbidden", invocationOutcome: "rejected", operationOutcome: "rejected" });
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
  });
  it("confirms a lost response only after a receipt matches the sent bytes", async () => {
    const f = await makeFixture(); const at = new Date().toISOString(); let original = "";
    f.setResponse((_url, init) => { if (init?.method === "PATCH") { original = String(init.body); throw new Error("connection lost after dispatch"); } return reply(receipt(at, hash(original))); });
    await runWebhookCommand(freshArgs(at), f.context);
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "PATCH", "GET"]); expect(original).toBe(body(at));
    expect(JSON.parse(Buffer.concat(f.chunks).toString())).toMatchObject({ operation: { operationId: operation, requestSha256: hash(original) } });
  });
  it.each([{ requestSha256: "1".repeat(64) }, { issuedAt: "2020-01-01T00:00:00Z" }, { actorUserId: other }, { endpointId: other }])("leaves a lost operation unknown when the receipt differs: %j", async (patch) => {
    const f = await makeFixture(); const at = new Date().toISOString();
    f.setResponse((_url, init) => { if (init?.method === "PATCH") throw new Error("lost response"); return reply(receipt(at, hash(body(at)), patch)); });
    const error = await runWebhookCommand(freshArgs(at), f.context).catch((e: unknown) => e);
    expect(diagnostic(error)).toMatchObject({ code: "operation_receipt_mismatch", invocationOutcome: "unknown", operationOutcome: "unknown" });
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "PATCH", "GET"]); expect(f.chunks).toEqual([]);
  });
  it.each([["not_found", 404], ["forbidden", 403], ["dependency_unavailable", 503]] as const)("keeps the original unknown on receipt %s", async (code, status) => {
    const f = await makeFixture(); const at = new Date().toISOString();
    f.setResponse((_url, init) => { if (init?.method === "PATCH") throw new Error("lost response"); return refusal(code, status); });
    const error = await runWebhookCommand(freshArgs(at), f.context).catch((e: unknown) => e);
    expect(diagnostic(error)).toMatchObject({ invocationOutcome: "unknown", operationOutcome: "unknown" }); expect(f.calls.map((c) => c.method)).toEqual(["GET", "PATCH", "GET"]);
  });
  it("keeps an expired matching receipt unknown without resubmitting", async () => {
    const f = await makeFixture(); const at = new Date().toISOString(), file = path.join(f.dir, "prepared.json"); await writeFile(file, JSON.stringify(prepared(at)));
    f.setResponse(() => reply(receipt(at, hash(body(at)), { expiresAt: "2020-01-01T00:00:00Z" })));
    const error = await runWebhookCommand(resumeArgs(file), f.context).catch((e: unknown) => e);
    expect(diagnostic(error)).toMatchObject({ code: "operation_expired", invocationOutcome: "not_submitted", operationOutcome: "unknown" });
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });
  it("reports a receipt mismatch even when that receipt has expired", async () => {
    const f = await makeFixture(); const at = new Date().toISOString(), file = path.join(f.dir, "prepared.json"); await writeFile(file, JSON.stringify(prepared(at)));
    f.setResponse(() => reply(receipt(at, "1".repeat(64), { expiresAt: "2020-01-01T00:00:00Z" })));
    const error = await runWebhookCommand(resumeArgs(file), f.context).catch((e: unknown) => e);
    expect(diagnostic(error)).toMatchObject({ code: "operation_receipt_mismatch", invocationOutcome: "not_submitted", operationOutcome: "unknown" });
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });
  it("resends identical bytes once after an authenticated 404 within the original window", async () => {
    const f = await makeFixture(); const at = new Date().toISOString(), file = path.join(f.dir, "prepared.json"); await writeFile(file, JSON.stringify(prepared(at)));
    f.setResponse((_url, init) => init?.method === "GET" ? refusal("not_found", 404) : reply({ operation: receipt(at, hash(String(init?.body))), endpoint: { id: endpoint, owner, lifecycle: "deleted", configVersion: "2", deletedAt: at } }));
    await runWebhookCommand(resumeArgs(file), f.context);
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"]); expect(f.calls[2]!.body).toBe(body(at));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(prepared(at));
  });
  it.each([-301_000, 61_000])("does not resend outside the admission window (offset %i)", async (offset) => {
    const f = await makeFixture(); const at = new Date(Date.now() + offset).toISOString(), file = path.join(f.dir, "prepared.json"); await writeFile(file, JSON.stringify(prepared(at)));
    f.setResponse(() => refusal("not_found", 404));
    const error = await runWebhookCommand(resumeArgs(file), f.context).catch((e: unknown) => e);
    expect(diagnostic(error)).toMatchObject({ phase: "reconcile", operationOutcome: "unknown" }); expect(f.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });
  it.each([{ serverOrigin: "http://localhost:8788" }, { actorUserId: other }, { owner: { kind: "team", id: other } }, { kind: "endpoint.delete" }, { endpointId: other }, { ifVersion: "2" }, { requestSha256: "a".repeat(64) }])("does not query or resend a mismatched prepared binding: %j", async (patch) => {
    const f = await makeFixture(); const at = new Date().toISOString(), file = path.join(f.dir, "prepared.json"), original = prepared(at, patch); await writeFile(file, JSON.stringify(original));
    const error = await runWebhookCommand(resumeArgs(file), f.context).catch((e: unknown) => e);
    const { formatVersion: _formatVersion, ...binding } = original;
    expect(diagnostic(error)).toMatchObject({ code: "operation_receipt_mismatch", operationOutcome: "unknown", operation: binding });
    expect((diagnostic(error).operation as Record<string, unknown>)).not.toHaveProperty("formatVersion");
    expect(f.calls.map((c) => c.path)).toEqual(["/api/v1/me"]); expect(JSON.parse(await readFile(file, "utf8"))).toEqual(original);
  });
  it("does not resend an unfenced redelivery generation", async () => {
    const f = await makeFixture(); const at = new Date().toISOString(), file = path.join(f.dir, "prepared.json");
    const originalBody = JSON.stringify({ operationId: operation, issuedAt: at, expectedUserId: actor, ifVersion: "1", ifGeneration: "2" });
    const original = prepared(at, { kind: "delivery.redeliver", deliveryId: delivery, ifGeneration: "2", requestSha256: hash(originalBody) });
    await writeFile(file, JSON.stringify(original));
    const error = await runWebhookCommand(["delivery", "redeliver", endpoint, delivery, "--personal", "--if-version", "1", "--if-generation", "3", "--confirm", "--json", "--resume-operation", file], f.context).catch((e: unknown) => e);
    const { formatVersion: _formatVersion, ...binding } = original;
    expect(diagnostic(error)).toMatchObject({ code: "operation_receipt_mismatch", operationOutcome: "unknown", operation: binding });
    expect((diagnostic(error).operation as Record<string, unknown>)).not.toHaveProperty("formatVersion");
    expect(f.calls.map((c) => c.path)).toEqual(["/api/v1/me"]);
  });
  it("requires explicit confirmation before a 404 resume dispatch", async () => {
    const f = await makeFixture(); const at = new Date().toISOString(), file = path.join(f.dir, "prepared.json"); await writeFile(file, JSON.stringify(prepared(at)));
    f.setResponse(() => refusal("not_found", 404));
    const context = { ...f.context, prompt: { isInteractive: true, ask: vi.fn(), select: vi.fn(), selectMany: vi.fn(), close: vi.fn() } };
    const error = await runWebhookCommand(resumeArgs(file).filter((arg) => arg !== "--confirm"), context).catch((e: unknown) => e);
    expect(diagnostic(error)).toMatchObject({ phase: "reconcile", operationOutcome: "unknown" }); expect(f.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });
  it("cancels a dispatched write without replaying it", async () => {
    const f = await makeFixture(); const at = new Date().toISOString();
    f.setResponse((_url, init) => { if (init?.method === "PATCH") { queueMicrotask(() => process.emit("SIGINT")); return new Promise<Response>(() => {}); } throw new Error("No receipt observation after cancellation"); });
    const error = await runWebhookCommand(freshArgs(at), f.context).catch((e: unknown) => e);
    expect(diagnostic(error)).toMatchObject({ invocationOutcome: "unknown", operationOutcome: "unknown" }); expect(f.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });
  it("rejects an oversized response before emitting a partial result", async () => {
    const f = await makeFixture(); f.setResponse(() => reply(`{"value":"${"x".repeat(1_048_576)}"}`));
    const error = await runWebhookCommand(["show", endpoint, "--personal", "--json"], f.context).catch((e: unknown) => e);
    expect(diagnostic(error)).toMatchObject({ phase: "read", invocationOutcome: "read_failed" }); expect(f.chunks).toEqual([]);
  });
});

describe("Webhook payload transport faults", () => {
  const envelope = (bytes: Buffer) => ({ owner, endpointId: endpoint, deliveryId: delivery, eventId: operation, mediaType: "application/cloudevents+json", encoding: "base64", body: bytes.toString("base64"), bytes: bytes.length, sha256: hash(bytes) });
  const args = ["delivery", "payload", endpoint, delivery, "--personal"];
  it("writes 64 KiB of original bytes without an added newline", async () => {
    const f = await makeFixture(), bytes = Buffer.alloc(65_536, 0x61); bytes[bytes.length - 1] = 0x7d;
    f.setResponse(() => reply(envelope(bytes))); await runWebhookCommand(args, f.context);
    expect(Buffer.concat(f.chunks)).toEqual(bytes); expect(f.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });
  it.each([
    ["oversized", (_v: ReturnType<typeof envelope>) => envelope(Buffer.alloc(65_537, 1))],
    ["noncanonical base64", (v: ReturnType<typeof envelope>) => ({ ...v, body: `${v.body}\n` })],
    ["length", (v: ReturnType<typeof envelope>) => ({ ...v, bytes: v.bytes + 1 })], ["digest", (v: ReturnType<typeof envelope>) => ({ ...v, sha256: "0".repeat(64) })],
    ["encoding", (v: ReturnType<typeof envelope>) => ({ ...v, encoding: "hex" })],
    ["media type", (v: ReturnType<typeof envelope>) => ({ ...v, mediaType: "text/html" })], ["owner", (v: ReturnType<typeof envelope>) => ({ ...v, owner: { kind: "personal", id: other } })],
    ["endpoint", (v: ReturnType<typeof envelope>) => ({ ...v, endpointId: other })], ["delivery", (v: ReturnType<typeof envelope>) => ({ ...v, deliveryId: other })], ["event", (v: ReturnType<typeof envelope>) => ({ ...v, eventId: "bad" })],
  ])("rejects invalid %s before writing or publishing bytes", async (_name, mutate) => {
    const f = await makeFixture(), destination = path.join(f.dir, "payload.bin"); f.setResponse(() => reply(mutate(envelope(Buffer.from('{"x":1}')))));
    const error = await runWebhookCommand([...args, "--output", destination], f.context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error); expect(f.chunks).toEqual([]); await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
