import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "../../api/client.js";
import { stringifyApiJson } from "../../api/json.js";
import { canonicalId } from "../../api/parse.js";
import { parseWebhookCatalog, parseWebhookDelivery, parseWebhookEndpoint, parseWebhookEndpointPage, parseWebhookAttempt, parseWebhookHistoryPage, parseWebhookMutation, parseWebhookPayload, parseWebhookReceipt, parseWebhookSecret } from "../../api/webhook.js";
import type { WebhookOwner } from "../../api/webhook.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { confirmTeamChange } from "../team/confirmation.js";
import { runServerCommand } from "../server/runtime.js";
import { webhookDefinition } from "./definition.js";
import { parseWebhookInput, readWebhookInput } from "./input.js";
import { PayloadCleanupError, publishPayload, readPrepared, writePrepared } from "./files.js";
import type { PreparedOperation } from "./files.js";

const int64 = (value: string): boolean => /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
const utc = (value: string): boolean => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0, 19) === value.slice(0, 19);
const eventTypes = new Set(["task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"]);
const states = new Set(["pending", "leased", "delivered", "failed", "suppressed"]);
type Phase = "input" | "auth" | "confirm" | "prepare" | "read" | "submit" | "reconcile" | "output";
type Outcome = "not_submitted" | "rejected" | "unknown" | "confirmed" | "read_failed";
type Receipt = ReturnType<typeof parseWebhookReceipt>;
class ExpiredReceiptError extends Error {
  constructor() { super("The operation receipt has expired."); }
}
const requireCurrentReceipt = (receipt: Receipt): Receipt => {
  if (Date.parse(receipt.expiresAt) <= Date.now()) throw new ExpiredReceiptError();
  return receipt;
};

const safeHuman = (value: unknown, reveal = false): unknown => {
  if (Array.isArray(value)) return value.map((v) => safeHuman(v, reveal));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "displayUrl" && typeof item === "string") {
      try { return [key, `${new URL(item).origin}/…`]; } catch { return [key, "[redacted]"]; }
    }
    return [key, key === "url" || key === "body" || key === "secret" && !reveal ? "[redacted]" : safeHuman(item, reveal)];
  }));
};
const render = (value: unknown, json: boolean, reveal = false): string => {
  const output = `${JSON.stringify(json ? value : safeHuman(value, reveal), null, json ? undefined : 2)}\n`;
  if (Buffer.byteLength(output) > 1_048_576) throw new Error("Webhook output exceeds 1 MiB.");
  return output;
};
const sameReceipt = (receipt: Receipt, prepared: PreparedOperation): void => {
  if (receipt.operationId !== prepared.operationId || receipt.issuedAt !== prepared.issuedAt || receipt.requestSha256 !== prepared.requestSha256 || receipt.actorUserId !== prepared.actorUserId || receipt.owner.kind !== prepared.owner.kind || receipt.owner.id !== prepared.owner.id || receipt.kind !== prepared.kind || prepared.endpointId !== null && receipt.endpointId !== prepared.endpointId || receipt.deliveryId !== prepared.deliveryId) throw new Error("operation_receipt_mismatch");
  if (prepared.kind !== "endpoint.patch" && receipt.effect !== "applied") throw new Error("operation_receipt_mismatch");
  if (prepared.kind === "endpoint.create" && receipt.destinationRevisionAfter !== "1") throw new Error("operation_receipt_mismatch");
  if (prepared.ifVersion !== null) {
    const before = BigInt(prepared.ifVersion), after = BigInt(receipt.configVersionAfter);
    if (prepared.kind === "delivery.redeliver" ? after !== before : after !== before + (receipt.effect === "unchanged" ? 0n : 1n)) throw new Error("operation_receipt_mismatch");
  } else if (receipt.configVersionAfter !== "1") throw new Error("operation_receipt_mismatch");
  if (prepared.ifGeneration !== null && (receipt.generationAfter === null || BigInt(receipt.generationAfter) !== BigInt(prepared.ifGeneration) + 1n)) throw new Error("operation_receipt_mismatch");
  requireCurrentReceipt(receipt);
};

