import path from "node:path";
import { randomUUID } from "node:crypto";
import { ArchiveRepairRequiredError, type ArchiveRepairCode } from "../../controller/archive-error.js";
import { controllerExecutionDirectory } from "../../controller/launch-ticket.js";
import { ARCHIVE_REPAIR_PROBE_INTERVAL_MS } from "../cleanup-schedule.js";
import type { ArchiveBackfillIdentity } from "../types.js";
import type { WorkerEvent } from "../execution.js";
import type { createMonitoringObserver } from "../monitoring/observer.js";
import { encodeWorktree } from "../monitoring/worktree.js";
import type { FailureWorktree } from "../monitoring/types.js";
import type { openWorkerStore } from "../store.js";
import type { openWebExecutionStore } from "./web-store.js";
import type { WebBackendOptions } from "./web.js";

export type WebArchiveMaintenance = { request(): void; close(): Promise<void> };

export const createWebArchiveMaintenance = ({ homeDirectory, serverUrl, webStore, store, archive, probeArchive, emit, monitoring, rootSignal }: {
  homeDirectory: string;
  serverUrl: string;
  webStore: ReturnType<typeof openWebExecutionStore>;
  store: ReturnType<typeof openWorkerStore>;
  archive: NonNullable<WebBackendOptions["archive"]>;
  probeArchive: NonNullable<WebBackendOptions["probeArchive"]>;
  emit: (event: WorkerEvent) => void;
  monitoring?: ReturnType<typeof createMonitoringObserver>;
  rootSignal: AbortSignal;
}): WebArchiveMaintenance => {
  const backfilled = new Set<string>();
  const archiveRetryAt = new Map<string, number>();
  const archiveRepairs = new Map<string, ArchiveRepairCode>();
  const archiveFailures = new Map<string, string>();
  const archiveObservations = new Map<string, string>();
  const archiveActivities = new Map<string, string>();
  const observeBackfill = (identity: ArchiveBackfillIdentity, nextAttemptAt: number, repairCode?: ArchiveRepairCode, error?: unknown, worktree?: FailureWorktree): void => {
    const scope = { kind: "claim" as const, projectId: identity.projectId, taskId: identity.taskId, claimId: identity.claimId };
    const next = new Date(nextAttemptAt).toISOString();
    try {
      const operationId = archiveFailures.get(identity.executionId) ?? randomUUID();
      if (!archiveFailures.has(identity.executionId) || error !== undefined) {
        monitoring?.fail({ operationId, component: "archive", phase: "archive-backfill", scope, ...(worktree === undefined ? {} : { worktree }), error: repairCode === undefined ? error : new ArchiveRepairRequiredError(repairCode), retryState: "scheduled", nextAttemptAt: next });
        archiveFailures.set(identity.executionId, operationId);
      }
      if (repairCode !== undefined) {
        const activity = archiveActivities.get(identity.executionId);
        if (activity === undefined) {
          const id = monitoring?.startActivity({ kind: "maintenance", phase: "archive-backfill", scope, status: "waiting", waitReason: "recovery-blocked", nextAttemptAt: next });
          if (id !== undefined) archiveActivities.set(identity.executionId, id);
        } else monitoring?.updateActivity(activity, { nextAttemptAt: next });
        if (error !== undefined && !(error instanceof ArchiveRepairRequiredError)) {
          const observationId = archiveObservations.get(identity.executionId) ?? randomUUID();
          archiveObservations.set(identity.executionId, observationId);
          monitoring?.fail({ operationId: observationId, component: "archive", phase: "archive-backfill", scope, ...(worktree === undefined ? {} : { worktree }), error, retryState: "scheduled", nextAttemptAt: next });
        }
      } else {
        const activity = archiveActivities.get(identity.executionId);
        if (activity !== undefined) monitoring?.updateActivity(activity, { waitReason: "retry-backoff", nextAttemptAt: next });
      }
    } catch { /* Monitoring cannot change archival. */ }
  };
  let lastArchiveAttempt: string | null = null;
  const backfillArchives = async (signal: AbortSignal) => {
    const tasks = webStore.listCompletedTasks();
    const previous = tasks.findIndex(task => task.webExecution?.executionId === lastArchiveAttempt);
    for (let offset = 1; offset <= tasks.length; offset++) {
      if (signal.aborted) return;
      const task = tasks[(previous + offset) % tasks.length]!;
      const execution = task.webExecution;
      if (!execution || execution.launchSubmission === "not-submitted" || task.serverOrigin !== serverUrl || backfilled.has(execution.executionId) || (archiveRetryAt.get(execution.executionId) ?? 0) > Date.now()) continue;
      // Advance on failure as well as success so a damaged source cannot monopolize catch-up.
      lastArchiveAttempt = execution.executionId;
      const identity = { serverOrigin: serverUrl, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId,
        executionId: execution.executionId, executionGeneration: execution.executionGeneration, launchId: execution.launchId };
      let worktree: FailureWorktree | undefined;
      try { if (task.resources.worktree !== null) worktree = encodeWorktree(task.repositoryPath, task.resources.worktree.worktreePath); } catch { /* Monitoring cannot change archival. */ }
      try {
        const retained = store.getArchiveBackfillSchedule(identity);
        if (retained !== null) {
          archiveRepairs.set(execution.executionId, retained.archiveRepairCode);
          archiveRetryAt.set(execution.executionId, retained.nextAttemptAt);
          observeBackfill(identity, retained.nextAttemptAt, retained.archiveRepairCode, undefined, worktree);
          if (retained.nextAttemptAt > Date.now()) continue;
        }
        const journalPath = path.join(controllerExecutionDirectory(homeDirectory, execution.executionId), "journal.sqlite");
        const admission = await probeArchive(task, journalPath, signal);
        if (admission.kind === "blocked") throw new ArchiveRepairRequiredError(admission.code);
        if (admission.kind === "complete") {
          // Receipt admission alone does not establish that the source was repaired.
          store.deleteArchiveBackfillSchedule(identity);
          archiveRepairs.delete(execution.executionId);
        }
        await archive(task, journalPath, signal);
        signal.throwIfAborted();
        store.deleteArchiveBackfillSchedule(identity);
        backfilled.add(execution.executionId);
        archiveRepairs.delete(execution.executionId);
        archiveRetryAt.delete(execution.executionId);
        const failure = archiveFailures.get(execution.executionId);
        if (failure) { try { monitoring?.recover(failure); } catch { /* Monitoring cannot change archival. */ } archiveFailures.delete(execution.executionId); }
        const observation = archiveObservations.get(execution.executionId), activity = archiveActivities.get(execution.executionId);
        try { if (observation) monitoring?.recover(observation); if (activity) monitoring?.endActivity(activity); } catch { /* Monitoring cannot change archival. */ }
        archiveObservations.delete(execution.executionId); archiveActivities.delete(execution.executionId);
        emit({ kind: "session-archive-ready", message: `Completed session ${execution.sessionId} history is archived.` });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ArchiveRepairRequiredError) archiveRepairs.set(execution.executionId, error.code);
        const repairCode = archiveRepairs.get(execution.executionId);
        const nextAttemptAt = Date.now() + (repairCode === undefined ? 60_000 : ARCHIVE_REPAIR_PROBE_INTERVAL_MS);
        archiveRetryAt.set(execution.executionId, nextAttemptAt);
        let reportedError = error;
        if (repairCode !== undefined) {
          try { store.saveArchiveBackfillSchedule(identity, { archiveRepairCode: repairCode, nextAttemptAt }); }
          catch (persistenceError) { reportedError = new AggregateError([error, persistenceError], "Archive backfill schedule was not persisted; in-memory condition backoff remains active."); }
        }
        observeBackfill(identity, nextAttemptAt, repairCode, reportedError, worktree);
        emit({ kind: "session-archive-retry", message: repairCode === undefined ? `Completed session ${execution.sessionId} archive is pending; its source is retained for retry.` : `Completed session ${execution.sessionId} archive requires repair (${repairCode}); originals retained; next condition probe ${new Date(nextAttemptAt).toISOString()}.`, error: reportedError });
      }
      // Bound historical catch-up per reconciliation round.
      break;
    }
  };

  const closing = new AbortController();
  const signal = AbortSignal.any([rootSignal, closing.signal]);
  let inFlight: Promise<void> | undefined;
  let closed = false;
  let scanFailure: string | undefined;
  return {
    request(): void {
      if (closed || signal.aborted || inFlight !== undefined) return;
      // Reserve before executing the scan so synchronous repeated requests cannot overlap.
      const job = Promise.resolve().then(() => backfillArchives(signal)).then(() => {
        if (scanFailure !== undefined) {
          try { monitoring?.recover(scanFailure); } catch { /* Monitoring cannot change archival. */ }
          scanFailure = undefined;
        }
      }, error => {
        if (signal.aborted) return;
        const operationId = scanFailure ?? randomUUID();
        scanFailure = operationId;
        try { monitoring?.fail({ operationId, component: "archive", phase: "archive-backfill", scope: { kind: "worker" }, error }); } catch { /* Monitoring cannot change archival. */ }
        emit({ kind: "session-archive-retry", message: "Historical session archive maintenance failed; sources remain available for retry.", error });
      });
      inFlight = job;
      void job.finally(() => { if (inFlight === job) inFlight = undefined; }).catch(() => undefined);
    },
    async close(): Promise<void> {
      closed = true;
      closing.abort();
      await inFlight;
    },
  };
};
