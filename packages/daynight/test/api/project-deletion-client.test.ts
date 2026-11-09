import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import { createOperation } from "../../src/api/operation.js";

const user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const request = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("Project deletion transport", () => {
  it.each(["timeout", "cancel"])("keeps a dispatched %s unknown without replay", async (kind) => {
    const cancellation = new AbortController();
    const operation = createOperation({ signal: cancellation.signal, limits: { requestMs: 30 } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      if (kind === "cancel") cancellation.abort();
      return new Promise<Response>(() => {});
    });
    try {
      const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
      await expect(api.deleteProject(user, project, request)).rejects.toMatchObject({ outcomeUnconfirmed: true });
      expect(fetch).toHaveBeenCalledOnce();
    } finally { operation.dispose(); }
  });

  it("retains the confirmed Project ID when response cleanup fails", async () => {
    const response = new Response(JSON.stringify({ projectId: project, deleted: true }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": user } });
    const reader = response.body!.getReader(), release = reader.releaseLock.bind(reader);
    Object.defineProperty(reader, "releaseLock", { value: () => { release(); throw new Error("release failed"); } });
    Object.defineProperty(response.body, "getReader", { value: () => reader });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const operation = createOperation();
    try {
      const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
      await expect(api.deleteProject(user, project, request)).rejects.toMatchObject({ confirmedMutationId: project, outcomeUnconfirmed: false });
      expect(fetch).toHaveBeenCalledOnce();
    } finally { operation.dispose(); }
  });
});
