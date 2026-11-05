import { randomUUID } from "node:crypto";
import { record, type NativeObject } from "./native-rpc.js";
import type { ProviderEntry } from "./types.js";

type ErrorEntry = Extract<ProviderEntry, { kind: "error" }>;
const bounded = (value: string, limit: number): string => {
  if (value.length <= limit) return value;
  const end = /[\uD800-\uDBFF]/.test(value[limit - 1]!) && /[\uDC00-\uDFFF]/.test(value[limit]!) ? limit - 1 : limit;
  return value.slice(0, end) + "\n[Native error details truncated]";
};
const diagnosticField = (value: unknown, budget: number): string => {
  const serialized = JSON.stringify(value, null, 2) ?? "null";
  if (serialized.length <= budget) return serialized;
  const text = typeof value === "string" ? value : serialized;
  let low = 0, high = Math.min(text.length, budget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(bounded(text, middle)).length <= budget) low = middle;
    else high = middle - 1;
  }
  return JSON.stringify(bounded(text, low));
};
const details = (params: NativeObject, completed = false): string => {
  const turn = record(params.turn), raw = completed ? turn.error : params.error ?? params;
  const fields: string[] = [];
  const field = (key: string, value: unknown, budget: number) => { if (value !== undefined) fields.push(`  ${JSON.stringify(key)}: ${diagnosticField(value, budget)}`); };
  field("threadId", params.threadId, 512);
  field("turnId", completed ? turn.id : params.turnId, 512);
  field(completed ? "status" : "willRetry", completed ? turn.status : params.willRetry, 128);
  // A turn's items are already projected separately. Reserve independent
  // budgets for error fields so a long message cannot hide its error code or
  // additionalDetails, including when two terminal reports share one row.
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const { message, code, codexErrorInfo, additionalDetails, misalignment, ...other } = record(raw);
    field("codexErrorInfo", codexErrorInfo, 2_000);
    field("code", code, 750);
    field("message", message, 2_000);
    field("additionalDetails", additionalDetails, 3_500);
    field("misalignment", misalignment, 750);
    if (Object.keys(other).length) field("otherErrorFields", other, 750);
  } else field("error", raw ?? null, 9_000);
  return `{\n${fields.join(",\n")}\n}`;
};
const readableMessage = (error: unknown, fallback: string): string => {
  const message = typeof error === "string" ? error : record(error).message;
  return typeof message === "string" && message.trim() ? bounded(message, 2_000) : fallback;
};
// Bound each field before serialization. Even JSON's six-character escapes fit
// the display budget, and truncation cannot invalidate the envelope itself.
const messageEnvelope = (message: string, raw: string): string => JSON.stringify({ message, details: raw });
const validId = (value: unknown): value is string => typeof value === "string" && !!value.trim();

export class CodexErrors {
  private terminal: { turnId: string; entry: ErrorEntry; details: string } | null = null;
  constructor(private readonly emit: (entry: ProviderEntry) => void) {}

  started(): void { this.terminal = null; }

  notification(params: NativeObject, threadId: string, currentTurnId: string | null): void {
    const error = record(params.error);
    const identified = !!threadId && params.threadId === threadId && validId(params.turnId);
    const validError = typeof error.message === "string" && !!error.message.trim();
    const code = identified && validError && params.willRetry === true && params.turnId === currentTurnId ? "native_retry"
      : identified && validError && params.willRetry === false ? "native_turn_error" : "native_error";
    const message = readableMessage(params.error ?? params, "Native error details are unavailable.");
    if (code === "native_turn_error" && params.turnId === currentTurnId) {
      this.failure(params.turnId as string, message, details(params));
    } else {
      this.emit({ entryId: randomUUID(), revision: "1", kind: "error", code, message: messageEnvelope(message, details(params)) });
    }
  }

  completed(params: NativeObject, threadId: string): void {
    const turn = record(params.turn);
    if (!threadId || params.threadId !== threadId || !validId(turn.id)) return;
    if (turn.status === "failed") this.failure(turn.id, readableMessage(turn.error, "Native turn failed."), details(params, true), false);
    if (this.terminal?.turnId === turn.id) this.terminal = null;
  }

  private failure(turnId: string, message: string, raw: string, retain = true): void {
    const previous = this.terminal?.turnId === turnId ? this.terminal : null;
    // The completion payload may omit additionalDetails already reported by
    // error/willRetry=false. Keep both reports in the same diagnostic row.
    const combined = previous ? `${bounded(previous.details, 12_000)}\n\nSubsequent native error report:\n${bounded(raw, 12_000)}` : raw;
    const entry: ErrorEntry = { entryId: previous?.entry.entryId ?? randomUUID(), revision: previous ? String(BigInt(previous.entry.revision) + 1n) : "1", kind: "error", code: "native_turn_error", message: messageEnvelope(message, combined) };
    if (retain) this.terminal = { turnId, entry, details: combined };
    this.emit(entry);
  }
}
