import { afterEach, expect, test, vi } from "vitest";
import type { SessionEvent } from "@github/copilot-sdk";
import type { ProviderEntry } from "../../../src/commands/controller/providers/types.js";
import { CopilotInteractions, type CopilotInteractionOptions } from "../../../src/commands/controller/providers/copilot-interactions.js";

const event = (type: string, data: object, agentId?: string): SessionEvent => ({ type, data, ...(agentId ? { agentId } : {}) }) as SessionEvent;
const created: CopilotInteractions[] = [];
afterEach(() => { for (const interactions of created.splice(0)) interactions.dispose(); vi.useRealTimers(); });
const setup = (permissionRpc?: CopilotInteractionOptions["permissionRpc"]) => {
  const entries: ProviderEntry[] = [], requests: unknown[] = [];
  const onChange = vi.fn();
  const interactions = new CopilotInteractions({ sessionId: "native-session", onTimeline: entry => entries.push(entry), onChange,
    permissionRpc: permissionRpc ?? (async input => { requests.push(input); return { success: true }; }), confirmationTimeoutMs: 100 });
  created.push(interactions);
  const pending = () => entries.filter(e => e.kind === "interaction" && e.interaction.state === "pending").map(e => e.kind === "interaction" ? e.interaction : never());
  return { interactions, entries, requests, pending, onChange };
};
const never = (): never => { throw new Error("Unreachable"); };
const permission = (id: string, prompt: object = { kind: "read" }) => event("permission.requested", { requestId: id, permissionRequest: { kind: "read", toolCallId: "tool" }, promptRequest: prompt });
const question = (id: string, data = { question: "Choose", choices: ["a", "b"], allowFreeform: false }, agentId?: string) => event("user_input.requested", { requestId: id, ...data }, agentId);
const schema = { type: "object" as const, properties: { count: { type: "number" as const, minimum: 1, maximum: 3 } }, required: ["count"] };
const form = { sessionId: "native-session", message: "Count", mode: "form" as const, requestedSchema: schema, elicitationSource: "mcp" };

test("permission RPC acknowledgement cannot resolve approval before matching native completion", async () => {
  const s = setup(); expect(s.interactions.onPermissionRequest()).toEqual({ kind: "no-result" });
  s.interactions.accept(permission("p1")); const p = s.pending()[0]!;
  let handled = false; const response = s.interactions.respond(p.interactionId, "1", { kind: "approval", action: "allow_once" }).then(value => { handled = true; return value; });
  await Promise.resolve(); expect(handled).toBe(false); expect(s.interactions.waiting).toBe(true);
  expect(s.requests).toEqual([{ requestId: "p1", result: { kind: "approve-once", approvedInteractively: true } }]);
  s.interactions.accept(event("user_input.completed", { requestId: "p1", answer: "a" }));
  s.interactions.accept(event("permission.completed", { requestId: "other", result: { kind: "approved" } }));
  expect(handled).toBe(false);
  s.interactions.accept(event("permission.completed", { requestId: "p1", result: { kind: "approved" } }));
  await expect(response).resolves.toEqual({ disposition: "handled" }); expect(s.interactions.waiting).toBe(false); expect(s.onChange).toHaveBeenCalled();
});

test("managed permission cannot acquire a session grant and native reject cannot confirm approval", async () => {
  const s = setup(); s.interactions.accept(permission("p", { kind: "read", managedApprovalRequired: true })); const p = s.pending()[0]!;
  await expect(s.interactions.respond(p.interactionId, "1", { kind: "approval", action: "allow_session" })).rejects.toThrow();
  const response = s.interactions.respond(p.interactionId, "1", { kind: "approval", action: "allow_once" });
  const assertion = expect(response).rejects.toThrow();
  s.interactions.accept(event("permission.completed", { requestId: "p", result: { kind: "denied" } })); await assertion;
  const terminal = s.entries.at(-1); expect(terminal?.kind === "interaction" && terminal.interaction.state).toBe("expired");
});

