import { canonicalImageJson, type ImageCaptureRequest, type ImageCaptureReceipt, type ImageError, type ImageLocator, type ImagePart, type ImageUnavailablePart, type NativeImageSource, type ValidatedImage } from "../../../session/image-values.js";
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
  private readonly registerRetryAt = new Map<string, number>();
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
          saved = { request, index: slot.index, waitingForSource: slot.payload.kind === "pending", phase: "new", unknownAction: null, part: pendingPart(imageId, slot.label), validated: null };
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
  private applyReceipt(pending: Pending, receipt: ImageCaptureReceipt): boolean {
    const original = pending.saved.request;
    if (receipt.captureId !== original.captureId || receipt.attemptId !== original.attemptId || canonicalImageJson(receipt.occurrence) !== canonicalImageJson(original.occurrence)) throw new Error("Native image capture receipt identity differs.");
    if (receipt.state === "committed") {
      if (!receipt.resourceId) throw new Error("Native image capture has no committed original.");
      pending.saved.part = { type: "image", imageId: original.occurrence.imageId, resourceId: receipt.resourceId, label: pending.slot.label };
    } else if (receipt.state === "failed") {
      pending.saved.part = pendingPart(original.occurrence.imageId, pending.slot.label, receipt.error ?? { code: "image_unavailable", message: "The original image could not be saved." });
    } else return false;
    pending.saved.phase = "settled"; this.save(pending);
    this.emitPart(pending); this.retire(pending); return true;
  }
  private async capture(pending: Pending): Promise<void> {
    const { options } = this, { request } = pending.saved;
    if (pending.saved.phase === "settled") {
      try {
        // The known receipt may precede either durable state or timeline
        // projection. Retry only these writes, never its capture or source IO.
        this.save(pending);
        this.emitPart(pending);
        this.retire(pending);
      } catch { this.scheduleQuery(); }
      return;
    }
    if (pending.slot.payload.kind === "pending" && pending.saved.phase === "new") return;
    if (!options.imageRuntime || !options.registerImageCapture || !options.queryImageCapture || !options.stageImageCapture || !options.commitImageCapture || !options.failImageCapture) {
      pending.saved.part = pendingPart(request.occurrence.imageId, pending.slot.label, { code: "component_unsupported", message: "The native image capture component is unavailable." });
      this.emitPart(pending); this.release(pending); this.pending.delete(request.occurrence.imageId); return;
    }
    let registerRefusal = false;
    let controlRefusal: "commit" | "failure" | null = null;
    try {
      if (pending.saved.phase === "new") {
        if (Date.now() < (this.registerRetryAt.get(request.captureId) ?? 0)) { this.scheduleQuery(); return; }
        this.registerRetryAt.delete(request.captureId);
        pending.saved.phase = "query"; pending.saved.unknownAction = "register"; this.save(pending);
        const receipt = await options.registerImageCapture(request).catch(error => { registerRefusal = error instanceof ImageCaptureRequestError || error instanceof ImageCapturePrerequisiteError || isRetryableCaptureRefusal(error); throw error; });
        if (this.applyReceipt(pending, receipt)) return;
        pending.saved.phase = receipt.state === "reserved" ? "reserved" : "query"; pending.saved.unknownAction = null; this.save(pending);
      } else if (pending.saved.phase === "query") {
        const receipt = await options.queryImageCapture(request.captureId);
        if (this.applyReceipt(pending, receipt)) return;
        if (receipt.state === "reserved" && pending.saved.unknownAction === "register") {
          pending.saved.phase = "reserved"; pending.saved.unknownAction = null;
        }
        this.save(pending);
      }
      if (this.stopped) return;
      if (pending.saved.phase === "reserved") {
        if (!pending.saved.validated) {
          if (pending.slot.payload.kind === "pending") return;
          let payload = pending.slot.payload;
          if (payload.kind === "deferred" || payload.kind === "source") {
            const deferred = payload.kind === "deferred" ? payload : null;
            const resolver = options.resolveImageCaptureSource;
            const read = deferred ? () => deferred.read(this.controller.signal) : resolver ? () => resolver(request, this.controller.signal) : null;
            if (read) {
              try { payload = await read(); pending.slot = { ...pending.slot, payload }; }
              catch {
                if (this.stopped) return;
                payload = { kind: "unavailable", error: { code: "source_unavailable", message: "The original native image source could not be read." } };
              }
            } else payload = { kind: "unavailable", error: { code: "component_unsupported", message: "The native image source resolver is unavailable." } };
            if (this.stopped) { this.release(pending); return; }
          }
          if (payload.kind !== "file") {
            const error = payload.kind === "unavailable" ? payload.error : { code: "resource_unavailable", message: "The original uploaded image could not be associated." };
            pending.saved.part = pendingPart(request.occurrence.imageId, pending.slot.label, error);
            pending.saved.phase = "failure"; this.save(pending);
          } else try {
            pending.saved.validated = await options.stageImageCapture({ captureId: request.captureId, attemptId: request.attemptId, imageId: request.occurrence.imageId, inputPath: payload.path, byteLength: payload.byteLength, sha256: payload.sha256 });
          } catch {
            // Staging has joined its owned reader/decoder. No service commit
            // has been invoked, so this is a source failure, not a lost commit.
            pending.saved.part = pendingPart(request.occurrence.imageId, pending.slot.label, { code: "source_validation_failed", message: "The native image could not be completely validated and saved." });
            pending.saved.phase = "failure"; this.save(pending);
          }
          if (pending.saved.phase === "reserved") { this.save(pending); this.release(pending); }
        }
        if (pending.saved.phase === "reserved") { pending.saved.phase = "commit"; this.save(pending); }
      }
      if (pending.saved.phase === "failure") {
        if (Date.now() < (pending.saved.retryAt ?? 0)) { this.scheduleQuery(); return; }
        if (pending.saved.part.type !== "image_unavailable") throw new Error("Native image capture failure is missing.");
        const failure = pending.saved.part.error;
        delete pending.saved.retryAt; pending.saved.phase = "query"; pending.saved.unknownAction = "failure"; this.save(pending);
        if (this.applyReceipt(pending, await options.failImageCapture(request.captureId, request.attemptId, failure).catch(error => { if (error instanceof ImageCaptureRequestError || isRetryableCaptureRefusal(error)) controlRefusal = "failure"; throw error; }))) return;
      }
      if (pending.saved.phase === "commit") {
        if (Date.now() < (pending.saved.retryAt ?? 0)) { this.scheduleQuery(); return; }
        const validated = pending.saved.validated;
        if (!validated) throw new Error("Native image capture validation is missing.");
        delete pending.saved.retryAt; pending.saved.phase = "query"; pending.saved.unknownAction = "commit"; this.save(pending);
        if (this.applyReceipt(pending, await options.commitImageCapture(request.captureId, request.attemptId, validated).catch(error => { if (error instanceof ImageCaptureRequestError || isRetryableCaptureRefusal(error)) controlRefusal = "commit"; throw error; }))) return;
      }
      this.scheduleQuery();
    } catch (error) {
      if ((pending.saved as Saved).phase === "settled") { this.scheduleQuery(); return; }
      if (controlRefusal && isRetryableCaptureRefusal(error)) {
        const action = controlRefusal;
        pending.saved.phase = action; pending.saved.unknownAction = null; pending.saved.retryAt = Date.now() + 1000;
        try { this.save(pending); } catch (saveError) {
          pending.saved.phase = "query"; pending.saved.unknownAction = action; delete pending.saved.retryAt;
          throw saveError;
        }
        this.scheduleQuery(); return;
      }
      if (registerRefusal && isRetryableCaptureRefusal(error)) {
        // Admission preceded registration, so the same frozen request remains eligible.
        pending.saved.phase = "new"; pending.saved.unknownAction = null;
        this.registerRetryAt.set(request.captureId, Date.now() + 1000);
        this.save(pending); this.scheduleQuery(); return;
      }
      if (registerRefusal && (error instanceof ImageCaptureRequestError || error instanceof ImageCapturePrerequisiteError)) {
        // A correlated refusal is a known request result, not a lost receipt.
        // Keep the original identity without inventing a service receipt.
        pending.saved.part = pendingPart(request.occurrence.imageId, pending.slot.label, { code: error.code, message: error.message });
        pending.saved.phase = "settled"; pending.saved.unknownAction = null;
        try { this.save(pending); this.emitPart(pending); this.retire(pending); } catch { this.scheduleQuery(); }
        return;
      }
      pending.saved.part = pendingPart(request.occurrence.imageId, pending.slot.label, { code: "capture_unknown", message: "The original image capture result is unknown." });
      // Reconciliation retains the same capture and attempt. It never repeats
      // register or commit after a response with an unknown outcome.
      this.scheduleQuery();
      this.save(pending); this.emitPart(pending);
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
