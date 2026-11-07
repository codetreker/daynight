import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../../src/cli/application.js";
import { runWebhookCommand } from "../../../src/commands/webhook/command.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const personalId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const endpointId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const operationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const wrongId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const owner = { kind: "personal", id: userId };
const me = { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: personalId, kind: "personal", name: null } };
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const fixture = async () => {
  const base = path.resolve("../../.tmp"); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "webhook-command-")); dirs.push(dir);
  vi.stubEnv("DN_CONFIG_DIR", dir);
  await writeFile(path.join(dir, "config.yml"), "serverUrl: http://localhost:8787\nserverToken: test-token\n");
  const stdout = vi.fn<(text: string) => void>();
  const stdoutBytes = vi.fn(async (_bytes: Uint8Array) => {});
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => dir, workingDirectory: () => dir, stdout, stdoutBytes, stderr: vi.fn() };
  const calls: { method: string; path: string; body: string | null }[] = [];
  let response = (_url: URL, _init?: RequestInit): Response => { throw new Error("Unexpected request"); };
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    calls.push({ method: init?.method ?? "GET", path: parsed.pathname, body: typeof init?.body === "string" ? init.body : null });
    if (parsed.pathname === "/api/v1/me") return reply(me);
    return response(parsed, init);
  }));
  return { dir, context, stdout, stdoutBytes, calls, setResponse: (fn: typeof response) => { response = fn; } };
};
const reply = (value: unknown, status = 200, principal = userId): Response => new Response(typeof value === "string" ? value : JSON.stringify(value), { status, headers: { "content-type": "application/json", "Daynight-User-ID": principal } });
const refusal = (code: string, principal = userId) => reply({ error: { code, message: "secret https://receiver.test/path?token=hidden", requestId: operationId } }, code === "not_found" ? 404 : 409, principal);
const errorData = (error: unknown) => JSON.parse((error as Error).message).error as Record<string, unknown>;
const issued = () => new Date().toISOString();
const args = (at: string) => ["enable", endpointId, "--personal", "--if-version", "1", "--confirm", "--json", "--operation-id", operationId, "--issued-at", at];