test("question callback resolves native input but stays pending until same request completes", async () => {
  const s = setup(); s.interactions.accept(question("q"));
  const callback = s.interactions.bindQuestion({ question: "Choose", choices: ["a", "b"], allowFreeform: false }); const p = s.pending()[0]!;
  const response = s.interactions.respond(p.interactionId, "1", { kind: "question", answers: [{ questionId: "answer", optionIds: ["b"], text: null }] });
  await expect(callback).resolves.toEqual({ answer: "b", wasFreeform: false }); expect(s.interactions.waiting).toBe(true);
  await expect(s.interactions.respond(p.interactionId, "1", { kind: "question", answers: [{ questionId: "answer", optionIds: ["a"], text: null }] })).rejects.toThrow();
  s.interactions.accept(event("user_input.completed", { requestId: "q", answer: "b", wasFreeform: false })); await expect(response).resolves.toEqual({ disposition: "handled" });
});

test("identical concurrent questions reject ambiguous callback identity visibly", async () => {
  const s = setup(); s.interactions.accept(question("q1", undefined, "one")); s.interactions.accept(question("q2", undefined, "two"));
  await expect(s.interactions.bindQuestion({ question: "Choose", choices: ["a", "b"], allowFreeform: false })).rejects.toThrow(/unique/);
  expect(s.entries.some(e => e.kind === "error")).toBe(true);
});

test("question signature distinguishes choice and freeform constraints", async () => {
  const s = setup(); s.interactions.accept(question("q"));
  await expect(s.interactions.bindQuestion({ question: "Choose", choices: ["a", "b"], allowFreeform: true })).rejects.toThrow(/unique/);
});

test("elicitation callback arriving before event binds full signature and waits for completion", async () => {
  const s = setup(); const callback = s.interactions.bindElicitation(form);
  s.interactions.accept(event("elicitation.requested", { ...form, requestId: "f" })); await Promise.resolve(); const p = s.pending()[0]!;
  await expect(s.interactions.respond(p.interactionId, "1", { kind: "form", values: [{ fieldId: "count", value: 9 }] })).rejects.toThrow();
  const response = s.interactions.respond(p.interactionId, "1", { kind: "form", values: [{ fieldId: "count", value: 2 }] });
  await expect(callback).resolves.toEqual({ action: "accept", content: { count: 2 } }); expect(s.interactions.waiting).toBe(true);
  s.interactions.accept(event("elicitation.completed", { requestId: "f", action: "accept", content: { count: 2 } })); await expect(response).resolves.toEqual({ disposition: "handled" });
});

test.each([
  { ...form, mode: "url", url: "https://example.com" },
  { ...form, requestedSchema: { ...schema, properties: { name: { type: "string", minLength: 2 } } } },
  { ...form, requestedSchema: { ...schema, required: ["missing"] } },
])("unsupported elicitation is visible and never creates weakened form", async payload => {
  const s = setup(); s.interactions.accept(event("elicitation.requested", { ...payload, requestId: "f" }));
  expect(s.pending()).toHaveLength(0); expect(s.entries.some(e => e.kind === "error")).toBe(true);
  await expect(s.interactions.bindElicitation(payload as typeof form)).rejects.toThrow();
});

test("plan presents native content and supported actions but waits for native completion", async () => {
  const s = setup(), plan = { summary: "Plan summary", planContent: "1. Inspect\n2. Implement", actions: ["exit_only", "interactive", "autopilot"], recommendedAction: "autopilot" };
  s.interactions.accept(event("exit_plan_mode.requested", { requestId: "plan", ...plan }));
  expect(s.entries.find(e => e.kind === "assistant_message")).toMatchObject({ content: [{ type: "text", text: plan.planContent }] });
  const p = s.pending()[0]!; expect(p.kind).toBe("form");
  expect(p.kind === "form" && p.fields[0]).toMatchObject({ fieldId: "action", options: [{ id: "exit_only", label: "Approve plan" }, { id: "interactive", label: "Approve and continue" }, { id: "reject", label: "Reject plan" }] });
  const callback = s.interactions.bindPlan(plan);
  await expect(s.interactions.respond(p.interactionId, "1", { kind: "form", values: [{ fieldId: "action", value: "autopilot" }] })).rejects.toThrow();
  const response = s.interactions.respond(p.interactionId, "1", { kind: "form", values: [{ fieldId: "action", value: "interactive" }, { fieldId: "feedback", value: "Keep the scope" }] });
  await expect(callback).resolves.toEqual({ approved: true, selectedAction: "interactive", feedback: "Keep the scope" }); expect(s.interactions.waiting).toBe(true);
  s.interactions.accept(event("elicitation.completed", { requestId: "plan", action: "accept" })); expect(s.interactions.waiting).toBe(true);
  s.interactions.accept(event("exit_plan_mode.completed", { requestId: "plan", approved: true, selectedAction: "interactive", feedback: "Keep the scope" })); await expect(response).resolves.toEqual({ disposition: "handled" });
});

