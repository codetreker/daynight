import type { InputObservation } from "../../../session/image-values.js";
import { NativeRpcError, record, string, type NativeObject } from "./native-rpc.js";
import { codexMedia } from "./codex-rpc-json.js";
import { nativeEntryId } from "./projection.js";
import type { NativeInput, ProviderOptions } from "./types.js";

export const encodeCodexInput = (input: NativeInput): NativeObject[] => input.content.every(part => part.type === "text")
  ? [{ type: "text", text: input.content.map(part => part.text).join("\n"), text_elements: [] }]
  : input.content.map(part => part.type === "text" ? { type: "text", text: part.text, text_elements: [] } : { type: "localImage", path: part.localPath });
type Saved = { nativeSessionId: string; operationId: string; intentSha256: string; expectedTurnId: string | null; acceptedTurnId: string | null; input: NativeInput; aliases: string[] };
export type CodexMatchedInput = { operationId: string; entryId: string; nativeMessageId: string; observation: InputObservation; originals: ReadonlyMap<number, { imageId: string; resourceId: string }> };

/** Original client identity joins native evidence to an immutable complete intent. */
export class CodexImageInputs {
  constructor(private readonly options: ProviderOptions, private readonly sessionId: string) {}
  private key(id: string): string { return `codex:input:${this.sessionId}:${id}`; }
  private saved(id: string): Saved | null { return this.options.imageRuntime?.readState(this.key(id)) as Saved | null ?? null; }
  private intentMatches(input: NativeInput, operationId: string, expectedTurnId: string | null): string | null {
    const intent = this.options.imageRuntime?.getIntent(operationId);
    if (!intent || intent.command.kind !== "send_message" || intent.command.operationId !== operationId) return null;
    const payload = intent.command.payload;
    if (payload.expectedTurnId !== expectedTurnId || payload.target?.expectedNativeSessionId !== null && payload.target?.expectedNativeSessionId !== this.sessionId || input.content.length !== payload.content.length) return null;
    if (!input.content.every((part, index) => {
      const original = payload.content[index]!;
      return part.type === "text" ? original.type === "text" && original.text === part.text : original.type === "image" && ["imageId", "resourceId", "sha256", "byteLength"].every(key => part[key as keyof typeof part] === original[key as keyof typeof original]);
    })) return null;
    return intent.sha256;
  }
  prepare(input: NativeInput, operationId: string, expectedTurnId: string | null): void {
    if (!input.content.some(part => part.type === "image")) return;
    const intentSha256 = this.intentMatches(input, operationId, expectedTurnId);
    if (!intentSha256) throw new NativeRpcError(-32602, "Native image input does not match the complete authorized intent.");
    if (this.saved(operationId)) throw new NativeRpcError(-32602, "The original native image input has already been dispatched.");
    this.options.imageRuntime!.writeState(this.key(operationId), { nativeSessionId: this.sessionId, operationId, intentSha256, expectedTurnId, acceptedTurnId: null, input, aliases: [] } satisfies Saved);
  }
  accepted(operationId: string, turnId: string): CodexMatchedInput | null {
    const saved = this.saved(operationId); if (!saved || this.intentMatches(saved.input, operationId, saved.expectedTurnId) !== saved.intentSha256) return null;
    if (!turnId || saved.expectedTurnId && saved.expectedTurnId !== turnId || saved.acceptedTurnId && saved.acceptedTurnId !== turnId) throw new Error("Native image input turn identity differs.");
    saved.acceptedTurnId = turnId; this.options.imageRuntime!.writeState(this.key(operationId), saved);
    return this.association(saved);
  }
  original(operationId: string): NativeInput | null { return this.saved(operationId)?.input ?? null; }
  match(raw: NativeObject, turnId: string): CodexMatchedInput | null {
    const operationId = string(raw.clientId), saved = this.saved(operationId);
    if (raw.type !== "userMessage" || !operationId || !string(raw.id) || !turnId || !saved || saved.nativeSessionId !== this.sessionId || this.intentMatches(saved.input, operationId, saved.expectedTurnId) !== saved.intentSha256) return null;
    if (saved.expectedTurnId && saved.expectedTurnId !== turnId || saved.acceptedTurnId && saved.acceptedTurnId !== turnId || !Array.isArray(raw.content) || raw.content.length !== saved.input.content.length) return null;
    const originals = new Map<number, { imageId: string; resourceId: string }>();
    for (const [index, original] of saved.input.content.entries()) {
      const part = record(raw.content[index]);
      if (original.type === "text") { if (part.type !== "text" || part.text !== original.text) return null; continue; }
      const media = codexMedia(part.url);
      if (!(part.type === "localImage" && part.path === original.localPath || part.type === "image" && media?.status === "available" && media.byteLength === Number(original.byteLength) && media.sha256 === original.sha256)) return null;
      originals.set(index, { imageId: original.imageId, resourceId: original.resourceId });
    }
    if (!saved.aliases.includes(string(raw.id))) {
      if (saved.aliases.length >= 1000) throw new Error("Native input alias budget exceeded.");
      saved.aliases.push(string(raw.id));
    }
    saved.acceptedTurnId = turnId;
    this.options.imageRuntime!.writeState(this.key(operationId), saved);
    // Codex preserves clientUserMessageId as userMessage.clientId across
    // history reconstruction; its raw item IDs remain separate trusted aliases.
    return this.association(saved);
  }
  private association(saved: Saved): CodexMatchedInput {
    const operationId = saved.operationId, nativeMessageId = operationId, entryId = nativeEntryId(this.sessionId, `input:${operationId}`);
    const originals = new Map<number, { imageId: string; resourceId: string }>();
    for (const [index, part] of saved.input.content.entries()) if (part.type === "image") originals.set(index, { imageId: part.imageId, resourceId: part.resourceId });
    return { operationId, nativeMessageId, entryId, originals, observation: { operationId, nativeSessionId: this.sessionId, intentSha256: saved.intentSha256, nativeMessageId, provider: "codex" } };
  }
  confirm(match: CodexMatchedInput): boolean { return this.options.onInputObserved?.(match.observation) === true; }
}
