import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { canonicalImageJson, parseImageCaptureRequest, type ImageCaptureReceipt, type ImageCaptureRequest, type ImageError, type ImageLocator, type ImageOccurrence, type ValidatedImage } from "../../../session/image-values.js";
import type { ControllerLifecycleStore } from "../lifecycle-store.js";
import type { ControllerLaunchTicket } from "../launch-ticket.js";
import type { NativeReadPolicy, ProviderOptions } from "../providers/types.js";
import type { CaptureReadPolicy, CaptureSourceLease } from "../media/preparations.js";
import { copyLocalImage, createLocalImageContext, parseLocalImagePath } from "./local-source.js";
import type { LocalImageCheckpoint } from "./local-source-proof.js";
import { copyExternalImage, createExternalImagePolicy, ExternalImageSourceError, parseExternalImageUrl, type ExternalImagePolicyOptions } from "./external-source.js";

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
};
type Hooks = Required<Pick<ProviderOptions, "registerImageCapture" | "queryImageCapture" | "commitImageCapture" | "failImageCapture">>;
const failure = (code: string): ImageError => ({ code, message: "The original image source could not be captured." });
const sourceError = (error: unknown): ImageError => {
  const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["policy_restricted", "source_forbidden", "context_unavailable", "permission_denied", "source_not_found", "source_timeout", "source_changed", "source_busy", "source_rate_limited", "source_capacity", "source_queue_timeout", "source_too_large", "invalid_image", "unsupported_media_type", "decode_failed"].includes(code)) return failure(code);
  return failure(String(error).includes("capacity") || String(error).includes("budget") || String(error).includes("free-space") ? "source_capacity" : "source_unavailable");
};
const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** Durable source intents precede register and IO. An interrupted writer is never restarted. */
export const createMarkdownCaptureCoordinator = (options: {
  ticket: ControllerLaunchTicket; journal: ControllerLifecycleStore;
  bridge: Pick<ProviderOptions, keyof Hooks>; writable(): boolean; fence(): string | null;
  nativeReadPolicy?(): NativeReadPolicy | null;
  externalPolicy?: Omit<ExternalImagePolicyOptions, "beforeRequest">;
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
    return record;
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
    record.request = { ...record.request, attemptId: receipt.attemptId };
    record.receipt = receipt;
    const terminal = receipt.state === "committed" || receipt.state === "failed";
    if (terminal) { record.phase = "unknown"; record.error = receipt.error; }
    saved(record);
    if (receipt.resource) {
      if (record.request.locator.kind === "resource") journal.saveResource(receipt.resource);
      else journal.media().adoptCaptureResource(receipt.captureId, receipt.attemptId, receipt.resource);
      store.put("context", `resource:daynight-resource:${receipt.resource.resourceId}`, receipt.resource.resourceId);
    }
    options.onReceipt(record.request, receipt);
    if (terminal) { record.phase = "settled"; saved(record); }
  };
  const settleFailure = async (record: MarkdownCaptureRecord, error: ImageError): Promise<void> => {
    record.error = error; record.phase = "unknown"; saved(record);
    try { observe(record, await hooks.failImageCapture(record.request!.captureId, record.request!.attemptId, error)); }
    catch { /* The original service identity remains query-only. */ }
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
    const media = journal.media(); let lease: CaptureSourceLease | undefined;
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
        if (!options.externalPolicy) return refuse("policy_restricted");
        const policy = createExternalImagePolicy({ ...options.externalPolicy,
          assertEgressPolicy: async () => { checkContext(record.context, false, fence); await options.externalPolicy!.assertEgressPolicy(); },
          beforeRequest: ({ hostname }) => { checkContext(record.context, false, fence); if (!store.rate(hostname)) throw new ExternalImageSourceError("source_rate_limited", 30); },
        });
        return copyExternalImage({ url: request.locator.url, outputPath, signal: joined, policy });
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
    } finally { await lease?.release(); }
  };
  const processRecord = async (record: MarkdownCaptureRecord, signal: AbortSignal): Promise<void> => {
    if (!record.request || record.phase === "settled" || !journal.imageOccurrenceAcknowledged(record.occurrence.imageId)) return;
    let request = record.request;
    let receipt: ImageCaptureReceipt;
    if (record.phase === "waiting") {
      journal.registerImageCaptureRequest(request);
      record.phase = "unknown"; saved(record);
      try { receipt = await hooks.registerImageCapture(request); } catch { return; }
    } else {
      try { receipt = await hooks.queryImageCapture(request.captureId); } catch { return; }
    }
    observe(record, receipt);
    if (receipt.attemptId !== request.attemptId) {
      // Only a service retry request may start that attempt. Query recovery can
      // observe its result but cannot race a second source writer into existence.
      record.awaitingRetry = true; record.started = false;
      if (receipt.state !== "committed" && receipt.state !== "failed") record.phase = "unknown";
      saved(record);
      request = record.request!;
    }
    if (receipt.state === "committed" || receipt.state === "failed") { await journal.media().releaseCaptureSource(request.captureId, request.attemptId); return; }
    if (receipt.state === "copying") { record.phase = "unknown"; saved(record); return; }
    if (record.awaitingRetry) return;
    let validated = journal.media().captureStatus(request.captureId, request.attemptId);
    if (validated && !hasAdmission(record, validated)) { await journal.media().releaseCaptureSource(request.captureId, request.attemptId); await settleFailure(record, failure("source_unavailable")); return; }
    if (!validated && record.started) { await journal.media().releaseCaptureSource(request.captureId, request.attemptId); await settleFailure(record, record.error ?? failure("source_unavailable")); return; }
    if (!validated) {
      try {
        if (Date.now() - record.queuedAt > 30_000) refuse("source_queue_timeout");
        validated = await copy(record, signal);
      } catch (error) {
        if (error instanceof ExternalImageSourceError && error.retryAfterSeconds !== undefined) record.cooldownUntil = Date.now() + error.retryAfterSeconds * 1000;
        await settleFailure(record, sourceError(error)); return;
      }
    }
    record.phase = "unknown"; saved(record);
    try { observe(record, await hooks.commitImageCapture(request.captureId, request.attemptId, validated)); } catch { /* Query the original commit. */ }
  };
  const track = <T>(id: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (active.has(id)) return active.get(id)!.work as Promise<T>;
    const controller = new AbortController();
    const work = Promise.resolve().then(() => run(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal));
    active.set(id, { controller, work });
    return work.finally(() => { active.delete(id); });
  };
  const tick = async (): Promise<void> => {
    if (stopped || !options.writable() || !options.fence() || active.size >= 2) return;
    const ids = store.listIds("source", { ...(cursor ? { after: cursor } : {}), limit: 32 });
    const work: Promise<unknown>[] = []; let exhausted = true;
    for (const id of ids) {
      if (active.size >= 2) { exhausted = false; break; }
      cursor = id;
      const value = get(id)!;
      // Source intent commits before position registration. Reconcile that
      // interrupted boundary before waiting for its durable ACK.
      journal.registerImageOccurrence(value.occurrence, null);
      if (value.phase === "settled") {
        // A crash may separate the durable receipt from its timeline update.
        if (value.receipt && value.request) options.onReceipt(value.request, value.receipt);
        else if (value.error) options.onFailure?.(value.occurrence, value.error);
        continue;
      }
      if (!value.request || active.has(id) || !journal.imageOccurrenceAcknowledged(id)) continue;
      work.push(track(id, signal => processRecord(value, signal)));
    }
    if (exhausted && ids.length < 32) cursor = undefined;
    await Promise.all(work);
  };
  const retry = async (request: ImageCaptureRequest, signal: AbortSignal): Promise<ValidatedImage> => {
    const old = get(request.occurrence.imageId);
    if (!old?.request || old.request.captureId !== request.captureId || canonicalImageJson(old.request.locator) !== canonicalImageJson(request.locator)) return refuse("context_unavailable");
    const running = active.get(request.occurrence.imageId); if (running) { await running.work; return retry(request, signal); }
    if (active.size >= 2) return refuse("source_capacity");
    const existing = journal.media().captureStatus(request.captureId, request.attemptId); if (existing) { if (!hasAdmission(old, existing)) return refuse("source_unavailable"); return existing; }
    if (old.request.attemptId === request.attemptId && old.started) return refuse("source_unavailable");
    return track(request.occurrence.imageId, async joined => {
      const remaining = Math.max(0, old.cooldownUntil - Date.now()), until = performance.now() + remaining;
      while (performance.now() < until) {
        joined.throwIfAborted(); checkContext(old.context, request.locator.kind === "local");
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, until - performance.now())));
      }
      await journal.media().releaseCaptureSource(old.request!.captureId, old.request!.attemptId);
      const record = saved({ ...old, request, phase: "registered", started: false, awaitingRetry: false, error: null, sourceAdmission: null, queuedAt: Date.now() });
      try { const result = await copy(record, joined); record.phase = "unknown"; saved(record); return result; }
      catch (error) { await settleFailure(record, sourceError(error)); throw error; }
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
