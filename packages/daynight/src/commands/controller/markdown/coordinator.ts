import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { canonicalImageJson, parseDirectCaptureSubmission, parseImageCaptureRequest, type DirectCaptureSubmission, type ImageCaptureReceipt, type ImageCaptureRequest, type ImageError, type ImageLocator, type ImageOccurrence, type ValidatedImage } from "../../../session/image-values.js";
import type { ControllerLifecycleStore } from "../lifecycle-store.js";
import type { ControllerLaunchTicket } from "../launch-ticket.js";
import type { NativeReadPolicy, ProviderOptions } from "../providers/types.js";
import type { CaptureReadPolicy, CaptureSourceLease } from "../media/preparations.js";
import { ImageCapturePrerequisiteError, ImageCaptureRequestError, isRetryableCaptureRefusal } from "../media/capture-error.js";
import { copyLocalImage, createLocalImageContext, parseLocalImagePath } from "./local-source.js";
import type { LocalImageCheckpoint } from "./local-source-proof.js";
import type { ExternalImagePolicyLease } from "./external-policy.js";
import { copyExternalImage, createExternalImagePolicy, ExternalImageSourceError, parseExternalImageUrl } from "./external-source.js";

export type MarkdownSourceContext = {
  contextId: string; serverOrigin: string; ownerUserId: string; sessionId: string; executionId: string;
  nativeSessionId: string | null; cwd: string; platform: NodeJS.Platform; entryId: string; partId: string; policyRevision: string;
  root: { dev: string; ino: string };
};
export type MarkdownCaptureRecord = {
  occurrence: ImageOccurrence; destination: string; context: MarkdownSourceContext;
  request: ImageCaptureRequest | null; phase: "waiting" | "registered" | "reading" | "validated" | "unknown" | "settled";
  started: boolean; awaitingRetry: boolean; queuedAt: number; receipt: ImageCaptureReceipt | null; error: ImageError | null; cooldownUntil: number;
  sourceAdmission?: { attemptId: string; policyRevision: string | null; sourceProofSha256: string | null; validated: ValidatedImage } | null;
  sourceCleanup?: { captureId: string; attemptId: string; pending: boolean; error: ImageError | null } | null;
  submission?: DirectCaptureSubmission;
  dispatchPending?: boolean;
};
type Hooks = Required<Pick<ProviderOptions, "prepareImageCapture" | "queryImageCapture" | "submitImageCapture">>;
const failure = (code: string): ImageError => ({ code, message: "The original image source could not be captured." });
const validationFailures = new Map<string, string>([["image_decode_failed", "decode_failed"], ["image_format_unsupported", "unsupported_media_type"], ["image_integrity_failed", "source_changed"], ["image_geometry_exceeded", "invalid_image"], ["image_too_large", "source_too_large"]]);
const sourceError = (error: unknown): ImageError => {
  const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
  const validation = validationFailures.get(code);
  if (validation) return failure(validation);
  if (["policy_restricted", "source_forbidden", "context_unavailable", "permission_denied", "source_not_found", "source_timeout", "source_changed", "source_busy", "source_rate_limited", "source_capacity", "source_queue_timeout", "source_too_large", "invalid_image", "unsupported_media_type", "decode_failed"].includes(code)) return failure(code);
  return failure(String(error).includes("capacity") || String(error).includes("budget") || String(error).includes("free-space") ? "source_capacity" : "source_unavailable");
};
const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** Durable source intents precede IO; frozen submissions retain their sealed content. */
export const createMarkdownCaptureCoordinator = (options: {
  ticket: ControllerLaunchTicket; journal: ControllerLifecycleStore;
  bridge: Pick<ProviderOptions, keyof Hooks>; writable(): boolean; fence(): string | null;
  nativeReadPolicy?(): NativeReadPolicy | null;
  acquireExternalPolicy?(): Promise<ExternalImagePolicyLease>;
  onReceipt(request: ImageCaptureRequest, receipt: ImageCaptureReceipt): void;
  onFailure?(occurrence: ImageOccurrence, error: ImageError): void;
}) => {
  const { ticket, journal } = options, store = journal.markdownStore, hooks = options.bridge as Hooks;
  const active = new Map<string, { controller: AbortController; work: Promise<unknown> }>();
  let stopped = false, cursor: string | undefined, decodeTail: Promise<void> = Promise.resolve();
  // The trusted execution cwd is bound before provider output can name a source.
  // Reopening a context must verify this object rather than adopting its pathname.
  const observedRoot = statSync(ticket.cwd, { bigint: true });
  const root = store.get<{ dev: string; ino: string }>("context", "execution-root") ?? { dev: String(observedRoot.dev), ino: String(observedRoot.ino) };
  store.put("context", "execution-root", root);
  const saved = (value: MarkdownCaptureRecord): MarkdownCaptureRecord => { store.put("source", value.occurrence.imageId, value); return value; };
  const get = (imageId: string): MarkdownCaptureRecord | null => {
    const record = store.get<MarkdownCaptureRecord>("source", imageId);
    if (record?.request) parseImageCaptureRequest(record.request);
    if (record?.submission) parseDirectCaptureSubmission(record.submission);
    return record;
  };
  const needsCleanup = (record: MarkdownCaptureRecord): boolean => !!record.sourceCleanup?.pending || !record.sourceCleanup && record.started && !!record.request;
  const cleanupSource = async (record: MarkdownCaptureRecord): Promise<void> => {
    // Older interrupted records predate the separate cleanup obligation.
    if (!record.sourceCleanup && record.started && record.request) {
      const cleanup = { captureId: record.request.captureId, attemptId: record.request.attemptId, pending: true, error: null };
      saved({ ...record, sourceCleanup: cleanup }); record.sourceCleanup = cleanup;
    }
    const cleanup = record.sourceCleanup;
    if (!cleanup?.pending) return;
    if (!record.request || cleanup.captureId !== record.request.captureId) throw new Error("Image source cleanup identity is corrupt.");
    parseImageCaptureRequest({ ...record.request, attemptId: cleanup.attemptId });
    try {
      await journal.media().releaseCaptureSource(cleanup.captureId, cleanup.attemptId);
      const completed = { ...cleanup, pending: false };
      saved({ ...record, sourceCleanup: completed }); record.sourceCleanup = completed;
    } catch (error) {
      try {
        // A metadata write can commit before its acknowledgement is lost. Read
        // its original identity back before retaining or clearing the obligation.
        const observed = get(record.occurrence.imageId)?.sourceCleanup;
        const current = observed?.captureId === cleanup.captureId && observed.attemptId === cleanup.attemptId ? observed : cleanup;
        const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
        const failed = { ...current, error: { code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : "source_cleanup_failed", message: "The original image source cleanup is incomplete." } };
        saved({ ...record, sourceCleanup: failed }); record.sourceCleanup = failed;
      } catch (persistenceError) { throw new AggregateError([error, persistenceError], "Image source cleanup and its error persistence failed."); }
      throw error;
    }
  };
  const policyRevision = () => options.nativeReadPolicy?.()?.revision ?? "unavailable";
  const contextFor = (occurrence: ImageOccurrence): MarkdownSourceContext => {
    if (occurrence.partId === null) return refuse("context_unavailable");
    const candidate = { serverOrigin: ticket.serverOrigin, ownerUserId: ticket.userId ?? ticket.ownerUserId, sessionId: ticket.sessionId, executionId: ticket.executionId, nativeSessionId: journal.getSnapshot().nativeSessionId, cwd: ticket.cwd, platform: process.platform, entryId: occurrence.entryId, partId: occurrence.partId, policyRevision: policyRevision(), root };
    const id = `part:${occurrence.partId}:${createHash("sha256").update(canonicalImageJson(candidate)).digest("hex")}`;
    const previous = store.get<MarkdownSourceContext>("context", id);
    if (previous) { if (canonicalImageJson({ ...previous, contextId: null }) !== canonicalImageJson({ ...candidate, contextId: null })) return refuse("context_unavailable"); return previous; }
    const context = { ...candidate, contextId: randomUUID() };
    store.put("context", id, context); store.put("context", context.contextId, context); return context;
  };
  const checkContext = (context: MarkdownSourceContext, local: boolean, originalFence?: string, expectedPolicy?: NativeReadPolicy): void => {
    if (stopped || !options.writable() || !options.fence() || originalFence !== undefined && options.fence() !== originalFence) refuse("policy_restricted");
    if (context.serverOrigin !== ticket.serverOrigin || context.ownerUserId !== (ticket.userId ?? ticket.ownerUserId) || context.sessionId !== ticket.sessionId || context.executionId !== ticket.executionId || !context.nativeSessionId || context.nativeSessionId !== journal.getSnapshot().nativeSessionId || context.cwd !== ticket.cwd || context.platform !== process.platform) refuse("context_unavailable");
    const known = store.get<MarkdownSourceContext>("context", context.contextId);
    if (!known || canonicalImageJson(known) !== canonicalImageJson(context)) refuse("context_unavailable");
    if (local) {
      const policy = options.nativeReadPolicy?.();
      if (!policy || !policy.revision || policy.nativeSessionId !== context.nativeSessionId || policy.cwd !== context.cwd || expectedPolicy && policy !== expectedPolicy) return refuse("policy_restricted");
      try { const result: unknown = policy.verify(); if (result !== undefined) refuse("policy_restricted"); } catch { refuse("policy_restricted"); }
    }
  };
  const hasAdmission = (record: MarkdownCaptureRecord, validated: ValidatedImage | null): boolean => {
    const admission = record.sourceAdmission;
    return !!validated && !!admission && admission.attemptId === record.request?.attemptId
      && (record.request?.locator.kind !== "local" || !!admission.policyRevision && /^[a-f0-9]{64}$/.test(admission.sourceProofSha256 ?? ""))
      && canonicalImageJson(admission.validated) === canonicalImageJson(validated);
  };
  const acquireReadPolicy: CaptureReadPolicy = request => {
    if (request.locator.kind !== "local" && request.locator.kind !== "external") return { verify() {}, close() {} };
    const record = get(request.occurrence.imageId);
    if (!record?.request || record.request.captureId !== request.captureId || record.request.attemptId !== request.attemptId) return refuse("context_unavailable");
    const fence = options.fence(); if (!fence) return refuse("policy_restricted");
    // Transfer only a previously admitted immutable copy. Later native source
    // restrictions do not reauthorize that copy; current Session access does.
    const verify = () => {
      checkContext(record.context, false, fence);
      const current = get(request.occurrence.imageId);
      if (!current?.request || current.request.captureId !== request.captureId || current.request.attemptId !== request.attemptId || !hasAdmission(current, journal.media().captureStatus(request.captureId, request.attemptId))) refuse("policy_restricted");
    };
    verify(); return { verify, close() {} };
  };
  const locatorFor = (destination: string, context: MarkdownSourceContext): ImageLocator => {
    if (/^daynight-resource:/i.test(destination)) {
      const resourceId = store.get<string>("context", `resource:${destination}`);
      if (!resourceId) return refuse("source_forbidden");
      return { kind: "resource", resourceId };
    }
    if (/^https?:/i.test(destination)) { parseExternalImageUrl(destination); return { kind: "external", url: destination }; }
    parseLocalImagePath(destination, context.platform);
    return { kind: "local", path: destination, contextId: context.contextId };
  };
  const enqueue = (occurrence: ImageOccurrence, destination: string, context: MarkdownSourceContext): void => {
    const old = get(occurrence.imageId);
    if (old) {
      if (canonicalImageJson(old.occurrence) !== canonicalImageJson(occurrence) || old.destination !== destination || canonicalImageJson(old.context) !== canonicalImageJson(context)) refuse("source_forbidden");
      journal.registerImageOccurrence(old.occurrence, null); return;
    }
    let request: ImageCaptureRequest | null = null, error: ImageError | null = null;
    try { request = parseImageCaptureRequest({ captureId: randomUUID(), attemptId: randomUUID(), occurrence, locator: locatorFor(destination, context), nativeSource: null }); }
    catch (cause) { error = sourceError(cause); }
    const record = saved({ occurrence, destination, context, request, phase: error ? "settled" : "waiting", started: false, awaitingRetry: false, queuedAt: Date.now(), receipt: null, error, cooldownUntil: 0 });
    journal.registerImageOccurrence(occurrence, null);
    if (record.error) options.onFailure?.(occurrence, record.error);
  };
  const observe = (record: MarkdownCaptureRecord, receipt: ImageCaptureReceipt): void => {
    if (!record.request) return;
    if (receipt.attemptId !== record.request.attemptId) {
      // Only the original control request may start a service retry. Persist
      // that boundary with its identity before receipt projection can fail.
      record.awaitingRetry = true; record.started = false; record.error = null; delete record.submission; delete record.dispatchPending; record.phase = "unknown";
    }
    record.request = { ...record.request, attemptId: receipt.attemptId };
    record.receipt = receipt;
    const terminal = receipt.state === "committed" || receipt.state === "failed";
    if (terminal) { record.phase = "unknown"; record.error = receipt.error; }
    saved(record);
    if (receipt.resource) {
      store.put("context", `resource:daynight-resource:${receipt.resource.resourceId}`, receipt.resource.resourceId);
    }
    options.onReceipt(record.request, receipt);
    if (terminal) { record.phase = "settled"; saved(record); }
  };
  const settleRefusal = (record: MarkdownCaptureRecord, error: unknown): boolean => {
    if (!(error instanceof ImageCaptureRequestError || error instanceof ImageCapturePrerequisiteError)) return false;
    // The local projection records the refusal, not a fabricated service receipt.
    record.error = { code: error.code, message: error.message }; record.receipt = null; record.phase = "settled";
    saved(record); options.onFailure?.(record.occurrence, record.error);
    return true;
  };
  const freeze = (record: MarkdownCaptureRecord, outcome: DirectCaptureSubmission["outcome"]): void => {
    if (record.submission) throw new Error("Image capture already has a frozen submission.");
    record.submission = parseDirectCaptureSubmission({ request: journal.getImageCaptureRequest(record.request!.captureId), attemptId: record.request!.attemptId, outcome });
    record.dispatchPending = true; record.phase = "unknown"; saved(record);
  };
  const submit = async (record: MarkdownCaptureRecord): Promise<void> => {
    const submission = record.submission!;
    checkContext(record.context, false);
    if (submission.outcome.kind === "validated") {
      const sealed = journal.media().captureStatus(submission.request.captureId, submission.attemptId);
      if (!hasAdmission(record, sealed) || canonicalImageJson(sealed) !== canonicalImageJson(submission.outcome.validated)) throw new Error("Image capture frozen source is unavailable.");
    }
    // Persist uncertainty before dispatch; only a definite admission refusal
    // permits another send without first observing this capture.
    record.dispatchPending = false; saved(record);
    let receipt: ImageCaptureReceipt;
    try { receipt = await hooks.submitImageCapture(submission); }
    catch (cause) {
      if (isRetryableCaptureRefusal(cause)) {
        record.dispatchPending = true; record.cooldownUntil = Date.now() + 1000; saved(record);
      } else if (cause instanceof ImageCaptureRequestError && ["capture_conflict", "resource_conflict"].includes(cause.code)) {
        return;
      } else if (cause instanceof ImageCaptureRequestError || cause instanceof ImageCapturePrerequisiteError) settleRefusal(record, cause);
      else throw cause;
      return;
    }
    observe(record, receipt);
  };
  const decode = async <T>(action: () => Promise<T>): Promise<T> => {
    const previous = decodeTail; let release!: () => void;
    decodeTail = new Promise<void>(resolve => { release = resolve; });
    try { await previous; return await action(); } finally { release(); }
  };
  const copy = async (record: MarkdownCaptureRecord, signal: AbortSignal): Promise<ValidatedImage> => {
    const request = record.request!, fence = options.fence();
    if (!fence) return refuse("policy_restricted");
    checkContext(record.context, request.locator.kind === "local", fence); signal.throwIfAborted();
    const sourcePolicy = request.locator.kind === "local" ? options.nativeReadPolicy!()! : null;
    let sourceProofSha256: string | null = null;
    const media = journal.media(); let lease: CaptureSourceLease | undefined, sourceFailed = false, sourceCause: unknown;
    // reserve can persist its private paths before it returns a lease.
    record.sourceCleanup = { captureId: request.captureId, attemptId: request.attemptId, pending: true, error: null };
    record.started = true; record.phase = "reading"; saved(record);
    try {
      lease = media.reserveCaptureSource(request.captureId, request.attemptId);
      const source = await lease.runWriter(async (outputPath, writerSignal) => {
        const joined = AbortSignal.any([signal, writerSignal]);
        if (request.locator.kind === "local") {
          const context = await createLocalImageContext({ cwd: record.context.cwd, platform: record.context.platform, policyRevision: sourcePolicy!.revision, nativeReadAllowed: true, expectedRoot: record.context.root });
          try {
            checkContext(record.context, true, fence, sourcePolicy!); joined.throwIfAborted();
            const result = await copyLocalImage({ path: request.locator.path, context, outputPath, signal: joined, checkPolicy: async (checkpoint: LocalImageCheckpoint) => {
              checkContext(record.context, true, fence, sourcePolicy!); joined.throwIfAborted();
              try { await sourcePolicy!.authorizeCheckpoint(checkpoint); } catch { refuse("policy_restricted"); }
              checkContext(record.context, true, fence, sourcePolicy!); joined.throwIfAborted();
              if (checkpoint.stage === "final") sourceProofSha256 = createHash("sha256").update(canonicalImageJson(checkpoint.proof)).digest("hex");
            } });
            return { ...result, byteLength: String(result.byteLength) };
          } finally { await context.close(); }
        }
        if (request.locator.kind !== "external") return refuse("source_forbidden");
        if (!options.acquireExternalPolicy) return refuse("policy_restricted");
        const externalLease = await options.acquireExternalPolicy();
        try {
          const policy = createExternalImagePolicy({ ...externalLease,
            assertEgressPolicy: async () => { checkContext(record.context, false, fence); await externalLease.assertEgressPolicy(); checkContext(record.context, false, fence); },
            beforeRequest: ({ hostname }) => { checkContext(record.context, false, fence); if (!store.rate(hostname)) throw new ExternalImageSourceError("source_rate_limited", 30); },
          });
          return await copyExternalImage({ url: request.locator.url, outputPath, signal: joined, policy });
        } finally { externalLease.release(); }
      });
      signal.throwIfAborted(); checkContext(record.context, false, fence);
      const result = await decode(async () => {
        signal.throwIfAborted(); checkContext(record.context, false, fence);
        return media.stageCapture({ ...source, captureId: request.captureId, attemptId: request.attemptId, imageId: request.occurrence.imageId });
      });
      signal.throwIfAborted(); checkContext(record.context, false, fence);
      if (request.locator.kind === "local" && !sourceProofSha256) return refuse("policy_restricted");
      record.sourceAdmission = { attemptId: request.attemptId, policyRevision: sourcePolicy?.revision ?? null, sourceProofSha256, validated: result };
      record.phase = "validated"; saved(record); return result;
    } catch (error) {
      sourceFailed = true; sourceCause = error;
      if (error instanceof ExternalImageSourceError && error.retryAfterSeconds !== undefined) record.cooldownUntil = Date.now() + error.retryAfterSeconds * 1000;
      record.error = sourceError(error); saved(record); throw error;
    } finally {
      try { await cleanupSource(record); }
      catch (error) { if (sourceFailed) throw new AggregateError([sourceCause, error], "Image source capture and cleanup failed."); throw error; }
    }
  };
  const processRecord = async (record: MarkdownCaptureRecord, signal: AbortSignal): Promise<void> => {
    // Local ownership cleanup is independent of service reachability and current
    // source authority, and must precede receipt adoption or attempt replacement.
    await cleanupSource(record);
    if (stopped || !options.writable() || !options.fence() || !record.request || record.phase === "settled" || !journal.imageOccurrenceAcknowledged(record.occurrence.imageId)) return;
    const request = record.request;
    if (record.submission || record.awaitingRetry) {
      if (record.dispatchPending) { if (Date.now() >= record.cooldownUntil) await submit(record); return; }
      let receipt: ImageCaptureReceipt;
      try { receipt = await hooks.queryImageCapture(request.captureId); }
      catch (error) {
        if (isRetryableCaptureRefusal(error)) return;
        if (error instanceof ImageCaptureRequestError) {
          if (error.code === "capture_not_found") { if (record.submission) await submit(record); }
          else settleRefusal(record, error);
          return;
        }
        throw error;
      }
      observe(record, receipt);
      return;
    }
    if (Date.now() < record.cooldownUntil) return;
    if (record.phase === "waiting") journal.registerImageCaptureRequest(request);
    try { await hooks.prepareImageCapture(journal.getImageCaptureRequest(request.captureId)); }
    catch (error) {
      if (isRetryableCaptureRefusal(error)) { record.cooldownUntil = Date.now() + 1000; saved(record); return; }
      else if (settleRefusal(record, error)) return;
      else throw error;
    }
    if (request.locator.kind === "resource") { freeze(record, { kind: "resource" }); await submit(record); return; }
    if (record.error) { freeze(record, { kind: "failed", error: record.error }); await submit(record); return; }
    let validated = journal.media().captureStatus(request.captureId, request.attemptId);
    if (validated && !hasAdmission(record, validated) || !validated && record.started) { record.error = failure("source_unavailable"); freeze(record, { kind: "failed", error: record.error }); await submit(record); return; }
    if (!validated) {
      try {
        if (Date.now() - record.queuedAt > 30_000) refuse("source_queue_timeout");
        validated = await copy(record, signal);
      } catch (error) {
        record.error ??= sourceError(error); freeze(record, { kind: "failed", error: record.error }); await submit(record); return;
      }
    }
    freeze(record, { kind: "validated", validated }); await submit(record);
  };
  const track = <T>(id: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (active.has(id)) return active.get(id)!.work as Promise<T>;
    const controller = new AbortController();
    const work = Promise.resolve().then(() => run(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal));
    active.set(id, { controller, work });
    return work.finally(() => { active.delete(id); });
  };
  const tick = async (): Promise<void> => {
    if (stopped || active.size >= 2) return;
    const ids = store.listIds("source", { ...(cursor ? { after: cursor } : {}), limit: 32 });
    const work: Promise<unknown>[] = []; let exhausted = true;
    for (const id of ids) {
      if (active.size >= 2) { exhausted = false; break; }
      cursor = id;
      const value = get(id)!;
      const cleanup = needsCleanup(value);
      if ((!options.writable() || !options.fence()) && !cleanup) continue;
      // Source intent commits before position registration. Reconcile that
      // interrupted boundary before waiting for its durable ACK.
      journal.registerImageOccurrence(value.occurrence, null);
      if (value.phase === "settled" && !cleanup) {
        // A crash may separate the durable receipt from its timeline update.
        if (value.receipt && value.request) options.onReceipt(value.request, value.receipt);
        else if (value.error) options.onFailure?.(value.occurrence, value.error);
        continue;
      }
      if (!value.request || active.has(id) || !cleanup && !journal.imageOccurrenceAcknowledged(id)) continue;
      work.push(track(id, signal => processRecord(value, signal)));
    }
    if (exhausted && ids.length < 32) cursor = undefined;
    await Promise.all(work);
  };
  const retry = async (request: ImageCaptureRequest, signal: AbortSignal): Promise<ValidatedImage> => {
    const old = get(request.occurrence.imageId);
    if (!old?.request || old.request.captureId !== request.captureId || canonicalImageJson(old.request.locator) !== canonicalImageJson(request.locator)) return refuse("context_unavailable");
    const running = active.get(request.occurrence.imageId); if (running) { await running.work; return retry(request, signal); }
    if (active.size >= 2) return refuse("rate_limited");
    return track(request.occurrence.imageId, async joined => {
      await cleanupSource(old);
      joined.throwIfAborted();
      if (old.request!.attemptId === request.attemptId && old.error) return refuse(old.error.code);
      const existing = journal.media().captureStatus(request.captureId, request.attemptId); if (existing) { if (!hasAdmission(old, existing)) return refuse("source_unavailable"); return existing; }
      if (old.request!.attemptId === request.attemptId && old.started) return refuse("source_unavailable");
      const remaining = Math.max(0, old.cooldownUntil - Date.now()), until = performance.now() + remaining;
      while (performance.now() < until) {
        joined.throwIfAborted(); checkContext(old.context, request.locator.kind === "local");
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, until - performance.now())));
      }
      const { submission: _previousSubmission, dispatchPending: _previousDispatch, ...withoutRetry } = old;
      const record = saved({ ...withoutRetry, request, phase: "registered", started: false, awaitingRetry: false, error: null, sourceAdmission: null, queuedAt: Date.now() });
      try { const result = await copy(record, joined); record.phase = "unknown"; saved(record); return result; }
      catch (error) { record.error ??= sourceError(error); freeze(record, { kind: "failed", error: record.error }); await submit(record); throw error; }
    }, signal);
  };
  const localWork = () => [...active].filter(([id]) => get(id)?.request?.locator.kind === "local").map(([, work]) => work);
  const invalidateNativeReadPolicy = (): void => { for (const work of localWork()) work.controller.abort(new Error("Native source authority changed.")); };
  return { contextFor, enqueue, get, tick, retry, acquireReadPolicy, invalidateNativeReadPolicy,
    async drainNativeReadPolicy(): Promise<void> { const work = localWork(); for (const item of work) item.controller.abort(new Error("Native source authority changed.")); await Promise.allSettled(work.map(item => item.work)); },
    contextKey: () => canonicalImageJson({ executionId: ticket.executionId, nativeSessionId: journal.getSnapshot().nativeSessionId, cwd: ticket.cwd, platform: process.platform, policyRevision: policyRevision() }),
    invalidate(): void { for (const work of active.values()) work.controller.abort(new Error("Image source authorization changed.")); },
    async stop(): Promise<void> { stopped = true; for (const work of active.values()) work.controller.abort(new Error("Controller source capture stopped.")); await Promise.allSettled([...active.values()].map(item => item.work)); await decodeTail; },
  };
};
