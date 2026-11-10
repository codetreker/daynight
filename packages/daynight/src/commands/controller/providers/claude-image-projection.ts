import { createHash } from "node:crypto";
import { ProviderImageProjector, type NativeImagePayload, type NativeImageSlot } from "./image-projector.js";
import { claudeLiveImage } from "./claude-live.js";
import { nativeEntryId, limited, readable } from "./projection.js";
import { record, string } from "./native-rpc.js";
import type { NativeInput, ProviderEntry, ProviderOptions } from "./types.js";
import type { ClaudeTranscriptRecord, ClaudeTranscriptReader } from "./claude-transcript.js";
import type { MessagePart } from "../../../session/protocol.js";

type Content = MessagePart[];
const unavailable = () => ({ type: "image_unavailable" as const, imageId: "pending", label: "Image", error: { code: "capture_pending", message: "The original image is being saved." } });
const waitForPage = async (acknowledged: Promise<void>, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted(); let abort!: () => void;
  try { await Promise.race([acknowledged, new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); })]); }
  finally { signal.removeEventListener("abort", abort); }
};

/** Live blocks, final SDK messages and acknowledged history use the same native positions. */
export class ClaudeProjection {
  private readonly images: ProviderImageProjector;
  private readonly tools = new Map<string, { name: string; input: string }>();
  private readonly streams = new Map<string, { text: string; kind: "text" | "thinking" }>();
  private readonly offsets = new Map<string, number>();
  private readonly ordinals = new Map<string, number>();
  private readonly local = new Map<string, { offset: number; ordinal: number; kind: string }>();
  private readonly messageIds = new Map<string, string>();
  constructor(private readonly options: ProviderOptions, private readonly sessionId: string, private readonly original: (id: string) => NativeInput | null) { this.images = new ProviderImageProjector(options); }
  private block(uuid: string, messageId: string, index: number, kind: string, knownOffset?: number) {
    const key = `claude:block:${this.sessionId}:${uuid}:${index}`;
    const saved = this.local.get(key) ?? this.options.imageRuntime?.readState(key) as { offset: number; ordinal: number; kind: string } | null;
    if (saved) {
      this.local.set(key, saved);
      if (!uuid.startsWith("stream:")) this.offsets.set(messageId, Math.max(saved.offset + 1, this.offsets.get(messageId) ?? 0));
      const group = `${messageId}:${saved.kind}`; this.ordinals.set(group, Math.max(saved.ordinal + 1, this.ordinals.get(group) ?? 0));
      return saved;
    }
    const offset = knownOffset === undefined ? this.offsets.get(messageId) ?? 0 : knownOffset;
    if (!uuid.startsWith("stream:")) {
      this.offsets.set(messageId, Math.max(offset + 1, this.offsets.get(messageId) ?? 0));
      const streamKey = `claude:block:${this.sessionId}:stream:${messageId}:${offset}:0`, streamed = this.local.get(streamKey) ?? this.options.imageRuntime?.readState(streamKey) as { offset: number; ordinal: number; kind: string } | null;
      if (streamed?.kind === kind) {
        const group = `${messageId}:${kind}`; this.ordinals.set(group, Math.max(streamed.ordinal + 1, this.ordinals.get(group) ?? 0));
        this.local.set(key, streamed); this.options.imageRuntime?.writeState(key, streamed); return streamed;
      }
    }
    const group = `${messageId}:${kind}`, ordinal = this.ordinals.get(group) ?? 0; this.ordinals.set(group, ordinal + 1);
    const value = { offset, ordinal, kind }; this.local.set(key, value); this.options.imageRuntime?.writeState(key, value); return value;
  }
  private slot(part: Record<string, unknown>, at: readonly (string | number)[], nativeMessageId: string, nativePartId: string, index: number, history?: { row: ClaudeTranscriptRecord; reader: ClaudeTranscriptReader; acknowledged?: Promise<void> }): NativeImageSlot {
    const source = record(part.source), media = claudeLiveImage(source.data);
    let payload: NativeImagePayload;
    if (media) payload = media.retain();
    else {
      const location = [...at, "source", "data"], descriptor = history?.row.media.find(item => JSON.stringify(item.path) === JSON.stringify(location));
      if (descriptor && descriptor.state === "available" && this.options.imageRuntime) {
        payload = { kind: "deferred", read: async signal => {
          if (history?.acknowledged) await waitForPage(history.acknowledged, signal); signal.throwIfAborted();
          const spool = this.options.imageRuntime!.createSpool(descriptor.byteLength), hash = createHash("sha256"); let bytes = 0;
          try { await history!.reader.readMedia(descriptor.mediaId, chunk => { signal.throwIfAborted(); spool.write(chunk); hash.update(chunk); bytes += chunk.length; }, signal); spool.seal(); return { kind: "file", path: spool.path, byteLength: String(bytes), sha256: hash.digest("hex"), release: () => spool.remove() }; }
          catch (error) { spool.remove(); throw error; }
        } };
      } else if (at[0] === "event" && (!source.type || source.type === "base64" && source.data === undefined)) payload = { kind: "pending" };
      else if (source.type === "url" && typeof source.url === "string") payload = { kind: "source", locator: { kind: "external", url: source.url } };
      else payload = { kind: "unavailable", error: { code: descriptor?.error ?? (string(record(source.data).error) || "unsupported_media_source"), message: "The original Claude image source is unavailable." } };
    }
    return { index, label: "Image", native: { provider: "claude", nativeSessionId: this.sessionId, nativeMessageId, nativePartId }, payload };
  }
  dispatch(input: NativeInput, id: string): void {
    const slots: NativeImageSlot[] = [], content: Content = input.content.map((part, index) => {
      if (part.type === "text") return { type: "text", text: limited(part.text) };
      slots.push({ index, label: "Image", native: { provider: "claude", nativeSessionId: this.sessionId, nativeMessageId: id, nativePartId: `content:${index}` }, original: { imageId: part.imageId, resourceId: part.resourceId }, payload: { kind: "resource", resourceId: part.resourceId } }); return unavailable();
    });
    this.images.publish({ entryId: nativeEntryId(this.sessionId, `${id}:0`), revision: "1", kind: "user_message", content }, slots);
  }
  stream(raw: unknown): void {
    const message = record(raw), event = record(message.event), delta = record(event.delta), part = record(event.content_block);
    const scope = string(message.parent_tool_use_id) || "root";
    if (event.type === "message_start") { this.messageIds.set(scope, string(record(event.message).id)); return; }
    const messageId = this.messageIds.get(scope), index = Number(event.index); if (!messageId || !Number.isSafeInteger(index) || index < 0) return;
    const source = `stream:${messageId}:${index}`, kind = string(part.type) || (delta.type === "thinking_delta" ? "thinking" : "text");
    const position = this.block(source, messageId, 0, kind, index), key = kind === "image" ? `${messageId}:image:${position.offset}` : `${messageId}:${kind}:${position.ordinal}`;
    const base = { entryId: nativeEntryId(this.sessionId, key), revision: "1" };
    if (event.type === "content_block_start" && kind === "image") this.images.publish({ ...base, kind: "assistant_message", content: [unavailable()] }, [this.slot(part, ["event", "content_block"], messageId, `content:${position.offset}`, 0)]);
    else if (event.type === "content_block_start" && ["text", "thinking"].includes(kind)) this.streams.set(source, { text: string(part.text ?? part.thinking), kind: kind as "text" | "thinking" });
    else if (event.type === "content_block_delta" && ["text_delta", "thinking_delta"].includes(string(delta.type))) {
      const saved = this.streams.get(source) ?? { text: "", kind: kind as "text" | "thinking" }; saved.text = limited(saved.text + string(delta.text ?? delta.thinking)); this.streams.set(source, saved);
      this.images.publish(saved.kind === "thinking" ? { ...base, kind: "reasoning", text: saved.text } : { ...base, kind: "assistant_message", content: [{ type: "text", text: saved.text }] });
    }
  }
  message(raw: unknown, history?: { row: ClaudeTranscriptRecord; reader: ClaudeTranscriptReader; acknowledged?: Promise<void> }): void {
    const value = record(raw), message = record(value.message), type = string(value.type), uuid = string(value.uuid), id = type === "assistant" ? string(message.id) || uuid : uuid;
    if (!id) return;
    const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
    const userContent: Content = [], userSlots: NativeImageSlot[] = [], original = type === "user" ? this.original(uuid) : null;
    for (const [index, rawPart] of parts.entries()) {
      const part = record(rawPart), kind = string(part.type), position = type === "assistant" ? this.block(uuid || id, id, index, kind, history?.row.assistantBlockOffset === null || history?.row.assistantBlockOffset === undefined ? undefined : history.row.assistantBlockOffset + index) : { offset: index, ordinal: index, kind };
      const key = type === "assistant" ? kind === "image" ? `${id}:image:${position.offset}` : `${id}:${kind}:${position.ordinal}` : `${id}:${index}`, base = { entryId: nativeEntryId(this.sessionId, key), revision: "1" };
      if (kind === "text") {
        if (type === "user") userContent.push({ type: "text", text: limited(string(part.text)) });
        else this.images.publish({ ...base, kind: "assistant_message", content: [{ type: "text", text: limited(string(part.text)) }] });
      } else if (kind === "image") {
        const slot = this.slot(part, ["message", "content", index], id, `content:${position.offset}`, type === "user" ? userContent.length : 0, history), inputPart = original?.content[index];
        if (inputPart?.type === "image") slot.original = { imageId: inputPart.imageId, resourceId: inputPart.resourceId };
        if (type === "user") { userSlots.push(slot); userContent.push(unavailable()); }
        else this.images.publish({ ...base, kind: "assistant_message", content: [unavailable()] }, [slot]);
      } else if (kind === "thinking") this.images.publish({ ...base, kind: "reasoning", text: limited(string(part.thinking)) });
      else if (kind === "tool_use") { const callId = string(part.id), tool = { name: string(part.name), input: limited(readable(part.input)) }; this.tools.set(callId, tool); this.images.publish({ entryId: nativeEntryId(this.sessionId, callId), revision: "1", kind: "tool_call", callId, ...tool, output: [], status: "running", truncated: false }); }
      else if (kind === "tool_result") {
        const callId = string(part.tool_use_id), output: Content = [], slots: NativeImageSlot[] = [];
        const nested = typeof part.content === "string" ? [{ type: "text", text: part.content }] : Array.isArray(part.content) ? part.content : [];
        for (const [nestedIndex, raw] of nested.entries()) {
          const child = record(raw);
          if (child.type === "image") { slots.push(this.slot(child, ["message", "content", index, "content", nestedIndex], id, `tool:${callId}:${index}:${nestedIndex}`, output.length, history)); output.push(unavailable()); }
          else output.push({ type: "text", text: limited(child.type === "text" ? string(child.text) : readable(raw)) });
        }
        this.images.publish({ entryId: nativeEntryId(this.sessionId, callId), revision: "1", kind: "tool_call", callId, ...(this.tools.get(callId) ?? { name: "tool", input: "" }), output, status: part.is_error ? "failed" : "completed", truncated: false }, slots);
      } else this.images.publish({ ...base, kind: "error", code: "unsupported_native_content", message: `Native ${kind} content is unavailable.` });
    }
    if (userContent.length) this.images.publish({ entryId: nativeEntryId(this.sessionId, `${id}:0`), revision: "1", kind: "user_message", content: userContent }, userSlots);
  }
  acknowledged() { this.images.acknowledged(); }
  close() { return this.images.close(); }
}
