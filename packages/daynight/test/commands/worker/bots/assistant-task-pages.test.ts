import { describe, expect, it, vi } from "vitest";
import { createAssistantTaskClient, type AssistantTask, type AssistantTaskEvent, type AssistantTaskPage, type AssistantTaskQuery } from "../../../../src/api/assistant-task.js";
import { createOperation } from "../../../../src/api/operation.js";
import { assistantTaskPages, ASSISTANT_TASK_RESPONSE_BYTES } from "../../../../src/commands/worker/bots/assistant-task-pages.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const observedAt = "2026-11-13T00:00:00Z";
const event = (n: number, payload: string = "fact"): AssistantTaskEvent => ({ id: id(n), taskId: id(2), targetBotId: id(3), type: "report", payload,
  state: "pending", attention: true, createdAt: observedAt, deliveredAt: null, seenAt: null, ackOperationId: null });
const page = (items: AssistantTaskEvent[], nextCursor: string | null = null): AssistantTaskPage<AssistantTaskEvent> => ({ items, nextCursor, observedAt });

describe("assistant task and event page iteration", () => {
  it("streams tasks whose independently updated fields exceed the former single-response and cumulative limits", async () => {
    const text = "<".repeat(900 * 1024);
    const task = (n: number): AssistantTask => ({ id: id(n), ownerUserId: id(1), application: text, name: text, purpose: text, scope: text,
      kind: "continuous", state: "active", takeover: "manual", trigger: null, version: "4", manualVersion: "1", createdAt: observedAt, updatedAt: observedAt,
      holderBotId: null, credentialOperationId: null, claimGeneration: "0", claimState: "unowned", claimedAt: null, renewedAt: null, leaseUntil: null, observedAt });
    let receivedBytes = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async url => {
      const query = new URL(String(url)).searchParams;
      expect(query.get("limit")).toBe("1");
      const index = Number(query.get("cursor") ?? "0");
      const body = JSON.stringify({ items: [task(index + 10)], nextCursor: index === 0 ? "1" : null, observedAt }).replaceAll("<", "\\u003c");
      expect(Buffer.byteLength(body)).toBeGreaterThan(8 * 1024 * 1024);
      receivedBytes += Buffer.byteLength(body);
      return new Response(body, { headers: { "content-type": "application/json", "Daynight-User-ID": id(1) } });
    });
    const seen: string[] = [];
    for await (const item of assistantTaskPages(async query => {
      const operation = createOperation({ limits: { totalMs: 10_000, requestMs: 10_000, responseBytes: ASSISTANT_TASK_RESPONSE_BYTES, totalBytes: 32 * 1024 * 1024 } });
      try { return await createAssistantTaskClient({ serverUrl: "https://daynight.example", expectedUserId: id(1), operation, fetch }).listTasks(query); }
      finally { operation.dispose(); }
    })) {
      expect(item.scope).toHaveLength(text.length); seen.push(item.id);
    }
    expect(seen).toEqual([id(10), id(11)]); expect(fetch).toHaveBeenCalledTimes(2);
    expect(receivedBytes).toBeGreaterThan(32 * 1024 * 1024);
  });

  it("keeps each response and API operation bounded while traversing more than the cumulative byte budget", async () => {
    // This legal sub-1-MiB input expands past 2 MiB under the server's HTML escaping.
    const payload = "<".repeat(900 * 1024), count = 7;
    let receivedBytes = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async url => {
      const query = new URL(String(url)).searchParams;
      expect(query.get("limit")).toBe("1"); expect(query.get("state")).toBe("pending"); expect(query.get("targetBotId")).toBe(id(3));
      const index = Number(query.get("cursor") ?? "0");
      const body = JSON.stringify(page([event(index + 10, payload)], index + 1 < count ? String(index + 1) : null)).replaceAll("<", "\\u003c");
      expect(Buffer.byteLength(body)).toBeGreaterThan(2 * 1024 * 1024);
      receivedBytes += Buffer.byteLength(body);
      return new Response(body, { headers: { "content-type": "application/json", "Daynight-User-ID": id(1) } });
    });
    const read = async (query: AssistantTaskQuery) => {
      const operation = createOperation({ limits: { totalMs: 10_000, requestMs: 10_000, responseBytes: ASSISTANT_TASK_RESPONSE_BYTES, totalBytes: 32 * 1024 * 1024 } });
      try { return await createAssistantTaskClient({ serverUrl: "https://daynight.example", expectedUserId: id(1), botId: id(3), operation, fetch }).listEvents(undefined, query); }
      finally { operation.dispose(); }
    };
    const seen: string[] = [];
    for await (const item of assistantTaskPages(read, { state: "pending", targetBotId: id(3) })) {
      expect(item.payload).toHaveLength(payload.length); seen.push(item.id);
    }
    expect(seen).toEqual(Array.from({ length: count }, (_, n) => id(n + 10)));
    expect(fetch).toHaveBeenCalledTimes(count); expect(receivedBytes).toBeGreaterThan(32 * 1024 * 1024);
  });

  it("stops reading at the consumer's batch boundary without fetching the remaining history", async () => {
    const read = vi.fn(async (_query: AssistantTaskQuery) => page([event(10)], "later"));
    for await (const item of assistantTaskPages(read)) { expect(item.id).toBe(id(10)); break; }
    expect(read).toHaveBeenCalledExactlyOnceWith({ limit: 1 });
  });

  it("preserves filters through empty pages and stops at the requested identity", async () => {
    const read = vi.fn<(query: AssistantTaskQuery) => Promise<AssistantTaskPage<AssistantTaskEvent>>>()
      .mockResolvedValueOnce(page([], "first"))
      .mockResolvedValueOnce(page([event(10)], "second"))
      .mockResolvedValueOnce(page([event(11)], "unused"));
    for await (const item of assistantTaskPages(read, { targetBotId: id(3), state: "pending" })) if (item.id === id(11)) break;
    expect(read.mock.calls.map(([query]) => query)).toEqual([
      { limit: 1, targetBotId: id(3), state: "pending" },
      { limit: 1, targetBotId: id(3), state: "pending", cursor: "first" },
      { limit: 1, targetBotId: id(3), state: "pending", cursor: "second" },
    ]);
  });

  it("does not turn a failed later page into an exhausted event history", async () => {
    const failure = new Error("Page unavailable");
    const read = vi.fn<(query: AssistantTaskQuery) => Promise<AssistantTaskPage<AssistantTaskEvent>>>()
      .mockResolvedValueOnce(page([event(10)], "later")).mockRejectedValueOnce(failure);
    const iterator = assistantTaskPages(read);
    expect((await iterator.next()).value).toEqual(event(10));
    await expect(iterator.next()).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects a repeated cursor before exposing the cyclic page", async () => {
    const read = vi.fn(async () => page([event(10)], "same")), iterator = assistantTaskPages(read);
    expect((await iterator.next()).value).toEqual(event(10));
    await expect(iterator.next()).rejects.toThrow(/repeated a cursor/);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects a response that exceeds the requested payload count", async () => {
    const read = vi.fn(async () => page([event(10), event(11)]));
    await expect(assistantTaskPages(read).next()).rejects.toThrow(/requested size/);
  });
});
