import { randomUUID } from "node:crypto";
import path from "node:path";
import { ApiError } from "../../api/client.js";
import { createAssistantTaskClient, AssistantTaskApiError } from "../../api/assistant-task.js";
import type { AssistantTaskQuery, AssistantTaskClaimKind, AssistantTaskCredential, JsonValue } from "../../api/assistant-task-types.js";
import type { CliContext } from "../../cli/context.js";
import { UsageError } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { resolveConfigurationPaths } from "../../config/paths.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { terminalText } from "../../platform/terminal.js";
import type { runServerCommand } from "../server/runtime.js";
import { assistantTaskId, assistantTaskInteger, assistantTaskJson } from "./api.js";
import { runClaimOperation, recoverClaimOperation, readClaimCredential } from "./claims.js";
import { ClaimStateError } from "./state.js";
import { assistantTaskDefinition } from "./definition.js";

export type AssistantTaskCommandDependencies = {
  runServerCommand: typeof runServerCommand;
  createClient: typeof createAssistantTaskClient;
  runClaimOperation: typeof runClaimOperation;
  recoverClaimOperation: typeof recoverClaimOperation;
  readClaimCredential: typeof readClaimCredential;
  environment: NodeJS.ProcessEnv;
};
const defaults: AssistantTaskCommandDependencies = {
  runServerCommand: async (...args) => (await import("../server/runtime.js")).runServerCommand(...args),
  createClient: createAssistantTaskClient, runClaimOperation, recoverClaimOperation, readClaimCredential,
  environment: process.env,
};
const userActions = new Set(["create", "update", "pause", "resume", "delete", "manual rollback", "appendix update", "appendix delete", "proposal decide", "events clear-attention"]);
const botActions = new Set(["claim", "bind", "renew", "appendix add", "propose", "record add", "item add", "item update", "ask", "answer", "events add", "events ack"]);
const claimActions = new Set(["claim", "bind", "renew", "release", "transfer"]);
const readActions = new Set(["list", "show", "claim-operation show", "manual show", "manual list", "appendix list", "proposal list", "record list", "item list", "item show", "inquiry list", "events pull"]);
const idOptions = new Set(["--operation-id", "--target-bot", "--item", "--source-record", "--evidence-record"]);
const integerOptions = new Set(["--if-version", "--base-version", "--manual-version", "--version", "--episode", "--expected-generation"]);
const jsonOptions = new Set(["--rules", "--trigger", "--app-state", "--refs", "--payload"]);
const output = (value: unknown, json: boolean): string => json ? `${JSON.stringify(value)}\n` : `${terminalText(JSON.stringify(value, null, 2))}\n`;

