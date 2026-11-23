import path from "node:path";
import { expect, test, vi } from "vitest";
import { createWebStoreFixtures } from "./web-store.fixtures.js";
import { createWebArchiveMaintenance } from "../../../src/commands/worker/web-archive-backfill.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { LocalTask } from "../../../src/commands/worker/backends/web-types.js";

const { fixture, id } = createWebStoreFixtures("file");

test.each([false, true])("maintains usage independently of disabled archival and discard selection (%s)", async discarded => {
  const { root, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "copilot", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  store.initializeWebExecution(claim, 2);
  const original = store.updateWebExecution(claim, { sessionId: id(7), launchSubmission: "acknowledged" }, 3);
  store.beginCleanup(claim, { kind: "terminal", deadline: 100 }, 4); store.completeTask(claim, 5);
  if (discarded) store.discardRecording(original, 6);
  const worker = openWorkerStore(path.join(root, "worker.sqlite")), controller = new AbortController();
  const archive = vi.fn(async () => {}), probeArchive = vi.fn(async () => ({ kind: "attempt" as const }));
  let observed!: () => void;
  const invoked = new Promise<void>(resolve => { observed = resolve; });
  const usage = vi.fn(async (_task: LocalTask, _journalPath: string, _signal: AbortSignal) => { observed(); return { pending: 0 }; });
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, userId: id(6), signal: controller.signal, store: worker, webStore: store, archive, probeArchive, usage, archiveSessions: () => false, emit: () => {} });
  try {
    maintenance.request(() => false);
    await invoked;
    await maintenance.close();
    expect(usage).toHaveBeenCalledOnce(); expect(archive).not.toHaveBeenCalled(); expect(probeArchive).not.toHaveBeenCalled();
    expect(usage.mock.calls[0]?.[0]).toMatchObject({ claimId: claim.claimId, webExecution: { executionId: original.webExecution!.executionId } });
  } finally { await maintenance.close(); worker.close(); }
});
