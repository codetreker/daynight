import { expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../../src/api/index.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runProjectCommand } from "../../../src/commands/project/command.js";
import type { ProjectCommandDependencies } from "../../../src/commands/project/command.js";

it("authenticates every request in project duplicate lookup and creation", async () => {
  const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", teamId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const time = "2026-10-20T01:02:03Z", token = "fixture-private-token";
  const user = { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: teamId, kind: "personal", name: null } };
  const team = { id: teamId, kind: "personal", name: null, version: 1n, createdAt: time, updatedAt: time, membership: { teamId, userId, role: "admin", version: 1n, createdAt: time, updatedAt: time } };
  const project = { id: projectId, name: "Project", repoUrl: "https://example.test/owner/repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId, version: 1n }, createdAt: time, updatedAt: time };
  const receipt = { ...project, access: { projectId, ownerTeam: { id: teamId, kind: "personal", name: null }, ownership: project.ownership, effectiveRole: "admin", teamRole: "admin", canTransfer: true, directGrant: { projectId, userId, role: "admin", version: 1n, createdAt: time, updatedAt: time } } };
  const requests: { method: string | undefined; path: string; authorization: string | null }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push({ method: init?.method, path, authorization: new Headers(init?.headers).get("Authorization") });
    const body = path === "/api/v1/me" ? user : path === `/api/v1/teams/${teamId}` ? team : init?.method === "POST" ? receipt : { items: [], nextCursor: null };
    return new Response(stringifyApiJson(body), { status: init?.method === "POST" ? 201 : 200, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
  });
  const operation = createOperation();
  const api = createApiClient({ serverUrl: "http://localhost", serverToken: token, operation, fetch });
  const context = { version: "0.0.0", packageDirectory: "unused", homeDirectory: () => { throw new Error("Unexpected config read"); }, workingDirectory: () => { throw new Error("Unexpected repository read"); }, stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_bytes: Uint8Array) => {}) } satisfies CliContext;
  const dependencies = { runServerCommand: vi.fn<ProjectCommandDependencies["runServerCommand"]>(async (current, command) => {
    const output = await command({ api, operation, serverUrl: "http://localhost", serverConfiguration: { serverUrl: "http://localhost", serverToken: token } });
    if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
  }) };
  try {
    await runProjectCommand(["create", project.name, "--repo", project.repoUrl, "--team", "personal", "--confirm"], context, dependencies);
    expect(requests.map(({ method, path }) => [method, path])).toEqual([["GET", "/api/v1/projects"], ["GET", "/api/v1/me"], ["GET", `/api/v1/teams/${teamId}`], ["POST", "/api/v1/projects"]]);
    expect(requests.every(({ authorization }) => authorization === `Bearer ${token}`)).toBe(true);
    expect(context.stdout.mock.calls[0]![0]).toContain(`Project created.\nID: ${projectId}\n`);
    expect(context.stdout.mock.calls[0]![0]).not.toContain(token); expect(context.stderr).not.toHaveBeenCalled();
  } finally { operation.dispose(); }
});
