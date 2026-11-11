import { expect, it, vi } from "vitest";
import { createWebArchiveMaintenance } from "../../../src/commands/worker/backends/web-archive-backfill.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

it("runs only one historical archive and joins its finalizer before close", async () => {
  const root = new AbortController(), started = deferred(), finalizer = deferred();
  const execution = { executionId: "00000000-0000-4000-8000-000000000001", executionGeneration: "1", launchId: "launch", sessionId: "session", launchSubmission: "submitted" };
  const task = { serverOrigin: "https://example.test", projectId: "project", taskId: "task", claimId: "claim", webExecution: execution };
  const listCompletedTasks = vi.fn(() => [task]);
  const archive = vi.fn(async (_task: unknown, _path: string, signal: AbortSignal) => {
    started.resolve();
    await finalizer.promise;
    expect(signal.aborted).toBe(true);
  });
  const emit = vi.fn();
  const options = { homeDirectory: "/tmp", serverUrl: task.serverOrigin, webStore: { listCompletedTasks },
    store: { getArchiveBackfillSchedule: () => null, deleteArchiveBackfillSchedule: vi.fn() },
    archive, probeArchive: async () => ({ kind: "attempt" as const }), emit, rootSignal: root.signal };
  const maintenance = createWebArchiveMaintenance(options as unknown as Parameters<typeof createWebArchiveMaintenance>[0]);
  maintenance.request(); maintenance.request();
  await started.promise;
  maintenance.request();
  expect(listCompletedTasks).toHaveBeenCalledTimes(1);
  expect(archive).toHaveBeenCalledTimes(1);
  root.abort();
  let closed = false;
  const closing = maintenance.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(emit).not.toHaveBeenCalled();
  finalizer.resolve();
  await closing;
  await maintenance.close();
  maintenance.request();
  expect(archive).toHaveBeenCalledTimes(1);
  expect(emit).not.toHaveBeenCalled();
});

it("reports scan errors and allows a later request without waking itself", async () => {
  const failed = deferred();
  const listCompletedTasks = vi.fn().mockImplementationOnce(() => { throw new Error("scan failed"); }).mockReturnValue([]);
  const emit = vi.fn(() => failed.resolve());
  const options = { homeDirectory: "/tmp", serverUrl: "https://example.test", webStore: { listCompletedTasks }, store: {}, archive: vi.fn(), probeArchive: vi.fn(), emit, rootSignal: new AbortController().signal };
  const maintenance = createWebArchiveMaintenance(options as unknown as Parameters<typeof createWebArchiveMaintenance>[0]);
  maintenance.request();
  await failed.promise;
  await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
  expect(listCompletedTasks).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  await Promise.resolve();
  maintenance.request();
  await vi.waitFor(() => expect(listCompletedTasks).toHaveBeenCalledTimes(2));
  await maintenance.close();
});
