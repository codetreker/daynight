import { record, string } from "./native-rpc.js";
import { limited, markdownTimelineMetadata, nativeEntryId, readable } from "./projection.js";
import type { MarkdownTimelineMetadata, ProviderEntry } from "./types.js";
import type { CopilotImages } from "./copilot-images.js";

type ToolEntry = Extract<ProviderEntry, { kind: "tool_call" }>;
type Position = { id: string; parentId: string; timestamp: number; order: number };
type NativePosition = { id: string; owner: string; position: Position; type: string; interactionId: string; steering: boolean };
const precedes = (left: Position, right: Position): boolean => {
  if (left.id && left.id === right.parentId) return true;
  if (right.id && right.id === left.parentId) return false;
  return Number.isFinite(left.timestamp) && Number.isFinite(right.timestamp)
    ? left.timestamp < right.timestamp || left.timestamp === right.timestamp && left.order <= right.order : left.order <= right.order;
};
const interruptionOutput = "Interrupted by the user before a completion result was recorded.";
export const copilotOwner = (raw: unknown): string => { const event = record(raw); return string(event.agentId) || string(record(event.data).parentToolCallId); };

export class CopilotProjection {
  private readonly content = new Map<string, string>();
  private readonly finalized = new Set<string>();
  private readonly tools = new Map<string, ToolEntry>();
  private readonly seenBoundaries = new Set<string>();
  private readonly boundaries = new Map<string, NativePosition[]>();
  private readonly toolStarts = new Map<string, NativePosition>();
  private readonly aborts = new Map<string, NativePosition>();
  private eventOrder = 0;
  constructor(private readonly session: string, private readonly emit: (entry: ProviderEntry, metadata?: MarkdownTimelineMetadata) => void, private readonly images?: CopilotImages) {}
  private publish(entry: ProviderEntry, metadata?: MarkdownTimelineMetadata): void { if (this.images) this.images.publish(entry, metadata); else this.emit(entry, metadata); }
  private turn(event: NativePosition): string {
    let scope = "", interactionId = "", ended = false;
    for (const boundary of this.boundaries.get(event.owner) ?? []) {
      if (!precedes(boundary.position, event.position)) break;
      if (boundary.id === event.id) continue;
      if (boundary.type === "user.message") {
        if (!boundary.steering) { scope = boundary.id; interactionId = boundary.interactionId; ended = false; }
        else if (boundary.interactionId) interactionId = boundary.interactionId;
      } else if (boundary.type === "assistant.turn_start") {
        if (!scope || ended || interactionId && boundary.interactionId && interactionId !== boundary.interactionId) scope = boundary.id;
        if (boundary.interactionId) interactionId = boundary.interactionId;
        ended = false;
      } else ended = true;
    }
    return `${event.owner}:${scope}`;
  }
  private interrupted(start: NativePosition, cancellation: NativePosition): boolean {
    return start.owner === cancellation.owner && precedes(start.position, cancellation.position) && this.turn(start) === this.turn(cancellation);
  }
  private interruptTool(item: string, entry: ToolEntry): void {
    // Preserve every already-projected output block, including truncation markers.
    const interrupted: ToolEntry = { ...entry, status: "failed", output: [...entry.output, { type: "text", text: interruptionOutput }] };
    this.tools.set(item, interrupted); this.toolStarts.delete(item);
    this.publish(interrupted, { complete: true, format: "plain", truncated: interrupted.truncated });
  }
  accept(raw: unknown): void {
    const event = record(raw), data = record(event.data), type = string(event.type), owner = copilotOwner(raw);
    const position: Position = { id: string(event.id), parentId: string(event.parentId), timestamp: Date.parse(string(event.timestamp)), order: ++this.eventOrder };
    const key = (kind: string, id: string) => `${owner}:${kind}:${id}`;
    const base = (id: string) => ({ entryId: nativeEntryId(this.session, id), revision: "1" });
    const error = (code: string, message: string) => this.publish({ ...base(key("error", string(event.id))), kind: "error", code, message: limited(message) });
    const native: NativePosition = { id: string(event.id), owner, position, type, interactionId: string(data.interactionId), steering: data.delivery === "steering" };
    if (native.id && !this.seenBoundaries.has(native.id)
      && (type === "assistant.turn_start" || type === "user.message" || ["session.idle", "assistant.idle", "abort"].includes(type))) {
      this.seenBoundaries.add(native.id);
      const boundaries = this.boundaries.get(owner) ?? [];
      if (!boundaries.length || precedes(boundaries.at(-1)!.position, position)) boundaries.push(native);
      else boundaries.splice(boundaries.findIndex(boundary => !precedes(boundary.position, position)), 0, native);
      this.boundaries.set(owner, boundaries);
    }
    if (type === "abort" && ["user_abort", "user_initiated"].includes(string(data.reason))) {
      const identity = key("abort", string(event.id));
      if (!string(event.id) || this.aborts.has(identity)) return;
      // Native assistant turns are iterations of an agentic loop. Only a new
      // user interaction, or a start after idle/abort, separates cancellation scope.
      // turn_end can precede abort and must not discard the current scope.
      this.aborts.set(identity, native);
      for (const [item, start] of this.toolStarts) if (this.interrupted(start, native)) this.interruptTool(item, this.tools.get(item)!);
      error(owner ? "subagent_interrupted" : "turn_interrupted", owner ? `[Subagent ${owner}] Interrupted by the user.` : "Interrupted by the user.");
      return;
    }
    if (["assistant.message_delta", "assistant.message", "assistant.reasoning_delta", "assistant.reasoning"].includes(type)) {
      const reasoning = type.startsWith("assistant.reasoning"), id = string(reasoning ? data.reasoningId : data.messageId);
      if (!id) { error("invalid_native_content", "Copilot message identity is unavailable."); return; }
      const item = key(reasoning ? "reasoning" : "message", id), delta = type.endsWith("_delta");
      if (this.finalized.has(item)) return;
      const text = delta ? ((this.content.get(item) ?? "") + string(data.deltaContent)).slice(0, 200_001) : string(data.content);
      if (delta) this.content.set(item, text); else { this.finalized.add(item); this.content.delete(item); }
      if (!text.trim()) return;
      const displayed = owner ? `[Subagent ${owner}]\n${limited(text)}` : limited(text);
      this.publish(reasoning ? { ...base(item), kind: "reasoning", text: displayed } : { ...base(item), kind: "assistant_message", content: [{ type: "text", text: displayed }] }, markdownTimelineMetadata(text, !delta));
    } else if (type === "user.message") {
      const text = string(data.content);
      if (this.images) { if (text.trim() || Array.isArray(data.attachments) && data.attachments.length) this.images.user(raw, { ...base(key("user", string(event.id))), kind: "user_message", content: text.trim() ? [{ type: "text", text: limited(text) }] : [] }, markdownTimelineMetadata(text, true)); return; }
      if (text.trim()) this.publish({ ...base(key("user", string(event.id))), kind: "user_message", content: [{ type: "text", text: limited(text) }] }, markdownTimelineMetadata(text, true));
      if (Array.isArray(data.attachments) && data.attachments.length) error("unsupported_native_resource", "Copilot native attachments are unavailable in this text session.");
    } else if (type.startsWith("tool.execution_")) {
      const callId = string(data.toolCallId); if (!callId) return;
      const item = key("tool", callId), old = this.tools.get(item);
      if (old && old.status !== "running") return;
      if (type === "tool.execution_start") {
        if (old) return;
        const name = string(data.toolName) || "Copilot tool";
        const entry: ToolEntry = { ...base(item), kind: "tool_call", callId, name: owner ? `[Subagent ${owner}] ${name}` : name, input: limited(readable(data.arguments)), output: [], status: "running", truncated: false };
        this.toolStarts.set(item, native); this.tools.set(item, entry);
        for (const cancellation of this.aborts.values()) {
          if (this.interrupted(native, cancellation)) { this.interruptTool(item, entry); break; }
        }
        if (this.tools.get(item)!.status === "running") this.publish(entry, { complete: false, format: "plain", truncated: false });
      } else if (type === "tool.execution_partial_result" && old) {
        const text = (old.output.map(part => part.type === "text" ? part.text : "").join("") + string(data.partialOutput)).slice(0, 200_001);
        const entry: ToolEntry = { ...old, output: text.trim() ? [{ type: "text", text: limited(text) }] : [], truncated: old.truncated || text.length > 200_000 };
        this.tools.set(item, entry); this.publish(entry, markdownTimelineMetadata(text, false, "plain"));
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
        this.toolStarts.delete(item);
        this.tools.set(item, entry); if (this.images) this.images.tool(raw, entry, markdownTimelineMetadata(text, true, "plain")); else this.publish(entry, markdownTimelineMetadata(text, true, "plain"));
      }
    } else if (type === "session.compaction_complete") {
      if (data.success) this.publish({ ...base(key("compaction", string(event.id))), kind: "compaction", summary: "Native conversation context compacted." });
      else error("native_compaction_failed", `Copilot compaction failed: ${string(data.error) || "Unknown native error"}`);
    } else if (type === "session.error") error("native_session_error", string(data.message) || "Copilot session failed.");
    else if (type === "session.binary_asset") { if (this.images) this.images.asset(raw); else error("unsupported_native_resource", "Copilot native binary content is unavailable in this text session."); }
  }
}
