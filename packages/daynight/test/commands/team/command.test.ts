import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringifyApiJson } from "../../../src/api/json.js";
import { runTeamCommand } from "../../../src/commands/team/command.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const personalId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const teamId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const wrongId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const time = "2026-11-04T00:00:00Z";
const me = { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: personalId, kind: "personal", name: null } };
const team = (id: string) => ({ id, kind: id === personalId ? "personal" : "ordinary", name: id === personalId ? null : " Team ", version: 1n, createdAt: time, updatedAt: time, membership: { teamId: id, userId, role: "admin", version: 1n, createdAt: time, updatedAt: time } });
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const fixture = async (defaultValue?: string, projectPages?: readonly unknown[]) => {
  const base = path.resolve("../../.tmp"); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "team-command-")); dirs.push(dir); vi.stubEnv("DN_CONFIG_DIR", dir);
  const config = `serverUrl: http://localhost:8787\nserverToken: test-token\n${defaultValue === undefined ? "" : `teamDefaults:\n  http://localhost:8787:\n    ${userId}: ${defaultValue}\n    ${wrongId}: ${wrongId}\n  https://elsewhere.test:\n    ${userId}: ${wrongId}\n`}`;
  await writeFile(path.join(dir, "config.yml"), config);
  const calls: string[] = [];
  const projectQueries: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    calls.push(`${init?.method} ${new URL(String(url)).pathname}`);
    const parsed = new URL(String(url));
    const headers = { "content-type": "application/json", "Daynight-User-ID": userId };
    if (parsed.pathname === "/api/v1/me") return new Response(stringifyApiJson(me), { headers });
    if (parsed.pathname === "/api/v1/teams") return new Response(stringifyApiJson({ items: [team(personalId), team(teamId)], nextCursor: null }), { headers });
    if (parsed.pathname === `/api/v1/teams/${wrongId}` || parsed.searchParams.get("teamId") === wrongId) return new Response(stringifyApiJson({ error: { code: "not_found", message: "Team was not found.", requestId: "request" } }), { status: 404, headers });
    if (parsed.pathname.startsWith("/api/v1/teams/")) return new Response(stringifyApiJson(team(parsed.pathname.split("/").at(-1)!)), { headers });
    if (parsed.pathname === "/api/v1/projects" && projectPages !== undefined) {
      projectQueries.push(parsed.search);
      return new Response(stringifyApiJson({ items: [projectPages[parsed.searchParams.has("cursor") ? 1 : 0]], nextCursor: parsed.searchParams.has("cursor") ? null : "next /+" }), { headers });
    }
    return new Response(stringifyApiJson({ items: [], nextCursor: null }), { headers });
  });
  const stdout = vi.fn<(value: string) => void>();
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => dir, workingDirectory: () => dir, stdout, stderr: vi.fn(), stdoutBytes: vi.fn(async (_value: Uint8Array) => {}) };
  const dependencies = { runServerCommand: ((ctx, command) => runServerCommand(ctx, command, { fetch })) as typeof runServerCommand };
  return { dir, config, calls, stdout, context, dependencies, projectQueries };
};

