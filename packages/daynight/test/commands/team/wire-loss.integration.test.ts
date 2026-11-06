import { createServer, type ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../../src/api/index.js";
import { runCli } from "../../../src/cli/application.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runTeamCommand, type TeamCommandDependencies } from "../../../src/commands/team/command.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const teamId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const personalId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const time = "2026-11-04T00:00:00Z";
const version = 9_007_199_254_740_993n;
const member = (id: string) => ({ teamId, userId: id, role: "admin", version, createdAt: time, updatedAt: time });
const me = { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: personalId, kind: "personal", name: null } };
const team = { id: teamId, kind: "ordinary", name: "Private old name", version, createdAt: time, updatedAt: time, membership: member(userId) };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Request = { method: string; path: string; body: string; requestId: string | undefined; authorization: string | undefined };
const fixture = async (lost = true, refusal?: string, privateFailure = false) => {
  const requests: Request[] = [];
  const server = createServer((request, response: ServerResponse) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", (part: string) => { body += part; });
    request.on("end", () => {
      const observed = { method: request.method!, path: request.url!, body, requestId: request.headers["x-request-id"] as string | undefined, authorization: request.headers.authorization };
      requests.push(observed);
      if (observed.method !== "GET") {
        if (lost) { response.socket!.destroy(); return; }
        if (refusal !== undefined) { response.writeHead(409, { "Content-Type": "application/json", "Daynight-User-ID": userId }); response.end(JSON.stringify({ error: { code: refusal, message: "refused", requestId: "refusal" } })); return; }
        const value = observed.method === "POST" ? { ...team, name: JSON.parse(observed.body).name, version: 1n, membership: { ...member(userId), version: 1n } } : observed.method === "PATCH" ? { membership: { ...member(userId), role: "member", version: version + 1n }, actorRole: "member" } : observed.path.endsWith(`/members/${userId}`) ? { teamId, userId, removed: true, actorRole: null } : { teamId, deleted: true };
        response.writeHead(observed.method === "POST" ? 201 : 200, { "Content-Type": "application/json", "Daynight-User-ID": userId, ...(observed.method === "POST" ? { Location: `/api/v1/teams/${teamId}` } : {}) }); response.end(stringifyApiJson(value)); return;
      }
      const selectedTeam = observed.path.includes(personalId) ? personalId : teamId;
      const value = observed.path === "/api/v1/me" ? me : observed.path.endsWith("/members") ? { items: [member(userId), member(otherId)].map((item) => ({ ...item, teamId: selectedTeam, profile: { name: null, email: null, avatarUrl: null } })) } : selectedTeam === personalId ? { ...team, id: personalId, kind: "personal", name: null, membership: { ...member(userId), teamId: personalId } } : team;
      response.writeHead(200, { "Content-Type": "application/json", "Daynight-User-ID": userId }); response.end(stringifyApiJson(value));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  cleanups.push(async () => { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))); });
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing HTTP listener.");
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const operation = createOperation({ limits: { totalMs: 5_000, requestMs: 3_000 } }); cleanups.push(() => operation.dispose());
  const fetchWithPrivateFailure: typeof globalThis.fetch = async (input, init) => {
    const response = await globalThis.fetch(input, init);
    if (init?.method === "DELETE") { await response.body?.cancel(); throw new Error("private proxy loss"); }
    return response;
  };
  const api = createApiClient({ serverUrl, serverToken: "private-token", expectedUserId: userId, operation, ...(privateFailure ? { fetch: fetchWithPrivateFailure } : {}) });
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => { throw new Error("Unexpected config read"); }, workingDirectory: () => { throw new Error("Unexpected repository read"); }, stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_value: Uint8Array) => {}) } satisfies CliContext;
  const dependencies: TeamCommandDependencies = { runServerCommand: async (current, command) => {
    const output = await command({ api, operation, serverUrl, serverConfiguration: { serverUrl } });
    operation.check(); if (typeof output === "string") current.stdout(output); else if (output !== undefined) await current.stdoutBytes(Buffer.from(output.output), operation.signal);
  } };
  const run = (args: string[]) => runCli(["team", ...args], context, [{ name: "team", description: "Manage teams", load: async () => ({ run: (rest, current) => runTeamCommand(rest, current, dependencies) }) }]);
  return { requests, context, run };
};

