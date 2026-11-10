import { canonicalImageJson, type InputObservation } from "../../../session/image-values.js";
import { NativeRpcError, record, string } from "./native-rpc.js";
import { nativeEntryId } from "./projection.js";
import { copilotOwner } from "./copilot-projection.js";
import type { NativeImageSlot } from "./image-projector.js";
import type { NativeImagePart, NativeInput, ProviderEntry, ProviderOptions } from "./types.js";

export type CopilotPublicationSlot = Omit<NativeImageSlot, "payload"> & { imageId: string; sourceKey: string };
export type CopilotInputPublication = {
  nativeEventId: string;
  raw: unknown;
  entry: Extract<ProviderEntry, { kind: "user_message" | "assistant_message" }> & { kind: "user_message" };
  slots: CopilotPublicationSlot[];
};
type Saved = { nativeSessionId: string; operationId: string; intentSha256: string; input: NativeInput; expectedTurnId: string | null; messageId: string | null; publication: CopilotInputPublication | null };
export type CopilotInputMatch = { operationId: string; messageId: string; images: readonly NativeImagePart[] };

/** Each original receipt and its immutable publication plan have one durable identity owner. */
export class CopilotImageInputs {
  private readonly receipts = new Map<string, string>();
  private readonly confirmed = new Set<string>();
  constructor(private readonly options: ProviderOptions, private readonly session: string) {
    for (const id of this.operationIds()) {
      const saved = this.get(id);
      if (saved?.messageId) {
        if (this.receipts.has(saved.messageId)) throw new Error("Copilot native message identity conflicts with another original operation.");
        this.receipts.set(saved.messageId, id);
      }
    }
  }
  private key(kind: string, value: string): string { return `copilot:${kind}:${nativeEntryId(this.session, value)}`; }
  private get operationsKey(): string { return this.key("index", "inputs"); }
  private operationIds(): string[] { const value = this.options.imageRuntime?.readState(this.operationsKey); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []; }
  private get(operationId: string): Saved | null { return this.options.imageRuntime?.readState(this.key("input", operationId)) as Saved | null ?? null; }
  private block(): void { this.options.imageRuntime?.writeState(this.key("profile", "association"), { blocked: true }); }
  private digest(input: NativeInput, operationId: string, expectedTurnId: string | null): string | null {
    const intent = this.options.imageRuntime?.getIntent(operationId);
    if (!intent || intent.command.kind !== "send_message" || intent.command.operationId !== operationId) return null;
    const payload = intent.command.payload;
    if (payload.expectedTurnId !== expectedTurnId || payload.target?.expectedNativeSessionId !== null && payload.target?.expectedNativeSessionId !== this.session || input.content.length !== payload.content.length) return null;
    if (!input.content.every((part, index) => {
      const original = payload.content[index]!;
      return part.type === "text" ? original.type === "text" && part.text === original.text : original.type === "image" && part.imageId === original.imageId && part.resourceId === original.resourceId && part.sha256 === original.sha256 && part.byteLength === original.byteLength;
    })) return null;
    return intent.sha256;
  }
  private matchOf(saved: Saved): CopilotInputMatch {
    return { operationId: saved.operationId, messageId: saved.messageId!, images: saved.input.content.filter((part): part is NativeImagePart => part.type === "image") };
  }
  private confirm(saved: Saved): boolean {
    if (this.confirmed.has(saved.operationId)) return true;
    if (!saved.messageId || saved.nativeSessionId !== this.session || this.digest(saved.input, saved.operationId, saved.expectedTurnId) !== saved.intentSha256) return false;
    const observation: InputObservation = { provider: "copilot", nativeSessionId: this.session, operationId: saved.operationId, intentSha256: saved.intentSha256, nativeMessageId: saved.messageId };
    if (this.options.onInputObserved?.(observation) !== true) return false;
    this.confirmed.add(saved.operationId); return true;
  }
  prepare(input: NativeInput, operationId: string, expectedTurnId: string | null): void {
    const intentSha256 = this.digest(input, operationId, expectedTurnId);
    if (!intentSha256) throw new NativeRpcError(-32602, "Copilot image input differs from its complete authorized intent.");
    if (this.get(operationId)) throw new NativeRpcError(-32602, "The original Copilot image operation has already been dispatched.");
    const operations = new Set(this.operationIds()); operations.add(operationId);
    if (operations.size > 1000) throw new NativeRpcError(-32602, "Copilot original input index exceeded its bound.");
    // An index-only crash cannot hide a dispatch: no native call occurs until
    // both writes return, and recovery ignores entries without an input record.
    this.options.imageRuntime!.writeState(this.operationsKey, [...operations]);
    this.options.imageRuntime!.writeState(this.key("input", operationId), { nativeSessionId: this.session, operationId, intentSha256, input, expectedTurnId, messageId: null, publication: null } satisfies Saved);
  }
  accept(operationId: string, messageId: unknown): CopilotInputMatch {
    const saved = this.get(operationId);
    if (!saved || typeof messageId !== "string" || !messageId || this.digest(saved.input, operationId, saved.expectedTurnId) !== saved.intentSha256 || saved.messageId && saved.messageId !== messageId) throw new Error("Copilot image acceptance has no stable native receipt; outcome is unknown.");
    const previous = this.receipts.get(messageId);
    if (previous !== undefined && previous !== operationId) throw new Error("Copilot native message identity conflicts with another original operation.");
    if (!saved.messageId) this.options.imageRuntime!.writeState(this.key("input", operationId), { ...saved, messageId });
    saved.messageId = messageId; this.receipts.set(messageId, operationId);
    if (!this.confirm(saved)) throw new Error("Copilot image acceptance was not durably recorded; outcome is unknown.");
    return this.matchOf(saved);
  }
  match(raw: unknown): CopilotInputMatch | null {
    const event = record(raw), data = record(event.data), messageId = string(event.id);
    if (event.type !== "user.message" || !messageId || copilotOwner(event)) return null;
    const operationId = this.receipts.get(messageId); if (!operationId || !this.confirmed.has(operationId)) return null;
    const saved = this.get(operationId);
    if (!saved || saved.messageId !== messageId || saved.nativeSessionId !== this.session || this.digest(saved.input, operationId, saved.expectedTurnId) !== saved.intentSha256) return null;
    const match = this.matchOf(saved), text = saved.input.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    if (data.content !== text || !Array.isArray(data.attachments) || data.attachments.length !== match.images.length || !match.images.every((part, index) => {
      const attachment = record((data.attachments as unknown[])[index]);
      return attachment.type === "blob" && attachment.mimeType === part.mediaType;
    })) { this.block(); return null; }
    return match;
  }
  publication(messageId: string): CopilotInputPublication | null {
    const operationId = this.receipts.get(messageId);
    return operationId && this.confirmed.has(operationId) ? this.get(operationId)?.publication ?? null : null;
  }
  associate(match: CopilotInputMatch, publication: CopilotInputPublication): CopilotInputPublication {
    const saved = this.get(match.operationId);
    if (!saved || !this.confirmed.has(match.operationId) || saved.messageId !== match.messageId || publication.nativeEventId !== match.messageId || this.match(publication.raw)?.operationId !== match.operationId) throw new Error("Copilot original image association is unconfirmed.");
    const originals = publication.slots.flatMap(slot => slot.original ? [slot.original] : []);
    if (publication.entry.entryId !== nativeEntryId(this.session, `:user:${match.messageId}`) || originals.length !== match.images.length || originals.some((original, index) => original.imageId !== match.images[index]!.imageId || original.resourceId !== match.images[index]!.resourceId)) throw new Error("Copilot original images changed their published owner or order.");
    let previousIndex = -1;
    for (const slot of publication.slots) {
      const sourceKey = canonicalImageJson([1, slot.native, publication.entry.entryId, "content", null, slot.index]);
      const part = publication.entry.content[slot.index];
      if (!Number.isSafeInteger(slot.index) || slot.index <= previousIndex || slot.native.provider !== "copilot" || slot.native.nativeSessionId !== this.session || slot.native.nativeMessageId !== match.messageId || slot.sourceKey !== sourceKey || slot.imageId !== (slot.original?.imageId ?? nativeEntryId(this.session, `image:${sourceKey}`)) || !part || part.type !== "image" && part.type !== "image_unavailable" || part.imageId !== slot.imageId) throw new Error("Copilot publication contains an unstable image position.");
      previousIndex = slot.index;
    }
    if (saved.publication) {
      if (canonicalImageJson(saved.publication) !== canonicalImageJson(publication)) throw new Error("Copilot original image publication cannot change its stable identity.");
      return saved.publication;
    }
    // The full receipt, alias, slot identities and ordering commit in one row.
    // Timeline and occurrence callbacks only materialize this immutable plan.
    this.options.imageRuntime!.writeState(this.key("input", match.operationId), { ...saved, publication });
    return publication;
  }
  restoreAccepted(): CopilotInputMatch[] {
    const accepted: CopilotInputMatch[] = [];
    for (const operationId of this.operationIds()) {
      const saved = this.get(operationId); if (!saved?.messageId) continue;
      if (this.confirm(saved)) accepted.push(this.matchOf(saved));
      else this.block();
    }
    return accepted;
  }
  pendingAccepted(): CopilotInputMatch[] {
    return this.operationIds().flatMap(operationId => { const saved = this.get(operationId); return saved?.messageId && !saved.publication && this.confirmed.has(operationId) ? [this.matchOf(saved)] : []; });
  }
  finishTurn(): void { if (this.pendingAccepted().length) this.block(); }
  get profileAllowed(): boolean { return record(this.options.imageRuntime?.readState(this.key("profile", "association"))).blocked !== true; }
}