test("plan without supported native approval actions can only reject or dismiss", async () => {
  const s = setup(), plan = { summary: "Plan", actions: ["autopilot"], recommendedAction: "autopilot" };
  s.interactions.accept(event("exit_plan_mode.requested", { requestId: "plan", ...plan })); const p = s.pending()[0]!;
  expect(p.kind === "form" && p.fields[0]).toMatchObject({ options: [{ id: "reject", label: "Reject plan" }] });
  const callback = s.interactions.bindPlan(plan);
  await expect(s.interactions.respond(p.interactionId, "1", { kind: "form", values: [{ fieldId: "action", value: "exit_only" }] })).rejects.toThrow();
  const response = s.interactions.respond(p.interactionId, "1", { kind: "dismiss" });
  await expect(callback).resolves.toEqual({ approved: false }); expect(s.interactions.waiting).toBe(true);
  s.interactions.accept(event("exit_plan_mode.completed", { requestId: "plan", approved: false })); await expect(response).resolves.toEqual({ disposition: "handled" });
});

test("plan callback uses complete signature and rejects ambiguous native identity", async () => {
  const s = setup(), plan = { summary: "Plan", planContent: "Body", actions: ["exit_only"], recommendedAction: "exit_only" };
  s.interactions.accept(event("exit_plan_mode.requested", { requestId: "one", ...plan }));
  await expect(s.interactions.bindPlan({ ...plan, recommendedAction: "interactive" })).rejects.toThrow(/unique/);
  s.interactions.accept(event("exit_plan_mode.requested", { requestId: "two", ...plan }, "child"));
  await expect(s.interactions.bindPlan(plan)).rejects.toThrow(/unique/); expect(s.interactions.waiting).toBe(false);
});

test("plan native completion that differs from submitted choice expires its response", async () => {
  const s = setup(), plan = { summary: "Plan", actions: ["exit_only", "interactive"], recommendedAction: "exit_only" };
  s.interactions.accept(event("exit_plan_mode.requested", { requestId: "plan", ...plan })); const callback = s.interactions.bindPlan(plan), p = s.pending()[0]!;
  const response = s.interactions.respond(p.interactionId, "1", { kind: "form", values: [{ fieldId: "action", value: "exit_only" }] }); const assertion = expect(response).rejects.toThrow();
  await expect(callback).resolves.toEqual({ approved: true, selectedAction: "exit_only" });
  s.interactions.accept(event("exit_plan_mode.completed", { requestId: "plan", approved: true, selectedAction: "autopilot" })); await assertion;
  const terminal = s.entries.at(-1); expect(terminal?.kind === "interaction" && terminal.interaction.state).toBe("expired");
});

test("unsolicited unsupported plan completion never resolves the SDK callback with greater permission", async () => {
  const s = setup(), plan = { summary: "Plan", actions: ["exit_only", "autopilot"], recommendedAction: "exit_only" };
  s.interactions.accept(event("exit_plan_mode.requested", { requestId: "plan", ...plan }));
  const callback = s.interactions.bindPlan(plan), assertion = expect(callback).rejects.toThrow();
  s.interactions.accept(event("exit_plan_mode.completed", { requestId: "plan", approved: true, selectedAction: "autopilot" })); await assertion;
  const terminal = s.entries.at(-1); expect(terminal?.kind === "interaction" && terminal.interaction.state).toBe("expired");
});

