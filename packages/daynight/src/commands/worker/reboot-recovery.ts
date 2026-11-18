import Database from "better-sqlite3";
import path from "node:path";
import type { CliContext } from "../../cli/context.js";
import { readWorkerClaim } from "../../api/task-properties.js";
import { parseConfigurationDocument } from "../../config/document.js";
import { readConfigurationSource } from "../../config/files.js";
import { inspectSqlite } from "../../platform/sqlite-format.js";
import { controllerExecutionDirectory, controllerPayloadHash, readLaunchTicket } from "../controller/launch-ticket.js";
import { readCurrentControllerSnapshot } from "../controller/lifecycle-store.js";
import { recoverControllerAfterWindowsReboot } from "../controller/reboot-recovery.js";
import { runServerCommand } from "../server/runtime.js";
import { parseWebTaskV1, webClaimKey } from "./backends/web-record.js";
import { webExecutionStoreFormat } from "./backends/web-store-format.js";
import { resolveWorkerPaths } from "./paths.js";
import { sameWorktreeLocation } from "./worktrees/paths.js";

export type WorkerRebootRecoveryTarget = { projectId: string; taskId: string; claimId: string; sessionId: string; worktreeId: string; prepare: boolean };

export const runWorkerRebootRecovery = async (target: WorkerRebootRecoveryTarget, context: CliContext): Promise<void> => {
  if (process.platform !== "win32") throw new Error("Reboot recovery is supported only on Windows.");
  await runServerCommand(context, async ({ api, operation, serverUrl }) => {
    const paths = resolveWorkerPaths(context.homeDirectory());
    const readLocal = () => {
      const db = new Database(path.join(paths.workerDirectory, "web-executions.sqlite"), { readonly: true, fileMustExist: true, timeout: 1000 });
      try {
        return db.transaction(() => {
          if (inspectSqlite(db, webExecutionStoreFormat).kind !== "current") throw new Error("Reboot recovery requires the current original Web execution database.");
          const row = db.prepare("SELECT data FROM executions WHERE identity=?").get(webClaimKey(target)) as { data: string } | undefined;
          if (!row) throw new Error("The original Web execution is missing; no recovery was started.");
          return parseWebTaskV1(JSON.parse(row.data));
        }).deferred();
      } finally { db.close(); }
    };
    const local = readLocal(), execution = local.webExecution;
    if (local.status !== "active" || (local.cleanup !== null && local.cleanup.kind !== "shutdown") || local.serverOrigin !== serverUrl || local.worktreeId !== target.worktreeId
      || execution?.sessionId !== target.sessionId || !local.resources.worktree || !local.resources.nativeSession) throw new Error("Reboot recovery requires the original active Web claim, worktree and native Session.");
    const ticket = await readLaunchTicket(context.homeDirectory(), execution.launchId);
    if (ticket.serverOrigin !== serverUrl || ticket.projectId !== target.projectId || ticket.taskId !== target.taskId || ticket.claimId !== target.claimId
      || ticket.workerId !== local.workerId || ticket.userId !== local.userId || ticket.worktreeId !== target.worktreeId || ticket.sessionId !== target.sessionId
      || ticket.executionId !== execution.executionId || ticket.executionGeneration !== execution.executionGeneration || ticket.controllerInstanceId !== execution.controllerInstanceId
      || ticket.controllerId !== execution.controllerId || ticket.initialOperationId !== execution.initialOperationId || ticket.nativeHome !== execution.nativeHome
      || controllerPayloadHash(ticket.configuration) !== controllerPayloadHash(local.configuration)
      || !await sameWorktreeLocation(ticket.cwd, local.resources.worktree.worktreePath)) throw new Error("The original launch ticket differs from the selected execution.");
    const file = path.join(controllerExecutionDirectory(context.homeDirectory(), execution.executionId), "journal.sqlite");
    const executionIdentity = (value: ReturnType<typeof readLocal>) => controllerPayloadHash({
      status: value.status, cleanup: value.cleanup, worktreeId: value.worktreeId, workerId: value.workerId, userId: value.userId, serverOrigin: value.serverOrigin,
      resources: value.resources, executionId: value.webExecution?.executionId, launchId: value.webExecution?.launchId,
      sessionId: value.webExecution?.sessionId, generation: value.webExecution?.executionGeneration, instanceId: value.webExecution?.controllerInstanceId,
    });
    const original = executionIdentity(local);
    const verify = async () => {
      operation.check();
      const user = await api.getCurrentUser(), task = await api.getTask(target.projectId, target.taskId), claim = readWorkerClaim(task.properties);
      if (task.status !== "in_progress" || claim?.state !== "active" || claim.claimId !== target.claimId || claim.workerId !== local.workerId
        || claim.worktreeId !== target.worktreeId || claim.userId !== user.id || ticket.userId !== user.id || claim.agentControlMode !== "web"
        || claim.platform !== "windows" || claim.agent !== ticket.provider || claim.nativeSessionId !== local.resources.nativeSession!.sessionId) throw new Error("The active original claim, owner, platform or native Session changed.");
      const configuration = parseConfigurationDocument(await readConfigurationSource(paths, operation.signal), paths);
      if (configuration.mapping.workerId !== local.workerId || executionIdentity(readLocal()) !== original
        || controllerPayloadHash(await readLaunchTicket(context.homeDirectory(), execution.launchId)) !== controllerPayloadHash(ticket)) throw new Error("The original Worker execution changed during reboot recovery.");
      const snapshot = readCurrentControllerSnapshot(file, ticket);
      if (snapshot.nativeSessionId !== local.resources.nativeSession!.sessionId) throw new Error("The original native Session differs from its Controller journal.");
    };
    await verify();
    const result = await recoverControllerAfterWindowsReboot({ file, ticket, prepare: target.prepare, deadline: Date.now() + 30_000, beforeWrite: verify });
    return {
      kind: "known-session-operation" as const,
      output: `${JSON.stringify({ ...target, result, executionGeneration: ticket.executionGeneration,
        nextAction: result === "prepared" ? "Restart Windows, then run this exact command without --prepare. No Controller has been started." : "Original process-tree stop is confirmed. Use the original Worker's normal recovery or explicit retry; no input was replayed." })}\n`,
      exitCode: 0,
      failureText: () => "Reboot recovery output failed; inspect the same original checkpoint and journal before deciding on another operation.",
    };
  }, { operationLimits: { totalMs: 60_000 } });
};
