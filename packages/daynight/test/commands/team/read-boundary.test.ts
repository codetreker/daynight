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
const time = "2026-11-04T00:00:00Z";
const user = { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: personalId, kind: "personal", name: null } };
const team = (id: string) => ({ id, kind: id === personalId ? "personal" : "ordinary", name: id === personalId ? null : "Team", version: 1n, createdAt: time, updatedAt: time, membership: { teamId: id, userId, role: "admin", version: 9_007_199_254_740_993n, createdAt: time, updatedAt: time } });
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const fixture = (failure?: "refusal" | "principal") => {
  const operation = createOperation(); cleanups.push(() => operation.dispose());
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input)), second = url.searchParams.has("cursor");
    const headers = { "content-type": "application/json", "Daynight-User-ID": second && failure === "principal" ? personalId : userId };
    if (url.pathname === "/api/v1/me") return new Response(stringifyApiJson(user), { headers });
    if (second && failure === "refusal") return new Response(JSON.stringify({ error: { code: "internal_error", message: "unavailable", requestId: "page-two" } }), { status: 500, headers });
    return new Response(stringifyApiJson(second ? { items: [team(teamId)], nextCursor: null } : { items: [team(personalId)], nextCursor: "opaque /+?" }), { headers });
  });
  const api = createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch });
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => { throw new Error("List must not read defaults"); }, workingDirectory: () => { throw new Error("List must not read repository"); }, stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_bytes: Uint8Array) => {}) } satisfies CliContext;
  const runServer: typeof runServerCommand = async (current, command) => {
    const result = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
    if (typeof result === "string") current.stdout(result); else if (result !== undefined) current.stdout(result.output);
  };
  const run = () => runCli(["team", "list", "--json"], context, [{ ...teamDefinition, load: async () => ({ run: (rest, current) => runTeamCommand(rest, current, { runServerCommand: runServer }) }) }]);
  return { context, fetch, run };
};

describe("Team list command paging", () => {
  it("prints all pages together with the original versions and cursor", async () => {
    const f = fixture();
    expect(await f.run()).toBe(0);
    expect(f.context.stdout).toHaveBeenCalledOnce();
    expect(f.context.stdout.mock.calls[0]![0]).toContain('"version":9007199254740993');
    expect(f.context.stdout.mock.calls[0]![0]).toContain(teamId);
    expect(new URL(String(f.fetch.mock.calls[2]![0])).searchParams.get("cursor")).toBe("opaque /+?");
    expect(f.fetch.mock.calls.map(([, init]) => init!.method)).toEqual(["GET", "GET", "GET"]);
    expect(f.context.stderr).not.toHaveBeenCalled();
  });
  it.each(["refusal", "principal"] as const)("keeps stdout empty on a later page %s", async (failure) => {
    const f = fixture(failure);
    expect(await f.run()).toBe(1); expect(f.context.stdout).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(3); expect(f.context.stderr).toHaveBeenCalledOnce();
  });
});
