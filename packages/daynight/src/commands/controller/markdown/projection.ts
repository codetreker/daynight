import { createHash, randomUUID } from "node:crypto";
import type { ProviderEntry } from "../providers/types.js";
import type { MessagePart } from "../../../session/protocol.js";
import { parseImagePart, parseMarkdownImagePart, type ImageOccurrence, type ImagePart, type ImageUnavailablePart, type MarkdownImageBinding, type MarkdownImageMetadata, type MarkdownImagePart, type RetainedMarkdownImage } from "../../../session/image-values.js";
import { parseMarkdownImages, type MarkdownSourceNode } from "./parser.js";

export type MarkdownProjectionPartInput = {
  readonly inputIndex: number;
  /** Native block identity, or a mapping durably allocated before the first projection. */
  readonly sourceKey: string;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly format: "markdown" | "plain";
  readonly contextKey: string;
};
export type MarkdownProjectionMetadata = { readonly parts: readonly MarkdownProjectionPartInput[] };
export type MarkdownProjectedOccurrence = {
  readonly occurrence: ImageOccurrence;
  readonly destination: string;
  readonly linkHref: string | null;
  readonly contextKey: string;
  readonly start: number;
  readonly end: number;
  readonly part: ImagePart | ImageUnavailablePart;
};
export type MarkdownProjectionPartState = {
  readonly sourceKey: string;
  readonly partId: string;
  readonly revision: string;
  readonly textSha256: string;
  readonly contextKey: string;
  readonly inputIndex: number | null;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly format: "markdown" | "plain";
  readonly status: "streaming" | "pending" | "complete" | "failed" | "plain" | "removed";
  readonly current: readonly MarkdownProjectedOccurrence[];
  readonly retained: readonly MarkdownProjectedOccurrence[];
  readonly cache: { readonly textSha256: string; readonly contextKey: string; readonly occurrences: readonly MarkdownProjectedOccurrence[] } | null;
};
/** JSON-only state: the caller persists it with the projected entry before any source registration. */
export type MarkdownProjectionState = {
  readonly schemaVersion: 1;
  readonly entryId: string;
  readonly token: string;
  readonly input: ProviderEntry;
  readonly parts: readonly MarkdownProjectionPartState[];
  readonly pending: boolean;
};
export type MarkdownProjectionResult = {
  readonly state: MarkdownProjectionState;
  readonly entry: ProviderEntry;
  readonly token: string;
  readonly pending: boolean;
  readonly failed: boolean;
  readonly occurrences: readonly MarkdownProjectedOccurrence[];
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex"), EMPTY_SHA = sha("");
const projectionError = { code: "source_unavailable", message: "Markdown image analysis is unavailable." };
function content(entry: ProviderEntry): readonly MessagePart[] | null {
  if (entry.kind === "user_message" || entry.kind === "assistant_message") return entry.content;
  if (entry.kind === "tool_call") return entry.output;
  if (entry.kind === "reasoning") return [{ type: "text", text: entry.text }];
  return null;
}
function sourceText(state: MarkdownProjectionState, part: MarkdownProjectionPartState): string {
  if (part.inputIndex === null) return "";
  const value = content(state.input)?.[part.inputIndex];
  if (value?.type !== "text") throw new Error("Invalid Markdown projection input.");
  return value.text;
}
const unique = (values: readonly MarkdownProjectedOccurrence[]) => [...new Map(values.map(value => [value.occurrence.imageId, value])).values()];
const binding = (source: MarkdownProjectedOccurrence): MarkdownImageBinding => ({ imageId: source.occurrence.imageId, start: source.start, end: source.end, part: source.part });
const retained = (source: MarkdownProjectedOccurrence): RetainedMarkdownImage => ({ ...binding(source), sourceRevision: source.occurrence.sourceRevision!, sourceTextSha256: source.occurrence.sourceTextSha256!, linkHref: source.linkHref });
function metadata(part: MarkdownProjectionPartState, text: string, carrier = false): MarkdownImageMetadata {
  return { partId: part.partId, revision: part.revision, textSha256: carrier ? EMPTY_SHA : sha(text), complete: carrier || part.status === "complete" || part.status === "failed" && part.complete, truncated: carrier ? false : part.truncated, bindings: part.status === "failed" && !carrier ? null : carrier ? [] : part.current.map(binding), retainedImages: part.retained.map(retained) };
}
function imageCarrier(part: MarkdownProjectionPartState): MarkdownImagePart { return { type: "markdown", text: "", ...metadata(part, "", true) }; }
function render(state: MarkdownProjectionState): ProviderEntry {
  const input = state.input, body = content(input); if (!body) return input;
  const failed = state.parts.some(part => part.status === "failed");
  if (input.kind === "reasoning") {
    const part = state.parts[0]; if (!part) return input;
    return { ...input, markdown: metadata(part, input.text), imageProjectionError: failed ? projectionError : null };
  }
  const projected: MessagePart[] = [];
  for (const [index, original] of body.entries()) {
    const part = state.parts.find(value => value.inputIndex === index);
    if (!part || original.type !== "text") { projected.push(original); continue; }
    if (part.status === "failed") projected.push(original, imageCarrier(part));
    else if (part.status === "plain") { projected.push(original); if (part.retained.length) projected.push(imageCarrier(part)); }
    else projected.push({ type: "markdown", text: original.text, ...metadata(part, original.text) });
  }
  for (const part of state.parts) if (part.status === "removed") projected.push(imageCarrier(part));
  if (input.kind === "tool_call") return { ...input, output: projected, imageProjectionError: failed ? projectionError : null };
  if (input.kind === "user_message" || input.kind === "assistant_message") return { ...input, content: projected, imageProjectionError: failed ? projectionError : null };
  return input;
}
function result(state: MarkdownProjectionState, occurrences: readonly MarkdownProjectedOccurrence[] = []): MarkdownProjectionResult {
  return { state, entry: render(state), token: state.token, pending: state.pending, failed: state.parts.some(part => part.status === "failed"), occurrences };
}
export function createMarkdownImageProjector(options: { parse?: (text: string) => Promise<readonly MarkdownSourceNode[]> } = {}) {
  const parse = options.parse ?? parseMarkdownImages;
  const prepare = (input: ProviderEntry, meta: MarkdownProjectionMetadata, previous: MarkdownProjectionState | null): MarkdownProjectionResult => {
    if (previous && (previous.schemaVersion !== 1 || previous.entryId !== input.entryId || previous.input.kind !== input.kind || previous.input.kind === "tool_call" && input.kind === "tool_call" && previous.input.callId !== input.callId)) throw new Error("Markdown projection identity changed.");
    const body = content(input), indices = new Set<number>(), keys = new Set<string>();
    const parts: MarkdownProjectionPartState[] = [];
    for (const descriptor of meta.parts) {
      if (!Number.isSafeInteger(descriptor.inputIndex) || descriptor.inputIndex < 0 || !descriptor.sourceKey || !descriptor.contextKey || keys.has(descriptor.sourceKey) || indices.has(descriptor.inputIndex) || body?.[descriptor.inputIndex]?.type !== "text") throw new Error("Markdown projection requires trusted unique block identities.");
      indices.add(descriptor.inputIndex); keys.add(descriptor.sourceKey);
      const text = (body[descriptor.inputIndex] as { text: string }).text;
      if (text.length > 1_048_576 || Buffer.byteLength(text) > 1_048_576) throw new Error("Markdown projection text capacity exceeded.");
      const textSha256 = sha(text), old = previous?.parts.find(part => part.sourceKey === descriptor.sourceKey);
      const sameBody = old?.textSha256 === textSha256 && old.contextKey === descriptor.contextKey && old.format === descriptor.format && old.status !== "removed";
      const cache = sameBody ? old.cache : null, canReuse = descriptor.complete && !descriptor.truncated && descriptor.format === "markdown" && cache?.textSha256 === textSha256 && cache.contextKey === descriptor.contextKey;
      const current = canReuse ? cache.occurrences : [], currentIds = new Set(current.map(value => value.occurrence.imageId));
      const oldImages = unique([...(old?.retained ?? []), ...(old?.current ?? [])]).filter(value => !currentIds.has(value.occurrence.imageId));
      const needsBodyRevision = old && (!sameBody || old.status === "failed");
      parts.push({ ...descriptor, partId: old?.partId ?? randomUUID(), revision: old ? String(BigInt(old.revision) + (needsBodyRevision ? 1n : 0n)) : "1", textSha256, current, retained: oldImages, cache, status: descriptor.format === "plain" ? "plain" : !descriptor.complete || descriptor.truncated ? "streaming" : canReuse ? "complete" : "pending" });
    }
    for (const old of previous?.parts ?? []) if (!keys.has(old.sourceKey)) parts.push({ ...old, revision: String(BigInt(old.revision) + (old.status === "removed" ? 0n : 1n)), inputIndex: null, textSha256: EMPTY_SHA, current: [], retained: unique([...old.retained, ...old.current]), status: "removed" });
    if (input.kind === "reasoning" && parts.length > 1) throw new Error("Reasoning Markdown identity changed.");
    const state: MarkdownProjectionState = { schemaVersion: 1, entryId: input.entryId, token: randomUUID(), input: structuredClone(input), parts, pending: parts.some(part => part.status === "pending") };
    return result(state);
  };
  const complete = async (input: MarkdownProjectionState): Promise<MarkdownProjectionResult> => {
    const occurrences: MarkdownProjectedOccurrence[] = [], parts: MarkdownProjectionPartState[] = [];
    for (const part of input.parts) {
      if (part.status !== "pending") { parts.push(part); continue; }
      const text = sourceText(input, part);
      try {
        const nodes = await parse(text), current: MarkdownProjectedOccurrence[] = [];
        if (nodes.length > 1000) throw new Error("Markdown image node budget exceeded.");
        let lastEnd = 0;
        for (const node of nodes) {
          if (!Number.isSafeInteger(node.start) || !Number.isSafeInteger(node.end) || node.start < lastEnd || node.end <= node.start || node.end > text.length) throw new Error("Invalid Markdown image source range.");
          for (const offset of [node.start, node.end]) if (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!)) throw new Error("Invalid Markdown image source range.");
          lastEnd = node.end; const imageId = randomUUID();
          const occurrence: ImageOccurrence = { imageId, entryId: input.entryId, container: input.input.kind === "reasoning" ? "reasoning" : input.input.kind === "tool_call" ? "tool_output" : "content", partId: part.partId, sourceRevision: part.revision, sourceTextSha256: part.textSha256, callId: input.input.kind === "tool_call" ? input.input.callId : null, sourceKey: `markdown:${part.partId}:${part.revision}:${imageId}` };
          current.push({ occurrence, destination: node.destination, linkHref: node.linkHref, contextKey: part.contextKey, start: node.start, end: node.end, part: { type: "image_unavailable", imageId, label: node.label, error: { code: "source_unavailable", message: "Image has not been captured." } } });
        }
        const resolved: MarkdownProjectionPartState = { ...part, current, cache: { textSha256: part.textSha256, contextKey: part.contextKey, occurrences: current }, status: "complete" };
        if (input.input.kind !== "reasoning") parseMarkdownImagePart({ type: "markdown", text, ...metadata(resolved, text) });
        parts.push(resolved); occurrences.push(...current);
      } catch {
        parts.push({ ...part, revision: String(BigInt(part.revision) + (input.input.kind === "reasoning" ? 0n : 1n)), current: [], retained: unique([...part.retained, ...part.current]), status: "failed" });
      }
    }
    return { ...result({ ...input, token: input.pending ? randomUUID() : input.token, parts, pending: false }, occurrences), token: input.token };
  };
  const updateImagePart = (input: MarkdownProjectionState, imageId: string, replacement: ImagePart | ImageUnavailablePart): MarkdownProjectionResult => {
    const part = parseImagePart(replacement); if (part.imageId !== imageId) throw new Error("Image occurrence identity changed.");
    let found = false;
    const update = (values: readonly MarkdownProjectedOccurrence[]) => values.map(value => { if (value.occurrence.imageId !== imageId) return value; found = true; return { ...value, part }; });
    const parts = input.parts.map(value => ({ ...value, current: update(value.current), retained: update(value.retained), cache: value.cache ? { ...value.cache, occurrences: update(value.cache.occurrences) } : null }));
    if (!found) throw new Error("Image occurrence is not owned by this Markdown entry.");
    return { ...result({ ...input, token: randomUUID(), parts }), token: input.token };
  };
  const markFailed = (input: MarkdownProjectionState): MarkdownProjectionResult => {
    const parts = input.parts.map(part => part.status === "pending" || part.status === "streaming" ? { ...part, revision: String(BigInt(part.revision) + (input.input.kind === "reasoning" ? 0n : 1n)), current: [], retained: unique([...part.retained, ...part.current]), status: "failed" as const } : part);
    return { ...result({ ...input, token: randomUUID(), parts, pending: false }), token: input.token };
  };
  return { prepare, complete, updateImagePart, markFailed, view: (state: MarkdownProjectionState) => result(state) };
}
