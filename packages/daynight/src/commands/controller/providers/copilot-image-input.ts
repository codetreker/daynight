import { canonicalImageJson, type InputObservation } from "../../../session/image-values.js";
import { NativeRpcError, record, string } from "./native-rpc.js";
import { nativeEntryId } from "./projection.js";
import { copilotOwner } from "./copilot-projection.js";
import type { NativeImageSlot } from "./image-projector.js";
import type { NativeImagePart, NativeInput, ProviderEntry, ProviderOptions } from "./types.js";
import type { NativeInputPublicationIdentity, NativeInputPublicationQuery, NativeInputPublicationRequest, NativeInputPublicationResult } from "../media/native-publication-types.js";

export type CopilotPublicationSlot = Omit<NativeImageSlot, "payload"> & { imageId: string; sourceKey: string };
export type CopilotInputPublication = {
  nativeEventId: string;
  raw: unknown;
  entry: Extract<ProviderEntry, { kind: "user_message" | "assistant_message" }> & { kind: "user_message" };
  slots: CopilotPublicationSlot[];
};
export type CopilotPublicationIntent = { raw: unknown; request: NativeInputPublicationRequest };
export type CopilotPublicationProposal = Omit<NativeInputPublicationRequest, "identity"> & { raw: unknown };
type Saved = { nativeSessionId: string; operationId: string; intentSha256: string; input: NativeInput; expectedTurnId: string | null; messageId: string | null; publication?: CopilotInputPublication | null; publicationIntent?: CopilotPublicationIntent };
export type CopilotInputMatch = { operationId: string; messageId: string; images: readonly NativeImagePart[] };

/** Native acceptance and publication intent survive independently of the shared commit receipt. */
export class CopilotImageInputs {
  private readonly receipts = new Map<string, string>();
  private readonly confirmed = new Set<string>();
  private readonly committed = new Set<string>();
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
  private identity(saved: Saved): NativeInputPublicationIdentity {
    return { provider: "copilot", nativeSessionId: this.session, operationId: saved.operationId, intentSha256: saved.intentSha256, nativeMessageId: saved.messageId!, entryId: nativeEntryId(this.session, `:user:${saved.messageId}`) };
  }
  private checked(saved: Saved, result: NativeInputPublicationResult | NativeInputPublicationQuery): typeof result {
    if (result.state === "committed") {
      const originals = this.matchOf(saved).images;
      if (canonicalImageJson(result.receipt.identity) !== canonicalImageJson(this.identity(saved)) || result.view.entry.entryId !== this.identity(saved).entryId || result.receipt.originalSlots.length !== originals.length || result.receipt.originalSlots.some((slot, index) => slot.imageId !== originals[index]!.imageId || slot.resourceId !== originals[index]!.resourceId)) throw new Error("Copilot shared publication receipt identity differs.");
      this.committed.add(saved.operationId);
    }
    return result;
  }
  private unknown(): Extract<NativeInputPublicationResult, { state: "unknown" }> {
    return { state: "unknown", error: { code: "publication_unknown", message: "The original input publication outcome is unknown; only its committed identity can be queried." } };
  }
  publication(messageId: string): NativeInputPublicationQuery | null {
    const operationId = this.receipts.get(messageId);
    const saved = operationId && this.confirmed.has(operationId) ? this.get(operationId) : null;
    if (!saved) return null;
    const query = this.options.imageRuntime?.queryNativeInputAssociation;
    if (!query) return this.unknown();
    try { return this.checked(saved, query(this.identity(saved))) as NativeInputPublicationQuery; }
    catch { return this.unknown(); }
  }
  publicationIntent(messageId: string): CopilotPublicationIntent | null {
    const operationId = this.receipts.get(messageId);
    return operationId && this.confirmed.has(operationId) ? this.get(operationId)?.publicationIntent ?? null : null;
  }
  acceptedMatch(messageId: string): CopilotInputMatch | null {
    const operationId = this.receipts.get(messageId), saved = operationId && this.confirmed.has(operationId) ? this.get(operationId) : null;
    return saved && this.digest(saved.input, saved.operationId, saved.expectedTurnId) === saved.intentSha256 ? this.matchOf(saved) : null;
  }
  legacyPublication(messageId: string): CopilotInputPublication | null {
    const operationId = this.receipts.get(messageId);
    return operationId && this.confirmed.has(operationId) ? this.get(operationId)?.publication ?? null : null;
  }
  associate(match: CopilotInputMatch, proposal: CopilotPublicationProposal): NativeInputPublicationResult {
    const saved = this.get(match.operationId);
    if (!saved || !this.confirmed.has(match.operationId) || saved.messageId !== match.messageId || this.match(proposal.raw)?.operationId !== match.operationId) throw new Error("Copilot original image association is unconfirmed.");
    const identity = this.identity(saved), { seed, originals } = proposal;
    if (seed.entry.entryId !== identity.entryId || originals.length !== match.images.length || originals.some((original, index) => original.imageId !== match.images[index]!.imageId || original.resourceId !== match.images[index]!.resourceId)) throw new Error("Copilot original images changed their published owner or order.");
    for (const original of originals) {
      const slot = seed.nativeSlots.find(slot => slot.index === original.nativeSlotIndex), source = original.appendNativeSource;
      if (!slot || slot.nativeSource.provider !== "copilot" || slot.nativeSource.nativeSessionId !== this.session || slot.nativeSource.nativeMessageId !== match.messageId || source.provider !== "copilot" || source.nativeSessionId !== this.session || source.nativeMessageId !== match.messageId) throw new Error("Copilot original image source identity differs.");
    }
    const request: NativeInputPublicationRequest = { identity, seed, originals };
    if (saved.publicationIntent) {
      if (canonicalImageJson(saved.publicationIntent.request) !== canonicalImageJson(request)) throw new Error("Copilot original image publication intent cannot change its stable identity.");
    } else {
      // This write is recovery intent only. The shared receipt and current view
      // are the sole evidence of publication, including for legacy plans.
      this.options.imageRuntime!.writeState(this.key("input", match.operationId), { ...saved, publicationIntent: { raw: proposal.raw, request } });
    }
    const queried = this.publication(match.messageId);
    if (!queried || queried.state === "unknown") return queried ?? this.unknown();
    if (queried.state === "committed") return queried;
    const publish = this.options.imageRuntime?.publishNativeInputAssociation;
    if (!publish) return { state: "not_committed", error: { code: "publication_unavailable", message: "Atomic native input publication is unavailable." } };
    try { return this.checked(saved, publish(request)) as NativeInputPublicationResult; }
    catch { return this.unknown(); }
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
    return this.operationIds().flatMap(operationId => { const saved = this.get(operationId); return saved?.messageId && !this.committed.has(operationId) && this.confirmed.has(operationId) ? [this.matchOf(saved)] : []; });
  }
  finishTurn(): void { if (this.pendingAccepted().some(match => { const saved = this.get(match.operationId); return !saved?.publicationIntent && !saved?.publication; })) this.block(); }
  get profileAllowed(): boolean { return record(this.options.imageRuntime?.readState(this.key("profile", "association"))).blocked !== true; }
}