export const runWebhookCommand = async (args: readonly string[], context: CliContext): Promise<void> => {
  let cmd: ReturnType<typeof parseCommand>;
  try { cmd = parseCommand(webhookDefinition, args, ["daynight", "webhook"], "daynight webhook --help"); }
  catch (error) { if (error instanceof UsageError) throw new UsageError("Invalid webhook command or arguments.", "daynight webhook --help"); throw error; }
  if (cmd.kind !== "run") { context.stdout(renderCommandHelp(cmd.command, cmd.path)); return; }
  const options = cmd.options, action = cmd.path.slice(2).join(" "), json = options.has("--json");
  const usage = (message: string): never => { throw new UsageError(message, `${cmd.path.join(" ")} --help`); };
  const str = (key: string): string | undefined => { const v = options.get(key); return typeof v === "string" ? v : undefined; };
  const uuid = (value: string | undefined, name: string): string => { if (value === undefined || canonicalId(value) !== value) return usage(`${name} must be a canonical UUID.`); return value; };
  const ownerTeam = str("--team");
  if (action !== "catalog" && options.has("--personal") === (ownerTeam !== undefined)) usage("Select exactly one of --personal or --team.");
  if (ownerTeam !== undefined) uuid(ownerTeam, "--team");
  const write = ["create", "update", "enable", "disable", "delete", "subscription replace", "subscription reconfirm", "secret rotate", "delivery redeliver"].includes(action);
  const inputKind = action === "create" ? "create" : action === "update" ? "update" : action === "subscription replace" ? "subscriptions" : undefined;
  if (inputKind !== undefined && options.has("--file") === options.has("--stdin")) usage("Select exactly one of --file or --stdin.");
  if (write && !options.has("--confirm") && (options.has("--stdin") || context.prompt?.isInteractive !== true)) usage("This change requires --confirm or interactive confirmation.");
  const operationIdOption = str("--operation-id"), issuedOption = str("--issued-at"), resume = str("--resume-operation");
  if ((operationIdOption === undefined) !== (issuedOption === undefined)) usage("--operation-id and --issued-at must be supplied together.");
  if (resume !== undefined && (operationIdOption !== undefined || str("--operation-out") !== undefined)) usage("--resume-operation cannot be combined with a new operation identity or --operation-out.");
  if (operationIdOption !== undefined) uuid(operationIdOption, "--operation-id");
  if (issuedOption !== undefined && !utc(issuedOption)) usage("--issued-at must be a UTC RFC3339 timestamp.");
  for (const key of ["--if-version", "--if-generation", "--generation"]) { const value = str(key); if (value !== undefined && !int64(value)) usage(`${key} must be a canonical positive int64.`); }
  const limit = str("--limit"); if (limit !== undefined && (!/^[1-9][0-9]*$/.test(limit) || Number(limit) > 100)) usage("--limit must be between 1 and 100.");
  if (str("--cursor") === "") usage("--cursor must not be empty.");
  if (str("--event-type") !== undefined && !eventTypes.has(str("--event-type")!)) usage("Unknown event type.");
  if (str("--state") !== undefined && !states.has(str("--state")!)) usage("Unknown delivery state.");
  for (const key of ["--from", "--to"]) { const v = str(key); if (v !== undefined && !utc(v)) usage(`${key} must be a UTC RFC3339 timestamp.`); }
  if (str("--from") !== undefined && str("--to") !== undefined && Date.parse(str("--from")!) > Date.parse(str("--to")!)) usage("--from must not be later than --to.");
  const projectOption = options.get("--project");
  const projects = Array.isArray(projectOption) ? [...projectOption] : typeof projectOption === "string" ? [projectOption] : [];
  for (const project of projects) uuid(project, "--project");
  if (new Set(projects).size !== projects.length) usage("Specify each Project only once.");
  if (action === "delivery payload" && options.has("--output") && json) usage("--json and --output are mutually exclusive.");
  const endpoint = action === "operation show" || action === "catalog" || action === "list" || action === "create" ? undefined : uuid(cmd.values[0], "endpoint-id");
  const delivery = ["delivery show", "delivery payload", "delivery redeliver", "attempt list"].includes(action) ? uuid(cmd.values[1], "delivery-id") : undefined;
  const lookup = action === "operation show" ? uuid(cmd.values[0], "operation-id") : undefined;

  let phase: Phase = "auth", invocation: Outcome = write ? "not_submitted" : "read_failed", operationOutcome: "unknown" | "confirmed" | "rejected" | null = resume === undefined ? null : "unknown";
  let prepared: PreparedOperation | null = null;
  let requestId: string | null = null;
  let reconcileCommand: string | null = null;
  let code = "webhook_error";
  const diagnostic = (message: string): string => json ? JSON.stringify({ error: { code, message, phase, requestId, invocationOutcome: invocation, operationOutcome, operation: prepared === null ? null : (({ formatVersion: _formatVersion, ...binding }) => binding)(prepared), reconcileCommand } }) : `${message}${prepared === null ? "" : ` (operationId=${prepared.operationId})`}${reconcileCommand === null ? "" : `; ${reconcileCommand}`}`;
  try {
    await runServerCommand(context, async ({ api, operation, serverUrl }) => {
      const actor = (await api.getCurrentUser(true)).id;
      const owner: WebhookOwner = ownerTeam === undefined ? { kind: "personal", id: actor } : { kind: "team", id: ownerTeam };
      const base = owner.kind === "personal" ? "/me/webhooks" : `/teams/${owner.id}/webhooks`;
      const get = <T>(path: string, parse: (value: unknown) => T): Promise<T> => api.webhookRequest({ userId: actor, path, method: "GET", parse });
      const query = (names: readonly (readonly [string, string])[], defaults = false): string => {
        const params = new URLSearchParams();
        for (const [option, name] of names) { const value = str(option); if (value !== undefined) params.set(name, value); }
        if (defaults && !params.has("limit")) params.set("limit", "50");
        const suffix = params.toString(); return suffix === "" ? "" : `?${suffix}`;
      };
      if (!write) {
        phase = "read";
        let result: unknown;
        if (action === "catalog") result = await get("/webhook-event-types", parseWebhookCatalog);
        else if (action === "list") {
          const items: ReturnType<typeof parseWebhookEndpointPage>["items"][number][] = [], ids = new Set<string>(), cursors = new Set<string>();
          let cursor: string | null = null;
          do {
            const params = new URLSearchParams(); if (str("--query") !== undefined) params.set("q", str("--query")!); if (str("--enabled") !== undefined) params.set("enabled", str("--enabled")!); if (cursor !== null) params.set("cursor", cursor);
            const page = await get(`${base}${params.size ? `?${params}` : ""}`, (v) => parseWebhookEndpointPage(v, owner));
            for (const item of page.items) { if (ids.has(item.id)) throw new Error("Duplicate endpoint in pagination."); ids.add(item.id); items.push(item); }
            if (Buffer.byteLength(JSON.stringify({ items })) > 1_048_576) throw new Error("Webhook list exceeds 1 MiB.");
            cursor = page.nextCursor; if (cursor !== null) { if (cursors.has(cursor)) throw new Error("Repeated endpoint cursor."); cursors.add(cursor); }
          } while (cursor !== null);
          result = { items };
        } else if (action === "operation show") result = requireCurrentReceipt(await get(`${base}/operations/${lookup}`, (v) => parseWebhookReceipt(v, owner, lookup)));
        else if (action === "show" || action === "subscription list" || action === "secret show" && !options.has("--reveal")) {
          const view = await get(`${base}/${endpoint}`, (v) => parseWebhookEndpoint(v, owner, endpoint));
          if (action === "show") result = view;
          else { if (view.lifecycle !== "active") throw new Error("The endpoint is deleted."); result = action === "subscription list" ? { endpointId: view.id, owner: view.owner, configVersion: view.configVersion, subscriptions: view.subscriptions } : { endpointId: view.id, configVersion: view.configVersion, signing: view.signing }; }
        } else if (action === "secret show") result = await get(`${base}/${endpoint}/signing-secret`, (v) => parseWebhookSecret(v, endpoint!));
        else if (action === "delivery list") result = await get(`${base}/${endpoint}/deliveries${query([["--event-type", "eventType"], ["--state", "state"], ["--project", "projectId"], ["--from", "from"], ["--to", "to"], ["--limit", "limit"], ["--cursor", "cursor"]], true)}`, (v) => parseWebhookHistoryPage(v, (item) => parseWebhookDelivery(item, owner, endpoint!)));
        else if (action === "delivery show") result = await get(`${base}/${endpoint}/deliveries/${delivery}`, (v) => parseWebhookDelivery(v, owner, endpoint!, delivery));
        else if (action === "attempt list") result = await get(`${base}/${endpoint}/deliveries/${delivery}/attempts${query([["--generation", "generation"], ["--limit", "limit"], ["--cursor", "cursor"]], true)}`, (v) => parseWebhookHistoryPage(v, (item) => parseWebhookAttempt(item, endpoint!, delivery!)));
        else if (action === "delivery payload") {
          const payload = await get(`${base}/${endpoint}/deliveries/${delivery}/payload`, (v) => parseWebhookPayload(v, owner, endpoint!, delivery!));
          phase = "output";
          if (json) { await context.stdoutBytes(Buffer.from(render(payload, true)), operation.signal); return; }
          const bytes = Buffer.from(payload.body, "base64");
          if (str("--output") !== undefined) await publishPayload(str("--output")!, bytes, operation.signal);
          else await context.stdoutBytes(bytes, operation.signal);
          return;
        } else throw new Error("Unsupported webhook command.");
        phase = "output";
        await context.stdoutBytes(Buffer.from(render(result, json, action === "secret show" && options.has("--reveal"))), operation.signal);
        return;
      }
      phase = "input";
      let editable: Record<string, unknown> = {};
      if (inputKind !== undefined) {
        const input = parseWebhookInput(await readWebhookInput(str("--file"), operation.signal), inputKind);
        editable = inputKind === "subscriptions" ? { subscriptions: input } : input as Record<string, unknown>;
      } else if (action === "enable" || action === "disable") editable = { enabled: action === "enable" };
      else if (action === "subscription reconfirm") editable = { confirmProjectIds: projects };
      else if (action === "secret rotate") editable = { mode: str("--mode") };
      const kind = action === "create" ? "endpoint.create" : action === "delete" ? "endpoint.delete" : action === "secret rotate" ? "signing-secret.rotate" : action === "delivery redeliver" ? "delivery.redeliver" : "endpoint.patch";
      const method = action === "create" || action === "secret rotate" || action === "delivery redeliver" ? "POST" : action === "delete" ? "DELETE" : "PATCH";
      const path = action === "create" ? base : action === "secret rotate" ? `${base}/${endpoint}/signing-secret/rotations` : action === "delivery redeliver" ? `${base}/${endpoint}/deliveries/${delivery}/redeliveries` : `${base}/${endpoint}`;
      phase = "confirm";
      if (resume === undefined) await confirmTeamChange(context, options.has("--confirm"), `Confirm ${kind} for ${owner.kind} ${owner.id}${endpoint === undefined ? "" : ` endpoint ${endpoint}`}${str("--if-version") === undefined ? "" : ` version ${str("--if-version")}`}?`, operation.signal, undefined, "Webhook change");
      phase = "prepare";
      let prior: PreparedOperation | undefined;
      if (resume !== undefined) {
        prior = await readPrepared(resume, operation.signal);
        prepared = prior;
        reconcileCommand = `daynight webhook operation show ${prior.operationId} ${prior.owner.kind === "personal" ? "--personal" : `--team ${prior.owner.id}`}`;
      }
      const operationId = prior?.operationId ?? operationIdOption ?? randomUUID(), issuedAt = prior?.issuedAt ?? issuedOption ?? new Date().toISOString();
      if (canonicalId(operationId) !== operationId || !utc(issuedAt)) throw new Error("Invalid prepared operation identity.");
      const body = { operationId, issuedAt, expectedUserId: actor, ...(str("--if-version") === undefined ? {} : { ifVersion: str("--if-version") }), ...(str("--if-generation") === undefined ? {} : { ifGeneration: str("--if-generation") }), ...editable };
      const serialized = stringifyApiJson(body); if (Buffer.byteLength(serialized) > 262_144) throw new Error("Webhook request exceeds 256 KiB.");
      const current: PreparedOperation = { formatVersion: 1, serverOrigin: serverUrl, actorUserId: actor, owner, kind, operationId, issuedAt, endpointId: endpoint ?? null, deliveryId: delivery ?? null, ifVersion: str("--if-version") ?? null, ifGeneration: str("--if-generation") ?? null, requestSha256: createHash("sha256").update(serialized).digest("hex") };
      operationOutcome = prior === undefined ? null : "unknown";
      if (prior !== undefined) {
        const expected = current;
        const actual = prior as unknown as Record<string, unknown>;
        const keys = Object.keys(expected);
        if (Object.keys(actual).length !== keys.length || keys.some((key) => key === "owner"
          ? typeof actual.owner !== "object" || actual.owner === null || Array.isArray(actual.owner) || Object.keys(actual.owner).length !== 2 || (actual.owner as WebhookOwner).kind !== expected.owner.kind || (actual.owner as WebhookOwner).id !== expected.owner.id
          : actual[key] !== expected[key as keyof PreparedOperation])) { code = "operation_receipt_mismatch"; throw new Error("Prepared operation does not match this request."); }
      }
      prepared = current;
      reconcileCommand = `daynight webhook operation show ${operationId} ${owner.kind === "personal" ? "--personal" : `--team ${owner.id}`}`;
      if (str("--operation-out") !== undefined) await writePrepared(str("--operation-out")!, prepared, operation.signal);
      const receipt = async (): Promise<Receipt> => { const found = await get(`${base}/operations/${operationId}`, (v) => parseWebhookReceipt(v, owner, operationId)); sameReceipt(found, prepared!); return found; };
      const confirmedOutput = (value: unknown) => {
        invocation = "confirmed"; operationOutcome = "confirmed"; phase = "output";
        const rendered = render(value, json);
        const output = !json && action === "delivery redeliver" ? `Redelivery registered.
${rendered}` : rendered;
        if (Buffer.byteLength(output) > 1_048_576) throw new Error("Webhook output exceeds 1 MiB.");
        return { kind: "confirmed-mutation" as const, output, containsSecret: true, failureText: () => { code = "output_failed"; phase = "output"; return diagnostic("The operation was confirmed, but local output failed."); } };
      };
      if (prior !== undefined) {
        phase = "reconcile";
        try { return confirmedOutput({ operation: await receipt() }); }
        catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404 || error.phase !== "response" || !error.confirmedRefusal || error.code !== "not_found") throw error;
          const delta = Date.now() - Date.parse(issuedAt);
          if (delta > 300_000 || delta < -60_000 || !options.has("--confirm")) throw new Error("Original operation cannot be resumed within its admission window without --confirm.");
        }
      }
      phase = "submit";
      operationOutcome = "unknown";
      try {
        const response = await api.webhookRequest({ userId: actor, path, method, body, statuses: action === "create" ? [200, 201] : action === "delivery redeliver" ? [202] : [200], confirmedOperationId: operationId, parse: (value) => {
          const result = parseWebhookMutation(value, owner, action === "secret rotate" ? "signing" : action === "delivery redeliver" ? "delivery" : "endpoint", operationId, endpoint, delivery);
          sameReceipt(result.operation, prepared!);
          if ("endpoint" in result && BigInt(result.endpoint.configVersion) < BigInt(result.operation.configVersionAfter) || "delivery" in result && BigInt(result.delivery.generation) < BigInt(result.operation.generationAfter!)) throw new Error("operation_receipt_mismatch");
          return result;
        } });
        return confirmedOutput(response);
      } catch (error) {
        if ((operationOutcome as string | null) === "confirmed") { phase = "output"; throw error; }
        if (error instanceof ApiError && error.confirmedMutationId === operationId) { invocation = "confirmed"; operationOutcome = "confirmed"; phase = "output"; throw error; }
        if (error instanceof ApiError && !error.outcomeUnconfirmed && !error.confirmedRefusal && (error.phase === "prepare" || error.phase === "request")) { invocation = "not_submitted"; operationOutcome = prior === undefined ? null : "unknown"; throw error; }
        if (error instanceof ApiError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408 && error.code !== "write_outcome_unknown" && error.phase === "response") { invocation = "rejected"; operationOutcome = error.code === "operation_conflict" || prior !== undefined ? "unknown" : "rejected"; throw error; }
        invocation = "unknown"; operationOutcome = "unknown"; phase = "reconcile";
        try { return confirmedOutput({ operation: await receipt() }); }
        catch (reconcileError) { if (reconcileError instanceof ExpiredReceiptError || reconcileError instanceof Error && reconcileError.message === "operation_receipt_mismatch") throw reconcileError; throw error; }
      }
    }, { operationLimits: { responseBytes: 1_048_576, totalBytes: 268_435_456 } });
  } catch (error) {
    if (error instanceof PublicDiagnosticError) throw error;
    if (error instanceof ApiError) { requestId = error.requestId ?? null; if (error.code !== undefined) code = error.code; }
    if (error instanceof ExpiredReceiptError) code = "operation_expired";
    if (error instanceof Error && error.message === "operation_receipt_mismatch") code = "operation_receipt_mismatch";
    if ((phase as Phase) === "output" && (operationOutcome as string | null) === "confirmed") { invocation = "confirmed"; code = "output_failed"; }
    const message = error instanceof PayloadCleanupError ? `Could not remove temporary payload file ${JSON.stringify(error.path)}.` : (operationOutcome as string | null) === "confirmed" ? "The operation was confirmed, but local output failed." : (invocation as Outcome) === "unknown" || resume !== undefined ? "The original operation outcome remains unknown." : "Webhook command failed.";
    throw new PublicDiagnosticError(diagnostic(message), 1, {});
  }
};
