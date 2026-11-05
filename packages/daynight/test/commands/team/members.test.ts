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
const version = 9_007_199_254_740_993n;
const me = { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: personalId, kind: "personal", name: null } };
const member = (id: string, role = "admin") => ({ teamId, userId: id, role, version, createdAt: time, updatedAt: time });
const team = { id: teamId, kind: "ordinary", name: "Team", version: 3n, createdAt: time, updatedAt: time, membership: member(userId) };
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const fixture = async (options: { failure?: string; principal?: string; answer?: string; interactive?: boolean } = {}) => {
  const base = path.resolve("../../.tmp"); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "team-members-")); dirs.push(dir); vi.stubEnv("DN_CONFIG_DIR", dir);
  await writeFile(path.join(dir, "config.yml"), "serverUrl: http://localhost:8787\nserverToken: test-token\n");
  const calls: { method: string; path: string; body: string | undefined }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const method = init!.method!, pathname = new URL(String(url)).pathname;
    calls.push({ method, path: pathname, body: typeof init?.body === "string" ? init.body : undefined });
    const headers = { "content-type": "application/json", "Daynight-User-ID": method === "GET" ? userId : options.principal ?? userId };
    if (method === "GET") {
      const value = pathname.endsWith("/me") ? me : pathname.endsWith("/members") ? { items: [member(userId), member(otherId, "member")].map((item) => ({ ...item, profile: { name: null, email: null, avatarUrl: null } })) } : team;
      return new Response(stringifyApiJson(value), { headers });
    }
    if (options.failure === "lost") throw new Error("connection lost");
    if (options.failure) return new Response(JSON.stringify({ error: { code: options.failure, message: "rejected", requestId: "request" } }), { status: 409, headers });
    const target = pathname.split("/").at(-1)!;
    const value = method === "PATCH" ? { membership: { ...member(target, "member"), version: version + 1n }, actorRole: target === userId ? "member" : "admin" } : { teamId, userId: target, removed: true, actorRole: target === userId ? null : "admin" };
    return new Response(stringifyApiJson(value), { headers });
  });
  const ask = vi.fn(async () => options.answer ?? "y");
  const stdoutBytes = vi.fn(async (_value: Uint8Array) => {});
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => dir, workingDirectory: () => dir, stdout: vi.fn(), stderr: vi.fn(), stdoutBytes, prompt: { isInteractive: options.interactive ?? true, ask, close: vi.fn(), select: vi.fn(), selectMany: vi.fn() } };
  const dependencies = { runServerCommand: ((ctx, command) => runServerCommand(ctx, command, { fetch })) as typeof runServerCommand };
  return { calls, context, dependencies, ask, stdoutBytes };
};

describe("Team membership commands", () => {
  it("prints nullable profiles and exact membership versions in the scoped directory", async () => {
    const f = await fixture();
    await runTeamCommand(["member", "list", "--team", teamId, "--json"], f.context, f.dependencies);
    expect(f.calls.map(x => x.path)).toEqual(["/api/v1/me", `/api/v1/teams/${teamId}/members`]);
    expect(f.context.stdout.mock.calls[0]![0]).toContain(`"version":${version}`);
    expect(f.context.stdout.mock.calls[0]![0]).toContain('"name":null');
  });
  it("uses the observed member version for self-demotion and returns the receipt", async () => {
    const f = await fixture();
    await runTeamCommand(["member", "set-role", userId, "member", "--team", teamId, "--if-version", String(version), "--confirm", "--json"], f.context, f.dependencies);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(f.calls[2]!.body).toContain(`"version":${version}`);
    expect(f.calls[2]!.body).toContain(`"expectedUserId":"${userId}"`);
    expect(Buffer.from(f.stdoutBytes.mock.calls[0]![0]).toString()).toContain('"actorRole":"member"');
  });
  it("leaves using the current membership and does not read after success", async () => {
    const f = await fixture();
    await runTeamCommand(["leave", "--team", teamId, "--confirm", "--json"], f.context, f.dependencies);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "DELETE"]);
    expect(f.calls[2]!.body).toContain(`"version":${version}`);
    expect(Buffer.from(f.stdoutBytes.mock.calls[0]![0]).toString()).toContain('"actorRole":null');
  });
  it("rejects stale versions and cancellation before submitting", async () => {
    for (const [options, args] of [[{}, ["--if-version", "1", "--confirm"]], [{ answer: "n" }, []], [{ interactive: false }, []]] as const) {
      const f = await fixture(options);
      await expect(runTeamCommand(["member", "remove", otherId, "--team", teamId, ...args], f.context, f.dependencies)).rejects.toThrow();
      expect(f.calls.every(x => x.method === "GET")).toBe(true);
    }
  });
  it.each(["last_admin", "personal_team_immutable", "version_conflict", "identity_mismatch"])("preserves %s without replay", async (failure) => {
    const f = await fixture({ failure });
    await expect(runTeamCommand(["leave", "--team", teamId, "--confirm"], f.context, f.dependencies)).rejects.toMatchObject({ code: failure, outcomeUnconfirmed: false });
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "DELETE"]);
  });
  it.each([{ failure: "lost" }, { principal: otherId }])("reports an unknown write without replay %#", async (options) => {
    const f = await fixture(options);
    await expect(runTeamCommand(["leave", "--team", teamId, "--confirm"], f.context, f.dependencies)).rejects.toThrow(/outcome is unknown/);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "DELETE"]);
  });
});
