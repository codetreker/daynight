import Database from "better-sqlite3";
import path from "node:path";
import { existsSync } from "node:fs";
import type { CliContext } from "../../cli/context.js";
import { runServerCommand } from "../server/runtime.js";
import { readTaskBlocked, readWorkerClaim } from "../../api/task-properties.js";
import { resolveWorkerPaths } from "./paths.js";
import { parseConfigurationDocument } from "../../config/document.js";
import { readConfigurationSource } from "../../config/files.js";
import { parseWebTaskV1, webClaimKey } from "./backends/web-record.js";
import { webExecutionStoreFormat } from "./backends/web-store-format.js";
import { inspectSqlite } from "../../platform/sqlite-format.js";
import { readLaunchTicket, controllerExecutionDirectory, controllerPayloadHash } from "../controller/launch-ticket.js";
import type { ControllerSnapshot } from "../controller/lifecycle-store.js";
import { controllerJournalFormat } from "../controller/journal-format.js";
import { repairStoppedMarkdownProjections } from "../controller/stopped-markdown-repair.js";
import { resolveStoppedMarkdownImage } from "../controller/stopped-markdown-images.js";
import { uploadStoppedControllerArchive } from "../controller/archive-upload.js";
import { runRepositoryGit } from "../../repository/git.js";
import { parseWorktreeBranches } from "./worktree-scan.js";
import { retainedWorktreePathInScope, sameWorktreeLocation } from "./worktrees/paths.js";
import { withWebRecordingSource } from "./web-recording-source.js";

export type WorkerMarkdownRepairTarget = { projectId: string; taskId: string; claimId: string; sessionId: string; worktreeId: string };
const repairNextAction = (code: string): string => {
  if (["projection_input_incomplete", "projection_identity_ambiguous", "image_identity_ambiguous", "projection_input_missing", "repair_plan_changed"].includes(code)) return "Keep the original journal and native history for source recovery; this command cannot reconstruct missing or ambiguous input. Do not remove failure markers.";
  if (["source_forbidden", "policy_restricted", "context_unavailable"].includes(code)) return "Keep the original resources and inspect the original worktree context. This command cannot fetch external images or bypass source policy.";
  if (code.startsWith("analysis_")) return "Keep the original input and inspect its retained analysis diagnostics before retrying; do not treat an unsuccessful analysis as an empty image list.";
  return "Restore the reported original source or context, then rerun this exact command. Original failed entries remain retained.";
};

