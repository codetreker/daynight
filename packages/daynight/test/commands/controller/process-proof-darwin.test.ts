import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFile: f.exec }));
import { inspectBootstrapProcessProof, inspectProcessProof, confirmControllerProcessesStopped } from "../../../src/commands/controller/process-proof.js";
import { stopControllerBootstrap } from "../../../src/commands/controller/launch-observation.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const proof = { pid: 4101, parentPid: 4000, processGroupId: 4101, startedAt: "Thu Nov 12 15:53:09 2026", commandHash: createHash("sha256").update("node main.js").digest("hex") };
const exiting = "4101 4000 4101 ?Es Thu Nov 12 15:53:09 2026 (node)\n";
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); Object.defineProperty(process, "platform", platform); });

it("waits through Darwin's exiting state without signaling incomplete identity or claiming a full tree stopped", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  vi.useFakeTimers();
  let probes = 0;
  const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal !== 0) throw new Error("An exiting process cannot be signaled.");
    if (++probes >= 5) throw Object.assign(new Error("Gone"), { code: "ESRCH" });
    return true;
  });
  f.exec.mockImplementation((_file, _args, _options, callback) => callback(null, exiting));
  expect(await inspectBootstrapProcessProof(proof)).toBe("exiting");
  await expect(inspectProcessProof(proof)).rejects.toThrow(/exiting/);
  expect(await confirmControllerProcessesStopped(proof, [])).toBe(false);
  const stopped = stopControllerBootstrap(proof, Date.now() + 5000);
  await vi.runAllTimersAsync(); await stopped;
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});
