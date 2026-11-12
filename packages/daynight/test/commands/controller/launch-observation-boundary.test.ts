import { afterEach, expect, it, vi } from "vitest";
import * as localClient from "../../../src/commands/controller/local-client.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as sqliteAccess from "../../../src/platform/sqlite-access.js";
import { ControllerLaunchJournalObservationError, reconcileSubmittedControllerLaunch } from "../../../src/commands/controller/launch-observation.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";

const ticket = {} as ControllerLaunchTicket;
const proof = { pid: 987, parentPid: 1, processGroupId: 987, startedAt: "original", commandHash: "a".repeat(64) };
const ipc = () => new localClient.ControllerIpcOutcomeUnknownError("IPC unavailable");
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("retains the IPC failure when its observation crosses the deadline", async () => {
  vi.useFakeTimers(); const deadline = Date.now() + 100, failure = ipc();
  vi.spyOn(localClient, "requestController").mockImplementation(async () => { vi.setSystemTime(deadline); throw failure; });
  const error = await reconcileSubmittedControllerLaunch({ journalFile: "/unused", ticket, spawnProof: proof, signal: new AbortController().signal, deadline }).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0]).toBe(failure); expect(error.errors[1].message).toMatch(/deadline/); expect(error.cause).toBe(failure);
});

it("retains IPC and process failures when process observation crosses the deadline", async () => {
  vi.useFakeTimers(); const deadline = Date.now() + 100, first = ipc(), second = new Error("process permission denied");
  vi.spyOn(localClient, "requestController").mockRejectedValue(first);
  vi.spyOn(processProof, "inspectBootstrapProcessProof").mockImplementation(async () => { vi.setSystemTime(deadline); throw second; });
  const error = await reconcileSubmittedControllerLaunch({ journalFile: "/unused", ticket, spawnProof: proof, signal: new AbortController().signal, deadline }).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0].errors).toEqual([first, second]); expect(error.errors[1].message).toMatch(/deadline/);
});

it("retains IPC and journal failures when journal observation crosses the deadline", async () => {
  vi.useFakeTimers(); const deadline = Date.now() + 100, first = ipc(), second = Object.assign(new Error("journal I/O"), { code: "EIO" });
  vi.spyOn(localClient, "requestController").mockRejectedValue(first);
  vi.spyOn(processProof, "inspectBootstrapProcessProof").mockResolvedValue("stopped");
  vi.spyOn(sqliteAccess, "sqliteDatabaseIsMissing").mockImplementation(() => { vi.setSystemTime(deadline); throw second; });
  const error = await reconcileSubmittedControllerLaunch({ journalFile: "/unused", ticket, spawnProof: proof, signal: new AbortController().signal, deadline }).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0]).toBeInstanceOf(ControllerLaunchJournalObservationError);
  expect(error.errors[0].errors).toEqual([first, second]); expect(error.errors[1].message).toMatch(/deadline/);
});

it("retains simultaneous cancellation and a separate process failure", async () => {
  const controller = new AbortController(), reason = new Error("cancelled"), first = ipc(), second = new Error("process unavailable");
  vi.spyOn(localClient, "requestController").mockRejectedValue(first);
  vi.spyOn(processProof, "inspectBootstrapProcessProof").mockImplementation(async () => { controller.abort(reason); throw second; });
  const error = await reconcileSubmittedControllerLaunch({ journalFile: "/unused", ticket, spawnProof: proof, signal: controller.signal }).catch(error => error);
  expect(error.errors[0].errors).toEqual([first, second]); expect(error.errors[1]).toBe(reason); expect(error.cause).toBe(error.errors[0]);
});

it("preserves a pure cancellation reason without wrapping it twice", async () => {
  const controller = new AbortController(), reason = new Error("cancelled");
  vi.spyOn(localClient, "requestController").mockImplementation(async () => { controller.abort(reason); throw reason; });
  await expect(reconcileSubmittedControllerLaunch({ journalFile: "/unused", ticket, spawnProof: proof, signal: controller.signal })).rejects.toBe(reason);
});


it("retains the IPC failure when a successful process inspection crosses the deadline", async () => {
  vi.useFakeTimers(); const deadline = Date.now() + 100, failure = ipc();
  vi.spyOn(localClient, "requestController").mockRejectedValue(failure);
  vi.spyOn(processProof, "inspectBootstrapProcessProof").mockImplementation(async () => { vi.setSystemTime(deadline); return "running"; });
  const error = await reconcileSubmittedControllerLaunch({ journalFile: "/unused", ticket, spawnProof: proof, signal: new AbortController().signal, deadline }).catch(error => error);
  expect(error.errors[0]).toBe(failure); expect(error.errors[1].message).toMatch(/deadline/); expect(error.cause).toBe(failure);
});

it("retains the IPC failure when a successful journal inspection crosses the deadline", async () => {
  vi.useFakeTimers(); const deadline = Date.now() + 100, failure = ipc();
  vi.spyOn(localClient, "requestController").mockRejectedValue(failure);
  vi.spyOn(processProof, "inspectBootstrapProcessProof").mockResolvedValue("stopped");
  vi.spyOn(sqliteAccess, "sqliteDatabaseIsMissing").mockImplementation(() => { vi.setSystemTime(deadline); return true; });
  const error = await reconcileSubmittedControllerLaunch({ journalFile: "/unused", ticket, spawnProof: proof, signal: new AbortController().signal, deadline }).catch(error => error);
  expect(error.errors[0]).toBe(failure); expect(error.errors[1].message).toMatch(/deadline/); expect(error.cause).toBe(failure);
});
