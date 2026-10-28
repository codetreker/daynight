import type { CopilotSession, ElicitationResult, ExitPlanModeResult, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { parseInteractionResponse, parseSessionInteraction, type InteractionResponse, type SessionInteraction } from "../../../session/protocol.js";
import { formInteraction, validateResponse } from "./interactions.js";
import { record, string, NativeRpcError } from "./native-rpc.js";
import { limited, nativeEntryId } from "./projection.js";
import type { ProviderEntry, ProviderReceipt } from "./types.js";

type Question = Parameters<NonNullable<SessionConfig["onUserInputRequest"]>>[0];
type QuestionReply = { answer: string; wasFreeform: boolean };
type Elicitation = Parameters<NonNullable<SessionConfig["onElicitationRequest"]>>[0];
type Plan = Parameters<NonNullable<SessionConfig["onExitPlanModeRequest"]>>[0];
type Permission = Parameters<CopilotSession["rpc"]["permissions"]["handlePendingPermissionRequest"]>[0];
type Kind = "permission" | "user_input" | "elicitation" | "exit_plan_mode";
type Callback<T> = { resolve(value: T): void; reject(error: Error): void };
type Pending = {
  nativeId: string; kind: Kind; interaction: SessionInteraction; signature: string;
  owner: string | null | undefined; toolCallId: string | undefined; submitted: boolean;
  sessionDecision: Permission["result"] | undefined;
  question?: Callback<QuestionReply>; elicitation?: Callback<ElicitationResult>; plan?: Callback<ExitPlanModeResult>;
  expected?: unknown; confirmation?: Callback<void>; timer?: NodeJS.Timeout;
};
export type CopilotInteractionOptions = {
  sessionId: string; onTimeline(entry: ProviderEntry): void; onChange(): void;
  permissionRpc(input: Permission): Promise<{ success: boolean }>;
  confirmationTimeoutMs?: number;
};
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const questionSignature = (p: Question): string => canonical([p.question, p.choices ?? [], p.allowFreeform !== false]);
const elicitationSignature = (p: Partial<Elicitation>): string => canonical([p.message, p.mode ?? "form", p.requestedSchema, p.url, p.elicitationSource]);
const planSignature = (p: Plan): string => canonical([p.summary, p.planContent ?? "", p.actions, p.recommendedAction]);
const sessionDecision = (prompt: Record<string, unknown>): Permission["result"] | undefined => {
  if (prompt.managedApprovalRequired === true) return undefined;
  if (prompt.kind === "read") return { kind: "approve-for-session", approval: { kind: "read" } };
  // Path session grants have no corresponding public typed approval receipt to verify.
  if (prompt.kind === "path") return undefined;
  if (prompt.canOfferSessionApproval !== true) return undefined;
  if (prompt.kind === "write") return { kind: "approve-for-session", approval: { kind: "write" } };
  if (prompt.kind === "commands" && Array.isArray(prompt.commandIdentifiers) && prompt.commandIdentifiers.length && prompt.commandIdentifiers.every(v => typeof v === "string"))
    return { kind: "approve-for-session", approval: { kind: "commands", commandIdentifiers: prompt.commandIdentifiers } };
  return undefined;
};
// Validate the schema before the shared mapper so unsupported or malformed constraints cannot disappear.
const checkedForm = (title: string, value: unknown): SessionInteraction => {
  const schema = record(value), properties = record(schema.properties);
  if (!Object.keys(properties).length || Object.keys(properties).length > 64) throw new Error("Unsupported Copilot form fields.");
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(k => typeof k !== "string" || !Object.hasOwn(properties, k)) || new Set(schema.required).size !== schema.required.length)) throw new Error("Invalid Copilot form required fields.");
  for (const [id, raw] of Object.entries(properties)) {
    if (["__proto__", "constructor", "prototype"].includes(id)) throw new Error("Unsupported Copilot form field.");
    const field = record(raw);
    const allowed = ["type", "title", "description", ...(field.type === "string" ? ["enum", "enumNames"] : field.type === "number" ? ["minimum", "maximum"] : field.type === "array" ? ["items"] : [])];
    if (Object.keys(field).some(k => !allowed.includes(k))) throw new Error("Unsupported Copilot form constraint.");
    for (const key of ["title", "description"]) if (field[key] !== undefined && typeof field[key] !== "string") throw new Error("Invalid Copilot form label.");
    if (field.enum !== undefined && (!Array.isArray(field.enum) || !field.enum.length || field.enum.some(v => typeof v !== "string") || new Set(field.enum).size !== field.enum.length)) throw new Error("Invalid Copilot form enum.");
    if (field.enumNames !== undefined && (!Array.isArray(field.enumNames) || !Array.isArray(field.enum) || field.enumNames.length !== field.enum.length || field.enumNames.some(v => typeof v !== "string"))) throw new Error("Invalid Copilot enum labels.");
    for (const key of ["minimum", "maximum"]) if (field[key] !== undefined && (typeof field[key] !== "number" || !Number.isFinite(field[key]))) throw new Error("Invalid Copilot numeric bound.");
    if (typeof field.minimum === "number" && typeof field.maximum === "number" && field.minimum > field.maximum) throw new Error("Invalid Copilot numeric bounds.");
  }
  return formInteraction(title, schema);
};

