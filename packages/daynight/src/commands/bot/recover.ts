import { ApiError } from "../../api/client.js";
import { canonicalId } from "../../api/parse.js";
import type { CliContext } from "../../cli/context.js";
import { UsageError } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { terminalText } from "../../platform/terminal.js";
import type { runServerCommand } from "../server/runtime.js";
import { deletionState, type Bot, type BotDeletion } from "./api.js";
import { botDefinition } from "./definition.js";
import type { recoverLocalBotDeletion } from "../worker/bots/deletion-local.js";

export type BotRecoveryCommandDependencies = {
  runServerCommand: typeof runServerCommand;
  recoverLocal?: typeof recoverLocalBotDeletion;
};
const apiError = (cause: unknown, seen = new Set<unknown>()): ApiError | undefined => {
  if (seen.has(cause)) return undefined;
  seen.add(cause);
  if (cause instanceof ApiError) return cause;
  if (cause instanceof AggregateError) for (const child of cause.errors) { const found = apiError(child, seen); if (found !== undefined) return found; }
  return cause instanceof Error ? apiError(cause.cause, seen) : undefined;
};
const localReasons: Record<string, string> = {
  worker_running: "Stop the hosting Worker before local recovery, then check the original result.",
  evidence_missing: "Original cleanup evidence is missing; retain the local files. Deletion remains incomplete.",
  wrong_worker: "Use the original execution's machine and its original DN_CONFIG_DIR.",
  storage_unreadable: "Original Bot storage is unreadable; preserve it for inspection.",
  deletion_changed: "The deletion identity changed; read the original Bot before another action.",
  recovery_not_required: "Local recovery requires a deleted Bot reporting execution_evidence_missing. Read its current state before another action.",
  stop_unproven: "The original execution stop is unproven; retain its evidence.",
  local_cleanup_failed: "Local cleanup failed; read the original deletion result before another action.",
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
const render = (bot: Extract<Bot, { readonly deletion: BotDeletion }>): string => [
  `Bot ID: ${bot.id}`, `Worker: ${bot.workerId}`, `Version: ${bot.version}`, `Deletion ID: ${bot.deletion.deletionId}`,
  `Deletion: ${deletionState(bot.deletion)}`, `Worker cleanup: ${bot.deletion.workerCleanup.state}`, `Server cleanup: ${bot.deletion.serverCleanup.state}`,
  ...[bot.deletion.workerCleanup.code, bot.deletion.serverCleanup.code].filter((code): code is string => code !== null).map(code => `Failure: ${terminalText(code)}`),
].join("\n") + "\n";
const changed = (): Error => Object.assign(new Error("Deletion identity changed."), { code: "deletion_changed" });

export const runBotRecoveryCommand = async (args: readonly string[], context: CliContext, dependencies: BotRecoveryCommandDependencies): Promise<void> => {
  const command = parseCommand(botDefinition, args, ["daynight", "bot"]);
  if (command.kind !== "run") { context.stdout(renderCommandHelp(command.command, command.path)); return; }
  const json = command.options.has("--json");
  const uuid = (value: unknown): string => { const result = typeof value === "string" ? canonicalId(value) : null; if (result === null || result === "00000000-0000-0000-0000-000000000000") throw new Error("Invalid UUID."); return result; };
  let botId: string, deletionId: string;
  try { botId = uuid(command.values[0]); deletionId = uuid(command.options.get("--deletion-id")); }
  catch { throw new UsageError("Invalid deletion recovery arguments: check the original Bot and deletion UUIDs.", `${command.path.join(" ")} --help`); }
  const reconcile = `daynight bot show ${botId} --json`;
  let localReceiptConfirmed = false;
  try {
    await dependencies.runServerCommand(context, async ({ api, operation, serverUrl, serverConfiguration }) => {
      const user = await api.getCurrentUser(true), scoped = api.withExpectedUserId(user.id);
      const bot = await scoped.getBot(botId);
      if (bot.deletion === null) throw Object.assign(new Error("The Bot does not require local deletion recovery."), { code: "recovery_not_required" });
      if (bot.deletion.deletionId !== deletionId) throw changed();
      if (bot.deletion.workerCleanup.state !== "failed" || bot.deletion.workerCleanup.code !== "execution_evidence_missing") throw Object.assign(new Error("The Bot does not require local deletion recovery."), { code: "recovery_not_required" });
      const result = await (dependencies.recoverLocal ?? (await import("../worker/bots/deletion-local.js")).recoverLocalBotDeletion)({
        homeDirectory: context.homeDirectory(), packageDirectory: context.packageDirectory, workingDirectory: context.workingDirectory(),
        serverUrl, serverToken: serverConfiguration.serverToken!, ownerUserId: user.id, botId, bot, signal: operation.signal,
      });
      localReceiptConfirmed = result.receiptConfirmed;
      const observed = await scoped.getBot(botId);
      if (observed.deletion === null || observed.deletion.deletionId !== deletionId || observed.deletion.requestedVersion !== bot.deletion.requestedVersion || observed.workerId !== bot.workerId) throw changed();
      return { kind: "confirmed-mutation", output: json ? `${JSON.stringify(observed)}\n` : render(observed), failureText: phase => json
        ? JSON.stringify({ error: { operation: "bot.recover", botId, deletionId, confirmed: true, outcomeUnconfirmed: false, phase, reconcile } })
        : `Local recovery receipt confirmed for Bot ${botId}, deletion ${deletionId}; local ${phase} failed. Reconcile with ${reconcile}.` };
    });
  } catch (cause) {
    if (cause instanceof PublicDiagnosticError) throw cause;
    const failure = apiError(cause), local = localError(cause), localReason = local.code;
    const hint = localReason === "evidence_missing" && local.generationStopped
      ? "The original generation is stopped; historical cleanup evidence is missing. Deletion remains incomplete. Inspect the retained local files before another recovery attempt." : undefined;
    const confirmed = localReceiptConfirmed || local.receiptConfirmed || failure?.confirmedMutationId !== undefined;
    const error = { operation: "bot.recover", botId, deletionId,
      ...(failure === undefined ? {} : { phase: failure.phase, status: failure.status, code: failure.code }), ...(localReason === undefined ? {} : { reason: localReason }), ...(hint === undefined ? {} : { hint }),
      ...(confirmed ? { confirmed: true } : {}), outcomeUnconfirmed: !confirmed && failure?.outcomeUnconfirmed === true, reconcile };
    throw new PublicDiagnosticError(json ? JSON.stringify({ error }) : `${error.operation} failed for Bot ${botId}, deletion ${deletionId}.${failure?.status === undefined ? "" : ` HTTP ${failure.status} (${failure.phase}).`}${failure?.code === undefined ? "" : ` Code: ${terminalText(failure.code)}.`}${localReason === undefined ? "" : ` ${localReasons[localReason]}`}${hint === undefined ? "" : ` ${hint}`}${confirmed ? " The submitted receipt is confirmed." : error.outcomeUnconfirmed ? " The remote outcome is unknown; do not automatically repeat the write." : ""} Reconcile with ${reconcile}.`, 1, { cause });
  }
};
