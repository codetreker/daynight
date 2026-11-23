import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { BotCliProbeCleanupError, retainedBotCliProbes } from "../../../src/commands/worker/bots/cli-probe.js";
import { createNativeSelectionVerifier } from "../../../src/commands/worker/native-selection.js";
import { OwnedCommandAdmissionError, withOwnedCommandLifecycle } from "../../../src/commands/worker/owned-command-lifecycle.js";
import { createExecutionScopeManager } from "../../../src/commands/worker/execution-scope.js";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../../src/commands/worker/bots/cli-probe.js", async original => ({ ...await original<object>(), createBotCliProbe: mocks.create }));
afterEach(() => vi.resetAllMocks());
const input = { native: { agent: "codex" as const, model: "model", args: [] }, cwd: process.cwd(), environment: {} };
const ownership = { launchId: "own-probe", pid: 123, process: null, jobObjectName: null, targetStarted: true };

it("retires a real probe rejected before reservation and permits a fresh execution scope", async () => {
  const actual = await vi.importActual<typeof import("../../../src/commands/worker/bots/cli-probe.js")>("../../../src/commands/worker/bots/cli-probe.js");
  mocks.create.mockImplementation(actual.createBotCliProbe);
  const manager = createExecutionScopeManager(new AbortController().signal), scope = manager.create();
  const operation = createOperation({ signal: scope.signal }), verifier = createNativeSelectionVerifier();
  const reason = new Error("Scope closed before the prepared sink was entered."), writes = vi.fn();
  const sink = vi.fn(async event => {
    expect(event.stage).toBe("prepared");
    expect(retainedBotCliProbes()).toContainEqual(expect.objectContaining({ launchId: event.resourceId, pid: null, targetStarted: false }));
    scope.closeAdmission(reason);
    if (scope.signal.aborted) throw new OwnedCommandAdmissionError(scope.signal.reason);
    await writes(event);
  });
  scope.register({ resourceId: "native-selection", ownerKind: "probe", stop: () => verifier.close() });
  try {
    await expect(withOwnedCommandLifecycle(sink, () => verifier.verify(input, operation))).rejects.toMatchObject({ code: "capability_error", cause: { kind: "cancelled", cause: reason } });
    expect(sink).toHaveBeenCalledOnce(); expect(writes).not.toHaveBeenCalled();
    expect(retainedBotCliProbes()).toEqual([]);
    expect((await scope.stop()).every(result => result.stop === "confirmed")).toBe(true);
    const next = manager.create();
    expect(next.generation).toBe("2"); expect(next.signal).not.toBe(scope.signal); expect(next.signal.aborted).toBe(false);
    await next.stop();
    expect(sink).toHaveBeenCalledOnce();
  } finally { operation.dispose(); await verifier.close(); }
});

it("blocks new probes while prior descendant cleanup is unconfirmed and retries at shutdown", async () => {
  const operation = createOperation(), verifier = createNativeSelectionVerifier();
  const retry = vi.fn().mockRejectedValue(new Error("descendants still live"));
  const cleanup = new BotCliProbeCleanupError(ownership, retry);
  mocks.create.mockResolvedValue({ run: vi.fn().mockResolvedValue({ stdout: '{"ok":true,"observation":{"model":"model","models":[{"id":"model","efforts":null}]}}' }), close: vi.fn().mockRejectedValue(cleanup) });
  try {
    await expect(verifier.verify(input, operation)).rejects.toMatchObject({ code: "cleanup_unknown", cause: cleanup });
    await expect(verifier.verify(input, operation)).rejects.toThrow("cleanup remains unconfirmed");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    await expect(verifier.close()).rejects.toThrow("cleanup remains unconfirmed");
    retry.mockResolvedValue(undefined);
    await verifier.close();
    expect(retry).toHaveBeenCalledTimes(3);
    await expect(verifier.verify(input, operation)).rejects.toThrow("closed");
  } finally { operation.dispose(); }
});

it("retains cleanup responsibility even when supervisor creation fails", async () => {
  const operation = createOperation(), verifier = createNativeSelectionVerifier();
  const retry = vi.fn().mockResolvedValue(undefined);
  const cleanup = new BotCliProbeCleanupError({ ...ownership, targetStarted: false }, retry);
  mocks.create.mockRejectedValueOnce(cleanup).mockResolvedValue({ run: vi.fn().mockResolvedValue({ stdout: '{"ok":true,"observation":{"model":"model","models":[{"id":"model","efforts":null}]}}' }), close: vi.fn().mockResolvedValue(undefined) });
  try {
    await expect(verifier.verify(input, operation)).rejects.toMatchObject({ code: "cleanup_unknown", cause: cleanup });
    await verifier.verify(input, operation);
    expect(retry).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledTimes(2);
    await verifier.close();
  } finally { operation.dispose(); }
});

it("preserves both selection and cleanup errors", async () => {
  const operation = createOperation(), verifier = createNativeSelectionVerifier();
  const retry = vi.fn().mockResolvedValue(undefined);
  const cleanup = new BotCliProbeCleanupError(ownership, retry);
  mocks.create.mockResolvedValue({ run: vi.fn().mockResolvedValue({ stdout: '{"ok":false,"error":"unsupported model"}' }), close: vi.fn().mockRejectedValue(cleanup) });
  try {
    await expect(verifier.verify(input, operation)).rejects.toMatchObject({ errors: [expect.objectContaining({ message: expect.stringContaining("unsupported model") }), cleanup] });
    await verifier.close();
    expect(retry).toHaveBeenCalledOnce();
  } finally { operation.dispose(); }
});

it("settles a borrowed verifier without closing subsequent probe admission", async () => {
  const operation = createOperation(), verifier = createNativeSelectionVerifier();
  const close = vi.fn().mockResolvedValue(undefined);
  mocks.create.mockResolvedValue({ run: vi.fn().mockResolvedValue({ stdout: '{"ok":true,"observation":{"model":"model","models":[{"id":"model","efforts":null}]}}' }), close });
  try {
    await verifier.verify(input, operation);
    await verifier.settle();
    await verifier.verify(input, operation);
    expect(close).toHaveBeenCalledTimes(2);
    await verifier.close();
  } finally { operation.dispose(); }
});
