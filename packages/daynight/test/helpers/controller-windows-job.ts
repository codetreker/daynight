import { controllerPayloadHash, type ControllerLaunchTicket } from "../../src/commands/controller/launch-ticket.js";
import { commitWindowsJobStop, readControllerSnapshot, type ControllerLifecycleStore } from "../../src/commands/controller/lifecycle-store.js";
import type { WindowsJobAssignedSource, WindowsJobPreparedSource } from "../../src/commands/controller/windows-job-evidence.js";

/** Controlled process evidence for journal/relay tests; this does not prove OS process stopping. */
export const prepareFixtureWindowsJob = (store: ControllerLifecycleStore, ticket: ControllerLaunchTicket, enabled = process.platform === "win32"): WindowsJobAssignedSource | null => {
  if (!enabled) return null;
  const controller = { pid: 1234, parentPid: 12, processGroupId: null, startedAt: "2026-11-11T00:00:00.1234560Z", commandHash: "a".repeat(64) };
  const guardian = { ...controller, pid: 1235, parentPid: controller.pid, commandHash: "b".repeat(64) };
  const prepared: WindowsJobPreparedSource = { version: 1, phase: "prepared", launchId: ticket.launchId, executionId: ticket.executionId, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, ticketHash: controllerPayloadHash(ticket), guardian, jobHandle: "123", controller };
  const assigned: WindowsJobAssignedSource = { ...prepared, phase: "assigned" };
  store.prepareWindowsJobSource(prepared); store.assignWindowsJobSource(prepared, assigned);
  store.patchSnapshot({ controllerProcess: { ...controller, jobObjectName: `Local\\Daynight-${ticket.launchId}` } });
  return assigned;
};

export const stopFixtureGeneration = (store: ControllerLifecycleStore, file: string, ticket: ControllerLaunchTicket, nativeSessionId: string, source: WindowsJobAssignedSource | null): void => {
  if (source === null) { store.patchSnapshot({ nativeSessionId, lifecycle: "stopped", nativeStopped: true }); store.close(); return; }
  store.patchSnapshot({ nativeSessionId }); store.close();
  const observed = readControllerSnapshot(file);
  if (observed === null) throw new Error("Original fixture generation is missing.");
  commitWindowsJobStop(file, ticket, observed, source);
};
