import { randomUUID } from "node:crypto";
import type { FormField, InteractionResponse, SessionInteraction } from "../../../session/protocol.js";
import { record, string } from "./native-rpc.js";

export const validateResponse = (interaction: SessionInteraction, response: InteractionResponse): void => {
  if (interaction.state !== "pending") throw new Error("This native interaction is no longer pending.");
  if (response.kind === "dismiss") { if (interaction.kind === "approval" || !interaction.canDismiss) throw new Error("Dismiss is not available."); return; }
  if (interaction.kind !== response.kind) throw new Error("Native interaction response kind does not match.");
  if (interaction.kind === "approval" && response.kind === "approval") { if (!interaction.actions.includes(response.action)) throw new Error("Approval action is not available."); }
  if (interaction.kind === "question" && response.kind === "question") {
    for (const answer of response.answers) if (!interaction.questions.some(q => q.questionId === answer.questionId)) throw new Error("Unknown question.");
    for (const q of interaction.questions) {
      const a = response.answers.find(a => a.questionId === q.questionId);
      if ((!a || !a.optionIds.length && !a.text?.trim()) && q.required) throw new Error("A required question is unanswered.");
      if (!a) continue;
      if ((!q.multiple && a.optionIds.length > 1) || a.optionIds.some(id => !q.options.some(o => o.id === id)) || (!q.allowCustom && a.text)) throw new Error("Invalid question answer.");
    }
  }
  if (interaction.kind === "form" && response.kind === "form") {
    for (const answer of response.values) if (!interaction.fields.some(f => f.fieldId === answer.fieldId)) throw new Error("Unknown form field.");
    for (const f of interaction.fields) {
      const v = response.values.find(a => a.fieldId === f.fieldId)?.value;
      if (v === undefined || v === "" || Array.isArray(v) && !v.length) { if (f.required) throw new Error("A required field is missing."); else continue; }
      if (f.type === "text" && typeof v !== "string" || f.type === "boolean" && typeof v !== "boolean" || f.type === "number" && (typeof v !== "number" || !Number.isFinite(v) || f.min !== null && v < f.min || f.max !== null && v > f.max) || f.type === "select" && (typeof v !== "string" || !f.options.some(o => o.id === v)) || f.type === "multiselect" && (!Array.isArray(v) || v.some(x => !f.options.some(o => o.id === x)))) throw new Error("Invalid form value.");
    }
  }
};
// Unsupported schema constraints are rejected, rather than weakened in the browser.
export const formInteraction = (title: string, value: unknown): SessionInteraction => {
  const schema = record(value); if (schema.type !== "object") throw new Error("Unsupported native form schema.");
  const allowedRoot = ["type", "properties", "required", "title", "description", "$schema"];
  if (Object.keys(schema).some(k => !allowedRoot.includes(k))) throw new Error("Unsupported native form constraint.");
  const required = Array.isArray(schema.required) ? schema.required : [];
  const fields: FormField[] = Object.entries(record(schema.properties)).map(([fieldId, raw]) => {
    const p = record(raw); if (Object.keys(p).some(k => !["type", "title", "description", "enum", "enumNames", "minimum", "maximum", "items", "default"].includes(k))) throw new Error("Unsupported native form constraint.");
    const base = { fieldId, label: string(p.title) || fieldId, required: required.includes(fieldId) };
    if (p.type === "string" && Array.isArray(p.enum) && p.enum.every(x => typeof x === "string")) return { ...base, type: "select", options: p.enum.map((x, i) => ({ id: x as string, label: Array.isArray(p.enumNames) ? string(p.enumNames[i]) || x as string : x as string })) };
    if (p.type === "string") return { ...base, type: "text", sensitive: false };
    if (p.type === "number") return { ...base, type: "number", min: typeof p.minimum === "number" ? p.minimum : null, max: typeof p.maximum === "number" ? p.maximum : null };
    if (p.type === "boolean") return { ...base, type: "boolean" };
    const items = record(p.items);
    if (p.type === "array" && items.type === "string" && Array.isArray(items.enum) && items.enum.every(x => typeof x === "string") && Object.keys(items).every(k => ["type", "enum"].includes(k))) return { ...base, type: "multiselect", options: items.enum.map(x => ({ id: x as string, label: x as string })) };
    throw new Error("Unsupported native form field.");
  });
  if (!fields.length) throw new Error("Empty native form schema.");
  return { interactionId: randomUUID(), revision: "1", state: "pending", kind: "form", title, fields, canDismiss: true };
};
