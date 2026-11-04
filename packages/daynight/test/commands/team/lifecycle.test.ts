import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringifyApiJson } from "../../../src/api/json.js";
import { runTeamCommand } from "../../../src/commands/team/command.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const personalId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const teamId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const otherId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const time = "2026-11-04T00:00:00Z";
const me = { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: personalId, kind: "personal", name: null } };
const version = 9_007_199_254_740_993n;
const team = (name = " Team ") => ({ id: teamId, kind: "ordinary" as const, name, version, createdAt: time, updatedAt: time, membership: { teamId, userId, role: "admin" as const, version: 1n, createdAt: time, updatedAt: time } });
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const fixture = async (options: { name?: string; answer?: string; interactive?: boolean; failure?: string; principal?: string; writeOutputFails?: boolean; releaseFails?: boolean; badReceipt?: boolean; badLocation?: boolean; personal?: boolean } = {}) => {
  const base = path.resolve("../../.tmp"); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "team-lifecycle-")); dirs.push(dir); vi.stubEnv("DN_CONFIG_DIR", dir);
  await writeFile(path.join(dir, "config.yml"), "serverUrl: http://localhost:8787\nserverToken: test-token\n");
  const calls: { method: string; body: string | undefined; requestId: string | null }[] = [];
  const observed = options.personal ? { ...team(), id: personalId, kind: "personal" as const, name: null, membership: { ...team().membership, teamId: personalId } } : team(options.name);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const method = init!.method!, pathname = new URL(String(url)).pathname;
    calls.push({ method, body: typeof init?.body === "string" ? init.body : undefined, requestId: new Headers(init?.headers).get("X-Request-ID") });
    const headers = { "content-type": "application/json", "Daynight-User-ID": method === "GET" ? userId : options.principal ?? userId, ...(method === "POST" ? { Location: options.badLocation ? "/invalid" : `/api/v1/teams/${teamId}` } : {}) };
    if (method === "GET") return new Response(stringifyApiJson(pathname.endsWith("/me") ? me : observed), { headers });
    if (options.failure === "lost") throw new Error("connection lost");
    if (options.failure) return new Response(JSON.stringify({ error: { code: options.failure, message: "rejected", requestId: "request" } }), { status: 409, headers });
    if (method === "DELETE") {
      const response = new Response(JSON.stringify({ teamId: options.badReceipt ? otherId : teamId, deleted: true }), { headers });
      if (options.releaseFails) {
        const reader = response.body!.getReader(), release = reader.releaseLock.bind(reader);
        Object.defineProperty(reader, "releaseLock", { value: () => { release(); throw new Error("release failed"); } });
        Object.defineProperty(response.body, "getReader", { value: () => reader });
      }
      return response;
    }
    const body = JSON.parse(String(init?.body));
    const updated = { ...observed, name: body.name, version: method === "POST" || body.name === observed.name ? version : version + 1n };
    return new Response(stringifyApiJson(updated), { status: method === "POST" ? 201 : 200, headers });
  });
  const ask = vi.fn(async (_question: string, _signal: AbortSignal) => options.answer ?? "y");
  const close = vi.fn();
  const stdoutBytes = vi.fn(async (_value: Uint8Array) => { if (options.writeOutputFails) throw new Error("output failed"); });
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => dir, workingDirectory: () => dir, stdout: vi.fn(), stderr: vi.fn(), stdoutBytes, prompt: { isInteractive: options.interactive ?? true, ask, close, select: vi.fn(), selectMany: vi.fn() } };
  const dependencies = { runServerCommand: ((ctx, command) => runServerCommand(ctx, command, { fetch })) as typeof runServerCommand };
  return { calls, context, dependencies, ask, close, stdoutBytes };
};

