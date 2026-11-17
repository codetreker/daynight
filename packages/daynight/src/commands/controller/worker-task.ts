import { createApiClient } from "../../api/client.js";
import { createOperation } from "../../api/operation.js";
import { readTaskPaused, readWorkerClaim } from "../../api/task-properties.js";
import { resolveConfigurationPaths } from "../../config/paths.js";
import { loadServerConfiguration } from "../../config/server.js";
import type { ControllerLaunchTicket } from "./launch-ticket.js";

/** Read the authoritative task only after the input reaches the native queue. */
export async function checkWorkerTask(ticket: ControllerLaunchTicket, home: string, deadline: number): Promise<"task_paused" | "claim_invalid" | null> {
  if (ticket.claimId === undefined) throw new Error("Worker input requires a claim ticket.");
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const operation = createOperation({ limits: { totalMs: remaining, requestMs: Math.min(remaining, 30_000) } });
  try {
    const config = await loadServerConfiguration(resolveConfigurationPaths(home), operation.signal);
    if (config.serverUrl !== ticket.serverOrigin || !config.serverToken) throw new Error("Worker input configuration does not match the ticket service or lacks a token.");
    const task = await createApiClient({ serverUrl: ticket.serverOrigin, serverToken: config.serverToken, expectedUserId: ticket.userId, operation }).getTask(ticket.projectId, ticket.taskId);
    const claim = readWorkerClaim(task.properties);
    if (task.status !== "in_progress" || !task.allowAgents || claim?.state !== "active" || claim.claimId !== ticket.claimId || claim.workerId !== ticket.workerId || claim.worktreeId !== ticket.worktreeId || claim.userId !== ticket.userId || claim.agent !== ticket.provider || claim.agentControlMode !== "web") return "claim_invalid";
    return readTaskPaused(task.properties) === true ? "task_paused" : null;
  } finally { operation.dispose(); }
}
