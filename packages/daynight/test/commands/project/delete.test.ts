import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProjectCommand } from "../../../src/commands/project/command.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";
import { stringifyApiJson } from "../../../src/api/json.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const teamId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const time = "2026-11-06T00:00:00Z";
const name = " 名\n\r\t\u001b ";
const team = { id: teamId, kind: "ordinary", name: "Team" };
const project = { id: projectId, name, repoUrl: "https://example.test/repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId, version: 1n }, createdAt: time, updatedAt: time };
const me = { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: teamId, kind: "personal", name: null } };
const preview = { observedAt: time, project: { id: projectId, name, repoUrl: project.repoUrl, ownerTeam: team }, summary: { taskCount: 0, unfinishedTaskCount: 0, attachmentCount: 0 }, activeClaims: [], nextCursor: null };
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const fixture = async (options: { interactive?: boolean; answer?: string; failure?: string; pages?: unknown[]; outputFailure?: boolean; previewFailure?: boolean; successPrincipal?: string } = {}) => {
  const base = path.resolve("../../.tmp"); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "project-delete-")); dirs.push(dir); vi.stubEnv("DN_CONFIG_DIR", dir);
  await writeFile(path.join(dir, "config.yml"), "serverUrl: http://localhost:8787\nserverToken: test-token\n");
  const calls: { url: URL; method: string; body: unknown }[] = [];
  let page = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const u = new URL(String(url)), method = init!.method!, requestId = new Headers(init!.headers).get("X-Request-ID");
    calls.push({ url: u, method, body: init!.body });
    const headers: Record<string, string> = { "content-type": "application/json", "Daynight-User-ID": userId };
    if (u.pathname.endsWith("/me")) return new Response(stringifyApiJson(me), { headers });
    if (u.pathname.endsWith("/deletion-preview")) {
      if (options.previewFailure && page++ === 1) throw new Error("lost preview page");
      return new Response(stringifyApiJson(options.pages?.[options.previewFailure ? page - 1 : page++] ?? preview), { headers });
    }
    if (method === "DELETE") {
      if (options.failure === "lost") throw new Error("lost");
      headers["X-Request-ID"] = options.failure === "wrong-header" ? "different" : requestId!;
      if (options.failure === "duplicate-outcome") return new Response(`{"error":{"code":"internal_error","message":"internal server error","requestId":"${requestId}","details":{"writeOutcome":"unknown","write\\u004futcome":"not_committed"}}}`, { status: 500, headers });
      if (options.failure === "duplicate-receipt") return new Response(`{"projectId":"${projectId}","deleted":false,"deleted":true}`, { headers });
      if (options.failure && options.failure !== "malformed-success") {
        if (options.failure === "active-claims" || options.failure === "not-found") return new Response(JSON.stringify({ error: { code: options.failure === "active-claims" ? "active_worker_claims" : "not_found", message: "rejected", requestId } }), { status: options.failure === "active-claims" ? 409 : 404, headers });
        if (options.failure === "wrong-principal") headers["Daynight-User-ID"] = teamId;
        const details = options.failure === "ordinary-500" ? undefined : options.failure === "bad-details" ? { writeOutcome: "not_committed", extra: true } : options.failure === "wrong-outcome" ? { writeOutcome: "committed" } : { writeOutcome: "not_committed" };
        return new Response(JSON.stringify({ ...(options.failure === "extra-envelope" ? { extra: true } : {}), error: { code: "internal_error", message: "internal server error", requestId: options.failure === "wrong-body" ? "different" : requestId, ...(options.failure === "extra-error" ? { extra: true } : {}), ...(details === undefined ? {} : { details }) } }), { status: 500, headers });
      }
      if (options.successPrincipal !== undefined) headers["Daynight-User-ID"] = options.successPrincipal;
      return new Response(JSON.stringify(options.failure === "malformed-success" ? { projectId, deleted: false } : { projectId, deleted: true }), { headers });
    }
    if (options.failure === "old-id") return new Response(JSON.stringify({ error: { code: "not_found", message: "not found", requestId: "request" } }), { status: 404, headers });
    return new Response(stringifyApiJson(project), { headers });
  });
  const ask = vi.fn(async (_question: string, _signal: AbortSignal) => options.answer ?? JSON.stringify(name));
  const stdoutBytes = vi.fn(async (_value: Uint8Array) => { if (options.outputFailure) throw new Error("output failed"); });
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => dir, workingDirectory: () => dir, stdout: vi.fn(), stderr: vi.fn(), stdoutBytes, prompt: { isInteractive: options.interactive ?? true, ask, close: vi.fn(), select: vi.fn(), selectMany: vi.fn() } };
  const dependencies = { runServerCommand: ((ctx, command) => runServerCommand(ctx, command, { fetch })) as typeof runServerCommand };
  return { calls, context, dependencies, ask, stdoutBytes };
};
const args = ["delete", "--project", projectId];

