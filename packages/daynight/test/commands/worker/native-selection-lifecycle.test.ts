import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { BotCliProbeCleanupError } from "../../../src/commands/worker/bots/cli-probe.js";
import { createNativeSelectionVerifier } from "../../../src/commands/worker/native-selection.js";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../../src/commands/worker/bots/cli-probe.js", async original => ({ ...await original<object>(), createBotCliProbe: mocks.create }));
afterEach(() => vi.resetAllMocks());
const input = { native: { agent: "codex" as const, model: "model", args: [] }, cwd: process.cwd(), environment: {} };
const ownership = { launchId: "own-probe", pid: 123, process: null, jobObjectName: null, targetStarted: true };

it("blocks new probes while prior descendant cleanup is unconfirmed and retries at shutdown", async () => {
  const operation = createOperation(), verifier = createNativeSelectionVerifier();
  const retry = vi.fn().mockRejectedValue(new Error("descendants still live"));
  const cleanup = new BotCliProbeCleanupError(ownership, retry);
  mocks.create.mockResolvedValue({ run: vi.fn().mockResolvedValue({ stdout: '{"ok":true,"observation":{"model":"model","models":[]}}' }), close: vi.fn().mockRejectedValue(cleanup) });
  try {
    await expect(verifier.verify(input, operation)).rejects.toBe(cleanup);
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
  mocks.create.mockRejectedValueOnce(cleanup).mockResolvedValue({ run: vi.fn().mockResolvedValue({ stdout: '{"ok":true,"observation":{"model":"model","models":[]}}' }), close: vi.fn().mockResolvedValue(undefined) });
  try {
    await expect(verifier.verify(input, operation)).rejects.toBe(cleanup);
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
  mocks.create.mockResolvedValue({ run: vi.fn().mockResolvedValue({ stdout: '{"ok":true,"observation":{"model":"model","models":[]}}' }), close });
  try {
    await verifier.verify(input, operation);
    await verifier.settle();
    await verifier.verify(input, operation);
    expect(close).toHaveBeenCalledTimes(2);
    await verifier.close();
  } finally { operation.dispose(); }
});