describe("Webhook command failure boundaries", () => {
  it("rejects malformed or ambiguous input without a webhook request", async () => {
    const f = await fixture();
    for (const input of ['{"name":"x","name":"hidden"}', '{"operationId":"hidden"}', '{"enabled":null}', '{"destination":{"kind":"http","adapterVersion":"1","configuration":{"url":"hidden","extra":1}}}', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), `{"destination":${"[".repeat(33)}0${"]".repeat(33)}}`]) {
      const file = path.join(f.dir, "input.json"); await writeFile(file, input);
      const error = await runWebhookCommand(["update", endpointId, "--personal", "--if-version", "1", "--file", file, "--confirm", "--json"], f.context).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(inspect(error, { depth: 20, showHidden: true })).not.toContain("hidden");
    }
    expect(f.calls.every(({ path: requestPath }) => requestPath === "/api/v1/me")).toBe(true);
    expect(f.stdout).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("creates a private exclusive prepared record before submission and preserves it on collision", async () => {
    const f = await fixture(); const at = issued(), recordPath = path.join(f.dir, "prepared.json");
    f.setResponse(() => refusal("operation_conflict"));
    const error = await runWebhookCommand([...args(at), "--operation-out", recordPath], f.context).catch((e: unknown) => e);
    expect(errorData(error)).toMatchObject({ code: "operation_conflict", invocationOutcome: "rejected", operationOutcome: "unknown" });
    expect(inspect(error, { depth: 20, showHidden: true })).not.toContain("token=hidden");
    const bytes = await readFile(recordPath); const prepared = JSON.parse(bytes.toString()) as Record<string, unknown>;
    expect(prepared).toMatchObject({ operationId, issuedAt: at, actorUserId: userId, owner, endpointId, ifVersion: "1" });
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
    expect(bytes.toString()).not.toContain("secret");
    expect(f.calls.filter(({ method }) => method === "PATCH")).toHaveLength(1);
    const before = f.calls.length;
    await expect(runWebhookCommand([...args(at), "--operation-out", recordPath], f.context)).rejects.toThrow();
    expect(f.calls.slice(before).every(({ path: p }) => p === "/api/v1/me")).toBe(true);
    expect(await readFile(recordPath)).toEqual(bytes);
  });

  it.skipIf(process.platform === "win32").each(["wrong principal", "malformed body"])("does not resend on a %s 404 during resume", async (failure) => {
    const f = await fixture(); const at = issued(), recordPath = path.join(f.dir, "prepared.json");
    f.setResponse(() => refusal("operation_conflict"));
    await runWebhookCommand([...args(at), "--operation-out", recordPath], f.context).catch(() => {});
    const before = f.calls.length;
    f.setResponse(() => failure === "wrong principal" ? refusal("not_found", wrongId) : reply("{bad json", 404));
    const error = await runWebhookCommand(["enable", endpointId, "--personal", "--if-version", "1", "--confirm", "--json", "--resume-operation", recordPath], f.context).catch((e: unknown) => e);
    expect(errorData(error).operationOutcome).toBe("unknown");
    expect(f.calls.slice(before).map(({ method }) => method)).toEqual(["GET", "GET"]);
  });

  it("retains confirmation when stdout fails and withholds sensitive causes", async () => {
    const f = await fixture(), at = issued();
    f.setResponse((_url, init) => {
      const body = String(init?.body); const requestSha256 = createHash("sha256").update(body).digest("hex");
      const operation = { operationId, kind: "endpoint.delete", issuedAt: at, requestSha256, actorUserId: userId, owner, endpointId, effect: "applied", configVersionAfter: "2", destinationRevisionAfter: "1", deliveryId: null, generationAfter: null, keyId: null, recordedAt: at, expiresAt: "2099-01-01T00:00:00Z" };
      return reply({ operation, endpoint: { id: endpointId, owner, lifecycle: "deleted", configVersion: "2", deletedAt: at } });
    });
    f.stdoutBytes.mockRejectedValue(new Error("secret https://receiver.test/path?token=hidden"));
    const error = await runWebhookCommand(["delete", endpointId, "--personal", "--if-version", "1", "--confirm", "--json", "--operation-id", operationId, "--issued-at", at], f.context).catch((e: unknown) => e);
    expect(errorData(error)).toMatchObject({ phase: "output", invocationOutcome: "confirmed", operationOutcome: "confirmed" });
    expect(inspect(error, { depth: 20, showHidden: true })).not.toContain("token=hidden");
    expect(f.calls.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  });

  it("hides sensitive destination paths and queries in human output", async () => {
    const f = await fixture(), at = issued();
    const secretUrl = "https://receiver.test/private-path?token=hidden";
    f.setResponse(() => reply({ id: endpointId, owner, lifecycle: "active", configVersion: "1", name: "Endpoint", enabled: true, destinationRevision: "1", destination: { kind: "http", adapterVersion: "1", url: secretUrl, displayUrl: secretUrl }, signing: { scheme: "standard-webhooks-v1", activeKeyId: operationId, overlapUntil: null }, subscriptions: [], capabilities: { manage: true, readSecret: true, redeliver: true }, createdAt: at, updatedAt: at, deletedAt: null }));
    await runWebhookCommand(["show", endpointId, "--personal"], f.context);
    const output = Buffer.from(f.stdoutBytes.mock.calls[0]![0]).toString();
    expect(output).not.toContain("private-path");
    expect(output).not.toContain("token=hidden");
    expect(output).toContain("https://receiver.test");
  });

  it.each(["stdout", "cleanup"])("reports a safe JSON read error when %s fails", async (failure) => {
    const f = await fixture(), at = issued();
    f.setResponse(() => reply({ id: endpointId, owner, lifecycle: "deleted", configVersion: "1", deletedAt: at }));
    const canary = "https://receiver.test/private?token=hidden";
    if (failure === "stdout") f.stdoutBytes.mockRejectedValue(new Error(canary));
    const context = { ...f.context, closeStdoutBytes: vi.fn(async () => { if (failure === "cleanup") throw new Error(canary); }) };
    const error = await runWebhookCommand(["show", endpointId, "--personal", "--json"], context).catch((e: unknown) => e);
    expect(errorData(error)).toMatchObject({ phase: "output", invocationOutcome: "read_failed", operationOutcome: null });
    expect(inspect(error, { depth: 20, showHidden: true })).not.toContain(canary);
    expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET"]);
    expect(f.stdout).not.toHaveBeenCalled();
  });

  it.each([
    ["webhook", "https://receiver.test/private?token=hidden"],
    ["webhook", "show", endpointId, "--personal", "--url=https://receiver.test/private?token=hidden"],
    ["webhook", "show", endpointId, "--personal", "https://receiver.test/private?token=hidden"],
  ])("does not leak unknown argv in usage diagnostics: %j", async (...argv) => {
    const f = await fixture();
    expect(await runCli(argv, f.context)).toBe(2);
    expect(f.context.stderr).toHaveBeenCalledOnce();
    expect(f.context.stderr.mock.calls[0]![0]).not.toContain("receiver.test");
    expect(f.context.stderr.mock.calls[0]![0]).not.toContain("token=hidden");
    expect(f.calls).toEqual([]);
  });
});
