import type Database from "better-sqlite3";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../launch-ticket.js";
import type { ControllerSnapshot } from "../lifecycle-store.js";
import { withStoppedControllerStorage } from "../stopped-storage.js";
import { runSqliteImmediate } from "../../../platform/sqlite-access.js";
import { countRetainedUsage, openUsageStore } from "./store.js";
import type { UsageStore } from "./types.js";
import { createUsageUploader } from "./uploader.js";

/** Reopens the original stopped journal for each local operation, never across IO. */
const stoppedUsageAccess = (journalPath: string, ticket: ControllerLaunchTicket) => {
  let original: string | undefined;
  const assertOriginal = (db: Database.Database): void => {
    const row = db.prepare("SELECT snapshot,ticket_hash,owner_pid FROM execution WHERE id=1").get() as { snapshot: string; ticket_hash: string; owner_pid: number | null } | undefined;
    const snapshot = row ? JSON.parse(row.snapshot) as ControllerSnapshot : null;
    if (!row || !snapshot || row.owner_pid !== null || !snapshot.nativeStopped || snapshot.lifecycle !== "stopped" || snapshot.executionId !== ticket.executionId || snapshot.sessionId !== ticket.sessionId || snapshot.claimId !== ticket.claimId || snapshot.testExecutionId !== ticket.testExecutionId || snapshot.executionGeneration !== ticket.executionGeneration || snapshot.controllerInstanceId !== ticket.controllerInstanceId || row.ticket_hash !== controllerPayloadHash(ticket) || original !== undefined && row.snapshot !== original) throw new Error("Usage replay requires the unchanged original stopped Controller generation.");
    original = row.snapshot;
  };
  const local = <T>(action: (db: Database.Database) => T): T => withStoppedControllerStorage({ journalPath, ticket, assertOriginal }, action);
  const store = new Proxy({} as UsageStore, {
    get: (_target, key) => (...args: unknown[]) => local(db => {
      const current = openUsageStore(db, { read: action => db.transaction(action).deferred(), write: action => runSqliteImmediate(db, action) });
      const method = current[key as keyof UsageStore] as (...input: unknown[]) => unknown;
      if (typeof method !== "function") throw new Error("Unknown stopped usage store operation.");
      return method(...args);
    }),
  });
  const pending = (): number => local(db => db.transaction(() => countRetainedUsage(db)).deferred());
  return { store, pending, endedAt: () => (JSON.parse(original!) as ControllerSnapshot).stoppedAt };
};

/** Includes quarantine and local conflicts: ACKs do not resolve contradictory ingress. */
export const countStoppedControllerUsage = (options: { journalPath: string; ticket: ControllerLaunchTicket }): number => stoppedUsageAccess(options.journalPath, options.ticket).pending();

/** A bounded late-report attempt using only retained original usage grants. */
export const replayStoppedControllerUsage = async (options: {
  journalPath: string; ticket: ControllerLaunchTicket; serverToken: string;
  signal?: AbortSignal; request?: typeof fetch; onDiagnostic?(message: string): void;
}): Promise<{ pending: number }> => {
  const { ticket } = options;
  const access = stoppedUsageAccess(options.journalPath, ticket);
  const pending = access.pending();
  if (!pending && access.store.states().every(state => state.stopped)) return { pending: 0 };
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
  const uploader = createUsageUploader({
    serverOrigin: ticket.serverOrigin, store: access.store,
    identity: { sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId },
    connection: () => null,
    readParentToken: async () => options.serverToken,
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    fetch: (input, init) => (options.request ?? fetch)(input, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }),
  });
  try {
    await uploader.tick();
    for (const state of access.store.states()) {
      if (state.stopped) continue;
      access.store.gap(state.stateId, "missing_final");
      access.store.gap(state.stateId, "native_recovery_gap");
      const capability = uploader.capability(state);
      if (capability) access.store.enqueueState(state.stateId, {
        collectionState: capability.qualification === "verified" ? "partial" : "unavailable", capability,
        reasonCodes: capability.qualification === "verified" ? ["missing_final", "native_recovery_gap"] : ["missing_final", "native_recovery_gap", "profile_unverified"],
        nativeStartedAt: null, nativeEndedAt: access.endedAt(), observedAt: new Date().toISOString(), seal: true,
      });
    }
  }
  finally { await uploader.close(); }
  return { pending: Math.max(access.pending(), access.store.states().filter(state => !state.stopped).length) };
};
