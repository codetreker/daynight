import { createMemoryDatabase } from "../../../helpers/sqlite.js";
import { afterEach, describe, expect, it } from "vitest";
import { createBotInventory } from "../../../../src/commands/worker/bots/inventory.js";
import { openBotStore } from "../../../../src/commands/worker/bots/store.js";
import type { Bot, BotOwner } from "../../../../src/commands/worker/bots/types.js";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const owner: BotOwner = { serverOrigin: "https://daynight.example", ownerUserId: id(1), workerId: id(2) };
const bot = (value = 3, version = "1"): Bot => ({
  id: id(value), ownerUserId: owner.ownerUserId, workerId: owner.workerId, version, deletion: null, name: "Assistant", creationOrder: "1",
  requestedOverrides: {}, resolvedConfiguration: { workerId: owner.workerId, cwd: "/ordinary", provider: "codex", model: null, args: [] },
  roleConfiguration: null, sessionId: null, testExecutionId: null, startupResult: { state: "pending", code: null },
  createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z",
});
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fixture = async () => {
  const store = openBotStore(createMemoryDatabase());
  cleanups.push(() => store.close());
  return store;
};
const signal = () => new AbortController().signal;

describe("Bot inventory reconciliation", () => {
  it("uses authoritative detail for duplicate and missing list identities before persisting observations", async () => {
    const store = await fixture();
    store.observe(owner, bot(4), 1);
    const reads: string[] = [];
    const inventory = createBotInventory({ owner, store, now: () => 2, remote: { owner,
      list: async () => [bot(3), bot(3, "2")],
      read: async botId => { reads.push(botId); return bot(botId === id(3) ? 3 : 4, "3"); },
    } });
    const result = await inventory.reconcile(signal());
    expect(new Set(reads)).toEqual(new Set([id(3), id(4)]));
    expect(result).toEqual({ observed: [id(3), id(4)], missing: [] });
    expect(store.get(owner, id(3))!.observed.version).toBe("3");
    expect(store.get(owner, id(4))!.observed.version).toBe("3");
  });

  it("retains existing responsibility after failed lists and failed authoritative reads", async () => {
    const store = await fixture();
    store.observe(owner, bot(4), 1);
    const before = store.list(owner);
    const failure = new Error("Unavailable");
    const failedList = createBotInventory({ owner, store, remote: { owner, list: async () => { throw failure; }, read: async () => null } });
    await expect(failedList.reconcile(signal())).rejects.toBe(failure);
    expect(store.list(owner)).toEqual(before);
    const failedDetail = createBotInventory({ owner, store, remote: { owner, list: async () => [bot(3)], read: async () => { throw failure; } } });
    await expect(failedDetail.reconcile(signal())).rejects.toBe(failure);
    expect(store.list(owner)).toEqual(before);
    expect(store.get(owner, id(3))).toBeNull();
  });

  it("records a confirmed missing identity without releasing its local records", async () => {
    const store = await fixture();
    store.observe(owner, bot(), 1);
    const original = store.get(owner, id(3));
    const inventory = createBotInventory({ owner, store, remote: { owner, list: async () => [], read: async () => null } });
    await expect(inventory.reconcile(signal())).resolves.toEqual({ observed: [], missing: [id(3)] });
    expect(store.get(owner, id(3))).toEqual(original);
  });

  it("preserves frozen data when a missing Bot becomes a deletion responsibility", async () => {
    const store = await fixture();
    store.observe(owner, bot(), 1);
    const original = store.get(owner, id(3))!;
    const deletion: Bot = { id: id(3), workerId: owner.workerId, version: "2", deletion: { deletionId: id(9), requestedVersion: "1", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } };
    const inventory = createBotInventory({ owner, store, remote: { owner, list: async () => [], read: async () => deletion } });
    await inventory.reconcile(signal());
    const result = store.get(owner, id(3))!;
    expect(result.observed).toEqual(deletion);
    expect(result.definition).toEqual(original.definition);
    expect(result.intent).toBeNull();
  });

  it("rejects foreign ownership or an unexpected detail identity without changing the inventory", async () => {
    const store = await fixture();
    store.observe(owner, bot(), 1);
    const before = store.list(owner);
    const foreign = createBotInventory({ owner, store, remote: { owner, list: async () => [{ ...bot(), workerId: id(99) }], read: async () => null } });
    await expect(foreign.reconcile(signal())).rejects.toThrow();
    const switched = createBotInventory({ owner, store, remote: { owner, list: async () => [], read: async () => bot(4) } });
    await expect(switched.reconcile(signal())).rejects.toThrow();
    expect(store.list(owner)).toEqual(before);
  });

  it("refuses a remote bound to another service even when user and Worker UUIDs match", async () => {
    const store = await fixture();
    expect(() => createBotInventory({ owner, store, remote: { owner: { ...owner, serverOrigin: "https://other.example" }, list: async () => [], read: async () => null } })).toThrow(/remote service/);
    expect(store.list(owner)).toEqual([]);
  });

  it("honors cancellation after network observations before creating durable records", async () => {
    const store = await fixture();
    const controller = new AbortController();
    const inventory = createBotInventory({ owner, store, remote: { owner, list: async () => { controller.abort(); return [bot()]; }, read: async () => null } });
    await expect(inventory.reconcile(controller.signal)).rejects.toThrow();
    expect(store.list(owner)).toEqual([]);
  });
});
