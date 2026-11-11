import type { NativeInput, ProviderEntry, ProviderOptions } from "./types.js";
import { record, string, type NativeObject } from "./native-rpc.js";
import { limited, nativeEntryId, readable } from "./projection.js";
import { codexMedia } from "./codex-rpc-json.js";
import type { CodexImageInputs, CodexMatchedInput } from "./codex-image-input.js";
import type { NativeImagePayload, NativeImageSlot, ProviderImageProjector } from "./image-projector.js";

type Tool = Extract<ProviderEntry, { kind: "tool_call" }>;
type Parts = Tool["output"];
type Owner = { entryId: string; nativeMessageId: string; original: boolean; turnId: string; itemId: string };
const unavailable = (code = "native_source_unavailable"): NativeImagePayload => ({ kind: "unavailable", error: { code, message: "The original native image is unavailable." } });
const safeSlots = (slots: readonly NativeImageSlot[]): NativeImageSlot[] => slots.map(slot => ({ ...slot, payload: slot.payload.kind === "pending" ? slot.payload : unavailable() }));

// Qualify native containers before projecting image placeholders or fallback text.
function userMessageFormat(content: readonly unknown[]): "markdown" | "plain" {
  let texts = 0;
  for (const raw of content) {
    const part = record(raw);
    if (part.type === "text" && typeof part.text === "string") texts++;
    else if (part.type !== "image" && part.type !== "localImage") return "plain";
  }
  return texts === 1 ? "markdown" : "plain";
}

