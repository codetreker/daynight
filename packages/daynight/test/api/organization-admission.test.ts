import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation } from "../../src/api/index.js";
import type { Operation, Team } from "../../src/api/index.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const teamId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const time = "2026-11-04T00:00:00Z";
const team: Team = { id: teamId, kind: "ordinary", name: "Before", version: 1n, createdAt: time, updatedAt: time, membership: { teamId, userId, role: "admin", version: 1n, createdAt: time, updatedAt: time } };
const operations: Operation[] = [];
afterEach(() => { operations.splice(0).forEach((operation) => operation.dispose()); });

describe("organization admission refusals", () => {
  it.each([
    { action: "team create", message: "name: 257 code points exceeds maximum 256", method: "POST" },
    { action: "team rename", message: "name: 257 code points exceeds maximum 256", method: "PATCH" },
    { action: "project name", message: "name: 257 code points exceeds maximum 256", method: "POST" },
    { action: "project repository", message: "repoUrl: 4097 bytes exceeds maximum 4096", method: "POST" },
  ])("preserves the service's confirmed $action refusal without replay", async ({ action, message, method }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: "invalid_input", message, requestId } }), {
      status: 400, headers: { "content-type": "application/json", "Daynight-User-ID": userId },
    }));
    const operation = createOperation(); operations.push(operation);
    const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
    const name = "a".repeat(257);
    const repoUrl = "https://example.test/" + "a".repeat(4076);
    const result = action === "team create" ? api.createTeam(userId, name, requestId)
      : action === "team rename" ? api.renameTeam(userId, team, name, requestId)
        : api.createProject({ name: action === "project name" ? name : "Project", repoUrl: action === "project repository" ? repoUrl : "host:repo", expectedUserId: userId }, requestId);
    await expect(result).rejects.toMatchObject({ status: 400, phase: "response", code: "invalid_input", serverMessage: message, confirmedRefusal: true, outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![1]?.method).toBe(method);
  });
});
