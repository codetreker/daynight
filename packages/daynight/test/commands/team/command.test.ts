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
const fixture = async (defaultValue?: string) => {
  const base = path.resolve("../../.tmp"); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "team-command-")); dirs.push(dir); vi.stubEnv("DN_CONFIG_DIR", dir);
  const config = `serverUrl: http://localhost:8787\nserverToken: test-token\n${defaultValue === undefined ? "" : `teamDefaults:\n  http://localhost:8787:\n    ${userId}: ${defaultValue}\n    ${wrongId}: ${wrongId}\n  https://elsewhere.test:\n    ${userId}: ${wrongId}\n`}`;
  await writeFile(path.join(dir, "config.yml"), config);
  const calls: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    calls.push(`${init?.method} ${new URL(String(url)).pathname}`);
    const parsed = new URL(String(url));
    const headers = { "content-type": "application/json", "Daynight-User-ID": userId };
    if (parsed.pathname === "/api/v1/me") return new Response(stringifyApiJson(me), { headers });
    if (parsed.pathname === "/api/v1/teams") return new Response(stringifyApiJson({ items: [team(personalId), team(teamId)], nextCursor: null }), { headers });
    if (parsed.pathname === `/api/v1/teams/${wrongId}` || parsed.searchParams.get("teamId") === wrongId) return new Response(stringifyApiJson({ error: { code: "not_found", message: "Team was not found.", requestId: "request" } }), { status: 404, headers });
    if (parsed.pathname.startsWith("/api/v1/teams/")) return new Response(stringifyApiJson(team(parsed.pathname.split("/").at(-1)!)), { headers });
    return new Response(stringifyApiJson({ items: [], nextCursor: null }), { headers });
  });
  const stdout = vi.fn<(value: string) => void>();
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => dir, workingDirectory: () => dir, stdout, stderr: vi.fn(), stdoutBytes: vi.fn(async () => {}) };
  const dependencies = { runServerCommand: ((ctx, command) => runServerCommand(ctx, command, { fetch })) as typeof runServerCommand };
  return { dir, config, calls, stdout, context, dependencies };
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
