import type { ControllerLifecycleStore } from "../lifecycle-store.js";
import type { NativeProvider, ProviderOptions } from "../providers/types.js";
import type { createControllerRelay } from "../relay.js";
import { type ImageCaptureReceipt, type ImageCaptureRequest, type ValidatedImage } from "../../../session/image-values.js";
import { ImageCaptureNotDispatchedError, ImageCapturePrerequisiteError, ImageCaptureRequestError, ImageCaptureRetrySettledError, ImageCaptureRetryUnknownError } from "./capture-error.js";
import { ImageHistorySyncFailedError } from "./history-sync.js";
import type { ControllerFence } from "../../../session/protocol.js";
import { canonicalImageJson, type DirectCaptureSubmission } from "../../../session/image-values.js";
import { ImageCapturePendingAckError, ImageCapturePositionError } from "./capture-source.js";

/** Provider capture hooks share one durable service identity with source retries. */
export const createControllerCaptureBridge = (options: {
  journal: ControllerLifecycleStore;
  capture: ReturnType<typeof createControllerRelay>["capture"];
  beforeCapture(signal?: AbortSignal): Promise<void>;
  provider(): NativeProvider | null;
  writable(): boolean;
  retrySource?(request: ImageCaptureRequest, signal: AbortSignal): Promise<ValidatedImage>;
  relayMode?(): boolean;
  currentFence?(): ControllerFence | null;
  currentAcknowledgedSequence?(): string | null;
  sourceEpoch?: string;
}) => {
  const { journal } = options;
  const retries = new Map<string, Promise<ValidatedImage>>();
  const observe = (input: ImageCaptureReceipt, reconcileAttempt = false, expectedAttempt?: string): ImageCaptureReceipt => {
    const receipt = journal.observeImageCaptureReceipt(input, reconcileAttempt, expectedAttempt);
    if (receipt.resource) {
      const request = journal.getImageCaptureRequest(receipt.captureId);
      if (request.locator.kind === "resource") journal.saveResource(receipt.resource);
      else journal.media().adoptCaptureResource(receipt.captureId, receipt.attemptId, receipt.resource);
    }
    return receipt;
  };
  const synchronizeHistory = async (signal?: AbortSignal): Promise<void> => {
    if (options.relayMode?.()) return;
    try { await options.beforeCapture(signal); }
    catch (error) {
      if (error instanceof ImageCapturePrerequisiteError) throw error;
      if (error instanceof ImageHistorySyncFailedError) throw new ImageCapturePrerequisiteError(error.imageError);
      throw new ImageCaptureNotDispatchedError("Image history synchronization has not completed.", { cause: error });
    }
  };
  const proof = (captureId: string, attemptId: string) => {
    const fence = options.currentFence?.();
    const ack = options.currentAcknowledgedSequence?.();
    if (!fence || !options.writable() || !options.sourceEpoch || ack == null) throw new ImageCaptureNotDispatchedError("Image capture relay is unavailable.");
    let position: { sourceSeq: string };
    try { position = journal.imageCaptureProof(captureId, attemptId); }
    catch (error) { if (error instanceof ImageCapturePendingAckError) throw new ImageCaptureNotDispatchedError("Image capture position is waiting for ACK.", { cause: error }); throw error; }
    if (BigInt(position.sourceSeq) > BigInt(ack)) throw new ImageCaptureNotDispatchedError("Image capture position is waiting for its current connection ACK.");
    if (!options.writable() || canonicalImageJson(options.currentFence?.()) !== canonicalImageJson(fence)) throw new ImageCaptureNotDispatchedError("Image capture connection changed.");
    return { sourceEpoch: options.sourceEpoch, ...position };
  };
  const settleRetryPosition = async (captureId: string, attemptId: string, cause: unknown): Promise<never> => {
    if (!(cause instanceof ImageCapturePositionError)) { if (cause instanceof ImageCaptureNotDispatchedError) throw cause; throw new ImageCaptureRetryUnknownError(cause); }
    if (!options.writable() || !options.currentFence?.()) throw new ImageCaptureNotDispatchedError("Image capture relay is unavailable.");
    const previous = journal.getImageCaptureSubmission(captureId, attemptId);
    const failure: DirectCaptureSubmission = previous?.outcome.kind === "failed" ? previous : { request: journal.getImageCaptureRequest(captureId), attemptId, outcome: { kind: "failed", error: { code: "capability_changed", message: "The original image position is no longer available." } } };
    let receipt: ImageCaptureReceipt;
    try { receipt = observe(await options.capture("submit", journal.freezeImageCaptureSubmission(failure, true))); }
    catch (error) { if (error instanceof ImageCaptureNotDispatchedError || error instanceof ImageCaptureRequestError && error.code === "rate_limited") throw error; throw new ImageCaptureRetryUnknownError(error); }
    if (receipt.state !== "failed" || !receipt.error) throw new ImageCaptureRetryUnknownError(new Error("Retry settlement returned a different receipt."));
    throw new ImageCaptureRetrySettledError(receipt.error);
  };
  const submitRetry = async (captureId: string, attemptId: string, validated: ValidatedImage): Promise<void> => {
    let admission: ReturnType<typeof proof>;
    try { admission = proof(captureId, attemptId); }
    catch (error) { return settleRetryPosition(captureId, attemptId, error); }
    const submission = journal.freezeImageCaptureSubmission({ request: journal.getImageCaptureRequest(captureId), attemptId, outcome: { kind: "validated", validated } });
    try { observe(await options.capture("submit", { ...submission, ...admission })); }
    catch (error) { if (error instanceof ImageCaptureNotDispatchedError || error instanceof ImageCaptureRequestError && error.code === "rate_limited") throw error; throw new ImageCaptureRetryUnknownError(error); }
  };
  const prepare = async (input: ImageCaptureRequest, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    journal.registerImageCaptureRequest(input);
    await synchronizeHistory(signal);
    signal?.throwIfAborted();
    if (options.relayMode?.()) {
      try { proof(input.captureId, input.attemptId); }
      catch (error) { if (error instanceof ImageCapturePositionError) throw new ImageCapturePrerequisiteError({ code: "capability_changed", message: "The original image position is no longer available." }); throw error; }
    }
  };
  const providerOptions: Pick<ProviderOptions, "prepareImageCapture" | "verifyImageCapture" | "freezeImageCapture" | "submitImageCapture" | "registerImageCapture" | "queryImageCapture" | "commitImageCapture" | "failImageCapture" | "stageImageCapture"> = {
    prepareImageCapture: prepare,
    freezeImageCapture: submission => {
      if (journal.getOnlineMode() === "relay") journal.freezeImageCaptureSubmission(submission, submission.outcome.kind === "failed" && submission.attemptId !== submission.request.attemptId);
    },
    verifyImageCapture: (captureId, attemptId) => {
      if (!options.writable()) throw new ImageCaptureNotDispatchedError("Image capture execution is not writable.");
      if (options.relayMode?.()) {
        try { proof(captureId, attemptId); }
        catch (error) { if (error instanceof ImageCapturePositionError) throw new ImageCapturePrerequisiteError({ code: "capability_changed", message: "The original image position is no longer available." }); throw error; }
      }
    },
    submitImageCapture: async input => {
      if (!options.writable()) throw new ImageCaptureNotDispatchedError("Image capture execution is not writable.");
      if (options.relayMode?.()) {
        let admission: ReturnType<typeof proof>;
        try { admission = proof(input.request.captureId, input.attemptId); }
        catch (error) {
          if (!(error instanceof ImageCapturePositionError)) throw error;
          if (input.outcome.kind === "failed" && input.attemptId !== input.request.attemptId) {
            let receipt: ImageCaptureReceipt;
            try { receipt = observe(await options.capture("query", { captureId: input.request.captureId })); }
            catch (cause) { throw new ImageCaptureRetryUnknownError(cause); }
            if (receipt.attemptId !== input.attemptId) throw new Error("Image capture retry receipt attempt conflict.");
            if (receipt.state !== "reserved") return receipt;
            if (!options.writable() || !options.currentFence?.()) throw new ImageCaptureNotDispatchedError("Image capture relay is unavailable.");
            try { return observe(await options.capture("submit", journal.freezeImageCaptureSubmission(input, true))); }
            catch (cause) { if (cause instanceof ImageCaptureNotDispatchedError || cause instanceof ImageCaptureRequestError && cause.code === "rate_limited") throw cause; throw new ImageCaptureRetryUnknownError(cause); }
          }
          throw new ImageCapturePrerequisiteError({ code: "capability_changed", message: "The original image position is no longer available." });
        }
        const submission = journal.freezeImageCaptureSubmission(input);
        if (submission.outcome.kind === "validated") journal.media().assertCaptureSealed(submission.request.captureId, submission.attemptId, submission.outcome.validated);
        try { return observe(await options.capture("submit", { ...submission, ...admission })); }
        catch (cause) { if (input.attemptId !== input.request.attemptId && !(cause instanceof ImageCaptureNotDispatchedError || cause instanceof ImageCaptureRequestError && cause.code === "rate_limited")) throw new ImageCaptureRetryUnknownError(cause); throw cause; }
      }
      const submission = journal.freezeImageCaptureSubmission(input);
      if (submission.outcome.kind === "validated") {
        journal.media().assertCaptureSealed(submission.request.captureId, submission.attemptId, submission.outcome.validated);
      }
      await synchronizeHistory();
      if (!options.writable()) throw new ImageCaptureNotDispatchedError("Image capture execution changed before submission.");
      return observe(await options.capture("submit", submission));
    },
    registerImageCapture: async input => {
      if (options.relayMode?.()) throw new ImageCaptureRequestError({ code: "component_unsupported", message: "Relay capture requires direct submission." });
      const request = journal.registerImageCaptureRequest(input);
      try { await options.beforeCapture(); }
      catch (error) {
        if (error instanceof ImageHistorySyncFailedError) throw new ImageCapturePrerequisiteError(error.imageError);
        throw new ImageCaptureNotDispatchedError("Image history synchronization has not completed.", { cause: error });
      }
      return journal.observeImageCaptureReceipt(await options.capture("register", request));
    },
    queryImageCapture: async captureId => {
      journal.getImageCaptureRequest(captureId);
      const receipt = await options.capture("query", { captureId });
      const previousAttempt = journal.getImageCaptureAttempt(captureId);
      journal.validateImageCaptureReceipt(receipt, true, previousAttempt);
      if (previousAttempt !== receipt.attemptId) await journal.media().releaseCaptureSource(captureId, previousAttempt);
      return observe(receipt, true, previousAttempt);
    },
    commitImageCapture: async (captureId, attemptId, validated) => {
      journal.assertImageCaptureAttempt(captureId, attemptId);
      return journal.observeImageCaptureReceipt(await options.capture("commit", { captureId, attemptId, validated }));
    },
    failImageCapture: async (captureId, attemptId, error) => {
      journal.assertImageCaptureAttempt(captureId, attemptId);
      return journal.observeImageCaptureReceipt(await options.capture("failed", { captureId, attemptId, error }));
    },
    stageImageCapture: input => journal.media().stageCapture(input),
  };
  return { providerOptions,
    retry: async ({ captureId, attemptId }: { captureId: string; attemptId: string }, signal: AbortSignal) => {
      const provider = options.provider();
      if (!options.retrySource && !provider?.retryImageCapture) throw new Error("component_unsupported: Image source retry resolver is unavailable.");
      if (!options.writable()) throw new Error("Image source retry target_changed.");
      signal.throwIfAborted();
      const relayRetry = options.relayMode?.() === true || journal.getOnlineMode() === "relay";
      const key = `${captureId}:${attemptId}`, pending = retries.get(key); if (pending) return pending;
      const work = (async () => {
        const previousAttempt = journal.getImageCaptureAttempt(captureId);
        if (previousAttempt !== attemptId) await journal.media().releaseCaptureSource(captureId, previousAttempt);
        signal.throwIfAborted();
        if (!options.writable()) throw new Error("Image source retry target_changed.");
        const request = journal.retryImageCaptureRequest(captureId, attemptId, options.relayMode?.() === true);
        if (options.relayMode?.()) {
          let receipt: ImageCaptureReceipt;
          try { receipt = observe(await options.capture("query", { captureId })); }
          catch (cause) { throw new ImageCaptureRetryUnknownError(cause); }
          if (receipt.attemptId !== attemptId) throw new Error("Image capture retry receipt attempt conflict.");
          if (receipt.state !== "reserved") {
            if (receipt.state === "failed" && receipt.error) throw new ImageCaptureRetrySettledError(receipt.error);
            const saved = journal.media().captureStatus(captureId, attemptId);
            if (saved && (receipt.state === "copying" || receipt.state === "committed")) return saved;
            throw new ImageCaptureRetryUnknownError(new Error("Original retry bytes are unavailable."));
          }
          const previous = journal.getImageCaptureSubmission(captureId, attemptId);
          if (previous?.outcome.kind === "failed") {
            let result: ImageCaptureReceipt;
            try { result = observe(await options.capture("submit", previous)); }
            catch (cause) { if (cause instanceof ImageCaptureNotDispatchedError || cause instanceof ImageCaptureRequestError && cause.code === "rate_limited") throw cause; throw new ImageCaptureRetryUnknownError(cause); }
            if (result.state !== "failed" || !result.error) throw new ImageCaptureRetryUnknownError(new Error("Retry settlement returned a different receipt."));
            throw new ImageCaptureRetrySettledError(result.error);
          }
          try { proof(captureId, attemptId); } catch (error) { return settleRetryPosition(captureId, attemptId, error); }
          if (previous?.outcome.kind === "validated") {
            journal.media().assertCaptureSealed(captureId, attemptId, previous.outcome.validated);
            await submitRetry(captureId, attemptId, previous.outcome.validated);
            return previous.outcome.validated;
          }
        }
        // A Markdown stage can survive before its source admission is durable.
        if (options.retrySource && ["local", "external"].includes(request.locator.kind)) {
          const validated = await options.retrySource(request, signal);
          if (options.relayMode?.()) await submitRetry(captureId, attemptId, validated);
          return validated;
        }
        const saved = journal.media().captureStatus(captureId, attemptId);
        if (saved) {
          if (options.relayMode?.()) await submitRetry(captureId, attemptId, saved);
          return saved;
        }
        if (!provider?.retryImageCapture) throw new Error("component_unsupported: Image source retry resolver is unavailable.");
        const source = await provider.retryImageCapture!(request, signal);
        try {
          signal.throwIfAborted();
          if (!options.writable()) throw new Error("Image source retry target_changed.");
          const validated = await journal.media().stageCapture({ ...source, captureId, attemptId, imageId: request.occurrence.imageId });
          signal.throwIfAborted();
          if (!options.writable()) throw new Error("Image source retry target_changed.");
          if (options.relayMode?.()) await submitRetry(captureId, attemptId, validated);
          return validated;
        } finally { source.release?.(); }
      })();
      const observed = work.catch(error => {
        if (!relayRetry) throw error;
        if (error instanceof ImageCaptureRetrySettledError || error instanceof ImageCaptureRetryUnknownError || error instanceof ImageCaptureNotDispatchedError || error !== null && typeof error === "object" && "code" in error && error.code === "rate_limited") throw error;
        throw new ImageCaptureRetryUnknownError(error);
      });
      retries.set(key, observed);
      try { return await observed; } finally { if (retries.get(key) === observed) retries.delete(key); }
    },
  };
};
