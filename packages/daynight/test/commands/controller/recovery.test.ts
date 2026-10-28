import { test, expect, vi } from "vitest";
import { isCleaningGeneration, observeNativeInput, observeNativeInteraction } from "../../../src/commands/controller/recovery.js";
import type { ControllerLifecycleStore, ControllerOperation } from "../../../src/commands/controller/lifecycle-store.js";

test("cleanup admission belongs to its execution generation, including legacy tombstones", () => {
  const operation = { kind: "cleanup", state: "confirmed", executionGeneration: "1" } as ControllerOperation;
  expect(isCleaningGeneration([operation], "1")).toBe(true);
  expect(isCleaningGeneration([operation], "2")).toBe(false);
  const { executionGeneration: omitted, ...legacy } = operation;
  expect(isCleaningGeneration([legacy], "2")).toBe(false);
});

test("native user identity resolves only uncertain input receipt, never cleanup or completed operations", () => {
  const recordOperation = vi.fn();
  const getOperation = vi.fn();
  const journal = { getOperation, recordOperation } as unknown as ControllerLifecycleStore;
  for (const kind of ["initial", "send_message"]) for (const state of ["unknown", "dispatching"]) {
    getOperation.mockReturnValue({ kind, state, result: null });
    expect(observeNativeInput(journal, "matching-id")).toBe(true);
    expect(recordOperation).toHaveBeenLastCalledWith("matching-id", "provider_accepted", null);
  }
  recordOperation.mockClear();
  for (const operation of [null, { kind: "cleanup", state: "unknown" }, { kind: "cancel", state: "unknown" }, { kind: "initial", state: "accepted" }, { kind: "initial", state: "confirmed" }, { kind: "send_message", state: "rejected" }]) {
    getOperation.mockReturnValue(operation); expect(observeNativeInput(journal, "other-id")).toBe(false);
  }
  expect(recordOperation).not.toHaveBeenCalled();
});


test("late interaction resolution settles only the matching uncertain response in the original generation", () => {
  const records = [
    { operationId: "matching", executionGeneration: "2", kind: "interaction_response", state: "unknown", payload: { interactionId: "card" } },
    { operationId: "older", executionGeneration: "1", kind: "interaction_response", state: "unknown", payload: { interactionId: "card" } },
    { operationId: "other", executionGeneration: "2", kind: "interaction_response", state: "dispatching", payload: { interactionId: "another-card" } },
    { operationId: "rejected", executionGeneration: "2", kind: "interaction_response", state: "rejected", payload: { interactionId: "card" } },
    { operationId: "unsent", executionGeneration: "2", kind: "interaction_response", state: "accepted", payload: { interactionId: "card" } },
  ];
  const recordOperation = vi.fn((id, state, result) => ({ operationId: id, state, result }));
  const journal = { listOperations: () => records, recordOperation } as unknown as ControllerLifecycleStore;
  expect(observeNativeInteraction(journal, "card", "2")).toEqual([{ operationId: "matching", state: "confirmed", result: { disposition: "handled" } }]);
  expect(recordOperation).toHaveBeenCalledOnce();
});