describe("Team command context", () => {
  it("resolves absent configuration to the real Personal Team", async () => {
    const f = await fixture();
    await runTeamCommand(["default", "show", "--json"], f.context, f.dependencies);
    expect(JSON.parse(f.stdout.mock.calls[0]![0])).toMatchObject({ configured: null, team: { id: personalId, kind: "personal" } });
    expect(f.calls).toEqual(["GET /api/v1/me", `GET /api/v1/teams/${personalId}`]);
    expect(await readFile(path.join(f.dir, "config.yml"), "utf8")).toBe(f.config);
  });
  it("uses current origin and account, and honors explicit selection", async () => {
    const f = await fixture(teamId);
    await runTeamCommand(["show", "--json"], f.context, f.dependencies);
    expect(JSON.parse(f.stdout.mock.calls[0]![0]).id).toBe(teamId);
    await runTeamCommand(["show", "--team", "personal", "--json"], f.context, f.dependencies);
    expect(JSON.parse(f.stdout.mock.calls[1]![0]).id).toBe(personalId);
    await runTeamCommand(["projects", "--team", teamId, "--json"], f.context, f.dependencies);
    expect(JSON.parse(f.stdout.mock.calls[2]![0])).toEqual([]);
    expect(await readFile(path.join(f.dir, "config.yml"), "utf8")).toBe(f.config);
    expect(f.calls.every((call) => call.startsWith("GET "))).toBe(true);
  });
  it("prints both pages of projects owned by the selected Team", async () => {
    const project = (id: string, name: string) => ({ id, name, repoUrl: `https://example.test/${name}.git`, settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId, version: 1n }, createdAt: time, updatedAt: time });
    const projects = [project("11111111-1111-4111-8111-111111111111", "first"), project("22222222-2222-4222-8222-222222222222", "second")];
    const f = await fixture(undefined, projects);
    await runTeamCommand(["projects", "--team", teamId, "--json"], f.context, f.dependencies);
    expect(f.stdout).toHaveBeenCalledOnce();
    expect(f.stdout.mock.calls[0]![0]).toBe(`${stringifyApiJson(projects)}\n`);
    expect(f.calls).toEqual(["GET /api/v1/me", "GET /api/v1/projects", "GET /api/v1/projects"]);
    const queries = f.projectQueries.map(value => new URLSearchParams(value));
    expect(queries.map(query => query.get("teamId"))).toEqual([teamId, teamId]);
    expect(queries.map(query => query.get("cursor"))).toEqual([null, "next /+"]);
    expect(await readFile(path.join(f.dir, "config.yml"), "utf8")).toBe(f.config);
  });
  it("rejects stale default yet allows list and explicit targets", async () => {
    const f = await fixture(wrongId);
    await expect(runTeamCommand(["default", "show"], f.context, f.dependencies)).rejects.toThrow();
    await expect(runTeamCommand(["projects"], f.context, f.dependencies)).rejects.toThrow();
    expect(f.stdout).not.toHaveBeenCalled();
    await runTeamCommand(["list", "--json"], f.context, f.dependencies);
    await runTeamCommand(["show", "--team", teamId, "--json"], f.context, f.dependencies);
    expect(f.stdout).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(f.dir, "config.yml"), "utf8")).toBe(f.config);
  });
  it("ignores a malformed old default for explicit target and list", async () => {
    const f = await fixture("not-a-uuid");
    await expect(runTeamCommand(["default", "show"], f.context, f.dependencies)).rejects.toThrow("canonical UUID");
    await runTeamCommand(["list"], f.context, f.dependencies);
    await runTeamCommand(["show", "--team", teamId], f.context, f.dependencies);
    expect(f.stdout).toHaveBeenCalledTimes(2);
  });
  it("repairs an invalid default and saves the real Personal Team", async () => {
    const f = await fixture("not-a-uuid");
    await runTeamCommand(["default", "set", "personal", "--confirm", "--json"], f.context, f.dependencies);
    const saved = await readFile(path.join(f.dir, "config.yml"), "utf8");
    expect(saved).toContain(`${userId}: ${personalId}`);
    expect(saved).toContain(`${wrongId}: ${wrongId}`);
    expect(JSON.parse(Buffer.from(f.context.stdoutBytes.mock.calls[0]![0]).toString())).toMatchObject({ configured: personalId, team: { id: personalId } });
    await runTeamCommand(["default", "show", "--json"], f.context, f.dependencies);
    expect(JSON.parse(f.stdout.mock.calls[0]![0]).configured).toBe(personalId);
  });
  it.each(["token", "pair"])("refuses a concurrent %s change during confirmation", async (changed) => {
    const f = await fixture(teamId);
    const configPath = path.join(f.dir, "config.yml");
    const next = changed === "token" ? f.config.replace("test-token", "rotated-token") : f.config.replace(`${userId}: ${teamId}`, `${userId}: ${wrongId}`);
    const context = { ...f.context, prompt: { isInteractive: true, ask: vi.fn(async () => { await writeFile(configPath, next); return "y"; }), close: vi.fn(), select: vi.fn(), selectMany: vi.fn() } };
    await expect(runTeamCommand(["default", "set", "personal"], context, f.dependencies)).rejects.toThrow("changed during the Team operation");
    expect(await readFile(configPath, "utf8")).toBe(next);
  });
  it.each([["--confirm", "--confirm"], ["--confirm=false"], ["--confirm", "false"]])("rejects invalid default confirmation syntax %#", async (...args) => {
    const f = await fixture(teamId);
    await expect(runTeamCommand(["default", "set", "personal", ...args], f.context, f.dependencies)).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(await readFile(path.join(f.dir, "config.yml"), "utf8")).toBe(f.config);
  });
  it("does not borrow another account's or server's default", async () => {
    const f = await fixture();
    const config = `serverUrl: http://localhost:8787\nserverToken: rotated-token\nteamDefaults:\n  http://localhost:8787:\n    ${wrongId}: ${teamId}\n  https://elsewhere.test:\n    ${userId}: ${teamId}\n`;
    await writeFile(path.join(f.dir, "config.yml"), config);
    await runTeamCommand(["show", "--json"], f.context, f.dependencies);
    expect(JSON.parse(f.stdout.mock.calls[0]![0]).id).toBe(personalId);
    expect(await readFile(path.join(f.dir, "config.yml"), "utf8")).toBe(config);
  });
  it("retains the current account default after token rotation", async () => {
    const f = await fixture(teamId);
    await runTeamCommand(["show", "--json"], f.context, f.dependencies);
    await writeFile(path.join(f.dir, "config.yml"), f.config.replace("test-token", "rotated-token"));
    await runTeamCommand(["show", "--json"], f.context, f.dependencies);
    expect(f.stdout.mock.calls.map(([output]) => JSON.parse(output).id)).toEqual([teamId, teamId]);
  });
  it("resolves a new account and service independently", async () => {
    const f = await fixture(teamId);
    const newPersonal = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const nextMe = { ...me, id: wrongId, personalTeam: { id: newPersonal, kind: "personal", name: null } };
    const nextTeam = { ...team(personalId), id: newPersonal, membership: { ...team(personalId).membership, userId: wrongId, teamId: newPersonal } };
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => new Response(stringifyApiJson(new URL(String(url)).pathname.endsWith("/me") ? nextMe : nextTeam), { headers: { "content-type": "application/json", "Daynight-User-ID": wrongId } }));
    const dependencies = { runServerCommand: ((ctx, command) => runServerCommand(ctx, command, { fetch })) as typeof runServerCommand };
    await writeFile(path.join(f.dir, "config.yml"), f.config.replace("http://localhost:8787", "http://127.0.0.1:8787"));
    await runTeamCommand(["show", "--json"], f.context, dependencies);
    expect(JSON.parse(f.stdout.mock.calls[0]![0]).id).toBe(newPersonal);
  });
  it("reports a configuration removed after authentication instead of silently falling back", async () => {
    const f = await fixture(teamId);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      await rm(path.join(f.dir, "config.yml"));
      return new Response(stringifyApiJson(me), { headers: { "content-type": "application/json", "Daynight-User-ID": userId } });
    });
    const dependencies = { runServerCommand: ((ctx, command) => runServerCommand(ctx, command, { fetch })) as typeof runServerCommand };
    await expect(runTeamCommand(["default", "show"], f.context, dependencies)).rejects.toThrow();
    expect(f.stdout).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