describe("project deletion", () => {
  it("requires exact JSON name even with --confirm and sends one unconditional DELETE", async () => {
    const f = await fixture();
    await runProjectCommand([...args, "--confirm", "--json"], f.context, f.dependencies);
    expect(f.ask).toHaveBeenCalledOnce();
    expect(f.ask.mock.calls[0]![0]).toContain(JSON.stringify(name).replace("\\u001b", "\\u001b"));
    expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET", "GET", "DELETE"]);
    expect(f.calls.at(-1)!.body).toBeUndefined(); expect(f.calls.at(-1)!.url.search).toBe("");
    expect(JSON.parse(Buffer.from(f.stdoutBytes.mock.calls[0]![0]).toString())).toEqual({ projectId, deleted: true });
    expect(f.context.stderr.mock.calls[0]![0]).not.toContain("\u001b");
  });
  it("rejects without IO when noninteractive confirmation is missing", async () => {
    const f = await fixture({ interactive: false });
    await expect(runProjectCommand(args, f.context, f.dependencies)).rejects.toThrow(/interactive confirmation/);
    expect(f.calls).toEqual([]);
  });
  it("allows explicit noninteractive confirmation", async () => {
    const f = await fixture({ interactive: false });
    await runProjectCommand([...args, "--confirm"], f.context, f.dependencies);
    expect(f.ask).not.toHaveBeenCalled(); expect(f.calls.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  });
  it("selects a repository binding without rewriting it", async () => {
    const f = await fixture({ interactive: false });
    const repo = f.context.workingDirectory();
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", project.repoUrl]);
    await mkdir(path.join(repo, ".daynight"));
    const binding = `serverUrl: http://localhost:8787\nrepoIdentity: example.test/repo\nprojectId: ${projectId}\n`;
    await writeFile(path.join(repo, ".daynight", "project.yml"), binding);
    await runProjectCommand(["delete", "--confirm", "--json"], f.context, f.dependencies);
    expect(f.calls.map(({ url, method }) => `${method} ${url.pathname}`)).toEqual([
      "GET /api/v1/me", `GET /api/v1/projects/${projectId}`, `GET /api/v1/projects/${projectId}/deletion-preview`, `DELETE /api/v1/projects/${projectId}`,
    ]);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(repo, ".daynight", "project.yml"), "utf8")).toBe(binding);
  });
  it("does not write on incorrect literal", async () => {
    const f = await fixture({ answer: JSON.stringify(name.trim()) });
    await expect(runProjectCommand([...args, "--confirm"], f.context, f.dependencies)).rejects.toThrow(/name did not match/);
    expect(f.calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
  });
  it("reads all pages and refuses a blocking active claim before deletion", async () => {
    const claim = { taskId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", title: "Task\n\u001b", worker: { machineName: "host", platform: "macos", phase: "executing", paused: false, connectivity: "offline" } };
    const f = await fixture({ pages: [{ ...preview, activeClaims: [claim], nextCursor: "cursor" }, preview] });
    await expect(runProjectCommand([...args, "--confirm"], f.context, f.dependencies)).rejects.toThrow(/blocked by active Worker/);
    expect(f.calls.filter(({ url }) => url.pathname.endsWith("deletion-preview"))).toHaveLength(2);
    expect(f.calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
    expect(f.context.stderr.mock.calls[0]![0]).not.toContain("\u001b");
  });
  it("does not freeze the observed name or owner in the deletion request", async () => {
    const changed = { ...preview, project: { ...preview.project, name: "Renamed", ownerTeam: { ...team, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } } };
    const f = await fixture({ interactive: false, pages: [{ ...preview, nextCursor: "cursor" }, changed] });
    await runProjectCommand([...args, "--confirm"], f.context, f.dependencies);
    expect(f.context.stderr.mock.calls[0]![0]).toContain("Renamed");
    const deletion = f.calls.find(({ method }) => method === "DELETE")!;
    expect(deletion.url.pathname).toBe(`/api/v1/projects/${projectId}`);
    expect(deletion.url.search).toBe(""); expect(deletion.body).toBeUndefined();
  });
  it("accepts a confirmed receipt after the authenticated principal changes", async () => {
    const f = await fixture({ interactive: false, successPrincipal: teamId });
    await runProjectCommand([...args, "--confirm", "--json"], f.context, f.dependencies);
    expect(JSON.parse(Buffer.from(f.stdoutBytes.mock.calls[0]![0]).toString())).toEqual({ projectId, deleted: true });
  });
  it("does not delete when a later preview page cannot be read", async () => {
    const f = await fixture({ previewFailure: true, pages: [{ ...preview, nextCursor: "cursor" }] });
    await expect(runProjectCommand([...args, "--confirm"], f.context, f.dependencies)).rejects.toThrow();
    expect(f.calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
  });
  it("does not discover another Project after an explicit old ID is unavailable", async () => {
    const f = await fixture({ interactive: false, failure: "old-id" });
    await expect(runProjectCommand([...args, "--confirm"], f.context, f.dependencies)).rejects.toMatchObject({ status: 404 });
    expect(f.calls.map(({ url }) => url.pathname)).toEqual(["/api/v1/me", `/api/v1/projects/${projectId}`]);
  });
  it.each(["active-claims", "not-found"])("reports %s as refusal without replay", async (failure) => {
    const f = await fixture({ interactive: false, failure });
    await expect(runProjectCommand([...args, "--confirm"], f.context, f.dependencies)).rejects.toMatchObject({ confirmedRefusal: true, outcomeUnconfirmed: false });
    expect(f.calls.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  });
  it("recognizes strictly correlated not_committed 500 as a definite refusal", async () => {
    const f = await fixture({ interactive: false, failure: "not-committed" });
    await expect(runProjectCommand([...args, "--confirm"], f.context, f.dependencies)).rejects.toMatchObject({ code: "internal_error", outcomeUnconfirmed: false, confirmedRefusal: true });
    expect(f.calls.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  });
  it.each(["ordinary-500", "bad-details", "wrong-outcome", "wrong-header", "wrong-body", "wrong-principal", "extra-envelope", "extra-error", "malformed-success", "duplicate-outcome", "duplicate-receipt", "lost"])("keeps %s unknown without replay", async (failure) => {
    const f = await fixture({ interactive: false, failure });
    await expect(runProjectCommand([...args, "--confirm"], f.context, f.dependencies)).rejects.toThrow(/outcome is unknown/);
    expect(f.calls.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  });
  it("preserves confirmed deletion when output fails", async () => {
    const f = await fixture({ interactive: false, outputFailure: true });
    await expect(runProjectCommand([...args, "--confirm"], f.context, f.dependencies)).rejects.toThrow(`deletion was confirmed for Project ${projectId}`);
  });
});
