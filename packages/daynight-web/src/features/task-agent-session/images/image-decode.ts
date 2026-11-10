import { ImageFailure, type DecodedImageLease, type ImageReadPriority, type ImageSize } from './image-types';

const MAX_CANVAS_BYTES = 128 * 1_048_576;
type DecodedSize = { width: number; height: number };
type BrowserImageDecoder = {
  readonly tracks: { readonly ready: Promise<void>; readonly selectedTrack: { readonly frameCount: number } | null };
  readonly completed: Promise<void>;
  decode(options: { frameIndex: number; completeFramesOnly: boolean }): Promise<{ image: { readonly displayWidth: number; readonly displayHeight: number; close(): void } }>;
  close(): void;
};
type DecoderConstructor = { new(options: { data: ReadableStream<Uint8Array>; type: string; preferAnimation: boolean }): BrowserImageDecoder; isTypeSupported(type: string): Promise<boolean> };
const checkSize = (width: number, height: number): DecodedSize => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > 16_384 || height > 16_384 || width * height > 33_554_432) throw new ImageFailure('decode_failed', 'This browser cannot display the image safely.');
  return { width, height };
};

/** Keeps cancellation charged until the browser decoder has actually settled. */
async function decodePixels(blob: Blob, signal: AbortSignal, frameCount: number | null, singleFrame: boolean): Promise<DecodedSize> {
  signal.throwIfAborted();
  const Decoder = (globalThis as typeof globalThis & { ImageDecoder?: DecoderConstructor }).ImageDecoder;
  if (Decoder && await Decoder.isTypeSupported(blob.type)) {
    signal.throwIfAborted();
    const decoder = new Decoder({ data: blob.stream(), type: blob.type, preferAnimation: true });
    const cancel = () => decoder.close();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await decoder.completed;
      await decoder.tracks.ready;
      signal.throwIfAborted();
      const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
      if (!Number.isSafeInteger(count) || count < 1 || count > 256 || frameCount !== null && frameCount !== count) throw new ImageFailure('decode_failed', 'This browser cannot display the image safely.');
      let first: DecodedSize | null = null, pixels = 0;
      for (let frameIndex = 0; frameIndex < count; frameIndex++) {
        signal.throwIfAborted();
        const { image } = await decoder.decode({ frameIndex, completeFramesOnly: true });
        try {
          const size = checkSize(image.displayWidth, image.displayHeight);
          pixels += size.width * size.height;
          if (pixels > 67_108_864) throw new ImageFailure('decode_failed', 'This browser cannot display the image safely.');
          first ??= size;
        } finally { image.close(); }
      }
      signal.throwIfAborted();
      return first!;
    } catch (error) {
      signal.throwIfAborted();
      // Codec support probes can succeed while decoding fails; only a verified
      // single-frame original can safely use the browser's bitmap decoder.
      if (error instanceof ImageFailure || !singleFrame) throw error;
    } finally { signal.removeEventListener('abort', cancel); decoder.close(); }
  }
  if (!singleFrame || typeof createImageBitmap !== 'function') throw new ImageFailure('decode_failed', 'This browser cannot display this image.');
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try { signal.throwIfAborted(); return checkSize(bitmap.width, bitmap.height); }
  finally { bitmap.close(); }
}

type DecodeJob = {
  readonly blob: Blob;
  readonly frameCount: number | null;
  readonly singleFrame: boolean;
  readonly signal: AbortSignal;
  readonly foreground: boolean;
  readonly estimate: number;
  readonly resolve: (lease: DecodedImageLease) => void;
  readonly reject: (error: unknown) => void;
  cancel(): void;
};

export class ImageDecodePool {
  private backgroundBytes = 0;
  private foregroundBytes = 0;
  private backgroundRunning = 0;
  private foregroundRunning = 0;
  private queue: DecodeJob[] = [];
  private running = new Set<Promise<void>>();
  private leases = new Set<DecodedImageLease>();

