import { afterEach, expect, it } from "vitest";
import { createOperation } from "../../src/api/operation.js";
import { withinOperation } from "../../src/platform/tool-io.js";

const operations: ReturnType<typeof createOperation>[] = [];
afterEach(() => operations.splice(0).forEach(item => item.dispose()));

it("rejects at cancellation and disposes an owned resource that arrives afterward", async () => {
  const controller = new AbortController(), operation = createOperation({ signal: controller.signal }); operations.push(operation);
  let release!: (value: { close: () => void }) => void, closed!: () => void;
  const disposal = new Promise<void>(resolve => { closed = resolve; });
  const result = withinOperation(new Promise<{ close: () => void }>(resolve => { release = resolve; }), operation, async value => value.close());
  controller.abort(); await expect(result).rejects.toMatchObject({ kind: "cancelled" });
  release({ close: closed }); await disposal;
});

it("preserves filesystem errors and does not dispose a resource returned to its caller", async () => {
  const operation = createOperation(); operations.push(operation);
  const failure = Object.assign(new Error("unreadable"), { code: "EACCES" });
  await expect(withinOperation(Promise.reject(failure), operation)).rejects.toBe(failure);
  const value = { close: () => { throw new Error("caller still owns this"); } };
  expect(await withinOperation(Promise.resolve(value), operation, async resource => resource.close())).toBe(value);
});