export const runAssistantTaskCommand = async (args: readonly string[], context: CliContext, injected: Partial<AssistantTaskCommandDependencies> = {}): Promise<void> => {
  const deps = { ...defaults, ...injected };
  const command = parseCommand(assistantTaskDefinition, args, ["daynight", "assistant-task"]);
  if (command.kind !== "run") { context.stdout(renderCommandHelp(command.command, command.path)); return; }
  const action = command.path.slice(2).join(" ");
  const option = (key: string): string | undefined => command.options.get(key) as string | undefined;
  const repeated = (key: string): string[] => [...(command.options.get(key) as readonly string[] | undefined ?? [])];
  const json = command.options.has("--json");
  const write = !readActions.has(action);
  const help = `${command.path.join(" ")} --help`;
  let botId: string | undefined, taskId: string | undefined, resourceId: string | undefined, operationId: string | undefined;
  const values = new Map<string, JsonValue>();
  try {
    if (deps.environment.DAYNIGHT_BOT_ID !== undefined) botId = assistantTaskId(deps.environment.DAYNIGHT_BOT_ID);
    if (command.values[0] !== undefined) taskId = assistantTaskId(command.values[0]);
    if (command.values[1] !== undefined) resourceId = assistantTaskId(command.values[1]);
    for (const [key, value] of command.options) {
      if (idOptions.has(key)) for (const entry of typeof value === "string" ? [value] : value as readonly string[]) assistantTaskId(entry);
      if (integerOptions.has(key)) assistantTaskInteger(value as string, key === "--expected-generation");
      if (jsonOptions.has(key)) {
        const parsed = assistantTaskJson(value as string);
        if (parsed === null && key !== "--trigger") throw new Error("This JSON field cannot be null.");
        values.set(key, parsed);
      }
    }
    if (option("--limit") !== undefined && (!/^[1-9][0-9]*$/.test(option("--limit")!) || Number(option("--limit")) > 200)) throw new Error("Invalid limit.");
    if (write) operationId = option("--operation-id") ?? randomUUID();
  } catch { throw new UsageError("Invalid assistant-task arguments: use canonical lowercase UUIDs, exact decimal int64 values, a limit from 1 to 200, and valid JSON without unsafe numbers. Check DAYNIGHT_BOT_ID when set.", help); }
  if (botActions.has(action) && botId === undefined) throw new UsageError("This operation requires DAYNIGHT_BOT_ID. Run it from the assigned Bot environment; user terminals may read tasks and perform user operations.", help);
  if (userActions.has(action) && botId !== undefined) throw new UsageError("This is a user-only operation and cannot run with DAYNIGHT_BOT_ID set. A Bot cannot approve or change user-owned rules.", help);
  if (action === "release" && botId === undefined && option("--if-version") === undefined) throw new UsageError("A user release requires --if-version from the current task observation.", help);
  if (action === "release" && botId !== undefined && option("--if-version") !== undefined) throw new UsageError("A Bot release uses its saved credential and --expected-generation; omit --if-version.", help);
  if (action === "update" && !["--name", "--purpose", "--scope", "--takeover", "--trigger"].some(key => command.options.has(key))) throw new UsageError("Update requires at least one changed field.", help);
  if (action === "proposal decide" && option("--decision") !== "edited" && (option("--body") !== undefined || option("--rules") !== undefined)) throw new UsageError("Only an edited decision accepts --body or --rules.", help);
  if (action === "appendix update" && command.options.has("--source-record") && command.options.has("--clear-source-records")) throw new UsageError("--source-record and --clear-source-records cannot be combined.", help);
  const value = (key: string, fallback: JsonValue = null): JsonValue => values.get(key) ?? fallback;
  const query: AssistantTaskQuery = {
    ...(option("--limit") === undefined ? {} : { limit: Number(option("--limit")) }),
    ...(option("--cursor") === undefined ? {} : { cursor: option("--cursor")! }),
    ...(option("--state") === undefined ? {} : { state: option("--state")! }),
    ...(option("--item") === undefined ? {} : { itemId: option("--item")! }),
    ...(option("--target-bot") === undefined ? {} : { targetBotId: option("--target-bot")! }),
  };
  if (action === "create") taskId = operationId;
  const reconcile = taskId === undefined ? "daynight assistant-task events pull --json" : claimActions.has(action)
    ? `daynight assistant-task claim-operation show ${taskId} ${operationId} --json`
    : `daynight assistant-task show ${taskId} --json`;
  let confirmed = false;
  try {
    await deps.runServerCommand(context, async session => {
      const user = await session.api.getCurrentUser(true);
      const api = deps.createClient({ serverUrl: session.serverUrl, ...(session.serverConfiguration.serverToken === undefined ? {} : { serverToken: session.serverConfiguration.serverToken }), expectedUserId: user.id, ...(botId === undefined ? {} : { botId }), operation: session.operation });
      const stateDirectory = deps.environment.DAYNIGHT_BOT_STATE_DIR ?? (botId === undefined ? path.join(resolveConfigurationPaths(context.homeDirectory(), path, deps.environment).stateDirectory, "assistant-tasks") : undefined);
      const scope = { api, serverOrigin: new URL(session.serverUrl).origin, ownerUserId: user.id, ...(botId === undefined ? {} : { botId }), ...(stateDirectory === undefined ? {} : { stateDirectory }), taskId: taskId! };
      const credential = (): Promise<AssistantTaskCredential> => deps.readClaimCredential(scope);
      const dispatch = async (): Promise<unknown> => {
        switch (action) {
          case "list": return api.listTasks(query);
          case "show": return api.getTask(taskId!);
          case "create": return api.createTask({ id: taskId!, name: option("--name")!, purpose: option("--purpose") ?? "", scope: option("--scope") ?? "", kind: (option("--kind") ?? "continuous") as "continuous" | "once", takeover: (option("--takeover") ?? "manual") as "manual" | "auto", ...(option("--application") === undefined ? {} : { application: option("--application")! }), ...(values.has("--trigger") ? { trigger: value("--trigger") } : {}), manual: { body: option("--body")!, rules: value("--rules", {}) } });
          case "update": return api.updateTask(taskId!, { ifVersion: option("--if-version")!, ...(option("--name") === undefined ? {} : { name: option("--name")! }), ...(option("--purpose") === undefined ? {} : { purpose: option("--purpose")! }), ...(option("--scope") === undefined ? {} : { scope: option("--scope")! }), ...(option("--takeover") === undefined ? {} : { takeover: option("--takeover")! as "manual" | "auto" }), ...(values.has("--trigger") ? { trigger: value("--trigger") } : {}) });
          case "pause": case "resume": return api.updateTask(taskId!, { ifVersion: option("--if-version")!, state: action === "pause" ? "paused" : "active" });
          case "delete": return api.deleteTask(taskId!, option("--if-version")!);
          case "claim": case "bind": case "renew": case "release": case "transfer": return deps.runClaimOperation({ ...scope, kind: action as AssistantTaskClaimKind, operationId: operationId!, ...(option("--if-version") === undefined ? {} : { ifVersion: option("--if-version")! }), ...(option("--expected-generation") === undefined ? {} : { expectedGeneration: option("--expected-generation")! }), ...(option("--target-bot") === undefined ? {} : { targetBotId: option("--target-bot")! }) });
          case "claim-operation show": return deps.recoverClaimOperation({ ...scope, operationId: resourceId! });
          case "manual show": return api.getManual(taskId!, option("--version"));
          case "manual list": return api.listManuals(taskId!, query);
          case "manual rollback": return api.rollback(taskId!, { ifVersion: option("--if-version")!, manualVersion: option("--manual-version")! });
          case "appendix list": return api.listAppendix(taskId!, query);
          case "appendix add": return api.addAppendix(taskId!, { ...await credential(), id: operationId!, text: option("--text")!, sourceRecords: repeated("--source-record") });
          case "appendix update": return api.updateAppendix(taskId!, resourceId!, { ifVersion: option("--if-version")!, text: option("--text")!, ...(command.options.has("--source-record") || command.options.has("--clear-source-records") ? { sourceRecords: repeated("--source-record") } : {}) });
          case "appendix delete": return api.deleteAppendix(taskId!, resourceId!, option("--if-version")!);
          case "propose": return api.propose(taskId!, { ...await credential(), id: operationId!, baseVersion: option("--base-version")!, body: option("--body")!, rules: value("--rules", {}), reason: option("--reason")!, evidenceRecords: repeated("--evidence-record") });
          case "proposal list": return api.listProposals(taskId!, query);
          case "proposal decide": return api.decide(taskId!, resourceId!, { ifVersion: option("--if-version")!, decision: option("--decision")! as "approved" | "edited" | "rejected", ...(option("--note") === undefined ? {} : { note: option("--note")! }), ...(option("--body") === undefined ? {} : { body: option("--body")! }), ...(values.has("--rules") ? { rules: value("--rules") } : {}) });
          case "record list": return api.listRecords(taskId!, query);
          case "record add": {
            const current = await api.getTask(taskId!);
            const protectedInput = current.holderBotId === botId ? await credential() : {};
            if (current.holderBotId !== botId && !["action", "note"].includes(option("--kind")!)) throw new ClaimStateError("Only the responsible Bot may append this record kind. Other Bots may append action or note records.");
            return api.addRecord(taskId!, { ...protectedInput, id: operationId!, kind: option("--kind")!, text: option("--text")!, ...(values.has("--refs") ? { refs: value("--refs") } : {}), ...(option("--item") === undefined ? {} : { itemId: option("--item")! }) });
          }
          case "item list": return api.listItems(taskId!, query);
          case "item show": return api.getItem(taskId!, resourceId!);
          case "item add": case "item update": return api.saveItem(taskId!, { ...await credential(), ...(action === "item add" ? { id: operationId! } : { ifVersion: option("--if-version")! }), key: option("--key")!, episode: option("--episode")!, state: option("--state")! as "open" | "closed", category: option("--category")!, appState: value("--app-state", {}) }, action === "item add" ? undefined : resourceId!);
          case "ask": return api.ask(taskId!, { id: operationId!, question: option("--question")!, ...(option("--item") === undefined ? {} : { itemId: option("--item")! }) });
          case "answer": return api.answer(taskId!, resourceId!, { ...await credential(), answer: option("--answer")! });
          case "inquiry list": return api.listInquiries(taskId!, query);
          case "events pull": return api.listEvents(taskId, query);
          case "events add": return api.addEvent(taskId!, { ...await credential(), id: operationId!, targetBotId: option("--target-bot")!, type: option("--type")!, ...(values.has("--payload") ? { payload: value("--payload") } : {}) });
          case "events ack": return api.ackEvent(taskId!, resourceId!, { operationId: operationId!, state: (option("--state") ?? "delivered") as "delivered" | "expired" });
          case "events clear-attention": return api.clearAttention(option("--target-bot")!);
          default: throw new Error("Unsupported assistant-task operation.");
        }
      };
      const result = await dispatch();
      if (!write) { session.operation.check(); return output(result, json); }
      confirmed = true;
      return { kind: "confirmed-mutation", output: output(result, json), containsSecret: true, failureText: phase => json
        ? JSON.stringify({ error: { operation: `assistant-task.${action}`, taskId, operationId, confirmed: true, outcomeUnconfirmed: false, phase, reconcile } })
        : `assistant-task.${action} confirmed; local ${phase} failed. Read back with ${reconcile}.` };
    });
  } catch (cause) {
    if (cause instanceof PublicDiagnosticError) throw cause;
    const failure = cause instanceof AssistantTaskApiError ? cause : undefined;
    const stateFailure = cause instanceof ClaimStateError ? cause : undefined;
    const loginRequired = cause instanceof ApiError && cause.status === 401 || cause instanceof Error && cause.message === "You are not logged in. Run daynight login to authenticate.";
    const error = { operation: `assistant-task.${action}`, ...(taskId === undefined ? {} : { taskId }), ...(operationId === undefined ? {} : { operationId }), ...(failure?.status === undefined ? {} : { status: failure.status }), ...(failure?.code === undefined ? loginRequired ? { code: "login_required" } : {} : { code: failure.code }), ...(stateFailure === undefined ? {} : { message: stateFailure.message }), confirmed: confirmed || stateFailure?.confirmed === true, outcomeUnconfirmed: failure?.outcomeUnconfirmed ?? stateFailure?.outcomeUnconfirmed ?? false, reconcile };
    const message = json ? JSON.stringify({ error }) : `${error.operation} failed${failure?.code === undefined ? "." : `: ${failure.code}.`}${operationId === undefined ? "" : ` Operation ID: ${operationId}.`}${error.outcomeUnconfirmed ? " Remote outcome is unknown; do not automatically repeat the write." : ""}${stateFailure === undefined ? "" : ` ${terminalText(stateFailure.message)}`} Read back with ${reconcile}.${failure?.status === 401 || loginRequired ? " Run daynight login to authenticate." : ""}`;
    // Transport, filesystem and response failures may contain tokens or request bodies.
    throw new PublicDiagnosticError(message, 1, { cause: new Error("Assistant task operation failed; private diagnostics withheld.") });
  }
};
