import type { ControllerLifecycleStore } from "../lifecycle-store.js";
import type { NativeProvider, ProviderOptions } from "../providers/types.js";
import type { createControllerRelay } from "../relay.js";
import { type ImageCaptureReceipt, type ImageCaptureRequest, type ValidatedImage } from "../../../session/image-values.js";
import { ImageCaptureNotDispatchedError, ImageCapturePrerequisiteError } from "./capture-error.js";
import { ImageHistorySyncFailedError } from "./history-sync.js";

/** Provider capture hooks share one durable service identity with source retries. */
export const createControllerCaptureBridge = (options: {
  journal: ControllerLifecycleStore;
  capture: ReturnType<typeof createControllerRelay>["capture"];
  beforeCapture(): Promise<void>;
  provider(): NativeProvider | null;
  writable(): boolean;
  retrySource?(request: ImageCaptureRequest, signal: AbortSignal): Promise<ValidatedImage>;
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
  const prepare = async (input: ImageCaptureRequest): Promise<void> => {
    journal.registerImageCaptureRequest(input);
    try { await options.beforeCapture(); }
    catch (error) {
      if (error instanceof ImageHistorySyncFailedError) throw new ImageCapturePrerequisiteError(error.imageError);
      throw new ImageCaptureNotDispatchedError("Image history synchronization has not completed.", { cause: error });
    }
  };
  const providerOptions: Pick<ProviderOptions, "prepareImageCapture" | "submitImageCapture" | "registerImageCapture" | "queryImageCapture" | "commitImageCapture" | "failImageCapture" | "stageImageCapture"> = {
    prepareImageCapture: prepare,
    submitImageCapture: async input => {
      if (!options.writable()) throw new ImageCaptureNotDispatchedError("Image capture execution is not writable.");
      const submission = journal.freezeImageCaptureSubmission(input);
      if (submission.outcome.kind === "validated") {
        journal.media().assertCaptureSealed(submission.request.captureId, submission.attemptId, submission.outcome.validated);
      }
      return observe(await options.capture("submit", submission));
    },
    registerImageCapture: async input => {
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
    stageImageCapture: async input => { await options.beforeCapture(); return journal.media().stageCapture(input); },
  };
  return { providerOptions,
    retry: async ({ captureId, attemptId }: { captureId: string; attemptId: string }, signal: AbortSignal) => {
      const provider = options.provider();
      if (!options.retrySource && !provider?.retryImageCapture) throw new Error("component_unsupported: Image source retry resolver is unavailable.");
      if (!options.writable()) throw new Error("Image source retry target_changed.");
      signal.throwIfAborted();
      const key = `${captureId}:${attemptId}`, pending = retries.get(key); if (pending) return pending;
      const work = (async () => {
        await journal.media().releaseCaptureSource(captureId, journal.getImageCaptureAttempt(captureId));
        signal.throwIfAborted();
        if (!options.writable()) throw new Error("Image source retry target_changed.");
        const request = journal.retryImageCaptureRequest(captureId, attemptId);
        // A Markdown stage can survive before its source admission is durable.
        if (options.retrySource && ["local", "external"].includes(request.locator.kind)) return options.retrySource(request, signal);
        const saved = journal.media().captureStatus(captureId, attemptId); if (saved) return saved;
        if (!provider?.retryImageCapture) throw new Error("component_unsupported: Image source retry resolver is unavailable.");
        const source = await provider.retryImageCapture!(request, signal);
        try {
          signal.throwIfAborted();
          if (!options.writable()) throw new Error("Image source retry target_changed.");
          const validated = await journal.media().stageCapture({ ...source, captureId, attemptId, imageId: request.occurrence.imageId });
          signal.throwIfAborted();
          if (!options.writable()) throw new Error("Image source retry target_changed.");
          return validated;
        } finally { source.release?.(); }
      })();
      retries.set(key, work);
      try { return await work; } finally { if (retries.get(key) === work) retries.delete(key); }
    },
  };
};