test("abort cancels only matching native owner and rejects its pending response", async () => {
  const s = setup(); s.interactions.accept(question("root")); s.interactions.accept(question("child", { question: "Child", choices: ["a"], allowFreeform: false }, "child-agent"));
  const childCallback = s.interactions.bindQuestion({ question: "Child", choices: ["a"], allowFreeform: false }); const assertion = expect(childCallback).rejects.toThrow();
  s.interactions.accept(event("abort", {}, "child-agent")); await assertion;
  expect(s.interactions.pendingIds).toEqual(["root"]);
});

test("unconfirmed response times out without resolving or enabling replay", async () => {
  vi.useFakeTimers(); const s = setup(); s.interactions.accept(permission("p")); const p = s.pending()[0]!;
  const response = s.interactions.respond(p.interactionId, "1", { kind: "approval", action: "reject" }); const assertion = expect(response).rejects.toThrow(/unknown/i);
  await vi.advanceTimersByTimeAsync(100); await assertion; expect(s.interactions.waiting).toBe(true);
  await expect(s.interactions.respond(p.interactionId, "1", { kind: "approval", action: "reject" })).rejects.toThrow();
});

test("history uses stable identity and cannot reopen or confirm live requests", async () => {
  const a = setup(), b = setup(); a.interactions.accept(permission("p")); b.interactions.accept(permission("p"), true);
  const historical = b.entries.find(e => e.kind === "interaction"); expect(historical?.kind === "interaction" && historical.interaction.state).toBe("expired");
  expect(historical?.entryId).toBe(a.pending()[0]!.interactionId); expect(b.interactions.waiting).toBe(false);
  const p = a.pending()[0]!; a.interactions.accept(event("permission.completed", { requestId: "p", result: { kind: "approved" } }), true);
  expect(a.interactions.pendingIds).toEqual(["p"]); await expect(a.interactions.respond(p.interactionId, "2", { kind: "approval", action: "reject" })).rejects.toThrow();
});

test("replayed history cannot replace an already live interaction projection", () => {
  const s = setup(); s.interactions.accept(permission("p")); const count = s.entries.length;
  s.interactions.accept(permission("p"), true);
  s.interactions.accept(event("permission.completed", { requestId: "p", result: { kind: "approved" } }), true);
  expect(s.entries).toHaveLength(count); expect(s.interactions.pendingIds).toEqual(["p"]);
});

test("tool ownership discovered later does not let a root abort cancel a subagent interaction", async () => {
  const s = setup(); s.interactions.accept(permission("p"));
  s.interactions.accept(event("abort", {})); expect(s.interactions.pendingIds).toEqual(["p"]);
  s.interactions.accept(event("tool.execution_start", { toolCallId: "tool", toolName: "read" }, "child"));
  const p = s.pending()[0]!; const response = s.interactions.respond(p.interactionId, "1", { kind: "approval", action: "reject" }); const assertion = expect(response).rejects.toThrow(/aborted/);
  s.interactions.accept(event("abort", {}, "other")); expect(s.interactions.pendingIds).toEqual(["p"]);
  s.interactions.accept(event("abort", {}, "child")); await assertion; expect(s.interactions.waiting).toBe(false);
});

test("dispose rejects native callbacks and prevents future reopening", async () => {
  const s = setup(); s.interactions.accept(question("q")); const callback = s.interactions.bindQuestion({ question: "Choose", choices: ["a", "b"], allowFreeform: false }); const assertion = expect(callback).rejects.toThrow(/closed/);
  s.interactions.dispose(); await assertion; s.interactions.accept(question("another")); expect(s.interactions.waiting).toBe(false);
});

test("form signatures distinguish source and full schema and reject another session", async () => {
  const s = setup(); s.interactions.accept(event("elicitation.requested", { ...form, requestId: "f" }));
  await expect(s.interactions.bindElicitation({ ...form, sessionId: "other" })).rejects.toThrow(/another/);
  await expect(s.interactions.bindElicitation({ ...form, elicitationSource: "other" })).rejects.toThrow(/unique/);
  await expect(s.interactions.bindElicitation({ ...form, requestedSchema: { ...schema, properties: { count: { type: "number", maximum: 3 } } } })).rejects.toThrow(/unique/);
});

