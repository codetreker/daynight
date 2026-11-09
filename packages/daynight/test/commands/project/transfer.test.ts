import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../../src/api/json.js";
import { runProjectCommand } from "../../../src/commands/project/command.js";
import { parseTeamIdentifier } from "../../../src/commands/team/identifier.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sourceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const targetId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const version = 9_007_199_254_740_993n;
const time = "2026-11-04T00:00:00Z";
const sourceTeam = { id: sourceId, kind: "ordinary", name: "Source\n\u001b[2J" };
const ownerTeam = { id: targetId, kind: "ordinary", name: "Target" };
const project = { id: projectId, name: "Project\nname", repoUrl: "https://example.test/repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: sourceId, version }, createdAt: time, updatedAt: time };
const preview = { sourceTeam, targetTeam: { ...ownerTeam, version }, ownership: project.ownership, actorRole: null };
const receipt = { projectId, changed: true, sourceTeam, ownerTeam, ownership: { teamId: targetId, version: version + 1n }, actorAccess: null };
const me = { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: sourceId, kind: "personal", name: null } };
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const fixture = async (options: { answer?: string; interactive?: boolean; failure?: string; outputFailure?: boolean } = {}) => {
  const base = path.resolve("../../.tmp"); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "project-transfer-")); dirs.push(dir); vi.stubEnv("DN_CONFIG_DIR", dir);
  await writeFile(path.join(dir, "config.yml"), "serverUrl: http://localhost:8787\nserverToken: test-token\n");
  const calls: { path: string; method: string; body: string | undefined }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    calls.push({ path: pathname, method: init!.method!, body: typeof init?.body === "string" ? init.body : undefined });
    const headers = { "content-type": "application/json", "Daynight-User-ID": userId };
    if (pathname.endsWith("/me")) return new Response(stringifyApiJson(me), { headers });
    if (pathname === "/api/v1/projects") return new Response(stringifyApiJson({ items: [project], nextCursor: null }), { headers });
    if (pathname.endsWith("/transfer-preview")) return new Response(stringifyApiJson(preview), { headers });
    if (pathname.endsWith("/transfer")) {
      if (options.failure === "lost") throw new Error("connection lost");
      if (options.failure) return new Response(JSON.stringify({ error: { code: options.failure, message: "rejected", requestId: "request" } }), { status: 409, headers });
      return new Response(stringifyApiJson(receipt), { headers });
    }
    return new Response(stringifyApiJson(project), { headers });
  });
  const ask = vi.fn(async (_question: string, _signal: AbortSignal) => options.answer ?? "yes");
  const stdoutBytes = vi.fn(async (_value: Uint8Array) => { if (options.outputFailure) throw new Error("output failed"); });
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => dir, workingDirectory: () => dir, stdout: vi.fn(), stderr: vi.fn(), stdoutBytes, prompt: { isInteractive: options.interactive ?? true, ask, close: vi.fn(), select: vi.fn(), selectMany: vi.fn() } };
  const dependencies = { runServerCommand: ((ctx, command) => runServerCommand(ctx, command, { fetch })) as typeof runServerCommand };
  return { calls, context, dependencies, ask, stdoutBytes };
};
const args = ["transfer", "--project", projectId, "--to-team", targetId];

describe("Team identifiers", () => {
  it("accepts canonical UUIDs and exact same-service links", () => {
    expect(parseTeamIdentifier(targetId, "http://localhost:8787")).toBe(targetId);
    expect(parseTeamIdentifier(`http://localhost:8787/teams/${targetId}`, "http://localhost:8787")).toBe(targetId);
    expect(parseTeamIdentifier(`HTTPS://DAYNIGHT.CC:443/teams/${targetId}`, "https://daynight.cc")).toBe(targetId);
  });
  it.each([
    targetId.toUpperCase(), `http://other/teams/${targetId}`, `http://user@localhost:8787/teams/${targetId}`,
    `http://localhost:8787/teams/${targetId}?`, `http://localhost:8787/teams/${targetId}#`,
    `http://localhost:8787/x/../teams/${targetId}`, `http://localhost:8787/teams/${targetId}/`, `http://localhost:8787/Teams/${targetId}`,
    `http://localhost:8787/teams/%64${targetId.slice(1)}`, `http://localhost:8787/teams/${targetId}?x=1`,
  ])("rejects noncanonical or foreign targets %s", (target) => {
    expect(() => parseTeamIdentifier(target, "http://localhost:8787")).toThrow();
  });
});

