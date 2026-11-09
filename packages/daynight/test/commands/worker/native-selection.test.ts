import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createBotCliProbe, BotCliProbeCleanupError } from "../../../src/commands/worker/bots/cli-probe.js";
import { verifyWorkerNativeSelection, discoverWorkerNativeCapabilities, createNativeSelectionVerifier } from "../../../src/commands/worker/native-selection.js";

vi.mock("../../../src/commands/worker/bots/cli-probe.js", async importOriginal => ({ ...await importOriginal<typeof import("../../../src/commands/worker/bots/cli-probe.js")>(), createBotCliProbe: vi.fn() }));
const observation = { model: "native-model", effort: "high", models: [{ id: "native-model", efforts: ["high"] }] };
const run = vi.fn(), close = vi.fn();
const operation = createOperation();
afterAll(() => operation.dispose());
beforeEach(() => {
  run.mockReset().mockResolvedValue({ stdout: JSON.stringify({ ok: true, observation }), stderr: "" });
  close.mockReset().mockResolvedValue(undefined);
  vi.mocked(createBotCliProbe).mockResolvedValue({ run, close, ownership: { launchId: "probe", pid: null, process: null, jobObjectName: null, targetStarted: false } });
});
afterEach(() => vi.clearAllMocks());
const verify = () => verifyWorkerNativeSelection({ native: { agent: "codex", model: "native-model", args: ["--effort", "high"] }, cwd: "/task", environment: { PATH: "/native/bin", CODEX_THREAD_ID: "parent-thread", CLAUDECODE: "1", DAYNIGHT_CONTROLLER_TOKEN: "parent-token" } }, operation);

describe("owned native selection probe", () => {
  it("requests discovery independently of strict selection verification", async () => {
    const native = { agent: "copilot" as const, model: null, args: [] };
    run.mockResolvedValue({ stdout: JSON.stringify({ ok: true, observation: { model: null, models: [{ id: "available", efforts: null, label: "Available", hidden: false, defaultEffort: null }] } }), stderr: "" });
    expect(await discoverWorkerNativeCapabilities({ native, cwd: "/task", environment: {} }, operation)).toMatchObject({ model: null, models: [{ id: "available" }] });
    expect(run.mock.calls[0]![1].at(-1)).toBe("discover");
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves typed native capability failures", async () => {
    run.mockResolvedValue({ stdout: JSON.stringify({ ok: false, error: "Native catalog is oversized.", code: "limit_exceeded" }), stderr: "" });
    await expect(discoverWorkerNativeCapabilities({ native: { agent: "codex", model: null, args: [] }, cwd: "/task", environment: {} }, operation)).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("classifies native command failure while retaining its original cause", async () => {
    const failure = new Error("native executable failed");
    run.mockRejectedValue(failure);
    await expect(discoverWorkerNativeCapabilities({ native: { agent: "codex", model: null, args: [] }, cwd: "/task", environment: {} }, operation)).rejects.toMatchObject({ code: "capability_error", cause: failure });
    expect(close).toHaveBeenCalledOnce();
  });

  it("retains cleanup ownership from discovery and retries it before verification", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    const cleanup = new BotCliProbeCleanupError({ launchId: "retained", pid: 12, process: null, jobObjectName: null, targetStarted: true }, retry);
    close.mockRejectedValueOnce(cleanup);
    const verifier = createNativeSelectionVerifier();
    const options = { native: { agent: "codex" as const, model: "native-model", args: [] }, cwd: "/task", environment: {} };
    await expect(verifier.discover(options, operation)).rejects.toMatchObject({ code: "cleanup_unknown", cause: cleanup });
    await verifier.verify(options, operation);
    expect(retry).toHaveBeenCalledOnce();
    expect(retry.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[1]!);
    await verifier.close();
  });
  it("uses task cwd and native executable environment without inheriting the parent session identity", async () => {
    expect(await verify()).toEqual(observation);
    expect(createBotCliProbe).toHaveBeenCalledWith({ cwd: "/task", environment: { PATH: "/native/bin" } }, operation);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["not-json", JSON.stringify({ ok: false, error: "effective model is unknown" }), JSON.stringify({ ok: true, observation: [] }), JSON.stringify({ ok: true, observation: { ...observation, models: [{ id: "native-model", efforts: 3 }] } })])("rejects invalid or failed native evidence and closes its scope", async stdout => {
    run.mockResolvedValue({ stdout, stderr: "" });
    await expect(verify()).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });

  it("cleans up after deadline failure and retains unconfirmed cleanup errors", async () => {
    run.mockRejectedValue(new Error("deadline elapsed"));
    await expect(verify()).rejects.toThrow("deadline elapsed");
    expect(close).toHaveBeenCalledOnce();
    const cleanup = new Error("process cleanup is unconfirmed");
    close.mockRejectedValue(cleanup);
    await expect(verify()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: "deadline elapsed" }), cleanup] });
  });
});
