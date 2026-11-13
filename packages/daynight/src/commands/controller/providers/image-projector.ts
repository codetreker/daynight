import { canonicalImageJson, type ImageCaptureRequest, type ImageCaptureReceipt, type ImageError, type ImageLocator, type ImagePart, type ImageUnavailablePart, type NativeImageSource, type DirectCaptureSubmission } from "../../../session/image-values.js";
import type { MarkdownTimelineMetadata, NativeImageFile, ProviderEntry, ProviderOptions } from "./types.js";
import { nativeEntryId } from "./projection.js";
import type { NativeImageProjectionState, NativeInputPublicationView } from "../media/native-publication-types.js";
import { ImageCapturePrerequisiteError, ImageCaptureRequestError, isRetryableCaptureRefusal } from "../media/capture-error.js";

export type NativeImagePayload =
  | { kind: "resource"; resourceId: string }
  | NativeImageFile
  | { kind: "pending" }
  | { kind: "deferred"; read(signal: AbortSignal): Promise<NativeImageFile> }
  | { kind: "source"; locator: Extract<ImageLocator, { kind: "local" | "external" }> }
  | { kind: "unavailable"; error: ImageError };
export type NativeImageSlot = {
  index: number;
  label: string;
  native: NativeImageSource;
  payload: NativeImagePayload;
  /** Supplied only after the provider has proved an original input association. */
  original?: { imageId: string; resourceId: string };
};
type Part = ImagePart | ImageUnavailablePart;
type Saved = NativeImageProjectionState;
type Projection = { entry: ProviderEntry; metadata?: MarkdownTimelineMetadata };
type Pending = { saved: Saved; slot: NativeImageSlot; key: string; released: boolean; projection: Projection | null };

const pendingPart = (imageId: string, label: string, error: ImageError = { code: "capture_pending", message: "The original image is being saved." }): ImageUnavailablePart => ({ type: "image_unavailable", imageId, label, error });
const contentOf = (entry: ProviderEntry) => entry.kind === "tool_call" ? entry.output : entry.kind === "user_message" || entry.kind === "assistant_message" ? entry.content : null;

/** Native positions and capture share the existing journal, ACK and resource pipeline. */
export class ProviderImageProjector {
  private readonly pending = new Map<string, Pending>();
  private readonly cleanup = new Set<NativeImagePayload>();
  private readonly retryAt = new Map<string, number>();
  private work: Promise<void> = Promise.resolve();
  private scheduled = false;
  private requested = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly controller = new AbortController();
  constructor(private readonly options: ProviderOptions) {}