it("prints every field of a confirmed Team creation", async () => {
  const f = await fixture(false);
  const name = "  Team\nwith\rcontrols\tand\\backslash  ";
  expect(await f.run(["create", name, "--confirm", "--json"])).toBe(0);
  const expected = { ...team, name, version: 1n, membership: { ...member(userId), version: 1n } };
  expect(Buffer.from(f.context.stdoutBytes.mock.calls[0]![0]).toString().trim()).toBe(stringifyApiJson(expected));
  expect(f.requests.map(({ method, path }) => `${method} ${path}`)).toEqual(["GET /api/v1/me", "POST /api/v1/teams"]);
  expect(JSON.parse(f.requests[1]!.body)).toEqual({ name, expectedUserId: userId });
  expect(f.context.stderr).not.toHaveBeenCalled();
});

it("prints both Team members with exact identities, roles, versions and profiles", async () => {
  const f = await fixture(false);
  expect(await f.run(["member", "list", "--team", teamId, "--json"])).toBe(0);
  const members = [member(userId), member(otherId)].map(item => ({ ...item, profile: { name: null, email: null, avatarUrl: null } }));
  expect(f.context.stdout).toHaveBeenCalledExactlyOnceWith(`${stringifyApiJson(members)}\n`);
  expect(f.requests.map(({ method, path }) => `${method} ${path}`)).toEqual(["GET /api/v1/me", `GET /api/v1/teams/${teamId}/members`]);
  expect(f.context.stderr).not.toHaveBeenCalled();
});

it.each(["rename", "remove"])("reports a lost %s response with one write and safe request identity", async (action) => {
  const f = await fixture();
  const args = action === "rename" ? ["rename", "Private new name", "--team", teamId, "--confirm", "--json"] : ["member", "remove", otherId, "--team", teamId, "--confirm", "--json"];
  expect(await f.run(args)).toBe(1);
  const expectedPath = action === "rename" ? `/api/v1/teams/${teamId}` : `/api/v1/teams/${teamId}/members/${otherId}`;
  expect(f.requests.map(({ method, path }) => `${method} ${path}`)).toEqual(["GET /api/v1/me", `GET /api/v1/teams/${teamId}${action === "remove" ? "/members" : ""}`, `${action === "rename" ? "PATCH" : "DELETE"} ${expectedPath}`]);
  const write = f.requests[2]!;
  expect(write.body).toContain(`"version":${version}`); expect(write.body).toContain(`"expectedUserId":"${userId}"`);
  if (action === "rename") expect(JSON.parse(write.body).name).toBe("Private new name");
  expect(write.authorization).toBe("Bearer private-token"); expect(write.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
  const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
  expect(diagnostic).toContain(`outcome is unknown (requestId=${write.requestId})`);
  expect(diagnostic).not.toMatch(/private-token|Private new name|Private old name|Caused by:/);
});

it("keeps a private transport failure out of an unknown removal diagnostic", async () => {
  const f = await fixture(false, undefined, true);
  expect(await f.run(["member", "remove", otherId, "--team", teamId, "--confirm", "--json"])).toBe(1);
  expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET", "DELETE"]);
  const write = f.requests[2]!;
  expect(write.requestId).toMatch(/^[0-9a-f-]{36}$/);
  const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
  expect(diagnostic).toContain(`outcome is unknown (requestId=${write.requestId})`);
  expect(diagnostic).not.toContain("private proxy loss");
  expect(diagnostic).not.toContain("private-token");
  expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
});

it.each([
  ["personal_team_immutable", "leave", personalId],
  ["personal_team_immutable", "set-role", personalId],
  ["last_admin", "leave", teamId],
  ["last_admin", "set-role", teamId],
])("preserves %s for %s with exit 1 and no success output", async (code, action, selectedTeam) => {
  const f = await fixture(false, code);
  const args = action === "leave" ? ["leave"] : ["member", "set-role", userId, "member"];
  expect(await f.run([...args, "--team", selectedTeam, "--confirm"])).toBe(1);
  expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
  expect(f.context.stderr.mock.calls.map(([text]) => text).join("")).toContain(code);
  expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET", action === "leave" ? "DELETE" : "PATCH"]);
});

it.each(["delete", "leave", "demote"])("prints the complete confirmed %s receipt", async (action) => {
  const f = await fixture(false);
  const args = action === "delete" ? ["delete"] : action === "leave" ? ["leave"] : ["member", "set-role", userId, "member"];
  expect(await f.run([...args, "--team", teamId, "--confirm", "--json"])).toBe(0);
  const output = Buffer.from(f.context.stdoutBytes.mock.calls[0]![0]).toString();
  const expected = action === "delete" ? { teamId, deleted: true } : action === "leave" ? { teamId, userId, removed: true, actorRole: null } : { membership: { ...member(userId), role: "member", version: version + 1n }, actorRole: "member" };
  expect(output.trim()).toBe(stringifyApiJson(expected));
  expect(f.requests).toHaveLength(3);
  expect(f.context.stderr).not.toHaveBeenCalled();
});
