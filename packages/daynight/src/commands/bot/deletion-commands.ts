import { ApiError } from "../../api/client.js";
import { canonicalId } from "../../api/parse.js";
import type { CliContext } from "../../cli/context.js";
import { UsageError } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { terminalText } from "../../platform/terminal.js";
import type { runServerCommand } from "../server/runtime.js";
import { botVersion } from "./api.js";
import { botDeletionReason, type BotDeletionRecovery } from "./deletion-api.js";
import { botDeletionDefinition } from "./deletion-definition.js";
import type { inspectLocalBotDeletion, recoverLocalBotDeletion } from "../worker/bots/deletion-local.js";

export type BotDeletionCommandDependencies = {
  runServerCommand: typeof runServerCommand;
  inspectLocal?: typeof inspectLocalBotDeletion;
  recoverLocal?: typeof recoverLocalBotDeletion;
};
const apiError = (cause: unknown, seen = new Set<unknown>()): ApiError | undefined => {
  if (seen.has(cause)) return undefined;
  seen.add(cause);
  if (cause instanceof ApiError) return cause;
  if (cause instanceof AggregateError) for (const child of cause.errors) { const found = apiError(child, seen); if (found !== undefined) return found; }
  return cause instanceof Error ? apiError(cause.cause, seen) : undefined;
};
const localError = (cause: unknown, seen = new Set<unknown>()): { code?: string; receiptConfirmed: boolean; generationStopped: boolean } => {
  if (typeof cause !== "object" || cause === null || seen.has(cause)) return { receiptConfirmed: false, generationStopped: false };
  seen.add(cause);
  const value = cause as { code?: unknown; receiptConfirmed?: unknown; generationStopped?: unknown };
  const found = { ...(typeof value.code === "string" && Object.hasOwn(localReasons, value.code) ? { code: value.code } : {}), receiptConfirmed: value.receiptConfirmed === true, generationStopped: value.generationStopped === true };
  const nested = cause instanceof AggregateError ? cause.errors : cause instanceof Error ? [cause.cause] : [];
  for (const child of nested) {
    const result = localError(child, seen);
    if (found.code === undefined && result.code !== undefined) found.code = result.code;
    found.receiptConfirmed ||= result.receiptConfirmed;
    found.generationStopped ||= result.generationStopped;
  }
  return found;
};
const hasErrorMessage = (cause: unknown, message: string, seen = new Set<unknown>()): boolean => {
  if (!(cause instanceof Error) || seen.has(cause)) return false;
  seen.add(cause);
  return cause.message === message || hasErrorMessage(cause.cause, message, seen)
    || cause instanceof AggregateError && cause.errors.some(child => hasErrorMessage(child, message, seen));
};
const render = (recovery: BotDeletionRecovery): string => [
  `Bot ID: ${recovery.botId}`, `Original Worker: ${recovery.workerId}`, `Hosting Worker: ${recovery.hostingWorkerId}`, `Version: ${recovery.version}`, `Deletion ID: ${recovery.deletionId}`,
  `Worker cleanup: ${recovery.workerCleanup.state}`, `Server cleanup: ${recovery.serverCleanup.state}`,
  ...(recovery.decision === null ? [`Recovery required: ${recovery.recoveryRequired}`] : [
    `Decision operation: ${recovery.decision.operationId}`, `Local verification: unverified`,
    `Tracking: ${recovery.serverCleanup.state === "completed" ? "closed; server cleanup completed, local execution and files remain unverified" : "server cleanup incomplete"}`,
    `Acknowledged by: ${recovery.decision.actorUserId}`, `Acknowledged at: ${recovery.decision.acknowledgedAt}`, `Reason: ${terminalText(recovery.decision.reason)}`,
  ]),
  ...[recovery.workerCleanup.code, recovery.serverCleanup.code].filter((code): code is string => code !== null).map(code => `Failure: ${terminalText(code)}`),
].join("\n") + "\n";
const localReasons: Record<string, string> = {
  worker_running: "Stop the hosting Worker before local recovery, then inspect again.",
  evidence_missing: "Original execution evidence is missing; inspect the recovery state before deciding whether to accept unverified local cleanup.",
  wrong_worker: "Use the hosting Worker's machine and its original DN_CONFIG_DIR.",
  storage_unreadable: "Original Bot storage is unreadable; preserve it for inspection.",
  deletion_changed: "The deletion identity changed; inspect the original Bot before another action.",
  stop_unproven: "The original execution stop is unproven; retain its evidence.",
  local_cleanup_failed: "Local cleanup failed; inspect the original deletion result before another action.",
};
export const runBotDeletionCommand = async (args: readonly string[], context: CliContext, dependencies: BotDeletionCommandDependencies): Promise<void> => {
  const command = parseCommand(botDeletionDefinition, args, ["daynight", "bot", "deletion"]);
  if (command.kind !== "run") { context.stdout(renderCommandHelp(command.command, command.path)); return; }
  const action = command.command.name, json = command.options.has("--json");
  const option = (name: string) => command.options.get(name) as string | undefined;
  const uuid = (value: string | undefined): string => { const result = value === undefined ? null : canonicalId(value); if (result === null || result === "00000000-0000-0000-0000-000000000000") throw new Error("Invalid UUID."); return result; };
  let botId: string, deletionId: string | undefined, operationId: string | undefined, version: string | undefined, reason: string | undefined;
  try {
    botId = uuid(command.values[0]);
    if (action !== "inspect") deletionId = uuid(option("--deletion-id"));
    if (action === "resolve" || action === "retry-cleanup") { operationId = uuid(option("--operation-id")); version = botVersion(option("--if-version")); }
    if (action === "resolve") reason = botDeletionReason(option("--reason"));
  } catch { throw new UsageError("Invalid deletion recovery arguments: check original UUIDs, exact positive int64 version and reason.", `${command.path.join(" ")} --help`); }
  const reconcile = `daynight bot deletion inspect ${botId} --server-only --json`;
  let localReceiptConfirmed = false;
  try {
    await dependencies.runServerCommand(context, async ({ api, operation, serverUrl, serverConfiguration }) => {
      if (action === "inspect" || action === "recover") {
        const serverOnly = command.options.has("--server-only");
        const user = serverOnly ? undefined : await api.getCurrentUser(true);
        const scoped = user === undefined ? api : api.withExpectedUserId(user.id);
        const recovery = await scoped.getBotDeletionRecovery(botId);
        if (deletionId !== undefined && recovery.deletionId !== deletionId) throw Object.assign(new Error("Deletion identity changed."), { code: "deletion_changed" });
        if (action === "inspect") {
          const local = serverOnly ? null : await (dependencies.inspectLocal ?? (await import("../worker/bots/deletion-local.js")).inspectLocalBotDeletion)({ homeDirectory: context.homeDirectory(), serverUrl, ownerUserId: user!.id, botId, recovery, signal: operation.signal });
          operation.check();
          return json ? `${JSON.stringify({ recovery, local })}\n` : render(recovery) + (local === null ? "" : `Local inspection: ${JSON.stringify(local)}\n`);
        }
        await (dependencies.recoverLocal ?? (await import("../worker/bots/deletion-local.js")).recoverLocalBotDeletion)({ homeDirectory: context.homeDirectory(), packageDirectory: context.packageDirectory, workingDirectory: context.workingDirectory(), serverUrl, serverToken: serverConfiguration.serverToken!, ownerUserId: user!.id, botId, recovery, signal: operation.signal });
        localReceiptConfirmed = true;
        const observed = await scoped.getBotDeletionRecovery(botId);
        if (observed.deletionId !== deletionId) throw new Error("Deletion identity changed after local recovery.");
        return { kind: "confirmed-mutation", output: json ? `${JSON.stringify(observed)}\n` : render(observed), failureText: phase => json
          ? JSON.stringify({ error: { operation: "bot.deletion.recover", botId, deletionId, confirmed: true, outcomeUnconfirmed: false, phase, reconcile } })
          : `Local recovery receipt confirmed for Bot ${botId}, deletion ${deletionId}; local ${phase} failed. Reconcile with ${reconcile}.` };
      }
      const recovery = await api.resolveBotDeletion(botId, action === "resolve"
        ? { action: "accept_unverified", ifVersion: version!, deletionId: deletionId!, operationId: operationId!, acknowledgeLocalUnverified: true, reason: reason! }
        : { action: "retry_cleanup", ifVersion: version!, deletionId: deletionId!, operationId: operationId! });
      return { kind: "confirmed-mutation", output: json ? `${JSON.stringify(recovery)}\n` : render(recovery), failureText: phase => json
        ? JSON.stringify({ error: { operation: `bot.deletion.${action}`, botId, deletionId, operationId, confirmed: true, outcomeUnconfirmed: false, phase, reconcile } })
        : `Recovery decision confirmed for Bot ${botId}, operation ${operationId}; local ${phase} failed. Reconcile with ${reconcile}.` };
    });
  } catch (cause) {
    if (cause instanceof PublicDiagnosticError) throw cause;
    const failure = apiError(cause);
    const local = localError(cause);
    const localReason = local.code;
    const recoveryUnavailable = failure?.operation === "bot.deletion.inspect" && failure.status === 404
      && (failure.code === "not_found" || failure.phase === "protocol" && hasErrorMessage(failure, "Expected an application/json UTF-8 response."));
    const hint = localReason === "evidence_missing" && local.generationStopped
      ? `The original generation is stopped; historical cleanup evidence is missing. Deletion remains incomplete. Inspect locally with daynight bot deletion inspect ${botId} --json.`
      : recoveryUnavailable ? "The server may not support deletion recovery. Check the configured server and Bot ID, and upgrade the server to a version supporting deletion recovery before inspecting again. HTTP 404 does not confirm Bot cleanup." : undefined;
    const confirmed = localReceiptConfirmed || local.receiptConfirmed === true || failure?.confirmedMutationId !== undefined;
    const error = { operation: `bot.deletion.${action}`, botId, ...(deletionId === undefined ? {} : { deletionId }), ...(operationId === undefined ? {} : { operationId }),
      ...(failure === undefined ? {} : { phase: failure.phase, status: failure.status, code: failure.code }), ...(localReason === undefined ? {} : { reason: localReason }), ...(hint === undefined ? {} : { hint }),
      ...(confirmed ? { confirmed: true } : {}), outcomeUnconfirmed: !confirmed && failure?.outcomeUnconfirmed === true, reconcile };
    throw new PublicDiagnosticError(json ? JSON.stringify({ error }) : `${error.operation} failed for Bot ${botId}.${failure?.status === undefined ? "" : ` HTTP ${failure.status} (${failure.phase}).`}${operationId === undefined ? "" : ` Operation ID: ${operationId}.`}${failure?.code === undefined ? "" : ` Code: ${terminalText(failure.code)}.`}${localReason === undefined ? "" : ` ${localReasons[localReason]}`}${hint === undefined ? "" : ` ${hint}`}${confirmed ? " The submitted receipt is confirmed." : error.outcomeUnconfirmed ? " The remote outcome is unknown; do not automatically repeat the write." : ""} Reconcile with ${reconcile}.`, 1, { cause });
  }
};