/** A terminal execution's storage permit is independent of the running Worker's scheduling lock. */
export const runWorkerMarkdownRepair = async (target: WorkerMarkdownRepairTarget, context: CliContext): Promise<void> => {
  await runServerCommand(context, async ({ api, operation, serverUrl, serverConfiguration }) => {
    const paths = resolveWorkerPaths(context.homeDirectory());
    const readLocal = () => {
      const db = new Database(path.join(paths.workerDirectory, "web-executions.sqlite"), { readonly: true, fileMustExist: true, timeout: 1000 });
      try {
        return db.transaction(() => {
          inspectSqlite(db, webExecutionStoreFormat);
          const row = db.prepare("SELECT data FROM executions WHERE identity=?").get(webClaimKey(target)) as { data: string } | undefined;
          if (!row) throw new Error("The original Web execution is missing; no repair was started.");
          return parseWebTaskV1(JSON.parse(row.data));
        }).deferred();
      } finally { db.close(); }
    };
    const local = readLocal(), execution = local.webExecution;
    if (!execution || local.serverOrigin !== serverUrl || local.worktreeId !== target.worktreeId || execution.sessionId !== target.sessionId || local.cleanup?.kind !== "terminal" || !local.resources.worktree) throw new Error("Markdown repair requires the original retained terminal Web execution.");
    return await withWebRecordingSource(context.homeDirectory(), local, readLocal, async () => {
    const ticket = await readLaunchTicket(context.homeDirectory(), execution.launchId);
    if (ticket.serverOrigin !== serverUrl || ticket.projectId !== target.projectId || ticket.taskId !== target.taskId || ticket.claimId !== target.claimId || ticket.worktreeId !== target.worktreeId || ticket.workerId !== local.workerId || ticket.sessionId !== target.sessionId || ticket.executionId !== execution.executionId || ticket.executionGeneration !== execution.executionGeneration || ticket.controllerInstanceId !== execution.controllerInstanceId || ticket.controllerId !== execution.controllerId || !await sameWorktreeLocation(ticket.cwd, local.resources.worktree!.worktreePath)) throw new Error("The original launch ticket differs from the selected execution.");
    const original = controllerPayloadHash(local);
    const journalPath = path.join(controllerExecutionDirectory(context.homeDirectory(), execution.executionId), "journal.sqlite");
    const verify = async (): Promise<void> => {
      operation.check();
      const task = await api.getTask(target.projectId, target.taskId), claim = readWorkerClaim(task.properties);
      const user = await api.getCurrentUser();
      if ((task.status !== "done" && task.status !== "cancelled") || readTaskBlocked(task.properties) === true || claim?.state !== "completed" || claim.claimId !== target.claimId || claim.workerId !== local.workerId || claim.worktreeId !== target.worktreeId || claim.agentControlMode !== "web" || claim.userId !== user.id || ticket.userId !== user.id) throw new Error("The terminal task, original claim or repair permission changed; original resources were retained.");
      const session = await api.inspectTaskSession(target.projectId, target.taskId, target.sessionId);
      if (session.fence.claimId !== target.claimId || session.fence.executionGeneration !== ticket.executionGeneration || !session.session.nativeSessionId || claim.nativeSessionId != null && session.session.nativeSessionId !== claim.nativeSessionId || !["archived", "stopped"].includes(session.session.lifecycle ?? "")) throw new Error("The selected Session does not confirm the original stopped execution.");
      const journal = new Database(journalPath, { readonly: true, fileMustExist: true, timeout: 1000 });
      let snapshot: ControllerSnapshot | null;
      try {
        snapshot = journal.transaction(() => {
          inspectSqlite(journal, controllerJournalFormat);
          const row = journal.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string } | undefined;
          return row ? JSON.parse(row.snapshot) as ControllerSnapshot : null;
        }).deferred();
      } finally { journal.close(); }
      const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform;
      if (!snapshot?.nativeSessionId || snapshot.nativeSessionId !== session.session.nativeSessionId || snapshot.nativeSessionId !== local.resources.nativeSession?.sessionId || claim.agent !== ticket.provider || claim.platform !== platform) throw new Error("The original native Session, provider or platform identity differs.");
      const configuration = parseConfigurationDocument(await readConfigurationSource(paths, operation.signal), paths);
      if (configuration.mapping.workerId !== local.workerId || controllerPayloadHash(readLocal()) !== original || controllerPayloadHash(await readLaunchTicket(context.homeDirectory(), execution.launchId)) !== controllerPayloadHash(ticket)) throw new Error("The local Worker assignment changed during repair.");
      const binding = local.resources.worktree!;
      if (!retainedWorktreePathInScope(local.repositoryPath, target, ticket.cwd)) throw new Error("The original worktree is outside its managed namespace.");
      const top = await runRepositoryGit(ticket.cwd, ["rev-parse", "--show-toplevel"], operation);
      const common = await runRepositoryGit(ticket.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], operation);
      const branch = `daynight/${target.taskId}`;
      const { stdout } = await runRepositoryGit(binding.repositoryPath, ["worktree", "list", "--porcelain", "-z"], operation);
      const matches = parseWorktreeBranches(stdout).filter(registration => registration.branch === `refs/heads/${branch}`);
      const registeredPath = matches[0]?.worktreePath;
      if (!await sameWorktreeLocation(top.stdout.trim(), ticket.cwd) || !await sameWorktreeLocation(common.stdout.trim(), binding.commonDirectory)
        || branch !== binding.branch || matches.length !== 1 || registeredPath === undefined
        || !await sameWorktreeLocation(registeredPath, ticket.cwd)) throw new Error("The actual worktree differs from its recorded owner.");
    };
    await verify();
    const coordination = new Database(journalPath, { readonly: true, fileMustExist: true, timeout: 1000 });
    let started: boolean;
    try {
      started = coordination.transaction(() => {
        inspectSqlite(coordination, controllerJournalFormat);
        // A durable source batch freezes the source before an archive intent exists.
        // The uploader owns reconciliation of that original batch and its receipt.
        return existsSync(`${journalPath}.archive-intent-${ticket.executionGeneration}.json`) || existsSync(`${journalPath}.archive-receipt-${ticket.executionGeneration}.json`)
          || coordination.prepare("SELECT 1 FROM image_runtime_state WHERE key IN ('stopped_source_tail','archive_history_checkpoint') LIMIT 1").get() !== undefined;
      }).deferred();
    } finally { coordination.close(); }
    const repair = started ? { repaired: [], failures: [] } : await repairStoppedMarkdownProjections({ journalPath, ticket, signal: operation.signal, resolveImage: resolveStoppedMarkdownImage, beforeWrite: verify });
    if (repair.failures.length) return { kind: "known-session-operation", output: `${JSON.stringify({ ...target, ...repair, failures: repair.failures.map(item => ({ ...item, nextAction: repairNextAction(item.code) })), archive: "not-started" })}\n`, exitCode: 1, failureText: () => "Markdown repair results could not be printed; inspect the same original execution before retrying." };
    await verify();
    const archive = await uploadStoppedControllerArchive({ journalPath, ticket, serverToken: serverConfiguration.serverToken!, signal: operation.signal,
      onRetry: event => context.stderr(`Session archive capacity ${JSON.stringify(event)}\n`),
    });
    return { kind: "known-session-operation" as const, output: `${JSON.stringify({ ...target, ...repair, archive, cleanup: "owned-by-worker" })}\n`, exitCode: 0, failureText: () => "Archive result output failed; reconcile the original archive receipt before retrying." };
    }, operation.signal);
  }, { operationLimits: { totalMs: 600_000 } });
};
