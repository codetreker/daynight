import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../../src/api/index.js";
import { runCli } from "../../../src/cli/application.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runTeamCommand } from "../../../src/commands/team/command.js";
import { teamDefinition } from "../../../src/commands/team/definition.js";
import type { runServerCommand } from "../../../src/commands/server/runtime.js";

const userId = "aaaaaaaa-1111-4111-8111-111111111111";
const personalId = "bbbbbbbb-2222-4222-8222-222222222222";
const teamId = "cccccccc-3333-4333-8333-333333333333";
const invitationId = "dddddddd-4444-4444-8444-444444444444";
const secret = `dnteam_${Buffer.alloc(32, 7).toString("base64url")}`;
const link = `http://localhost:8787/team-invitations#${secret}`;
const time = "2026-11-04T00:00:00Z";
const user = { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: personalId, kind: "personal", name: null } };
const team = { id: teamId, kind: "ordinary", name: "Team", version: 7n, createdAt: time, updatedAt: time, membership: { teamId, userId, role: "admin", version: 2n, createdAt: time, updatedAt: time } };
const metadata = { id: invitationId, teamId, createdBy: userId, createdAt: time, expiresAt: "2026-11-11T00:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null };
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const fixture = (failure?: "lost" | "malformed" | "wrong-principal" | "malicious") => {
  const operation = createOperation(); cleanups.push(() => operation.dispose());
  let revoked = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const pathname = new URL(String(input)).pathname, method = init!.method;
    const headers = { "content-type": "application/json", "Daynight-User-ID": method === "POST" && failure === "wrong-principal" ? personalId : userId, ...(method === "POST" ? { Location: `/api/v1/teams/${teamId}/invitations/${invitationId}` } : {}) };
    const json = (body: unknown, status = 200) => new Response(stringifyApiJson(body), { status, headers });
    if (pathname === "/api/v1/me") return json(user);
    if (pathname === `/api/v1/teams/${personalId}`) return json({ ...team, id: personalId, kind: "personal", name: null, membership: { ...team.membership, teamId: personalId } });
    if (pathname === `/api/v1/teams/${teamId}`) return json(team);
    if (method === "GET") return json({ items: [metadata] });
    if (method === "DELETE") { const changed = !revoked; revoked = true; return json({ teamId, invitationId, changed }); }
    if (failure === "lost") throw new Error(`lost ${secret}`);
    if (failure === "malformed") return new Response(`{"link":"${link}",`, { status: 201, headers });
    return json({ ...metadata, link: failure === "malicious" ? `https://evil.example/team-invitations#${secret}` : link }, 201);
  });
  const api = createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch });
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => { throw new Error("Unexpected config read"); }, workingDirectory: () => { throw new Error("Unexpected repository read"); }, stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_bytes: Uint8Array) => {}) } satisfies CliContext;
  const runServer: typeof runServerCommand = async (current, command) => {
    const result = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
    if (typeof result === "string") current.stdout(result); else if (result !== undefined) current.stdout(result.output);
  };
  const run = (args: readonly string[]) => runCli(["team", ...args], context, [{ ...teamDefinition, load: async () => ({ run: (rest, current) => runTeamCommand(rest, current, { runServerCommand: runServer }) }) }]);
  return { context, fetch, run };
};

describe("Team invitation command", () => {
  it("creates a link once, lists metadata, then preserves both revoke outcomes", async () => {
    const f = fixture();
    expect(await f.run(["invitation", "create", "--team", teamId, "--confirm"])).toBe(0);
    expect(f.context.stdout.mock.calls[0]![0]).toBe(`${link}\n`);
    expect(JSON.parse(String(f.fetch.mock.calls[2]![1]!.body))).toEqual({ expectedUserId: userId });
    f.context.stdout.mockClear();
    expect(await f.run(["invitation", "create", "--team", teamId, "--confirm", "--json"])).toBe(0);
    expect(JSON.parse(f.context.stdout.mock.calls[0]![0])).toEqual({ ...metadata, link });
    f.context.stdout.mockClear();
    expect(await f.run(["invitation", "list", "--team", teamId, "--json"])).toBe(0);
    expect(JSON.parse(f.context.stdout.mock.calls[0]![0])).toEqual([metadata]);
    expect(f.context.stdout.mock.calls[0]![0]).not.toContain(secret);
    f.context.stdout.mockClear();
    for (const changed of [true, false]) {
      expect(await f.run(["invitation", "revoke", invitationId, "--team", teamId, "--confirm", "--json"])).toBe(0);
      expect(JSON.parse(f.context.stdout.mock.calls.at(-1)![0])).toEqual({ teamId, invitationId, changed });
    }
    const writes = f.fetch.mock.calls.filter(([, init]) => init!.method === "DELETE");
    expect(writes).toHaveLength(2);
    for (const [, init] of writes) expect(JSON.parse(String(init!.body))).toEqual({ expectedUserId: userId });
    expect(f.context.stderr).not.toHaveBeenCalled();
  });
  it.each(["lost", "malformed", "wrong-principal", "malicious"] as const)("keeps %s creation unconfirmed and secret without replay", async (failure) => {
    const f = fixture(failure);
    expect(await f.run(["invitation", "create", "--team", teamId, "--confirm"])).toBe(1);
    expect(f.context.stdout).not.toHaveBeenCalled();
    const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
    expect(diagnostic).toContain("outcome is unknown"); expect(diagnostic).not.toContain(secret);
    expect(f.fetch.mock.calls.map(([, init]) => init!.method)).toEqual(["GET", "GET", "POST"]);
  });
  it("rejects missing confirmation, invalid flags and Personal Team before any mutation", async () => {
    const f = fixture();
    expect(await f.run(["invitation", "create", "--team", teamId])).toBe(1);
    expect(await f.run(["invitation", "create", "--team", teamId, "--confirm=false"])).toBe(2);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.run(["invitation", "create", "--team", "personal", "--confirm"])).toBe(1);
    expect(f.fetch.mock.calls.map(([, init]) => init!.method)).toEqual(["GET", "GET"]);
    expect(f.context.stderr.mock.calls.at(-1)![0]).toContain("Personal Team");
  });
});
