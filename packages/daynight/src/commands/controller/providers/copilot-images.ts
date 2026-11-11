import { canonicalImageJson, type NativeImageSource } from "../../../session/image-values.js";
import { isCopilotBridgeImage, releaseCopilotBridgeImage, retainCopilotBridgeImage, type CopilotBridgeImage } from "./copilot-bridge.js";
import { CopilotImageInputs, type CopilotInputMatch, type CopilotPublicationProposal } from "./copilot-image-input.js";
import { ProviderImageProjector, type NativeImagePayload, type NativeImageSlot } from "./image-projector.js";
import { record, string } from "./native-rpc.js";
import { limited, nativeEntryId, readable } from "./projection.js";
import type { MarkdownTimelineMetadata, ProviderEntry, ProviderOptions } from "./types.js";

type Message = Extract<ProviderEntry, { kind: "user_message" | "assistant_message" }> & { kind: "user_message" };
type Tool = Extract<ProviderEntry, { kind: "tool_call" }>;
type Parts = Array<Message["content"][number]>;
type SlotIdentity = Omit<NativeImageSlot, "payload">;
type Published = { raw: unknown; entry: Message; slots: SlotIdentity[]; metadata?: MarkdownTimelineMetadata };
type Asset = { marker: CopilotBridgeImage; release(): void } | { error: string };
const unavailable = (code = "source_unavailable"): NativeImagePayload => ({ kind: "unavailable", error: { code, message: "The original native image is unavailable." } });
const imageMime = (value: unknown) => typeof value === "string" && ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"].includes(value);
const placeholder = (source: NativeImageSource) => ({ type: "image_unavailable" as const, imageId: nativeEntryId(source.nativeSessionId, `${source.nativeMessageId}:${source.nativePartId}`), label: "Native image", error: { code: "capture_pending", message: "The original image is being saved." } });

