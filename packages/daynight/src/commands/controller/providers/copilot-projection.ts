import { record, string } from "./native-rpc.js";
import { limited, nativeEntryId, readable } from "./projection.js";
import type { ProviderEntry } from "./types.js";

type ToolEntry = Extract<ProviderEntry, { kind: "tool_call" }>;
export const copilotOwner = (raw: unknown): string => { const event = record(raw); return string(event.agentId) || string(record(event.data).parentToolCallId); };

export class CopilotProjection {
  private readonly content = new Map<string, string>();
  private readonly finalized = new Set<string>();
  private readonly tools = new Map<string, ToolEntry>();
  constructor(private readonly session: string, private readonly emit: (entry: ProviderEntry) => void) {}
  accept(raw: unknown): void {
    const event = record(raw), data = record(event.data), type = string(event.type), owner = copilotOwner(raw);
    const key = (kind: string, id: string) => `${owner}:${kind}:${id}`;
    const base = (id: string) => ({ entryId: nativeEntryId(this.session, id), revision: "1" });
    const error = (code: string, message: string) => this.emit({ ...base(key("error", string(event.id))), kind: "error", code, message: limited(message) });
    if (["assistant.message_delta", "assistant.message", "assistant.reasoning_delta", "assistant.reasoning"].includes(type)) {
      const reasoning = type.startsWith("assistant.reasoning"), id = string(reasoning ? data.reasoningId : data.messageId);
      if (!id) { error("invalid_native_content", "Copilot message identity is unavailable."); return; }
      const item = key(reasoning ? "reasoning" : "message", id), delta = type.endsWith("_delta");
      if (this.finalized.has(item)) return;
      const text = delta ? ((this.content.get(item) ?? "") + string(data.deltaContent)).slice(0, 200_001) : string(data.content);
      if (delta) this.content.set(item, text); else { this.finalized.add(item); this.content.delete(item); }
      if (!text.trim()) return;
      const displayed = owner ? `[Subagent ${owner}]\n${limited(text)}` : limited(text);
      this.emit(reasoning ? { ...base(item), kind: "reasoning", text: displayed } : { ...base(item), kind: "assistant_message", content: [{ type: "text", text: displayed }] });
    } else if (type === "user.message") {
      const text = string(data.content);
      if (text.trim()) this.emit({ ...base(key("user", string(event.id))), kind: "user_message", content: [{ type: "text", text: limited(text) }] });
      if (Array.isArray(data.attachments) && data.attachments.length) error("unsupported_native_resource", "Copilot native attachments are unavailable in this text session.");
    } else if (type.startsWith("tool.execution_")) {
      const callId = string(data.toolCallId); if (!callId) return;
      const item = key("tool", callId), old = this.tools.get(item);
      if (old && old.status !== "running") return;
      if (type === "tool.execution_start") {
        const name = string(data.toolName) || "Copilot tool";
        const entry: ToolEntry = { ...base(item), kind: "tool_call", callId, name: owner ? `[Subagent ${owner}] ${name}` : name, input: limited(readable(data.arguments)), output: [], status: "running", truncated: false };
        this.tools.set(item, entry); this.emit(entry);
      } else if (type === "tool.execution_partial_result" && old) {
        const text = (old.output.map(part => part.type === "text" ? part.text : "").join("") + string(data.partialOutput)).slice(0, 200_001);
        const entry: ToolEntry = { ...old, output: text.trim() ? [{ type: "text", text: limited(text) }] : [], truncated: old.truncated || text.length > 200_000 };
        this.tools.set(item, entry); this.emit(entry);
      } else if (type === "tool.execution_complete") {
        const result = record(data.result);
        // Native summary and UI detail often contain the same complete output.
        // Deduplicate whole fields only: repeated lines inside native output are meaningful.
        // https://github.com/xuangong/agent-remote-control/blob/7905c9e2d4a2beb28e84b954a29da3778094e384/packages/agent-provider-copilot/src/tool-result.ts
        const outputs = typeof data.result === "string" ? [data.result] : [result.content, result.detailedContent, result.structuredContent].filter(value => value !== undefined).map(readable);
        // Keep the failure visible even when the accompanying result exceeds the text limit.
        if (data.success === false) outputs.unshift(string(record(data.error).message) || "Native tool failed.");
        const text = [...new Set(outputs.filter(value => value.length > 0))].join("\n");
        const entry: ToolEntry = { ...(old ?? { ...base(item), kind: "tool_call", callId, name: "Copilot tool", input: "" }), status: data.success ? "completed" : "failed", output: text.trim() ? [{ type: "text", text: limited(text) }] : [], truncated: text.length > 200_000 };
        this.tools.set(item, entry); this.emit(entry);
      }
    } else if (type === "session.compaction_complete") {
      if (data.success) this.emit({ ...base(key("compaction", string(event.id))), kind: "compaction", summary: "Native conversation context compacted." });
      else error("native_compaction_failed", `Copilot compaction failed: ${string(data.error) || "Unknown native error"}`);
    } else if (type === "session.error") error("native_session_error", string(data.message) || "Copilot session failed.");
    else if (type === "session.binary_asset") error("unsupported_native_resource", "Copilot native binary content is unavailable in this text session.");
  }
}
