import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";

const projectId = "11111111-1111-1111-1111-111111111111";
const taskId = "22222222-2222-2222-2222-222222222222";
const time = "2026-10-20T01:02:03Z";
const task = { id: taskId, type: "task", parentId: null, projectId, title: "private", description: "private description", tags: [], properties: {}, status: "todo", allowAgents: false, requiredPlatform: null, assignedTo: null, version: 9007199254740994n, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true };
const operations: ReturnType<typeof createOperation>[] = [];
afterEach(() => { operations.splice(0).forEach(op => op.dispose()); vi.restoreAllMocks(); });
const response = (body: unknown, returnHeader?: string, status = 200) => new Response(stringifyApiJson(body), { status, headers: { "Content-Type": "application/json", ...(returnHeader === undefined ? {} : { "Daynight-Return": returnHeader }) } });
const setup = (result: Response) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(result);
  const operation = createOperation(); operations.push(operation);
  return { fetch, api: createApiClient({ serverUrl: "http://localhost:8787", operation, fetch }) };
};

describe("scoped Task update receipts", () => {
  it.each(["receipt", "legacy"])("accepts %s response once without exposing the full Task", async (kind) => {
    const f = setup(kind === "receipt" ? response({ projectId, taskId, version: task.version }, "receipt-v1") : response(task));
    await expect(f.api.updateTaskReceipt(projectId, taskId, { version: 9007199254740993n, title: "new" })).resolves.toEqual({ projectId, taskId, version: task.version });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls[0]![1]!.headers).toMatchObject({ "Daynight-Return": "receipt-v1" });
    expect(String(f.fetch.mock.calls[0]![1]!.body)).toContain('"version":9007199254740993');
  });

  it.each([
    [{ projectId, taskId, version: 3n }, "receipt-v1"],
    [{ projectId, taskId: projectId, version: 2n }, "receipt-v1"],
    [{ projectId, taskId, version: 2n, description: "leak" }, "receipt-v1"],
    [task, "unexpected"],
    [{ ...task, id: projectId, version: 2n }, undefined],
  ] as const)("rejects mismatched or malformed response without resending", async (body, header) => {
    const f = setup(response(body, header));
    await expect(f.api.updateTaskReceipt(projectId, taskId, { version: 1n, title: "new" })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("preserves scope refusal without retry", async () => {
    const f = setup(new Response(JSON.stringify({ error: { code: "forbidden", message: "insufficient scope", requestId: "req-1" } }), { status: 403, headers: { "Content-Type": "application/json", "Daynight-Scope-Status": "insufficient_scope" } }));
    await expect(f.api.updateTaskReceipt(projectId, taskId, { version: 1n, allowAgents: true })).rejects.toMatchObject({ status: 403, confirmedRefusal: true, scopeStatus: "insufficient_scope" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});
