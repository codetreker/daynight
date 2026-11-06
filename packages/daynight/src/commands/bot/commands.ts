import { randomUUID } from "node:crypto";
import { ApiError } from "../../api/client.js";
import { canonicalId } from "../../api/parse.js";
import type { CliContext } from "../../cli/context.js";
import { UsageError } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { terminalText } from "../../platform/terminal.js";
import type { runServerCommand } from "../server/runtime.js";
import { botCwd, botName, botNativeChoice, botProvider, botVersion, deletionState } from "./api.js";
import type { Bot, BotOverrides } from "./api.js";
import { botDefinition } from "./definition.js";

export type BotCommandDependencies = { runServerCommand: typeof runServerCommand };
const defaults: BotCommandDependencies = { runServerCommand: async (...args) => (await import("../server/runtime.js")).runServerCommand(...args) };
const apiFailure = (cause: unknown, seen = new Set<unknown>()): ApiError | undefined => {
  if (seen.has(cause)) return undefined;
  seen.add(cause);
  if (cause instanceof ApiError) return cause;
  if (cause instanceof AggregateError) {
    for (const child of cause.errors) { const result = apiFailure(child, seen); if (result !== undefined) return result; }
  }
  return cause instanceof Error && cause.cause !== undefined ? apiFailure(cause.cause, seen) : undefined;
};
const failureReason = (cause: unknown): string | undefined => {
  if (cause instanceof ApiError && cause.code === "resource_conflict") {
    const reasons = ["no_available_worker", "unsupported", "offline", "stale", "unavailable", "invalid_cwd", "provider_unavailable", ...["unsupported_arguments", "invalid_cwd", "not_found", "permission_denied", "timeout", "command_failed", "invalid_output", "unavailable"].map(value => `provider_${value}`)];
    const reason = reasons.find(value => cause.serverMessage === `Bot configuration is unavailable: ${value}. Read current defaults before submitting a new request.`);
    if (reason !== undefined) return reason;
    if (cause.serverMessage === "Bot ID already belongs to a different creation request.") return "creation_request_conflict";
    if (cause.serverMessage === "Bot deletion belongs to a different request.") return "deletion_request_conflict";
    if (cause.serverMessage === "A bound Bot requires the Session deletion barrier.") return "session_deletion_barrier_required";
  }
  if (cause instanceof Error && cause.message === "You are not logged in. Run daynight login to authenticate.") return "login_required";
  return undefined;
};
const render = (bot: Bot): string => {
  const lines = [`ID: ${bot.id}`, `Worker: ${bot.workerId}`, `Version: ${bot.version}`];
  if (bot.deletion !== null) lines.push(`Deletion: ${deletionState(bot.deletion)}`, `Deletion ID: ${bot.deletion.deletionId}`, `Requested version: ${bot.deletion.requestedVersion}`, `Worker cleanup: ${bot.deletion.workerCleanup.state}`, `Server cleanup: ${bot.deletion.serverCleanup.state}`, ...[bot.deletion.workerCleanup.code, bot.deletion.serverCleanup.code].filter((code): code is string => code !== null).map(code => `Failure: ${terminalText(code)}`));
  else lines.push(`Name: ${terminalText(bot.name)}`, `Startup: ${bot.startupResult.state}`, ...(bot.startupResult.code === null ? [] : [`Failure: ${terminalText(bot.startupResult.code)}`]), `Directory: ${terminalText(bot.resolvedConfiguration.cwd)}`, `Agent: ${bot.resolvedConfiguration.provider}`, `Session: ${bot.sessionId ?? "not registered"}`, `Created: ${bot.createdAt}`, `Updated: ${bot.updatedAt}`);
  return lines.join("\n") + "\n";
};
export const runBotCommand = async (args: readonly string[], context: CliContext, dependencies: BotCommandDependencies = defaults): Promise<void> => {
  const command = parseCommand(botDefinition, args, ["daynight", "bot"], "daynight bot --help");
  if (command.kind !== "run") { context.stdout(renderCommandHelp(command.command, command.path)); return; }
  const action = command.command.name;
  const option = (name: string) => command.options.get(name) as string | undefined;
  const uuid = (value: string): string => { const parsed = canonicalId(value); if (parsed === null) throw new Error("Expected a hyphenated UUID."); return parsed; };
  let botId: string | undefined, requestId: string | undefined, name: string | undefined, version: string | undefined;
  const overrides: { workerId?: string; cwd?: string; provider?: NonNullable<BotOverrides["provider"]>; model?: string; reasoningEffort?: string } = {};
  try {
    if (action === "show" || action === "delete") botId = uuid(command.values[0]!);
    if (action === "create") {
      name = botName(option("--name"));
      if (option("--worker") !== undefined) overrides.workerId = uuid(option("--worker")!);
      if (option("--cwd") !== undefined) overrides.cwd = botCwd(option("--cwd"));
      if (option("--agent") !== undefined) overrides.provider = botProvider(option("--agent"));
      if (option("--model") !== undefined) overrides.model = botNativeChoice(option("--model"), 256);
      if (option("--reasoning-effort") !== undefined) overrides.reasoningEffort = botNativeChoice(option("--reasoning-effort"), 64);
    }
    if (action === "delete") version = botVersion(option("--if-version"));
    if (action === "create" || action === "delete") requestId = option("--request-id") === undefined ? randomUUID() : uuid(option("--request-id")!);
    if (action === "create") botId = requestId;
  } catch (cause) { throw new UsageError("Invalid Bot arguments: check UUIDs, name, absolute directory, provider and positive int64 decimal version.", `${command.path.join(" ")} --help`); }
  const json = command.options.has("--json");
  const reconcile = botId === undefined ? undefined : `daynight bot show ${botId} --json`;
  try {
    await dependencies.runServerCommand(context, async ({ api, operation }) => {
      if (action === "list") {
        const bots = await api.listBots(); operation.check();
        return json ? `${JSON.stringify(bots)}\n` : bots.length === 0 ? "No Bots.\n" : bots.map(render).join("\n");
      }
      if (action === "show") { const bot = await api.getBot(botId!); operation.check(); return json ? `${JSON.stringify(bot)}\n` : render(bot); }
      const bot = action === "create"
        ? await api.createBot({ id: botId!, name: name!, ...(Object.keys(overrides).length === 0 ? {} : { overrides }) })
        : await api.deleteBot(botId!, { ifVersion: version!, deletionId: requestId! });
      return { kind: "confirmed-mutation", output: json ? `${JSON.stringify(bot)}\n` : render(bot), failureText: (phase) => json
        ? JSON.stringify({ error: { operation: `bot.${action}`, botId, requestId, phase, outcomeUnconfirmed: false, confirmed: true, reconcile } })
        : `bot.${action} confirmed for Bot ${botId}, request ${requestId}; local ${phase} failed. Reconcile with ${reconcile}.` };
    });
  } catch (cause) {
    if (cause instanceof PublicDiagnosticError) throw cause;
    const failure = apiFailure(cause);
    const reason = failureReason(failure ?? cause);
    const error = { ...(reason === undefined ? {} : { reason }), operation: `bot.${action}`, ...(botId === undefined ? {} : { botId }), ...(requestId === undefined ? {} : { requestId }), ...(failure === undefined ? {} : { phase: failure.phase, ...(failure.status === undefined ? {} : { status: failure.status }), ...(failure.code === undefined ? {} : { code: failure.code }), ...(failure.requestId === undefined ? {} : { serverRequestId: failure.requestId }), ...(failure.confirmedMutationId === undefined ? {} : { confirmed: true }) }), outcomeUnconfirmed: failure?.outcomeUnconfirmed === true, ...(reconcile === undefined ? {} : { reconcile }) };
    const message = json ? JSON.stringify({ error }) : `${error.operation} failed${"status" in error ? ` (HTTP ${error.status})` : ""}${"code" in error ? `: ${terminalText(error.code!)}` : "."}${reason === undefined ? "" : ` Reason: ${reason}.`}${botId === undefined ? "" : ` Bot ID: ${botId}.`}${requestId === undefined ? "" : ` Request ID: ${requestId}.`}${error.outcomeUnconfirmed ? " Remote mutation outcome is unconfirmed; do not automatically repeat the write." : ""}${reconcile === undefined ? "" : ` Reconcile with ${reconcile}.`}${(failure?.status === 401 || reason === "login_required") ? " Run daynight login to authenticate." : ""}`;
    throw new PublicDiagnosticError(message, 1, { cause });
  }
};