/** SDK callbacks carry no request ID; only an unambiguous full payload can bind them to a native event. */
export class CopilotInteractions {
  private readonly pending = new Map<string, Pending>();
  private readonly history = new Map<string, { kind: Kind; interaction: SessionInteraction }>();
  private readonly seen = new Set<string>();
  private readonly tools = new Map<string, string | undefined>();
  private closed = false;
  constructor(private readonly options: CopilotInteractionOptions) {}
  get waiting(): boolean { return this.pending.size > 0; }
  get pendingIds(): readonly string[] { return [...this.pending.keys()]; }
  onPermissionRequest(): { kind: "no-result" } { return { kind: "no-result" }; }
  private publish(interaction: SessionInteraction): void { this.options.onTimeline({ entryId: interaction.interactionId, revision: interaction.revision, kind: "interaction", interaction }); }
  private error(message: string, id = "unsupported"): Error {
    this.options.onTimeline({ entryId: nativeEntryId(this.options.sessionId, `interaction-error:${id}`), revision: "1", kind: "error", code: "copilot_interaction_unsupported", message });
    return new Error(message);
  }
  accept(event: SessionEvent, history = false): void {
    if (this.closed) return;
    if (event.type === "tool.execution_start" && !history) {
      const owner = event.agentId ?? event.data.parentToolCallId;
      this.tools.set(event.data.toolCallId, owner);
      for (const p of this.pending.values()) if (p.owner === null && p.toolCallId === event.data.toolCallId) p.owner = owner;
      return;
    }
    if (event.type === "abort" && !history) { this.cancelOwner(event.agentId); return; }
    const match = /^(permission|user_input|elicitation|exit_plan_mode)\.(requested|completed)$/.exec(event.type);
    if (!match) return;
    const kind = match[1] as Kind, data = record(event.data), nativeId = string(data.requestId);
    if (!nativeId) { this.error("Copilot interaction has no native request identity."); return; }
    if (history && this.seen.has(nativeId)) return;
    if (match[2] === "completed") {
      if (history) {
        const previous = this.history.get(nativeId);
        if (previous?.kind === kind) { this.history.delete(nativeId); this.publish({ ...previous.interaction, state: "resolved", revision: "2" }); }
        return;
      }
      const p = this.pending.get(nativeId);
      if (!p || p.kind !== kind) return;
      let outcome: unknown = kind === "permission" ? /^(approved(?:-for-session|-for-location)?|denied-[\w-]+)$/.test(string(record(data.result).kind)) ? data.result : undefined
        : kind === "user_input" ? typeof data.answer === "string" ? { answer: data.answer, wasFreeform: data.wasFreeform === true } : undefined
        : kind === "exit_plan_mode" ? typeof data.approved === "boolean" ? { approved: data.approved, ...(typeof data.selectedAction === "string" ? { selectedAction: data.selectedAction } : {}), ...(typeof data.feedback === "string" ? { feedback: data.feedback } : {}) } : undefined
        : data.action === "accept" || data.action === "decline" || data.action === "cancel" ? { action: data.action, ...(data.action === "accept" ? { content: data.content ?? {} } : {}) } : undefined;
      if (kind === "exit_plan_mode" && data.approved === true) {
        const action = p.interaction.kind === "form" ? p.interaction.fields.find(field => field.fieldId === "action") : undefined;
        if (action?.type !== "select" || !["exit_only", "interactive"].includes(string(data.selectedAction)) || !action.options.some(option => option.id === data.selectedAction)) outcome = undefined;
      }
      if (kind === "exit_plan_mode" && data.autoApproveEdits === true) outcome = undefined;
      const confirmed = outcome !== undefined && (!p.submitted || canonical(outcome) === canonical(p.expected));
      if (kind === "user_input" && outcome !== undefined) p.question?.resolve(outcome as QuestionReply);
      if (kind === "elicitation" && outcome !== undefined) p.elicitation?.resolve(outcome as ElicitationResult);
      if (kind === "exit_plan_mode" && outcome !== undefined) p.plan?.resolve(outcome as ExitPlanModeResult);
      this.retire(p, confirmed ? "resolved" : "expired", confirmed ? undefined : new Error("Native Copilot interaction did not confirm the submitted response."));
      return;
    }
    if (kind === "permission" && data.resolvedByHook === true) return;
    if (!history && this.seen.has(nativeId)) return;
    try {
      let interaction: SessionInteraction, signature = "", grant: Permission["result"] | undefined;
      const base = { interactionId: nativeEntryId(this.options.sessionId, `interaction:${nativeId}`), revision: "1", state: "pending" as const };
      if (kind === "permission") {
        const prompt = record(data.promptRequest); grant = sessionDecision(prompt);
        interaction = { ...base, kind: "approval", title: string(prompt.intention) || "Copilot permission", detail: JSON.stringify({ permission: data.permissionRequest, prompt: data.promptRequest }, null, 2), actions: grant ? ["allow_once", "allow_session", "reject"] : ["allow_once", "reject"] };
      } else if (kind === "user_input") {
        const q = data as unknown as Question; signature = questionSignature(q);
        interaction = { ...base, kind: "question", title: "Copilot question", canDismiss: false, questions: [{ questionId: "answer", label: q.question, options: (q.choices ?? []).map(v => ({ id: v, label: v })), multiple: false, allowCustom: q.allowFreeform !== false, required: true, sensitive: false }] };
      } else if (kind === "exit_plan_mode") {
        const plan = data as unknown as Plan;
        if (typeof plan.summary !== "string" || !plan.summary.trim() || !Array.isArray(plan.actions) || plan.actions.some(action => typeof action !== "string") || typeof plan.recommendedAction !== "string" || plan.planContent !== undefined && typeof plan.planContent !== "string") throw new Error("Invalid Copilot plan approval request.");
        signature = planSignature(plan);
        const actions = [
          ...(plan.actions.includes("exit_only") ? [{ id: "exit_only", label: "Approve plan" }] : []),
          ...(plan.actions.includes("interactive") ? [{ id: "interactive", label: "Approve and continue" }] : []),
          { id: "reject", label: "Reject plan" },
        ];
        interaction = { ...base, kind: "form", title: "Copilot plan approval", canDismiss: true, fields: [
          { fieldId: "action", label: "Decision", type: "select", required: true, options: actions },
          { fieldId: "feedback", label: "Feedback", type: "text", required: false, sensitive: false },
        ] };
        this.options.onTimeline({ entryId: nativeEntryId(this.options.sessionId, `plan:${nativeId}`), revision: "1", kind: "assistant_message", content: [{ type: "text", text: limited(plan.planContent || plan.summary) }] });
      } else {
        if (data.mode !== undefined && data.mode !== "form") throw new Error("Copilot URL elicitation is unsupported by this Session protocol.");
        if (typeof data.message !== "string" || !data.message.trim()) throw new Error("Copilot elicitation requires a message.");
        signature = elicitationSignature(data);
        interaction = { ...checkedForm(data.message, data.requestedSchema), ...base };
      }
      interaction = parseSessionInteraction(interaction);
      if (history) { this.history.set(nativeId, { kind, interaction }); this.publish({ ...interaction, state: "expired" }); return; }
      const toolCallId = string(data.toolCallId ?? record(data.promptRequest).toolCallId ?? record(data.permissionRequest).toolCallId) || undefined;
      const owner = event.agentId ?? (toolCallId ? this.tools.has(toolCallId) ? this.tools.get(toolCallId) : null : undefined);
      this.seen.add(nativeId);
      this.pending.set(nativeId, { nativeId, kind, interaction, signature, owner, toolCallId, submitted: false, sessionDecision: grant });
      this.publish(interaction); this.options.onChange();
    } catch (error) { this.error(error instanceof Error ? error.message : "Unsupported Copilot interaction.", nativeId); }
  }
  async bindQuestion(payload: Question): Promise<QuestionReply> {
    return this.bind("user_input", questionSignature(payload), "question");
  }
  async bindElicitation(payload: Elicitation): Promise<ElicitationResult> {
    // The SDK starts the callback before emitting the identity-bearing notification in the same dispatch.
    await Promise.resolve();
    if (payload.sessionId !== this.options.sessionId) throw this.error("Copilot elicitation belongs to another native session.");
    return this.bind("elicitation", elicitationSignature(payload), "elicitation");
  }
  async bindPlan(payload: Plan): Promise<ExitPlanModeResult> { return this.bind("exit_plan_mode", planSignature(payload), "plan"); }
  private bind(kind: "user_input", signature: string, callback: "question"): Promise<QuestionReply>;
  private bind(kind: "elicitation", signature: string, callback: "elicitation"): Promise<ElicitationResult>;
  private bind(kind: "exit_plan_mode", signature: string, callback: "plan"): Promise<ExitPlanModeResult>;
  private bind(kind: Kind, signature: string, callback: "question" | "elicitation" | "plan"): Promise<QuestionReply | ElicitationResult | ExitPlanModeResult> {
    const matches = [...this.pending.values()].filter(p => p.kind === kind && p.signature === signature);
    if (this.closed || matches.length !== 1 || matches[0]![callback]) {
      const error = this.error("Copilot callback has no unique native request identity.");
      if (matches.length > 1) for (const p of matches) this.retire(p, "expired", error);
      return Promise.reject(error);
    }
    const p = matches[0]!;
    return callback === "question" ? new Promise<QuestionReply>((resolve, reject) => { p.question = { resolve, reject }; })
      : callback === "elicitation" ? new Promise<ElicitationResult>((resolve, reject) => { p.elicitation = { resolve, reject }; })
      : new Promise<ExitPlanModeResult>((resolve, reject) => { p.plan = { resolve, reject }; });
  }
  private retire(p: Pending, state: "resolved" | "expired", error?: Error): void {
    this.pending.delete(p.nativeId); if (p.timer) clearTimeout(p.timer);
    const ended = error ?? new Error("Native Copilot interaction is no longer pending.");
    p.question?.reject(ended); p.elicitation?.reject(ended); p.plan?.reject(ended);
    if (error || state === "expired") p.confirmation?.reject(ended); else p.confirmation?.resolve();
    this.publish({ ...p.interaction, state, revision: "2" }); this.options.onChange();
  }
  cancelOwner(owner?: string | null): void { for (const p of this.pending.values()) if (p.owner === owner) this.retire(p, "expired", new Error("Native Copilot interaction was aborted.")); }
  dispose(error = new Error("Native Copilot interactions closed.")): void { this.closed = true; for (const p of this.pending.values()) this.retire(p, "expired", error); this.history.clear(); this.tools.clear(); }
  async respond(id: string, revision: string, input: InteractionResponse): Promise<ProviderReceipt> {
    const p = [...this.pending.values()].find(p => p.interaction.interactionId === id);
    if (!p || p.submitted || p.interaction.revision !== revision || this.closed) throw new NativeRpcError(-32602, "Native Copilot interaction is stale or already submitted.");
    const response = parseInteractionResponse(input); validateResponse(p.interaction, response);
    if (p.kind === "user_input" && !p.question || p.kind === "elicitation" && !p.elicitation || p.kind === "exit_plan_mode" && !p.plan) throw new NativeRpcError(-32602, "Native Copilot callback is not available.");
    let reply: QuestionReply | ElicitationResult | ExitPlanModeResult | undefined, decision: Permission["result"] | undefined;
    if (response.kind === "approval") {
      decision = response.action === "reject" ? { kind: "reject" } : response.action === "allow_session" ? p.sessionDecision : { kind: "approve-once", approvedInteractively: true };
      if (!decision) throw new NativeRpcError(-32602, "Native session approval is not available.");
      p.expected = response.action === "reject" ? { kind: "denied-interactively-by-user" } : response.action === "allow_once" ? { kind: "approved" }
        : { kind: "approved-for-session", ...(decision.kind === "approve-for-session" ? { approval: decision.approval } : {}) };
    } else if (response.kind === "question") {
      const answer = response.answers[0]!;
      if (answer.text !== null && answer.optionIds.length || answer.optionIds.length + (answer.text !== null ? 1 : 0) !== 1) throw new NativeRpcError(-32602, "Copilot requires one unambiguous question answer.");
      reply = { answer: answer.text ?? answer.optionIds[0]!, wasFreeform: answer.text !== null }; p.expected = reply;
    } else if (p.kind === "exit_plan_mode") {
      const values = response.kind === "form" ? response.values : [];
      const action = values.find(v => v.fieldId === "action")?.value;
      const feedback = values.find(v => v.fieldId === "feedback")?.value;
      reply = { approved: action === "exit_only" || action === "interactive", ...(action === "exit_only" || action === "interactive" ? { selectedAction: action } : {}), ...(typeof feedback === "string" && feedback ? { feedback } : {}) };
      p.expected = reply;
    } else {
      reply = response.kind === "dismiss" ? { action: "cancel" } : { action: "accept", content: Object.fromEntries(response.values.map(v => [v.fieldId, typeof v.value === "object" ? [...v.value] : v.value])) };
      p.expected = reply;
    }
    p.submitted = true;
    const confirmation = new Promise<void>((resolve, reject) => { p.confirmation = { resolve, reject }; });
    // Attach rejection handling before dispatch, which may synchronously deliver completion.
    const result = confirmation.then((): ProviderReceipt => ({ disposition: "handled" }));
    p.timer = setTimeout(() => { p.confirmation?.reject(new Error("Native Copilot interaction result is unknown.")); }, this.options.confirmationTimeoutMs ?? 30_000);
    if (decision) {
      const failed = (error: unknown) => { if (p.timer) clearTimeout(p.timer); p.confirmation?.reject(error instanceof Error ? error : new Error(String(error))); };
      try {
        void this.options.permissionRpc({ requestId: p.nativeId, result: decision }).then(ack => {
          if (!ack.success) failed(new Error("Copilot did not accept the permission response; result is unknown."));
        }, failed);
      } catch (error) { failed(error); }
    } else if (p.kind === "user_input") p.question!.resolve(reply as QuestionReply);
    else if (p.kind === "exit_plan_mode") p.plan!.resolve(reply as ExitPlanModeResult);
    else p.elicitation!.resolve(reply as ElicitationResult);
    return result;
  }
}
