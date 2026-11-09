import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { readLaunchTicket } from "../../controller/launch-ticket.js";
import type { WebExecutionStore } from "./web-store.js";
import type { createWebControllerLauncher } from "./web-process.js";

/** Renew before two default task polling intervals can exhaust the credential. */
export const controllerCredentialNeedsRefresh = async (credentialFile: string, now: number): Promise<boolean> => {
  let expiresAt: unknown;
  try { expiresAt = (JSON.parse(await readFile(credentialFile, "utf8")) as { expiresAt: unknown }).expiresAt; }
  catch { throw new Error("Controller credential state is unavailable; it cannot be silently replaced."); }
  if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) throw new Error("Controller credential expiry is invalid.");
  return Date.parse(expiresAt) - now <= 120_000;
};

/** Keep execution credentials current independently of discovery polling. */
export const maintainControllerGrants = async <Execution>(options: {
  list(): readonly Execution[];
  key(execution: Execution): string;
  refresh(execution: Execution, signal: AbortSignal): Promise<void>;
  signal: AbortSignal;
  onError(message: string, executionId: string): void;
}): Promise<void> => {
  const failures = new Map<string, string>();
  const inFlight = new Map<string, Promise<void>>();
  const unhandled: unknown[] = [];
  try {
    while (!options.signal.aborted) {
      if (unhandled.length > 0) break;
      for (const execution of options.list()) {
        if (options.signal.aborted) break;
        const key = options.key(execution);
        if (inFlight.has(key)) continue;
        // A slow execution owns only its own slot; other credentials retain
        // their maintenance cadence, including while its process lock is busy.
        const renewal = (async () => {
          try {
            await options.refresh(execution, options.signal);
            failures.delete(key);
          } catch (error) {
            if (options.signal.aborted) return;
            const message = error instanceof Error ? error.message : "Controller credential renewal failed.";
            if (failures.get(key) !== message) options.onError(message, key);
            failures.set(key, message);
          }
        })().catch(error => { unhandled.push(error); }).finally(() => { inFlight.delete(key); });
        inFlight.set(key, renewal);
      }
      try { await delay(30_000, undefined, { signal: options.signal }); }
      catch (error) { if (!options.signal.aborted) throw error; }
    }
  } finally { await Promise.all(inFlight.values()); }
  if (unhandled.length > 0) throw new AggregateError(unhandled, "Controller credential renewal could not finish safely.");

};

/** Keep native channels authorized independently of claim-discovery polling. */
export const maintainWorkerControllerGrants = async (options: {
  homeDirectory: string; serverOrigin: string; store: Pick<WebExecutionStore, "listUnfinishedTasks">;
  launcher: Pick<ReturnType<typeof createWebControllerLauncher>, "refreshGrant"> & Partial<Pick<ReturnType<typeof createWebControllerLauncher>, "reportTicketFailure" | "reportTicketVerified">>;
  signal: AbortSignal; onError(message: string): void;
  readTicket?: typeof readLaunchTicket;
}): Promise<void> => {
  const readTicket = options.readTicket ?? readLaunchTicket;
  await maintainControllerGrants({
    list: () => options.store.listUnfinishedTasks().filter(task => task.serverOrigin === options.serverOrigin && task.webExecution?.ticketPath && task.webExecution.launchSubmission !== "not-submitted"),
    key: task => task.webExecution!.executionId,
    refresh: async (task, signal) => {
      const execution = task.webExecution!;
      let ticket: Awaited<ReturnType<typeof readLaunchTicket>>;
      try {
        ticket = await readTicket(options.homeDirectory, execution.launchId);
        if (ticket.executionId !== execution.executionId || ticket.executionGeneration !== execution.executionGeneration || ticket.controllerInstanceId !== execution.controllerInstanceId || ticket.claimId !== task.claimId) throw new Error("Controller credential renewal has conflicting execution evidence.");
      } catch (error) {
        if (!signal.aborted) try { options.launcher.reportTicketFailure?.(task, error); } catch { /* Monitoring cannot change the renewal failure. */ }
        throw error;
      }
      if (!signal.aborted) try { options.launcher.reportTicketVerified?.(task); } catch { /* Monitoring cannot change renewal. */ }
      await options.launcher.refreshGrant(task, ticket, signal);
    },
    signal: options.signal,
    onError: message => options.onError(message),
  });
};