  acquire(blob: Blob, storedSize: ImageSize | null, signal: AbortSignal, priority: ImageReadPriority, frameCount: number | null, singleFrame: boolean): Promise<DecodedImageLease> {
    signal.throwIfAborted();
    // One foreground canvas remains available even when visible frames fill their allowance.
    const estimate = storedSize ? Math.min(MAX_CANVAS_BYTES, storedSize.width * storedSize.height * 4) : MAX_CANVAS_BYTES;
    return new Promise((resolve, reject) => {
      if (priority === 'background' && this.queue.filter(job => !job.foreground).length >= 32) { reject(new ImageFailure('cache_busy', 'Image display is busy. Try opening the image.')); return; }
      const job: DecodeJob = { blob, frameCount, singleFrame, signal, foreground: priority !== 'background', estimate, resolve, reject, cancel: () => {
        const at = this.queue.indexOf(job);
        if (at >= 0) { this.queue.splice(at, 1); signal.removeEventListener('abort', job.cancel); reject(signal.reason); }
      } };
      signal.addEventListener('abort', job.cancel, { once: true });
      this.queue.push(job); this.pump();
    });
  }
  private pump() {
    for (const job of [...this.queue].sort((a, b) => Number(b.foreground) - Number(a.foreground))) {
      const bytes = job.foreground ? this.foregroundBytes : this.backgroundBytes;
      const running = job.foreground ? this.foregroundRunning : this.backgroundRunning;
      if (running >= 1 || bytes + job.estimate > MAX_CANVAS_BYTES) continue;
      this.queue.splice(this.queue.indexOf(job), 1);
      job.signal.removeEventListener('abort', job.cancel);
      if (job.foreground) { this.foregroundBytes += job.estimate; this.foregroundRunning++; }
      else { this.backgroundBytes += job.estimate; this.backgroundRunning++; }
      const operation = this.run(job);
      this.running.add(operation);
      void operation.finally(() => { this.running.delete(operation); this.pump(); });
    }
  }
  private async run(job: DecodeJob): Promise<void> {
    const timeout = new AbortController(), signal = AbortSignal.any([job.signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(new ImageFailure('decode_timeout', 'Image decoding timed out.')), 15_000);
    let retained = false, charged = job.estimate;
    const returnBytes = (bytes = charged) => { if (job.foreground) this.foregroundBytes -= bytes; else this.backgroundBytes -= bytes; };
    try {
      const size = await decodePixels(job.blob, signal, job.frameCount, job.singleFrame);
      signal.throwIfAborted();
      // A descriptor may describe pre-EXIF axes, but rotation preserves its canvas area.
      const actual = size.width * size.height * 4;
      if (actual > job.estimate) throw new ImageFailure('decode_failed', 'The decoded image exceeds its declared dimensions.');
      returnBytes(charged - actual); charged = actual;
      const url = URL.createObjectURL(job.blob), listeners = new Set<() => void>();
      let valid = true;
      const lease: DecodedImageLease = { ...size, url, get valid() { return valid; }, subscribeInvalidation(listener) { listeners.add(listener); return () => listeners.delete(listener); }, release: () => {
        if (!valid) return;
        valid = false; job.signal.removeEventListener('abort', lease.release);
        URL.revokeObjectURL(url); returnBytes(); this.leases.delete(lease);
        for (const listener of listeners) listener(); listeners.clear(); this.pump();
      } };
      job.signal.addEventListener('abort', lease.release, { once: true });
      this.leases.add(lease); retained = true; job.resolve(lease);
    } catch (error) {
      job.reject(signal.aborted ? signal.reason : error instanceof ImageFailure ? error : new ImageFailure('decode_failed', 'This browser cannot display this image.'));
    } finally {
      clearTimeout(timer);
      if (!retained) returnBytes();
      if (job.foreground) this.foregroundRunning--; else this.backgroundRunning--;
    }
  }
  usage() { return { bytes: this.backgroundBytes + this.foregroundBytes, running: this.backgroundRunning + this.foregroundRunning, queued: this.queue.length }; }
  async drain(): Promise<void> { await Promise.all([...this.running]); }
}
