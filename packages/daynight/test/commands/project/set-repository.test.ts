import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringifyApiJson } from "../../../src/api/json.js";
import { runProjectCommand } from "../../../src/commands/project/command.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const teamId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const oldRepo = "https://example.test/old";
const repo = "https://example.test/new";
const version = "9007199254740993";
const project = { id: projectId, name: "Project", repoUrl: oldRepo, settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId, version: 1n }, createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z" };
const me = { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: teamId, kind: "personal", name: null } };
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const fixture = async (options: { classification?: "same_repository" | "different_repository" | "unverified" | "unchanged"; answers?: string[]; interactive?: boolean; failure?: string } = {}) => {
  const base = path.resolve("../../.tmp"); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "repository-command-")); dirs.push(dir); vi.stubEnv("DN_CONFIG_DIR", dir);
  await writeFile(path.join(dir, "config.yml"), "serverUrl: http://localhost:8787\nserverToken: test-token\n");
  const classification = options.classification ?? "different_repository";
  const targetRepo = classification === "unchanged" ? oldRepo : repo;
  const invalidated = classification === "different_repository" || classification === "unverified";
  const preview = { projectId, projectName: "Project", currentRepoUrl: oldRepo, repoUrl: targetRepo, repositoryVersion: version, ownershipVersion: "9007199254740994", classification, targetGitHubRepositoryId: null, unverifiedReason: classification === "unverified" ? "no_github_access" : null, bindingsInvalidated: invalidated };
  const receipt = { projectId, repoUrl: targetRepo, repositoryVersion: classification === "unchanged" ? version : "9007199254740994", changed: classification !== "unchanged", bindingsInvalidated: invalidated };
  const calls: { method: string; path: string; body?: string }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    calls.push({ method: init!.method!, path: pathname, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const headers = { "content-type": "application/json", "Daynight-User-ID": userId };
    if (pathname.endsWith("/me")) return new Response(stringifyApiJson(me), { headers });
    if (pathname.endsWith("/repository/preview")) {
      if (options.failure === "old-server") return new Response(JSON.stringify({ error: { code: "not_found", message: "not found", requestId: "request" } }), { status: 404, headers });
      return new Response(JSON.stringify(preview), { headers });
    }
    if (pathname.endsWith("/repository")) {
      if (options.failure === "lost") throw new Error("connection lost");
      if (options.failure) {
        const requestId = new Headers(init!.headers).get("X-Request-ID")!;
        return new Response(JSON.stringify({ error: { code: options.failure, message: "rejected", requestId } }), { status: options.failure === "forbidden" ? 403 : 409, headers: { ...headers, "X-Request-ID": requestId } });
      }
      return new Response(JSON.stringify(receipt), { headers });
    }
    return new Response(stringifyApiJson(project), { headers });
  });
  const answers = [...(options.answers ?? ["yes", "yes"])];
  const ask = vi.fn(async () => answers.shift() ?? "no");
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => dir, workingDirectory: () => dir, stdout: vi.fn(), stderr: vi.fn(), stdoutBytes: vi.fn(async (_value: Uint8Array) => {}), prompt: { isInteractive: options.interactive ?? true, ask, close: vi.fn(), select: vi.fn(), selectMany: vi.fn() } };
  const dependencies = { runServerCommand: ((ctx, command) => runServerCommand(ctx, command, { fetch })) as typeof runServerCommand };
  return { calls, context, dependencies, ask, receipt, targetRepo };
};
const args = (target: string) => ["set-repository", "--project", projectId, "--repo", target];

describe("project set-repository", () => {
  it.each(["unchanged", "same_repository", "different_repository", "unverified"] as const)("confirms %s and submits exact preview evidence outside Git", async classification => {
    const f = await fixture({ classification });
    await runProjectCommand([...args(f.targetRepo), "--json"], f.context, f.dependencies);
    expect(f.ask).toHaveBeenCalledTimes(classification === "unverified" ? 2 : 1);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "POST", "PATCH"]);
    expect(JSON.parse(f.calls[3]!.body!)).toEqual({ repoUrl: f.targetRepo, expectedUserId: userId, repositoryVersion: version, ownershipVersion: "9007199254740994", classification, targetGitHubRepositoryId: null, treatUnverifiedAsSwitch: classification === "unverified" });
    expect(JSON.parse(Buffer.from(f.context.stdoutBytes.mock.calls[0]![0]).toString())).toEqual(f.receipt);
    expect(f.context.stderr.mock.calls[0]![0]).toContain(f.targetRepo);
  });
  it("requires both noninteractive confirmations for an unverified identity", async () => {
    const f = await fixture({ classification: "unverified", interactive: false });
    await expect(runProjectCommand(args(repo), f.context, f.dependencies)).rejects.toThrow(/--confirm/);
    expect(f.calls).toHaveLength(0);
    await expect(runProjectCommand([...args(repo), "--confirm"], f.context, f.dependencies)).rejects.toThrow(/--allow-unverified-switch/);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "POST"]);
    await runProjectCommand([...args(repo), "--confirm", "--allow-unverified-switch"], f.context, f.dependencies);
    expect(f.calls.at(-1)!.method).toBe("PATCH");
  });
  it.each([["no"], ["yes", "no"]])("cancellation never writes", async (...answers) => {
    const f = await fixture({ classification: "unverified", answers });
    await expect(runProjectCommand(args(repo), f.context, f.dependencies)).rejects.toThrow(/cancelled/);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "POST"]);
  });
  it.each(["forbidden", "version_conflict", "project_repository_conflict", "lost"])("does not replay %s", async failure => {
    const f = await fixture({ failure, interactive: false });
    await expect(runProjectCommand([...args(repo), "--confirm"], f.context, f.dependencies)).rejects.toThrow(failure === "lost" ? /outcome is unknown/ : failure === "version_conflict" ? /preview and confirm/ : new RegExp(failure));
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "POST", "PATCH"]);
  });
  it("reports an unavailable preview on an older service without writing", async () => {
    const f = await fixture({ failure: "old-server", interactive: false });
    await expect(runProjectCommand([...args(repo), "--confirm"], f.context, f.dependencies)).rejects.toThrow(/server may not support/);
    expect(f.calls.map(x => x.method)).toEqual(["GET", "GET", "POST"]);
  });
});
