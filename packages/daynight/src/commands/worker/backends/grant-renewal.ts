import { setTimeout as delay } from "node:timers/promises";
import { readLaunchTicket } from "../../controller/launch-ticket.js";
import type { WebExecutionStore } from "./web-store.js";
import type { createWebControllerLauncher } from "./web-process.js";

/** Keep native channels authorized independently of claim-discovery polling. */
export const maintainWorkerControllerGrants = async (options: {
  homeDirectory: string; serverOrigin: string; store: Pick<WebExecutionStore, "listUnfinishedTasks">;
  launcher: Pick<ReturnType<typeof createWebControllerLauncher>, "refreshGrant">;
  signal: AbortSignal; onError(message: string): void;
  readTicket?: typeof readLaunchTicket;
}): Promise<void> => {
  const readTicket = options.readTicket ?? readLaunchTicket;
  const failures = new Map<string, string>();
  while (!options.signal.aborted) {
    const renewals = await Promise.allSettled(options.store.listUnfinishedTasks().map(async task => {
      if (options.signal.aborted) return;
      const execution = task.webExecution;
      if (task.serverOrigin !== options.serverOrigin || !execution?.ticketPath || execution.launchSubmission === "not-submitted" || task.cleanup?.agentStopped) return;
      try {
        const ticket = await readTicket(options.homeDirectory, execution.launchId);
        if (ticket.executionId !== execution.executionId || ticket.executionGeneration !== execution.executionGeneration || ticket.controllerInstanceId !== execution.controllerInstanceId || ticket.claimId !== task.claimId) throw new Error("Controller credential renewal has conflicting execution evidence.");
        await options.launcher.refreshGrant(task, ticket, options.signal);
        failures.delete(execution.executionId);
      } catch (error) {
        if (options.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Controller credential renewal failed.";
        if (failures.get(execution.executionId) !== message) options.onError(message);
        failures.set(execution.executionId, message);
      }
    }));
    const rejected = renewals.filter(result => result.status === "rejected");
    if (rejected.length > 0) throw new AggregateError(rejected.map(result => result.reason), "Controller credential renewal could not finish safely.");
    try { await delay(30_000, undefined, { signal: options.signal }); }
    catch (error) { if (!options.signal.aborted) throw error; }
  }
};