/** Explicit native containers share one position-preserving image publisher. */
export class CodexImageProjection {
  private readonly tools = new Map<string, { entry: Tool; slots: NativeImageSlot[] }>();
  constructor(private readonly sessionId: string, private readonly options: ProviderOptions, private readonly inputs: CodexImageInputs, private readonly publisher: Pick<ProviderImageProjector, "publish">) {}
  acceptedInput(match: CodexMatchedInput, input: NativeInput): boolean {
    const slots: NativeImageSlot[] = [];
    const content = input.content.map((part, index) => {
      if (part.type === "text") return { type: "text" as const, text: limited(part.text) };
      slots.push({ index, label: "Native image", native: { provider: "codex", nativeSessionId: this.sessionId, nativeMessageId: match.nativeMessageId, nativePartId: `content/${index}` }, original: { imageId: part.imageId, resourceId: part.resourceId }, payload: { kind: "resource", resourceId: part.resourceId } });
      return { type: "text" as const, text: "" };
    });
    this.publisher.publish({ entryId: match.entryId, revision: "1", kind: "user_message", content }, slots,
      { complete: true, format: userMessageFormat(input.content), truncated: input.content.some(part => part.type === "text" && part.text.length > 200_000) });
    return this.inputs.confirm(match);
  }
  private payload(value: unknown, local = false): NativeImagePayload {
    const media = codexMedia(value);
    if (media) {
      if (media.status !== "available") return unavailable(media.errorCode ?? "native_source_unavailable");
      const lease = media.retain();
      return { kind: "file", path: lease.path, byteLength: String(media.byteLength), sha256: media.sha256!, release: lease.release };
    }
    if (typeof value !== "string" || !value || Buffer.byteLength(value) > 8192) return unavailable();
    if (local) return { kind: "source", locator: { kind: "local", path: value, contextId: nativeEntryId(this.sessionId, `source-context:${this.options.cwd}`) } };
    try { const url = new URL(value); if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return { kind: "source", locator: { kind: "external", url: value } }; } catch { /* Invalid native locators remain at their original position. */ }
    return unavailable();
  }
  item(item: NativeObject, completed: boolean, turnId: string): boolean {
    const type = string(item.type), id = string(item.id);
    if (!id || !["userMessage", "mcpToolCall", "dynamicToolCall", "functionCallOutput", "imageView", "imageGeneration"].includes(type)) return false;
    if (type === "userMessage" && !(Array.isArray(item.content) && item.content.some(part => ["image", "localImage"].includes(string(record(part).type))))) return false;
    const old = this.tools.get(id);
    const content = type === "mcpToolCall" ? record(item.result).content : type === "dynamicToolCall" ? item.contentItems : item.output;
    // Keep ordinary tools on their established projection. Media containers
    // need explicit handling so their bytes cannot enter the text fallback.
    if (["mcpToolCall", "dynamicToolCall"].includes(type) && !old && !(Array.isArray(content) && content.some(part => !["text", "inputText", "input_text"].includes(string(record(part).type))))) return false;
    const matched = type === "userMessage" ? this.inputs.match(item, turnId) : null;
    const ownerKey = `codex:owner:${this.sessionId}:${id}`;
    const prior = this.options.imageRuntime?.readState(ownerKey) as Owner | null | undefined;
    if (prior?.turnId && turnId && prior.turnId !== turnId) throw new Error("Native image item moved to a different turn.");
    const owner: Owner = prior ?? { entryId: matched?.entryId ?? nativeEntryId(this.sessionId, id), nativeMessageId: matched?.nativeMessageId ?? id, original: matched !== null, turnId, itemId: id };
    if (prior && !prior.turnId && turnId) { owner.turnId = turnId; this.options.imageRuntime?.writeState(ownerKey, owner); }
    if (!prior) this.options.imageRuntime?.writeState(ownerKey, owner);
    const originals = owner.original && owner.entryId === matched?.entryId ? matched.originals : null;
    const base = { entryId: owner.entryId, revision: "1" }, parts: Parts[number][] = [], slots: NativeImageSlot[] = [];
    let truncated = false;
    const text = (value: string) => { truncated ||= value.length > 200_000; parts.push({ type: "text", text: limited(value) }); };
    const image = (value: unknown, nativePartId: string, originalIndex?: number, local = false, explicit?: NativeImagePayload) => {
      const original = originalIndex === undefined ? undefined : originals?.get(originalIndex), index = parts.length;
      parts.push({ type: "text", text: "" });
      slots.push({ index, label: "Native image", native: { provider: "codex", nativeSessionId: this.sessionId, nativeMessageId: owner.nativeMessageId, nativePartId }, payload: original ? { kind: "resource", resourceId: original.resourceId } : explicit ?? this.payload(value, local), ...(original ? { original } : {}) });
    };
    if (type === "userMessage") {
      for (const [index, raw] of (item.content as unknown[]).entries()) {
        const part = record(raw);
        if (part.type === "text") text(string(part.text));
        else if (part.type === "image" || part.type === "localImage") image(part.type === "localImage" ? part.path : part.url, `content/${index}`, index, part.type === "localImage");
        else text(`[Unsupported native content: ${string(part.type) || "unknown"}]`);
      }
      this.publisher.publish({ ...base, kind: "user_message", content: parts }, slots, { complete: completed, format: userMessageFormat(item.content as unknown[]), truncated });
      if (matched) this.inputs.confirm(matched);
      return true;
    }
    if (!completed && old?.entry.status !== undefined && old.entry.status !== "running") { this.publisher.publish(old.entry, safeSlots(old.slots), { complete: true, format: "plain", truncated: old.entry.truncated }); return true; }
    if (type === "imageView") image(item.path, "path", undefined, true);
    else if (type === "imageGeneration") {
      // fileId has no documented byte-read contract in this supported profile.
      if (item.failure || ["failed", "cancelled"].includes(string(item.status))) image(null, "result", undefined, false, unavailable("native_image_failed"));
      else if (item.status !== "completed") image(null, "result", undefined, false, { kind: "pending" });
      else image(codexMedia(item.result) ? item.result : typeof item.savedPath === "string" ? item.savedPath : null, "result", undefined, !codexMedia(item.result) && typeof item.savedPath === "string");
    } else if (type === "functionCallOutput" && typeof item.output === "string") text(item.output);
    else {
      if ((!Array.isArray(content) || !content.length) && old) {
        parts.push(...old.entry.output); slots.push(...safeSlots(old.slots)); truncated = old.entry.truncated;
      }
      for (const [index, raw] of (Array.isArray(content) ? content : []).entries()) {
        const part = record(raw), nativePartId = `${type === "mcpToolCall" ? "result/content" : type === "dynamicToolCall" ? "contentItems" : "output"}/${index}`;
        if (["text", "inputText", "input_text"].includes(string(part.type))) text(string(part.text));
        else if (part.type === "image") image(part.data, nativePartId);
        else if (part.type === "inputImage") image(part.imageUrl, nativePartId);
        else if (part.type === "input_image") image(part.image_url, nativePartId);
        else if (part.type === "resource") { const resource = record(part.resource); if (typeof resource.text === "string") text(resource.text); else image(resource.blob, nativePartId); }
        else text(`[Unsupported native content: ${string(part.type) || "unknown"}]`);
      }
    }
    const error = string(item.error) || string(record(item.error).message) || string(item.failure) || string(record(item.failure).message);
    if (error && !parts.some(part => part.type === "text" && part.text === limited(error))) text(error);
    const failed = ["failed", "declined", "cancelled"].includes(string(item.status)) || !!item.error || !!item.failure || item.success === false;
    const input = item.arguments !== undefined ? readable(item.arguments) : old?.entry.input ?? (type === "functionCallOutput" ? "Native function output; original call identity unavailable." : type);
    const entry: Tool = { ...base, kind: "tool_call", callId: id, name: string(item.tool) || string(item.name) || old?.entry.name || type, input: limited(input), output: parts, status: old?.entry.status === "failed" ? "failed" : failed ? "failed" : completed || old?.entry.status === "completed" ? "completed" : "running", truncated: truncated || input.length > 200_000 };
    this.tools.set(id, { entry, slots: safeSlots(slots) }); this.publisher.publish(entry, slots, { complete: entry.status !== "running", format: "plain", truncated: entry.truncated }); return true;
  }
  toolDelta(id: string, delta: string): boolean {
    const old = this.tools.get(id); if (!old) return false;
    const output = [...old.entry.output], textIndex = output.findIndex((part, index) => part.type === "text" && !old.slots.some(slot => slot.index === index));
    let truncated = old.entry.truncated;
    if (textIndex >= 0) { const part = output[textIndex]!; if (part.type === "text") { const text = part.text + delta; truncated ||= text.length > 200_000; output[textIndex] = { type: "text", text: limited(text) }; } }
    else { truncated ||= delta.length > 200_000; output.push({ type: "text", text: limited(delta) }); }
    old.entry = { ...old.entry, output, truncated }; this.publisher.publish(old.entry, safeSlots(old.slots), { complete: old.entry.status !== "running", format: "plain", truncated }); return true;
  }
}
