import type { ControllerLifecycleStore } from "../lifecycle-store.js";
import type { NativeProvider, ProviderOptions } from "../providers/types.js";
import type { createControllerRelay } from "../relay.js";
import type { ImageCaptureRequest, ValidatedImage } from "../../../session/image-values.js";

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
  const providerOptions: Pick<ProviderOptions, "registerImageCapture" | "queryImageCapture" | "commitImageCapture" | "failImageCapture" | "stageImageCapture"> = {
    registerImageCapture: async input => {
      const request = journal.registerImageCaptureRequest(input);
      await options.beforeCapture();
      return journal.observeImageCaptureReceipt(await options.capture("register", request));
    },
    queryImageCapture: async captureId => {
      journal.getImageCaptureRequest(captureId);
      return journal.observeImageCaptureReceipt(await options.capture("query", { captureId }), true);
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
      const request = journal.retryImageCaptureRequest(captureId, attemptId);
      const saved = journal.media().captureStatus(captureId, attemptId); if (saved) return saved;
      const key = `${captureId}:${attemptId}`, pending = retries.get(key); if (pending) return pending;
      const work = (async () => {
        if (options.retrySource && ["local", "external"].includes(request.locator.kind)) return options.retrySource(request, signal);
        const source = await provider!.retryImageCapture!(request, signal);
        signal.throwIfAborted();
        if (!options.writable()) throw new Error("Image source retry target_changed.");
        const validated = await journal.media().stageCapture({ ...source, captureId, attemptId, imageId: request.occurrence.imageId });
        signal.throwIfAborted();
        if (!options.writable()) throw new Error("Image source retry target_changed.");
        return validated;
      })();
      retries.set(key, work);
      try { return await work; } finally { if (retries.get(key) === work) retries.delete(key); }
    },
  };
};
