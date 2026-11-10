import { canonicalImageJson, type NativeImageSource } from "../../../session/image-values.js";
import { isCopilotBridgeImage, releaseCopilotBridgeImage, retainCopilotBridgeImage, type CopilotBridgeImage } from "./copilot-bridge.js";
import { CopilotImageInputs, type CopilotInputMatch, type CopilotInputPublication } from "./copilot-image-input.js";
import { ProviderImageProjector, type NativeImagePayload, type NativeImageSlot } from "./image-projector.js";
import { record, string } from "./native-rpc.js";
import { limited, nativeEntryId, readable } from "./projection.js";
import type { ProviderEntry, ProviderOptions } from "./types.js";

type Message = Extract<ProviderEntry, { kind: "user_message" | "assistant_message" }> & { kind: "user_message" };
type Tool = Extract<ProviderEntry, { kind: "tool_call" }>;
type Parts = Array<Message["content"][number]>;
type SlotIdentity = Omit<NativeImageSlot, "payload">;
type Published = { raw: unknown; entry: Message; slots: SlotIdentity[] };
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
  constructor(private readonly options: ProviderOptions, private readonly session: string, private readonly inputs: CopilotImageInputs) { this.projector = new ProviderImageProjector(options); }
  private key(id: string): string { return `copilot:published:${nativeEntryId(this.session, id)}`; }
  private unavailableAsset(id: string, reason: string): void { if (this.missing.size >= 1000 && !this.missing.has(id)) this.missing.delete(this.missing.keys().next().value!); this.missing.set(id, reason); }
  private get pendingKey(): string { return `copilot:pending:${nativeEntryId(this.session, "sources")}`; }
  requiresReplay(): boolean {
    const saved = this.options.imageRuntime?.readState(this.pendingKey);
    return Array.isArray(saved) && saved.some(key => typeof key === "string" && record(this.options.imageRuntime?.readState(key)).phase !== "settled");
  }
  private withSlots(entry: ProviderEntry, slots: readonly NativeImageSlot[]): void {
    try { if (slots.length && this.options.imageRuntime) {
      const saved = this.options.imageRuntime.readState(this.pendingKey), keys = new Set<string>(Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string" && record(this.options.imageRuntime!.readState(key)).phase !== "settled") : []);
      for (const slot of slots) {
        const sourceKey = canonicalImageJson([1, slot.native, entry.entryId, entry.kind === "tool_call" ? "tool_output" : "content", entry.kind === "tool_call" ? entry.callId : null, slot.index]);
        keys.add(`image-slot:${nativeEntryId(slot.native.nativeSessionId, sourceKey)}`);
      }
      if (keys.size > 1000) throw new Error("Copilot pending source index exceeded its bound.");
      this.options.imageRuntime.writeState(this.pendingKey, [...keys]);
    } } catch (error) { this.releaseSlots(slots); throw error; }
    this.projector.publish(entry, slots);
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
  publish(entry: ProviderEntry): void { this.projector.publish(entry); }
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
  private plan(raw: unknown, entry: Message, slots: readonly NativeImageSlot[]): CopilotInputPublication {
    const content = [...entry.content];
    const positions = slots.map(({ payload: _payload, ...slot }) => {
      const sourceKey = canonicalImageJson([1, slot.native, entry.entryId, "content", null, slot.index]);
      const imageId = slot.original?.imageId ?? nativeEntryId(this.session, `image:${sourceKey}`);
      content[slot.index] = { ...placeholder(slot.native), imageId };
      return { ...slot, sourceKey, imageId };
    });
    return { nativeEventId: string(record(raw).id), raw, entry: { ...entry, content }, slots: positions };
  }
  private materialize(plan: CopilotInputPublication, current: readonly NativeImageSlot[] = []): void {
    const sources = new Map(current.map(slot => [slot.native.nativePartId, slot.payload]));
    const used = new Set<string>();
    const slots = plan.slots.map(({ imageId, sourceKey, ...slot }) => {
      const expected = canonicalImageJson([1, slot.native, plan.entry.entryId, "content", null, slot.index]);
      if (sourceKey !== expected || imageId !== (slot.original?.imageId ?? nativeEntryId(this.session, `image:${expected}`))) throw new Error("Copilot saved image slot identity changed.");
      if (!slot.original) used.add(slot.native.nativePartId);
      return { ...slot, payload: slot.original ? { kind: "resource" as const, resourceId: slot.original.resourceId } : sources.get(slot.native.nativePartId) ?? { kind: "pending" as const } };
    });
    for (const slot of current) if (!used.has(slot.native.nativePartId) && slot.payload.kind === "file") slot.payload.release();
    this.withSlots(plan.entry, slots);
  }
  user(raw: unknown, entry: Message): void {
    const event = record(raw), data = record(event.data), attachments = Array.isArray(data.attachments) ? data.attachments : [];
    const plan = this.inputs.publication(string(event.id));
    const existing = this.options.imageRuntime?.readState(this.key(string(event.id))) as Published | null;
    const match = this.inputs.match(raw), parts = [...entry.content], slots: NativeImageSlot[] = [];
    const replay = () => this.user(raw, entry);
    for (const [index, rawAttachment] of attachments.entries()) {
      const attachment = record(rawAttachment);
      if (attachment.type !== "blob" && !imageMime(attachment.mimeType)) continue;
      const native = this.source(raw, `attachments[${index}]`), original = !existing && !plan && match ? match.images[index] : undefined;
      const payload = original ? { kind: "resource" as const, resourceId: original.resourceId } : this.payload(attachment, attachment.data, entry.entryId, replay, native);
      if (original && isCopilotBridgeImage(attachment.data)) releaseCopilotBridgeImage(attachment.data);
      slots.push({ index: parts.length, label: "Native image", native, payload, ...(original ? { original: { imageId: original.imageId, resourceId: original.resourceId } } : {}) }); parts.push(placeholder(native));
    }
    if (plan) { this.materialize(plan, slots); return; }
    if (existing) {
      if (match) { this.accepted(match, slots); return; }
      const current = new Map(slots.map(slot => [slot.native.nativePartId, slot.payload]));
      this.withSlots(existing.entry, existing.slots.map(slot => ({ ...slot, payload: current.get(slot.native.nativePartId) ?? { kind: "pending" as const } })));
      return;
    }
    const next = { ...entry, content: parts };
    const safeRaw = { id: event.id, type: event.type, ...(event.agentId ? { agentId: event.agentId } : {}), data: { content: data.content, parentToolCallId: data.parentToolCallId, attachments: attachments.map(item => ({ type: record(item).type, mimeType: record(item).mimeType })) } };
    if (match) {
      let committed: CopilotInputPublication;
      try { committed = this.inputs.associate(match, this.plan(safeRaw, next, slots)); }
      catch (error) { this.releaseSlots(slots); throw error; }
      this.materialize(committed, slots);
    } else {
      this.options.imageRuntime?.writeState(this.key(string(event.id)), { raw: safeRaw, entry: next, slots: slots.map(({ payload: _payload, ...slot }) => slot) } satisfies Published);
      this.withSlots(next, slots);
    }
  }
  accepted(match: CopilotInputMatch, current: readonly NativeImageSlot[] = []): void {
    const committed = this.inputs.publication(match.messageId);
    if (committed) { this.materialize(committed, current); return; }
    const saved = this.options.imageRuntime?.readState(this.key(match.messageId)) as Published | null;
    if (!saved || !this.inputs.match(saved.raw)) return;
    const content = [...saved.entry.content], slots: NativeImageSlot[] = saved.slots.map(slot => ({ ...slot, label: "Native recorded image", payload: { kind: "pending" } }));
    for (const image of match.images) {
      const native = this.source(saved.raw, `original:${match.operationId}:${image.imageId}`);
      slots.push({ index: content.length, label: "Original uploaded image", native, original: { imageId: image.imageId, resourceId: image.resourceId }, payload: { kind: "resource", resourceId: image.resourceId } }); content.push(placeholder(native));
    }
    let plan: CopilotInputPublication;
    try { plan = this.inputs.associate(match, this.plan(saved.raw, { ...saved.entry, content }, slots)); }
    catch (error) { this.releaseSlots(current); throw error; }
    this.materialize(plan, current);
  }
  tool(raw: unknown, entry: Tool): void {
    const event = record(raw), data = record(event.data), result = record(data.result), parts: Parts = [], slots: NativeImageSlot[] = [];
    const texts = new Set<string>();
    const text = (value: unknown, unique = true) => { if (typeof value !== "string" || !value || unique && texts.has(value)) return; texts.add(value); parts.push({ type: "text", text: limited(value) }); };
    if (data.success === false) text(string(record(data.error).message) || "Native tool failed.");
    const mirrored = new Set<string>();
    const replay = () => this.tool(raw, entry);
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
    this.withSlots({ ...entry, output: parts, truncated: entry.truncated || [...texts].some(value => value.length > 200_000) }, slots);
  }
  finishHistory(): void {
    const owners = [...this.waiting.entries()]; this.waiting.clear();
    for (const [id, replays] of owners) { this.unavailableAsset(id, "native_bytes_missing"); for (const replay of replays.values()) replay(); }
  }
  acknowledge(): void { this.projector.acknowledged(); }
  async settled(): Promise<void> { await this.projector.settled(); }
  async close(): Promise<void> {
    const errors: unknown[] = [];
    try { await this.projector.close(); } catch (error) { errors.push(error); }
    for (const [id, asset] of this.assets) {
      try { if ("marker" in asset) asset.release(); this.assets.delete(id); }
      catch (error) { errors.push(error); }
    }
    this.waiting.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Copilot image cleanup did not release every retained lease.");
  }
}