  /** Consume every unsubmitted lease, retaining failed removals for close. */
  discard(slots: readonly NativeImageSlot[]): void {
    const failures: unknown[] = [];
    for (const slot of slots) try { this.releasePayload(slot.payload); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Unsubmitted native image leases could not be released.");
  }

  /** Adopt the owner's current commit without publishing its entry or occurrences again. */
  adoptCommitted(view: NativeInputPublicationView, payloads: readonly NativeImageSlot[] = []): void {
    const handled = new Set<NativeImageSlot>(), failures: unknown[] = [];
    const release = (slot: NativeImageSlot) => { handled.add(slot); try { this.releasePayload(slot.payload); } catch (error) { failures.push(error); } };
    if (this.stopped) {
      for (const slot of payloads) release(slot);
      if (failures.length) throw new AggregateError(failures, "Stopped native image leases could not be released.");
      return;
    }
    try {
      const restored = structuredClone(view), indexes = new Set<number>(), images = new Set<string>();
      for (const slot of restored.slots) {
        const { state: saved, key } = slot, { occurrence, nativeSource } = saved.request, part = restored.entry.content[saved.index];
        const sourceKey = nativeSource && canonicalImageJson([1, nativeSource, restored.entry.entryId, "content", null, saved.index]);
        if (!nativeSource || !Number.isSafeInteger(saved.index) || saved.index < 0 || indexes.has(saved.index) || images.has(occurrence.imageId) || occurrence.entryId !== restored.entry.entryId || occurrence.container !== "content" || occurrence.callId !== null || occurrence.sourceKey !== sourceKey || key !== `image-slot:${nativeEntryId(nativeSource.nativeSessionId, sourceKey!)}` || !part || part.type !== "image" && part.type !== "image_unavailable" || part.imageId !== occurrence.imageId || saved.part.imageId !== occurrence.imageId) throw new Error("Committed native image position or state differs from its current entry.");
        const active = this.pending.get(occurrence.imageId);
        if (active && (active.key !== key || canonicalImageJson(active.saved.request.occurrence) !== canonicalImageJson(occurrence))) throw new Error("Committed native image cannot replace an active capture identity.");
        indexes.add(saved.index); images.add(occurrence.imageId);
      }
      if (restored.entry.content.some(part => (part.type === "image" || part.type === "image_unavailable") && !images.has(part.imageId))) throw new Error("Committed native image has no capture owner.");
      const { entrySeq: _entrySeq, ...entry } = restored.entry;
      for (const committed of restored.slots) {
        const { state: saved, key, label, original } = committed, native = saved.request.nativeSource!;
        const incoming = payloads.find(slot => !handled.has(slot) && canonicalImageJson(slot.native) === canonicalImageJson(native));
        const active = this.pending.get(saved.request.occurrence.imageId);
        if (saved.phase === "settled" && canonicalImageJson(restored.entry.content[saved.index]) === canonicalImageJson(saved.part)) {
          if (active) { active.saved = saved; this.retire(active); }
          if (incoming) release(incoming);
          continue;
        }
        const locator = saved.request.locator;
        const fallback: NativeImagePayload = original ? { kind: "resource", resourceId: original.resourceId } : locator.kind === "resource" ? { kind: "resource", resourceId: locator.resourceId } : locator.kind === "local" || locator.kind === "external" ? { kind: "source", locator } : { kind: "pending" };
        const replace = !active || active.slot.payload.kind === "pending" && incoming && incoming.payload.kind !== "pending";
        const payload = original ? fallback : replace && incoming ? incoming.payload : active?.slot.payload ?? fallback;
        if (incoming) { if (payload === incoming.payload) handled.add(incoming); else release(incoming); }
        const slot: NativeImageSlot = { index: saved.index, label, native, payload, ...(original ? { original } : {}) };
        const pending = active ?? { saved, slot, key, released: false, projection: null };
        pending.saved = saved; pending.slot = slot;
        if (replace) pending.released = false;
        this.pending.set(saved.request.occurrence.imageId, pending);
        this.resolvePending(pending);
      }
      // A publication receipt proves image ownership, not Markdown completeness.
      this.retainProjection(entry);
      this.acknowledged();
    } catch (error) { failures.push(error); }
    finally { for (const slot of payloads) if (!handled.has(slot)) release(slot); }
    if (failures.length) throw new AggregateError(failures, "Committed native image resources could not be adopted.");
  }

  publish(input: ProviderEntry, slots: readonly NativeImageSlot[] = [], metadata?: MarkdownTimelineMetadata): void {
    if (this.stopped) {
      const failures: unknown[] = [];
      for (const slot of slots) try { this.releasePayload(slot.payload); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Stopped native image leases could not be released.");
      return;
    }
    const handled = new Set<NativeImageSlot>();
    try {
      const content = contentOf(input);
      if (!content && slots.length) throw new Error("Native image has no supported message or tool position.");
      const parts = content ? [...content] : null;
      const registrations: Pending[] = [];
      for (const slot of slots) {
        if (!Number.isSafeInteger(slot.index) || slot.index < 0 || !parts || slot.index >= parts.length) throw new Error("Native image position is invalid.");
        const container = input.kind === "tool_call" ? "tool_output" as const : "content" as const;
        const callId = input.kind === "tool_call" ? input.callId : null;
        const sourceKey = canonicalImageJson([1, slot.native, input.entryId, container, callId, slot.index]);
        const imageId = slot.original?.imageId ?? nativeEntryId(slot.native.nativeSessionId, `image:${sourceKey}`);
        const key = `image-slot:${nativeEntryId(slot.native.nativeSessionId, sourceKey)}`;
        const loaded = this.options.imageRuntime?.readState(key) as Saved | null | undefined;
        let saved: Saved;
        if (loaded) {
          const occurrence = loaded.request.occurrence;
          if (occurrence.imageId !== imageId) throw new Error("Native image cannot replace its published identity.");
          if (loaded.index !== slot.index || occurrence.entryId !== input.entryId || occurrence.container !== container || occurrence.callId !== callId || canonicalImageJson(loaded.request.nativeSource) !== canonicalImageJson(slot.native)) throw new Error("Native image cannot move from its published owner.");
          saved = loaded;
        } else {
          const request: ImageCaptureRequest = {
            captureId: nativeEntryId(imageId, "capture"), attemptId: nativeEntryId(imageId, "attempt"),
            occurrence: { imageId, entryId: input.entryId, container, partId: null, sourceRevision: null, sourceTextSha256: null, callId, sourceKey },
            nativeSource: slot.native,
            locator: slot.original ? { kind: "resource", resourceId: slot.original.resourceId } : slot.payload.kind === "resource" ? { kind: "resource", resourceId: slot.payload.resourceId } : slot.payload.kind === "source" ? slot.payload.locator : { kind: "native", ...slot.native },
          };
          saved = { request, attemptId: request.attemptId, index: slot.index, waitingForSource: slot.payload.kind === "pending", phase: "new", part: pendingPart(imageId, slot.label), submission: null };
          this.options.imageRuntime?.writeState(key, saved);
        }
        parts[slot.index] = saved.part;
        const active = this.pending.get(imageId);
        if (active && active.slot.payload.kind === "pending" && slot.payload.kind !== "pending") {
          handled.add(slot);
          active.slot = slot;
          this.resolvePending(active);
        } else if (active || saved.phase === "settled") { handled.add(slot); this.releasePayload(slot.payload); }
        else {
          const pending: Pending = { saved, slot, key, released: false, projection: null };
          this.pending.set(imageId, pending); handled.add(slot);
          this.resolvePending(pending);
          registrations.push(pending);
        }
      }
      const enriched = parts?.some(part => part.type !== "text" && part.type !== "resource") ? { imageProjectionError: "imageProjectionError" in input ? input.imageProjectionError ?? null : null } : {};
      const entry = parts ? input.kind === "tool_call" ? { ...input, ...enriched, output: parts } : { ...input, ...enriched, content: parts } as ProviderEntry : input;
      this.retainProjection(entry, metadata);
      this.options.onTimeline(entry, metadata);
      // The durable timeline callback precedes occurrence registration. The ACK
      // is checked again by the shared capture owner before any source is read.
      for (const pending of registrations) this.options.onImageOccurrence?.(pending.saved.request.occurrence, pending.saved.request.nativeSource);
      this.acknowledged();
    } catch (error) {
      const failures: unknown[] = [error];
      for (const slot of slots) if (!handled.has(slot)) try { this.releasePayload(slot.payload); } catch (failure) { failures.push(failure); }
      if (failures.length > 1) throw new AggregateError(failures, "Native image projection and release failed.");
      throw error;
    }
  }

  acknowledged(): void {
    if (this.stopped) return;
    this.requested = true;
    if (this.scheduled) return;
    this.scheduled = true;
    this.work = this.work.then(async () => {
      do {
        this.requested = false;
        for (const pending of this.pending.values()) {
          if (this.stopped) break;
          if (!this.options.imageOccurrenceAcknowledged?.(pending.saved.request.occurrence.imageId)) continue;
          await this.capture(pending);
        }
      } while (this.requested && !this.stopped);
    }).catch(() => {
      this.options.onDiagnostic?.("Native image capture could not finish; its original identity remains durable.");
    }).finally(() => { this.scheduled = false; });
  }

  private save(pending: Pending): void { this.options.imageRuntime?.writeState(pending.key, pending.saved); }
  private retainProjection(entry: ProviderEntry, metadata?: MarkdownTimelineMetadata): void {
    // The journal patch owns the current body. Standalone projection retains a
    // shared body only while an image capture still needs its callback.
    const projection = this.options.imageRuntime?.patchNativeImagePart ? null : { entry, ...(metadata ? { metadata: structuredClone(metadata) } : {}) };
    for (const pending of this.pending.values()) if (pending.saved.request.occurrence.entryId === entry.entryId) pending.projection = projection;
  }
  private resolvePending(pending: Pending): void {
    const { saved, slot } = pending;
    if (!saved.waitingForSource || slot.payload.kind === "pending") return;
    if (saved.phase !== "new") throw new Error("An unresolved native image source was registered prematurely.");
    if (slot.payload.kind === "source") saved.request = { ...saved.request, locator: slot.payload.locator };
    saved.waitingForSource = false; this.save(pending);
  }
  private emitPart(pending: Pending): void {
    const { occurrence } = pending.saved.request, patch = this.options.imageRuntime?.patchNativeImagePart;
    if (patch) {
      patch(occurrence, pending.saved.part); return;
    }
    const projection = pending.projection;
    if (!projection) throw new Error("Active native image projection has no current body.");
    const { entry, metadata } = projection;
    const content = contentOf(entry); if (!content) return;
    if (canonicalImageJson(content[pending.saved.index]) === canonicalImageJson(pending.saved.part)) return;
    const parts = content.map(part => (part.type === "image" || part.type === "image_unavailable") && part.imageId === occurrence.imageId ? pending.saved.part : part);
    const updated = entry.kind === "tool_call" ? { ...entry, output: parts } : { ...entry, content: parts } as ProviderEntry;
    this.options.onTimeline(updated, metadata); this.retainProjection(updated, metadata);
  }
  private releasePayload(payload: NativeImagePayload): void {
    if (payload.kind !== "file") return;
    this.cleanup.add(payload); payload.release(); this.cleanup.delete(payload);
  }
  private release(pending: Pending): void { if (!pending.released) { this.releasePayload(pending.slot.payload); pending.released = true; } }
  private retire(pending: Pending): void {
    try { this.release(pending); this.pending.delete(pending.saved.request.occurrence.imageId); }
    catch { this.options.onDiagnostic?.("Saved native image bytes could not be released; their original lease is retained."); this.scheduleQuery(); }
  }
  private applyReceipt(pending: Pending, receipt: ImageCaptureReceipt, reconcileAttempt = false): boolean {
    const { request, attemptId } = pending.saved;
    if (receipt.captureId !== request.captureId || canonicalImageJson(receipt.occurrence) !== canonicalImageJson(request.occurrence)) throw new Error("Native image capture receipt identity differs.");
    if (receipt.attemptId !== attemptId) {
      if (!reconcileAttempt) throw new Error("Native image capture receipt attempt differs.");
      // Query may discover a service-owned source retry. Only that retry's
      // exact command can acquire new bytes; projection keeps observing it.
      pending.saved.attemptId = receipt.attemptId;
      pending.saved.submission = null;
      pending.saved.phase = "query";
    }
    if (receipt.state === "committed") {
      if (!receipt.resourceId) throw new Error("Native image capture has no committed original.");
      pending.saved.part = { type: "image", imageId: request.occurrence.imageId, resourceId: receipt.resourceId, label: pending.slot.label };
    } else if (receipt.state === "failed") {
      if (!receipt.error) throw new Error("Native image capture has no failure result.");
      pending.saved.part = pendingPart(request.occurrence.imageId, pending.slot.label, receipt.error);
    } else { this.save(pending); return false; }
    pending.saved.phase = "settled"; this.save(pending);
    this.emitPart(pending); this.retire(pending); return true;
  }
  private freeze(pending: Pending, outcome: DirectCaptureSubmission["outcome"]): void {
    pending.saved.submission = structuredClone({ request: pending.saved.request, attemptId: pending.saved.attemptId, outcome });
    pending.saved.phase = "submit";
    this.save(pending);
  }
  private sourceFailure(pending: Pending, error: unknown, fallback: ImageError): void {
    const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : fallback.code;
    this.options.onDiagnostic?.(`${fallback.message} ${String(error)}`);
    this.freeze(pending, { kind: "failed", error: { code, message: fallback.message } });
  }
  private async prepare(pending: Pending): Promise<void> {
    const { options } = this, { saved } = pending;
    await options.prepareImageCapture!(saved.request);
    if (this.stopped) return;
    // Persist the source start before IO. An interrupted reader cannot be
    // reopened under the same attempt against possibly changed source bytes.
    saved.phase = "preparing"; this.save(pending);
    let payload = pending.slot.payload;
    if (payload.kind === "resource") { this.freeze(pending, { kind: "resource" }); return; }
    if (payload.kind === "deferred" || payload.kind === "source") {
      try {
        if (payload.kind === "deferred") payload = await payload.read(this.controller.signal);
        else {
          if (!options.resolveImageCaptureSource) throw new Error("Native image source resolver is unavailable.");
          payload = await options.resolveImageCaptureSource(saved.request, this.controller.signal);
        }
        pending.slot = { ...pending.slot, payload };
      } catch (error) {
        if (this.stopped) return;
        this.sourceFailure(pending, error, { code: "source_unavailable", message: "The original native image source could not be read." }); return;
      }
      if (this.stopped) { this.release(pending); return; }
    }
    if (payload.kind !== "file") {
      const error = payload.kind === "unavailable" ? payload.error : { code: "source_unavailable", message: "The original native image source is unavailable." };
      this.freeze(pending, { kind: "failed", error }); return;
    }
    let validated;
    try { validated = await options.stageImageCapture!({ captureId: saved.request.captureId, attemptId: saved.attemptId, imageId: saved.request.occurrence.imageId, inputPath: payload.path, byteLength: payload.byteLength, sha256: payload.sha256 }); }
    catch (error) {
      if (this.stopped) return;
      this.sourceFailure(pending, error, { code: "source_validation_failed", message: "The native image could not be completely validated and saved." });
      return;
    }
    this.freeze(pending, { kind: "validated", validated });
  }
  private async capture(pending: Pending): Promise<void> {
    const { options } = this, { saved } = pending, { request } = saved;
    if (saved.phase === "settled") {
      try { this.save(pending); this.emitPart(pending); this.retire(pending); }
      catch { this.scheduleQuery(); }
      return;
    }
    if (saved.waitingForSource && saved.phase === "new") return;
    if (!options.imageRuntime || !options.prepareImageCapture || !options.queryImageCapture || !options.stageImageCapture || !options.submitImageCapture) {
      saved.part = pendingPart(request.occurrence.imageId, pending.slot.label, { code: "component_unsupported", message: "The native image capture component is unavailable." });
      saved.phase = "settled"; this.save(pending); this.emitPart(pending); this.retire(pending); return;
    }
    if (Date.now() < (this.retryAt.get(request.captureId) ?? 0)) { this.scheduleQuery(); return; }
    this.retryAt.delete(request.captureId);
    let dispatching = false;
    try {
      if (saved.phase === "query") {
        try {
          const receipt = await options.queryImageCapture(request.captureId);
          if (this.applyReceipt(pending, receipt, true)) return;
          this.scheduleQuery(); return;
        } catch (error) {
          if (!(error instanceof ImageCaptureRequestError) || error.code !== "capture_not_found" || !saved.submission) throw error;
          saved.phase = "submit"; this.save(pending);
        }
      }
      if (saved.phase === "new") await this.prepare(pending);
      else if (saved.phase === "preparing") this.freeze(pending, { kind: "failed", error: { code: "source_unavailable", message: "The original native image source read was interrupted." } });
      if (this.stopped) return;
      if (saved.phase === "submit") {
        const submission = saved.submission;
        if (!submission || submission.attemptId !== saved.attemptId) throw new Error("Native image capture has no frozen current submission.");
        try { this.release(pending); }
        catch (error) { this.options.onDiagnostic?.(`Native image source cleanup is incomplete: ${String(error)}`); }
        saved.phase = "query"; this.save(pending);
        dispatching = true;
        const receipt = await options.submitImageCapture(submission);
        dispatching = false;
        if (this.applyReceipt(pending, receipt)) return;
      }
      this.scheduleQuery();
    } catch (error) {
      if ((saved as Saved).phase === "settled") { this.scheduleQuery(); return; }
      if (isRetryableCaptureRefusal(error)) {
        if (dispatching) saved.phase = "submit";
        this.retryAt.set(request.captureId, Date.now() + 1000);
        this.save(pending); this.scheduleQuery(); return;
      }
      if (error instanceof ImageCapturePrerequisiteError || dispatching && error instanceof ImageCaptureRequestError && error.code === "upgrade_required") {
        saved.part = pendingPart(request.occurrence.imageId, pending.slot.label, { code: error.code, message: error.message });
        saved.phase = "settled";
        try { this.save(pending); this.emitPart(pending); this.retire(pending); } catch { this.scheduleQuery(); }
        return;
      }
      saved.part = pendingPart(request.occurrence.imageId, pending.slot.label, error instanceof ImageCaptureRequestError ? { code: error.code, message: error.message } : { code: "capture_unknown", message: "The original image capture result is unknown." });
      this.options.onDiagnostic?.(`Native image capture requires reconciliation: ${String(error)}`);
      this.save(pending); this.emitPart(pending); this.scheduleQuery();
    }
  }
  private scheduleQuery(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.acknowledged(); }, 1000);
    this.timer.unref();
  }
  async settled(): Promise<void> { await this.work; }
  async close(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; await this.work;
    const failures: unknown[] = [], active = new Set([...this.pending.values()].map(pending => pending.slot.payload));
    for (const payload of [...this.cleanup]) if (!active.has(payload)) try { this.releasePayload(payload); } catch (error) { failures.push(error); }
    for (const [imageId, pending] of this.pending) {
      try { this.release(pending); this.pending.delete(imageId); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Native image leases could not be released.");
  }
}