test("session grants preserve command scope and cannot approve managed requests", async () => {
  const s = setup(); s.interactions.accept(permission("p", { kind: "commands", canOfferSessionApproval: true, commandIdentifiers: ["git status"] })); const p = s.pending()[0]!;
  const response = s.interactions.respond(p.interactionId, "1", { kind: "approval", action: "allow_session" });
  expect(s.requests).toEqual([{ requestId: "p", result: { kind: "approve-for-session", approval: { kind: "commands", commandIdentifiers: ["git status"] } } }]);
  s.interactions.accept(event("permission.completed", { requestId: "p", result: { kind: "approved-for-session", approval: { kind: "commands", commandIdentifiers: ["git status"] } } })); await expect(response).resolves.toEqual({ disposition: "handled" });
});

test.each([
  { action: "allow_once" as const, result: { kind: "approved-for-session", approval: { kind: "read" } } },
  { action: "allow_once" as const, result: { kind: "approved-for-location", approval: { kind: "read" }, locationKey: "/project" } },
  { action: "allow_session" as const, result: { kind: "approved" } },
  { action: "allow_session" as const, result: { kind: "approved-for-session", approval: { kind: "write" } } },
])("permission completion must preserve submitted scope: $action/$result.kind", async ({ action, result }) => {
  const s = setup(); s.interactions.accept(permission("p")); const p = s.pending()[0]!;
  const response = s.interactions.respond(p.interactionId, "1", { kind: "approval", action }); const assertion = expect(response).rejects.toThrow();
  s.interactions.accept(event("permission.completed", { requestId: "p", result })); await assertion;
  const terminal = s.entries.at(-1); expect(terminal?.kind === "interaction" && terminal.interaction.state).toBe("expired");
});

test("path permission does not offer a session grant with unverifiable native scope", async () => {
  const s = setup(); s.interactions.accept(permission("p", { kind: "path", paths: ["/project"], accessKind: "write" })); const p = s.pending()[0]!;
  expect(p.kind === "approval" && p.actions).toEqual(["allow_once", "reject"]);
  await expect(s.interactions.respond(p.interactionId, "1", { kind: "approval", action: "allow_session" })).rejects.toThrow();
});

test("plan completion enabling edit autoapproval cannot confirm an ordinary approval", async () => {
  const s = setup(), plan = { summary: "Plan", actions: ["interactive"], recommendedAction: "interactive" };
  s.interactions.accept(event("exit_plan_mode.requested", { requestId: "plan", ...plan })); const callback = s.interactions.bindPlan(plan), p = s.pending()[0]!;
  const response = s.interactions.respond(p.interactionId, "1", { kind: "form", values: [{ fieldId: "action", value: "interactive" }] }); const assertion = expect(response).rejects.toThrow();
  await callback;
  s.interactions.accept(event("exit_plan_mode.completed", { requestId: "plan", approved: true, selectedAction: "interactive", autoApproveEdits: true })); await assertion;
  const terminal = s.entries.at(-1); expect(terminal?.kind === "interaction" && terminal.interaction.state).toBe("expired");
});

test.each(["sync", "async", "refused"] as const)("permission %s failure preserves unknown input and releases its response timer", async failure => {
  vi.useFakeTimers(); const s = setup(() => {
    if (failure === "sync") throw new Error("RPC failed");
    if (failure === "async") return Promise.reject(new Error("RPC failed"));
    return Promise.resolve({ success: false });
  });
  s.interactions.accept(permission("p")); const p = s.pending()[0]!;
  await expect(s.interactions.respond(p.interactionId, "1", { kind: "approval", action: "allow_once" })).rejects.toThrow();
  expect(s.interactions.waiting).toBe(true); expect(vi.getTimerCount()).toBe(0);
  await expect(s.interactions.respond(p.interactionId, "1", { kind: "approval", action: "allow_once" })).rejects.toThrow(/submitted/);
});
