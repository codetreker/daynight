import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createBotCliProbe } from "../../../src/commands/worker/bots/cli-probe.js";
import { verifyWorkerNativeSelection } from "../../../src/commands/worker/native-selection.js";

vi.mock("../../../src/commands/worker/bots/cli-probe.js", () => ({ createBotCliProbe: vi.fn() }));
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
