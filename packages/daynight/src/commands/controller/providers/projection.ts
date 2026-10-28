import { createHash } from "node:crypto";
import { record, string } from "./native-rpc.js";
import type { ProviderEntry } from "./types.js";

// Native item IDs survive reconnects; transport IDs must never create new timeline rows.
export const nativeEntryId = (session: string, item: string): string => {
  const h = createHash("sha256").update(session).update("\0").update(item).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const readable = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
export const limited = (value: string): string => {
  if (value.length <= 200_000) return value;
  // UTF-16 limits must not split a scalar value accepted by the wire codec.
  const end = /[\uD800-\uDBFF]/.test(value[199_999]!) && /[\uDC00-\uDFFF]/.test(value[200_000]!) ? 199_999 : 200_000;
  return value.slice(0, end) + "\n[Output truncated at 200000 characters]";
};
export type ProviderArguments = { sandbox?: "read-only" | "workspace-write"; approvalPolicy?: "untrusted" | "on-request" | "never"; effort?: "low" | "medium" | "high" | "xhigh" | "max"; permissionMode?: "default" | "acceptEdits" | "plan"; additionalDirectories?: string[] };
export const parseProviderArguments = (provider: "codex" | "claude" | "copilot", args: readonly string[]): ProviderArguments => {
  const result: ProviderArguments = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, value = args[++i];
    if (!value) throw new Error(`Unsupported or incomplete Web ${provider} argument: ${arg}`);
    if (provider === "codex" && ["--sandbox", "-s"].includes(arg) && ["read-only", "workspace-write"].includes(value)) result.sandbox = value as NonNullable<ProviderArguments["sandbox"]>;
    else if (provider === "codex" && ["--ask-for-approval", "-a"].includes(arg) && ["untrusted", "on-request", "never"].includes(value)) result.approvalPolicy = value as NonNullable<ProviderArguments["approvalPolicy"]>;
    else if (provider === "claude" && arg === "--permission-mode" && ["default", "acceptEdits", "plan"].includes(value)) result.permissionMode = value as NonNullable<ProviderArguments["permissionMode"]>;
    else if (arg === "--effort" && (provider === "copilot" ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high", "xhigh", "max"]).includes(value)) result.effort = value as NonNullable<ProviderArguments["effort"]>;
    else if (provider === "claude" && arg === "--add-dir") (result.additionalDirectories ??= []).push(value);
    else throw new Error(`Unsupported Web ${provider} argument: ${arg}`);
  }
  return result;
};
export class CodexProjection {
  private readonly content = new Map<string, string>();
  private readonly tools = new Map<string, Extract<ProviderEntry, {kind: "tool_call"}>>();
  constructor(private readonly sessionId: string, private readonly emit: (entry: ProviderEntry) => void) {}
  private base(id: string) { return { entryId: nativeEntryId(this.sessionId, id), revision: "1" }; }
  delta(id: string, delta: string, kind: "assistant_message" | "reasoning"): void {
    const value = (this.content.get(id) ?? "") + delta; this.content.set(id, value);
    if (kind === "reasoning" && value.trim() === "") return;
    this.emit(kind === "reasoning" ? { ...this.base(id), kind, text: limited(value) } : { ...this.base(id), kind, content: [{ type: "text", text: limited(value) }] });
  }
  toolDelta(id: string, delta: string): void {
    const old = this.tools.get(id); if (!old) return;
    const prior = old.output.map(part => part.type === "text" ? part.text : "").join("");
    const output = prior + delta;
    const entry = { ...old, output: [{ type: "text" as const, text: limited(output) }], truncated: old.truncated || output.length > 200_000 };
    this.tools.set(id, entry); this.emit(entry);
  }
  item(value: unknown, completed: boolean): void {
    const item = record(value), id = string(item.id), type = string(item.type); if (!id) return;
    const base = this.base(id);
    if (type === "agentMessage") { const text = string(item.text); this.content.set(id, text); this.emit({ ...base, kind: "assistant_message", content: [{ type: "text", text: limited(text) }] }); }
    else if (type === "userMessage") this.emit({ ...base, kind: "user_message", content: (Array.isArray(item.content) ? item.content : []).flatMap(part => { const p = record(part); return p.type === "text" ? [{ type: "text" as const, text: limited(string(p.text)) }] : [{ type: "text" as const, text: `[${string(p.type) || "unsupported native content"}]` }]; }) });
    else if (type === "reasoning") {
      const text = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])].map(readable).join("\n");
      // Empty native reasoning can contain only opaque provider state. It is
      // neither displayable text nor evidence that streamed text was removed.
      if (text.trim() === "") return;
      this.content.set(id, text); this.emit({ ...base, kind: "reasoning", text: limited(text) });
    }
    else if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageView", "collabAgentToolCall"].includes(type)) {
      const output = readable(item.aggregatedOutput ?? item.result ?? item.error ?? item.changes ?? "");
      const entry: Extract<ProviderEntry, { kind: "tool_call" }> = { ...base, kind: "tool_call", callId: id, name: string(item.tool) || type, input: limited(readable(item.command ?? item.arguments ?? item.query ?? item.changes ?? item)), output: [{ type: "text", text: limited(output) }], status: ["failed", "declined"].includes(string(item.status)) || item.error ? "failed" : completed ? "completed" : "running", truncated: output.length > 200_000 };
      this.tools.set(id, entry); this.emit(entry);
    } else if (type === "contextCompaction") this.emit({ ...base, kind: "compaction", summary: "Native conversation context compacted." });
    else if (type === "plan") this.emit({ ...base, kind: "assistant_message", content: [{ type: "text", text: limited(string(item.text) || readable(item)) }] });
    else this.emit({ ...base, kind: "error", code: "unsupported_native_item", message: `Unsupported native timeline item: ${type || "unknown"}. ${limited(readable(item))}` });
  }
}
