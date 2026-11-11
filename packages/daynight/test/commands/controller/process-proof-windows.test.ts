import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const f = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock("../../../src/commands/controller/windows-process-proof.js", () => ({ captureWindowsProcessProof: f.native }));
import { confirmControllerProcessesStopped, inspectProcessProof, stopControllerProcesses, type ProcessProof } from "../../../src/commands/controller/process-proof.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const controller: ProcessProof = { pid: 4101, parentPid: 4000, processGroupId: null, startedAt: "fixture-birth", commandHash: createHash("sha256").update("fixture-controller").digest("hex"), jobObjectName: "Local\\Daynight-11111111-1111-4111-8111-111111111111" };
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.clearAllMocks(); f.native.mockImplementation(async pid => ({ ...controller, pid }));
});
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });

test("retains unknown ownership when the live original birth has conflicting command evidence", async () => {
  vi.spyOn(process, "kill").mockReturnValue(true);
  const command = "fixture-controller 📖";
  const retained = { ...controller, commandHash: createHash("sha256").update(command.replace("📖", "??")).digest("hex") };
  f.native.mockResolvedValue({ ...controller, commandHash: createHash("sha256").update(command).digest("hex") });
  await expect(inspectProcessProof(retained)).rejects.toThrow("ownership remains unknown");
});

test("requires the original held Job for Windows stop without guessing from a name", async () => {
  const liveness = vi.spyOn(process, "kill");
  await expect(confirmControllerProcessesStopped(controller, [])).rejects.toThrow("requires the original held Job");
  await expect(stopControllerProcesses(controller, [], Date.now() + 100)).rejects.toThrow("requires the original held Job");
  expect(liveness).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled();
});

test("does not turn a process permission failure into successful identity evidence", async () => {
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Denied"), { code: "EPERM" }); });
  await expect(inspectProcessProof(controller)).rejects.toThrow("Process liveness could not be established");
  expect(f.native).not.toHaveBeenCalled();
});