/** One normalizer serves live events and history; only branded bridge bytes become file capabilities. */
export class CopilotImages {
  private readonly projector: ProviderImageProjector;
  private readonly assets = new Map<string, Asset>();
  private readonly waiting = new Map<string, Map<string, () => void>>();
  private readonly missing = new Map<string, string>();
  private readonly associations = new Map<string, { match: CopilotInputMatch; slots: NativeImageSlot[]; fallback?: Published }>();
  private publicationTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  constructor(private readonly options: ProviderOptions, private readonly session: string, private readonly inputs: CopilotImageInputs) { this.projector = new ProviderImageProjector(options); }
  private key(id: string): string { return `copilot:published:${nativeEntryId(this.session, id)}`; }
  private unavailableAsset(id: string, reason: string): void { if (this.missing.size >= 1000 && !this.missing.has(id)) this.missing.delete(this.missing.keys().next().value!); this.missing.set(id, reason); }
  private get pendingKey(): string { return `copilot:pending:${nativeEntryId(this.session, "sources")}`; }
  requiresReplay(): boolean {
    const saved = this.options.imageRuntime?.readState(this.pendingKey);
    return Array.isArray(saved) && saved.some(key => typeof key === "string" && record(this.options.imageRuntime?.readState(key)).phase !== "settled");
  }
  private withSlots(entry: ProviderEntry, slots: readonly NativeImageSlot[], metadata?: MarkdownTimelineMetadata): void {
    try { this.prepareSlots(entry, slots); }
    catch (error) { this.discardUnsubmitted(slots, error); }
    this.projector.publish(entry, slots, metadata);
  }
  private prepareSlots(entry: ProviderEntry, slots: readonly NativeImageSlot[]): void {
    if (slots.length && this.options.imageRuntime) {
      const saved = this.options.imageRuntime.readState(this.pendingKey), keys = new Set<string>(Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string" && record(this.options.imageRuntime!.readState(key)).phase !== "settled") : []);
      for (const slot of slots) {
        const sourceKey = canonicalImageJson([1, slot.native, entry.entryId, entry.kind === "tool_call" ? "tool_output" : "content", entry.kind === "tool_call" ? entry.callId : null, slot.index]);
        keys.add(`image-slot:${nativeEntryId(slot.native.nativeSessionId, sourceKey)}`);
      }
      if (keys.size > 1000) throw new Error("Copilot pending source index exceeded its bound.");
      this.options.imageRuntime.writeState(this.pendingKey, [...keys]);
    }
  }
  private discardUnsubmitted(slots: readonly NativeImageSlot[], error: unknown): never {
    try { this.projector.discard(slots); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Native image preparation and release failed."); }
    throw error;
  }
  private releaseSlots(slots: readonly NativeImageSlot[]): void { for (const slot of slots) if (slot.payload.kind === "file") slot.payload.release(); }
  private source(raw: unknown, field: string): NativeImageSource {
    const event = record(raw), data = record(event.data);
    return { provider: "copilot", nativeSessionId: this.session, nativeMessageId: string(event.id), nativePartId: nativeEntryId(this.session, JSON.stringify([string(event.agentId), string(data.parentToolCallId), field])) };
  }
  private file(marker: CopilotBridgeImage): NativeImagePayload {
    const release = retainCopilotBridgeImage(marker); releaseCopilotBridgeImage(marker);
    return { kind: "file", path: marker.path, byteLength: marker.byteLength, sha256: marker.sha256, release };
  }
  private payload(raw: unknown, bytes: unknown, entryId: string, replay: () => void, source: NativeImageSource): NativeImagePayload {
    const item = record(raw);
    if (isCopilotBridgeImage(bytes)) {
      const key = `copilot:source:${nativeEntryId(this.session, canonicalImageJson(source))}`, saved = this.options.imageRuntime?.readState(key);
      const identity = { sha256: bytes.sha256, byteLength: bytes.byteLength, mediaType: bytes.mediaType };
      if (saved && canonicalImageJson(saved) !== canonicalImageJson(identity)) { releaseCopilotBridgeImage(bytes); return unavailable("native_source_changed"); }
      this.options.imageRuntime?.writeState(key, identity); return this.file(bytes);
    }
    if (record(bytes).kind === "copilot_bridge_unavailable") return unavailable(string(record(bytes).code) || "source_unavailable");
    const assetId = string(item.assetId);
    if (assetId) {
      const asset = this.assets.get(assetId);
      if (asset && "marker" in asset) {
        if (item.byteLength !== undefined && String(item.byteLength) !== asset.marker.byteLength || item.mimeType !== undefined && item.mimeType !== asset.marker.mediaType) return unavailable("asset_identity_conflict");
        const release = retainCopilotBridgeImage(asset.marker);
        return { kind: "file", path: asset.marker.path, byteLength: asset.marker.byteLength, sha256: asset.marker.sha256, release };
      }
      if (asset && "error" in asset) return unavailable(asset.error);
      if (this.missing.has(assetId)) return unavailable(this.missing.get(assetId));
      if (this.assets.size >= 1000) return unavailable("capacity_exceeded");
      let owners = this.waiting.get(assetId);
      if (!owners) { if (this.waiting.size >= 1000) return unavailable("capacity_exceeded"); this.waiting.set(assetId, owners = new Map()); }
      if (owners.size >= 1000) return unavailable("capacity_exceeded"); owners.set(entryId, replay);
      return { kind: "pending" };
    }
    if (typeof item.path === "string") return { kind: "source", locator: { kind: "local", path: item.path, contextId: this.session } };
    if (typeof item.url === "string") return { kind: "source", locator: { kind: "external", url: item.url } };
    return unavailable("native_bytes_missing");
  }
  discard(raw: unknown): void {
    const visited = new Set<object>();
    const walk = (value: unknown) => {
      if (!value || typeof value !== "object" || visited.has(value)) return; visited.add(value);
      if (isCopilotBridgeImage(value)) { releaseCopilotBridgeImage(value); return; }
      for (const child of Object.values(value)) walk(child);
    };
    walk(raw);
  }
  publish(entry: ProviderEntry, metadata?: MarkdownTimelineMetadata): void { this.projector.publish(entry, [], metadata); }
  asset(raw: unknown): void {
    const data = record(record(raw).data), id = string(data.assetId), marker = data.data;
    if (!id) { if (isCopilotBridgeImage(marker)) releaseCopilotBridgeImage(marker); return; }
    const previous = this.assets.get(id), savedKey = `copilot:asset:${nativeEntryId(this.session, id)}`;
    const saved = this.options.imageRuntime?.readState(savedKey), identity: Record<string, unknown> = typeof saved === "string" ? { sha256: saved } : record(saved);
    const conflict = identity.error === "asset_identity_conflict" || previous && "error" in previous && previous.error === "asset_identity_conflict" || !isCopilotBridgeImage(marker) || String(data.byteLength) !== marker.byteLength || data.mimeType !== marker.mediaType || id.startsWith("sha256:") && id !== `sha256:${marker.sha256}` || identity.sha256 !== undefined && identity.sha256 !== marker.sha256 || identity.byteLength !== undefined && identity.byteLength !== marker.byteLength || identity.mediaType !== undefined && identity.mediaType !== marker.mediaType || previous && "marker" in previous && (previous.marker.sha256 !== marker.sha256 || previous.marker.byteLength !== marker.byteLength || previous.marker.mediaType !== marker.mediaType);
    if (this.assets.size >= 1000 && !previous) {
      this.unavailableAsset(id, "capacity_exceeded"); if (isCopilotBridgeImage(marker)) releaseCopilotBridgeImage(marker);
    } else if (conflict) {
      if (previous && "marker" in previous) previous.release();
      this.options.imageRuntime?.writeState(savedKey, { ...identity, error: "asset_identity_conflict" });
      this.assets.set(id, { error: "asset_identity_conflict" });
      if (isCopilotBridgeImage(marker)) releaseCopilotBridgeImage(marker);
    } else if (isCopilotBridgeImage(marker)) {
      this.options.imageRuntime?.writeState(savedKey, { sha256: marker.sha256, byteLength: marker.byteLength, mediaType: marker.mediaType });
      if (previous && "marker" in previous) previous.release();
      const release = retainCopilotBridgeImage(marker); releaseCopilotBridgeImage(marker); this.assets.set(id, { marker, release });
    }
    const waiting = this.waiting.get(id); this.waiting.delete(id);
    for (const replay of waiting?.values() ?? []) replay();
  }
  private proposal(match: CopilotInputMatch, raw: unknown, entry: Message, slots: readonly SlotIdentity[]): CopilotPublicationProposal {
    const content = [...entry.content];
    const nativeSlots = slots.map(slot => {
      const sourceKey = canonicalImageJson([1, slot.native, entry.entryId, "content", null, slot.index]);
      const imageId = nativeEntryId(this.session, `image:${sourceKey}`);
      content[slot.index] = { ...placeholder(slot.native), imageId };
      return { index: slot.index, nativeSource: slot.native, label: slot.label };
    });
    const { revision: _revision, ...seed } = entry;
    return { raw, seed: { entry: { ...seed, content, imageProjectionError: seed.imageProjectionError ?? null }, nativeSlots }, originals: match.images.map((image, index) => {
      const slot = nativeSlots[index]; if (!slot) throw new Error("Copilot original input has no exact native image position.");
      return { imageId: image.imageId, resourceId: image.resourceId, nativeSlotIndex: slot.index, appendNativeSource: this.source(raw, `original:${match.operationId}:${image.imageId}`) };
    }) };
  }
  private hold(match: CopilotInputMatch, current: readonly NativeImageSlot[]): NativeImageSlot[] {
    const held = this.associations.get(match.messageId)?.slots ?? [], failures: unknown[] = [];
    for (const incoming of current) {
      const index = held.findIndex(slot => canonicalImageJson(slot.native) === canonicalImageJson(incoming.native));
      if (index < 0) held.push(incoming);
      else if (held[index]!.payload.kind === "pending") held[index] = incoming;
      else try { this.releaseSlots([incoming]); } catch (error) { held.push(incoming); failures.push(error); }
    }
    this.associations.set(match.messageId, { ...this.associations.get(match.messageId), match, slots: held });
    if (failures.length) throw new AggregateError(failures, "Copilot repeated publication sources could not be released.");
    return held;
  }
  private schedulePublication(): void {
    if (this.stopped || this.publicationTimer) return;
    this.publicationTimer = setTimeout(() => { this.publicationTimer = null; this.reconcilePublications(); }, 1000);
    this.publicationTimer.unref();
  }
  private reconcilePublications(): void {
    if (this.stopped) return;
    for (const { match } of [...this.associations.values()]) {
      try { this.accepted(match); }
      catch { this.options.onDiagnostic?.("The original Copilot input publication could not be reconciled; its identity and sources are retained."); }
    }
    if (this.associations.size) this.schedulePublication();
  }
  user(raw: unknown, entry: Message, metadata?: MarkdownTimelineMetadata): void {
    const event = record(raw), data = record(event.data), attachments = Array.isArray(data.attachments) ? data.attachments : [];
    const match = this.inputs.match(raw), accepted = this.inputs.acceptedMatch(string(event.id)), parts = [...entry.content], slots: NativeImageSlot[] = [];
    const replay = () => this.user(raw, entry, metadata);
    let transferred = false;
    try {
      for (const [index, rawAttachment] of attachments.entries()) {
        const attachment = record(rawAttachment);
        if (attachment.type !== "blob" && !imageMime(attachment.mimeType)) continue;
        const native = this.source(raw, `attachments[${index}]`), payload = this.payload(attachment, attachment.data, entry.entryId, replay, native);
        slots.push({ index: parts.length, label: "Native image", native, payload }); parts.push(placeholder(native));
      }
      const next = { ...entry, content: parts };
      const safeRaw = { id: event.id, type: event.type, ...(event.agentId ? { agentId: event.agentId } : {}), data: { content: data.content, parentToolCallId: data.parentToolCallId, attachments: attachments.map(item => ({ type: record(item).type, mimeType: record(item).mimeType })) } };
      const published = { raw: safeRaw, entry: next, slots: slots.map(({ payload: _payload, ...slot }) => slot), ...(metadata ? { metadata } : {}) } satisfies Published;
      const proposal = match ? this.proposal(match, safeRaw, next, slots) : undefined;
      transferred = true;
      if (accepted) this.accepted(accepted, slots, proposal, published);
      else this.publishNative(string(event.id), published, slots);
    } catch (error) {
      if (transferred) throw error;
      this.discardUnsubmitted(slots, error);
    }
  }
  private publishNative(messageId: string, published: Published, slots: readonly NativeImageSlot[]): void {
    let prepared: ReturnType<CopilotImages["prepareNative"]>;
    try { prepared = this.prepareNative(messageId, published, slots); }
    catch (error) { this.discardUnsubmitted(slots, error); }
    const selected = new Set(prepared.slots.map(slot => slot.payload));
    try { this.projector.discard(slots.filter(slot => !selected.has(slot.payload))); }
    catch (error) { this.discardUnsubmitted(prepared.slots, error); }
    this.withSlots(prepared.entry, prepared.slots, prepared.metadata);
  }
  private prepareNative(messageId: string, published: Published, slots: readonly NativeImageSlot[]): { entry: Message; slots: readonly NativeImageSlot[]; metadata?: MarkdownTimelineMetadata } {
    const existing = this.options.imageRuntime?.readState(this.key(messageId)) as Published | null;
    if (existing) {
      const current = new Map(slots.map(slot => [slot.native.nativePartId, slot.payload]));
      return { entry: existing.entry, slots: existing.slots.map(slot => ({ ...slot, payload: current.get(slot.native.nativePartId) ?? { kind: "pending" as const } })), ...(existing.metadata ? { metadata: existing.metadata } : {}) };
    }
    this.options.imageRuntime?.writeState(this.key(messageId), published);
    return { entry: published.entry, slots, ...(published.metadata ? { metadata: published.metadata } : {}) };
  }
  accepted(match: CopilotInputMatch, current: readonly NativeImageSlot[] = [], proposed?: CopilotPublicationProposal, fallback?: Published): void {
    const held = this.hold(match, current), association = this.associations.get(match.messageId)!;
    if (fallback) association.fallback ??= fallback;
    const intent = this.inputs.publicationIntent(match.messageId);
    let proposal = intent ? { raw: intent.raw, seed: intent.request.seed, originals: intent.request.originals } : proposed;
    if (!proposal) {
      const saved = this.options.imageRuntime?.readState(this.key(match.messageId)) as Published | null;
      if (saved && this.inputs.match(saved.raw)) proposal = this.proposal(match, saved.raw, saved.entry, saved.slots);
      const legacy = this.inputs.legacyPublication(match.messageId);
      if (!proposal && legacy && this.inputs.match(legacy.raw)) {
        const content: Parts = string(record(record(legacy.raw).data).content).trim() ? [{ type: "text", text: limited(string(record(record(legacy.raw).data).content)) }] : [];
        const slots = match.images.map((_image, index) => { const native = this.source(legacy.raw, `attachments[${index}]`), slot = { index: content.length, label: "Native image", native }; content.push(placeholder(native)); return slot; });
        proposal = this.proposal(match, legacy.raw, { ...legacy.entry, content }, slots);
      }
    }
    const result = proposal ? this.inputs.associate(match, proposal) : this.inputs.publication(match.messageId);
    if (!proposal && result?.state === "absent") {
      const native = association.fallback;
      if (native) {
        const prepared = this.prepareNative(match.messageId, native, held);
        this.prepareSlots(prepared.entry, prepared.slots);
        const selected = new Set(prepared.slots.map(slot => slot.payload)), retained: NativeImageSlot[] = [], failures: unknown[] = [];
        for (const slot of held) {
          if (selected.has(slot.payload)) { retained.push(slot); continue; }
          try { this.releaseSlots([slot]); } catch (error) { retained.push(slot); failures.push(error); }
        }
        association.slots = retained;
        if (failures.length) throw new AggregateError(failures, "Unselected Copilot native image leases could not be released.");
        // A shape mismatch prevents original association, not native display.
        // Preparation retains ownership through every fallible read and write;
        // publish consumes all selected leases, including on projection failure.
        this.associations.delete(match.messageId); this.projector.publish(prepared.entry, prepared.slots, prepared.metadata);
      } else if (!held.length) this.associations.delete(match.messageId);
      return;
    }
    if (result?.state === "committed") {
      const runtime = this.options.imageRuntime!;
      const old = runtime.readState(this.pendingKey), keys = new Set<string>(Array.isArray(old) ? old.filter((key): key is string => typeof key === "string" && record(runtime.readState(key)).phase !== "settled") : []);
      for (const slot of result.view.slots) if (slot.state.phase !== "settled") keys.add(slot.key);
      if (keys.size > 1000) throw new Error("Copilot pending source index exceeded its bound.");
      runtime.writeState(this.pendingKey, [...keys]);
      this.associations.delete(match.messageId);
      this.projector.adoptCommitted(result.view, held);
      return;
    }
    if (result?.state === "not_committed" && result.error.code === "publication_conflict") throw new Error(result.error.message);
    if (proposal || result?.state === "unknown" || fallback) this.schedulePublication();
    else if (!held.length) this.associations.delete(match.messageId);
  }
  tool(raw: unknown, entry: Tool, metadata?: MarkdownTimelineMetadata): void {
    const event = record(raw), data = record(event.data), result = record(data.result), parts: Parts = [], slots: NativeImageSlot[] = [];
    const texts = new Set<string>();
    const text = (value: unknown, unique = true) => { if (typeof value !== "string" || !value || unique && texts.has(value)) return; texts.add(value); parts.push({ type: "text", text: limited(value) }); };
    if (data.success === false) text(string(record(data.error).message) || "Native tool failed.");
    const mirrored = new Set<string>();
    const replay = () => this.tool(raw, entry, metadata);
    for (const field of ["contents", "binaryResultsForLlm"] as const) for (const [index, rawItem] of (Array.isArray(result[field]) ? result[field] : []).entries()) {
      const item = record(rawItem), resource = record(item.resource), embedded = item.type === "resource" ? resource : item;
      if (item.type === "text") { text(item.text, false); continue; }
      if (item.type === "resource" && typeof resource.text === "string") { text(resource.text, false); continue; }
      if (!imageMime(embedded.mimeType) && item.type !== "image") continue;
      const assetId = string(embedded.assetId);
      if (field === "binaryResultsForLlm" && assetId && mirrored.has(assetId)) {
        const bytes = item.type === "resource" ? resource.blob : item.data;
        try { if (isCopilotBridgeImage(bytes)) releaseCopilotBridgeImage(bytes); }
        catch (error) {
          // These readers have not reached the projector. A failed mirror unlink
          // must not orphan the earlier transfers; the bridge retains failed spools.
          const errors = [error];
          for (const slot of slots) if (slot.payload.kind === "file") try { slot.payload.release(); } catch (error) { errors.push(error); }
          if (errors.length === 1) throw error;
          throw new AggregateError(errors, "Copilot tool image cleanup did not release every transfer.");
        }
        continue;
      }
      if (field === "contents" && assetId) mirrored.add(assetId);
      const native = this.source(raw, `result.${field}[${index}]${item.type === "resource" ? ".resource.blob" : ".data"}`);
      slots.push({ index: parts.length, label: "Native tool image", native, payload: this.payload(embedded, item.type === "resource" ? resource.blob : item.data, entry.entryId, replay, native) }); parts.push(placeholder(native));
    }
    texts.add(parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"));
    for (const value of typeof data.result === "string" ? [data.result] : [result.content, result.detailedContent]) text(typeof value === "string" ? value : value === undefined ? undefined : readable(value));
    if (result.structuredContent !== undefined) text(readable(result.structuredContent));
    const truncated = entry.truncated || [...texts].some(value => value.length > 200_000);
    this.withSlots({ ...entry, output: parts, truncated }, slots, metadata ? { ...metadata, truncated: metadata.truncated || truncated } : undefined);
  }
  finishHistory(): void {
    const owners = [...this.waiting.entries()]; this.waiting.clear();
    for (const [id, replays] of owners) { this.unavailableAsset(id, "native_bytes_missing"); for (const replay of replays.values()) replay(); }
  }
  acknowledge(): void { this.reconcilePublications(); this.projector.acknowledged(); }
  async settled(): Promise<void> { await this.projector.settled(); }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.publicationTimer) clearTimeout(this.publicationTimer); this.publicationTimer = null;
    const errors: unknown[] = [];
    try { await this.projector.close(); } catch (error) { errors.push(error); }
    for (const [id, asset] of this.assets) {
      try { if ("marker" in asset) asset.release(); this.assets.delete(id); }
      catch (error) { errors.push(error); }
    }
    for (const [id, held] of this.associations) {
      const pending: NativeImageSlot[] = [];
      for (const slot of held.slots) try { this.releaseSlots([slot]); } catch (error) { pending.push(slot); errors.push(error); }
      if (pending.length) held.slots = pending; else this.associations.delete(id);
    }
    this.waiting.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Copilot image cleanup did not release every retained lease.");
  }
}