describe("Team lifecycle", () => {
  it("creates exactly once with the principal and preserves raw names", async () => {
    const f = await fixture();
    await runTeamCommand(["create", "  new\\name\n  ", "--confirm", "--json"], f.context, f.dependencies);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "POST"]);
    expect(JSON.parse(f.calls[1]!.body!)).toEqual({ name: "  new\\name\n  ", expectedUserId: userId });
    expect(f.calls[1]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.ask).not.toHaveBeenCalled();
    expect(Buffer.from(f.stdoutBytes.mock.calls[0]![0]).toString()).toContain("new\\\\name\\n");
  });
  it("renames using the exact observed int64 version", async () => {
    const f = await fixture({ answer: "yes" });
    await runTeamCommand(["rename", "new", "--team", teamId, "--if-version", version.toString()], f.context, f.dependencies);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(f.calls[2]!.body).toContain(`"version":${version}`);
    expect(f.calls[2]!.body).toContain(`"expectedUserId":"${userId}"`);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it.each(["line\nnext", "line\rnext", " x\t\u001b\\ ", "  leading and trailing  "]) ("accepts exact JSON literal for delete name %j", async (name) => {
    const f = await fixture({ name, answer: JSON.stringify(name) });
    await runTeamCommand(["delete", "--team", teamId], f.context, f.dependencies);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "DELETE"]);
    const body = JSON.parse(f.calls[2]!.body!);
    expect(body.name).toBe(name);
    expect(f.calls[2]!.body).toContain(`"version":${version}`);
    expect(f.ask.mock.calls[0]![0]).toContain(JSON.stringify(name));
  });
  it("rejects mismatch, cancellation, stale versions and noninteractive calls before a write", async () => {
    for (const options of [{ answer: '"wrong"' }, { answer: "n" }, { interactive: false }]) {
      const f = await fixture(options);
      await expect(runTeamCommand([options.answer === "n" ? "rename" : "delete", ...(options.answer === "n" ? ["new"] : []), "--team", teamId], f.context, f.dependencies)).rejects.toThrow();
      expect(f.calls.every(x => x.method === "GET")).toBe(true);
    }
    const f = await fixture();
    await expect(runTeamCommand(["delete", "--team", teamId, "--if-version", "1", "--confirm"], f.context, f.dependencies)).rejects.toThrow("version differs");
    expect(f.calls.every(x => x.method === "GET")).toBe(true);
  });
  it.each([["--confirm", "--confirm"], ["--confirm=false"], ["--confirm", "false"]])("rejects invalid confirmation syntax %#", async (...args) => {
    const f = await fixture();
    await expect(runTeamCommand(["create", "new", ...args], f.context, f.dependencies)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it.each(["team_not_empty", "version_conflict", "identity_mismatch", "personal_team_immutable"]) ("preserves service refusal %s without replay", async (failure) => {
    const f = await fixture({ failure });
    await expect(runTeamCommand(["delete", "--team", teamId, "--confirm"], f.context, f.dependencies)).rejects.toMatchObject({ code: failure, outcomeUnconfirmed: false });
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "DELETE"]);
  });
  it.each(["rename", "delete"])("rejects %s of Personal Team before confirmation or write", async (action) => {
    const f = await fixture({ personal: true });
    await expect(runTeamCommand([action, ...(action === "rename" ? ["new"] : []), "--team", "personal"], f.context, f.dependencies)).rejects.toThrow("Personal Team cannot");
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET"]);
    expect(f.ask).not.toHaveBeenCalled();
  });
  it.each([{ failure: "lost" }, { principal: otherId }, { badReceipt: true }])("reports an unconfirmed write without replay %#", async (options) => {
    const f = await fixture(options);
    await expect(runTeamCommand(["delete", "--team", teamId, "--confirm"], f.context, f.dependencies)).rejects.toThrow(/outcome is unknown \(requestId=/);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "DELETE"]);
  });
  it("preserves a confirmed receipt if local output fails", async () => {
    const f = await fixture({ writeOutputFails: true });
    await expect(runTeamCommand(["delete", "--team", teamId, "--confirm"], f.context, f.dependencies)).rejects.toThrow(/Team deletion was confirmed/);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "DELETE"]);
  });
  it("preserves a confirmed receipt when the response reader fails to release", async () => {
    const f = await fixture({ releaseFails: true });
    await expect(runTeamCommand(["delete", "--team", teamId, "--confirm"], f.context, f.dependencies)).rejects.toThrow(`Team delete was confirmed for Team ${teamId}`);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "DELETE"]);
  });
  it("rejects a creation receipt with a wrong Location as unknown", async () => {
    const f = await fixture({ badLocation: true });
    await expect(runTeamCommand(["create", "new", "--confirm"], f.context, f.dependencies)).rejects.toThrow(/outcome is unknown/);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "POST"]);
  });
});