describe("project transfer", () => {
  it("prints the complete confirmed JSON receipt when the actor loses access", async () => {
    const f = await fixture();
    await runProjectCommand([...args, "--confirm", "--json"], f.context, f.dependencies);
    const output = Buffer.from(f.stdoutBytes.mock.calls[0]![0]).toString();
    expect(parseApiJson(output)).toEqual(receipt);
    expect(output).toContain('"actorAccess":null'); expect(output).toContain(`"version":${version + 1n}`);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "POST", "POST"]);
    expect(parseApiJson(f.calls[3]!.body!)).toEqual({ ownership: { teamId: sourceId, version }, targetTeam: { id: targetId, version }, expectedUserId: userId });
  });
  it("previews and confirms exact versions, reports success after losing access without a follow-up GET", async () => {
    const f = await fixture();
    await runProjectCommand([...args, "--if-version", version.toString()], f.context, f.dependencies);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "POST", "POST"]);
    expect(f.calls[3]!.body).toContain(`"version":${version}`);
    expect(f.calls[3]!.body).toContain(`"expectedUserId":"${userId}"`);
    expect(f.ask.mock.calls[0]![0]).toContain("Your access after transfer: none");
    expect(f.ask.mock.calls[0]![0]).toContain("Project\\nname");
    expect(f.ask.mock.calls[0]![0]).not.toContain("\u001b");
    expect(Buffer.from(f.stdoutBytes.mock.calls[0]![0]).toString()).toContain("Your access: none");
  });
  it("discovers a repository without writing its binding or ignore file", async () => {
    const f = await fixture();
    const repo = f.context.workingDirectory();
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", project.repoUrl]);
    await runProjectCommand(["transfer", "--to-team", targetId, "--confirm"], f.context, f.dependencies);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "GET", "POST", "POST"]);
    await expect(stat(path.join(repo, ".daynight"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(repo, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses noninteractive execution before any request", async () => {
    const f = await fixture({ interactive: false });
    await expect(runProjectCommand(args, f.context, f.dependencies)).rejects.toThrow(/interactive confirmation/);
    expect(f.calls).toEqual([]);
  });
  it("does not write after cancellation or a stale version", async () => {
    const f = await fixture({ answer: "n" });
    await expect(runProjectCommand(args, f.context, f.dependencies)).rejects.toThrow(/cancelled/);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "POST"]);
    const stale = await fixture();
    await expect(runProjectCommand([...args, "--if-version", "1", "--confirm"], stale.context, stale.dependencies)).rejects.toThrow(/version differs/);
    expect(stale.calls.map(x => x.method)).toEqual(["GET", "GET", "POST"]);
  });
  it.each(["version_conflict", "identity_mismatch", "forbidden"])("exposes %s without replay", async (failure) => {
    const f = await fixture({ failure });
    await expect(runProjectCommand([...args, "--confirm"], f.context, f.dependencies)).rejects.toMatchObject({ code: failure, outcomeUnconfirmed: false });
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "POST", "POST"]);
  });
  it("keeps lost receipts unknown without probing or replay", async () => {
    const f = await fixture({ failure: "lost" });
    await expect(runProjectCommand([...args, "--confirm"], f.context, f.dependencies)).rejects.toThrow(/outcome is unknown.*404 cannot establish success/);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "POST", "POST"]);
  });
  it("retains confirmed success when output fails", async () => {
    const f = await fixture({ outputFailure: true });
    await expect(runProjectCommand([...args, "--confirm"], f.context, f.dependencies)).rejects.toThrow(/transfer was confirmed/);
  });
  it.each([["--confirm", "--confirm"], ["--confirm=false"], ["--confirm", "false"]])("rejects malformed confirmation syntax %#", async (...extra) => {
    const f = await fixture();
    await expect(runProjectCommand([...args, ...extra], f.context, f.dependencies)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
});
