import { ImageFailure, type ImageAssetAdapter, type ImageScope, type VerifiedImageLease } from './image-types';

const extensions: Readonly<Record<VerifiedImageLease['mediaType'], string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };
export function imageDownloadName(label: string, mime: VerifiedImageLease['mediaType'], identity: string): string {
  const extension = extensions[mime];
  let stem = (label.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').split(/[\\/]/).at(-1) ?? '').replace(/[:*?"<>|]/g, '-').replace(/\.[^.]*$/, '').replace(/^[.\s]+|[.\s]+$/g, '');
  if (!stem || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(stem)) stem = `image-${identity.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'download'}`;
  return [...stem].slice(0, 119 - extension.length).join('') + `.${extension}`;
}
type Request = { readonly scope: ImageScope; readonly asset: ImageAssetAdapter; readonly label: string; readonly signal: AbortSignal };
type Job = { readonly request: Request; readonly controller: AbortController; readonly resolve: () => void; readonly reject: (error: unknown) => void; readonly unsubscribe: () => void; timer: ReturnType<typeof setTimeout> | null; cleanup: (() => void) | null; triggered: boolean };

/**
 * A page reads at most one download original at a time and keeps at most two
 * waiting user requests. Triggered downloads leave the read slot immediately;
 * their dedicated URLs stay retained, at most two at once, for the browser's
 * bounded handoff period.
 */
export class ImageDownloadQueue {
  private active: Job | null = null;
  private queue: Job[] = [];
  private retained: Job[] = [];
  download(request: Request): Promise<void> {
    if (request.scope !== request.asset.scope || !request.asset.canDownload() || request.signal.aborted) return Promise.reject(request.signal.aborted ? request.signal.reason : new ImageFailure(request.scope.valid ? 'access_pending' : 'access_revoked', 'Image download is unavailable.'));
    if (this.active && this.queue.length >= 2) return Promise.reject(new ImageFailure('download_busy', 'Image download is busy. Try again.'));
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const cancel = () => controller.abort(request.signal.aborted ? request.signal.reason : new ImageFailure('access_revoked', 'Image access has ended.'));
      request.signal.addEventListener('abort', cancel, { once: true });
      const unsubscribeScope = request.scope.subscribeInvalidation(cancel), unsubscribeAsset = request.asset.subscribeInvalidation(cancel);
      const job: Job = { request, controller, resolve, reject, triggered: false, timer: null, cleanup: null, unsubscribe: () => { request.signal.removeEventListener('abort', cancel); unsubscribeScope(); unsubscribeAsset(); } };
      controller.signal.addEventListener('abort', () => {
        const at = this.queue.indexOf(job);
        if (at >= 0) { this.queue.splice(at, 1); this.finish(job); reject(controller.signal.reason); }
        else job.cleanup?.();
      }, { once: true });
      if (this.active) {
        job.timer = setTimeout(() => controller.abort(new ImageFailure('download_busy', 'Image download is busy. Try again.')), 65_000);
        this.queue.push(job);
      } else this.start(job);
    });
  }
  private start(job: Job) { this.active = job; if (job.timer) clearTimeout(job.timer); job.timer = null; void this.run(job); }
  private async run(job: Job) {
    let lease: VerifiedImageLease | null = null, handoff: VerifiedImageLease | null = null, url: string | null = null;
    const cleanup = () => { if (url) { URL.revokeObjectURL(url); url = null; } lease?.release(); lease = null; handoff?.release(); handoff = null; this.finish(job); };
    try {
      job.controller.signal.throwIfAborted();
      if (!job.request.asset.canDownload()) throw new ImageFailure(job.request.scope.valid ? 'access_pending' : 'access_revoked', 'Image download is unavailable.');
      lease = await job.request.asset.acquire(job.controller.signal, 'download');
      job.controller.signal.throwIfAborted();
      // The cached original resolves this lease without another read. It keeps
      // the retained URL's bytes charged to the background budget once the
      // download reservation is released; when that budget is full the store
      // drops its cache entry and the URL alone holds the Blob until revoked.
      handoff = await job.request.asset.acquire(job.controller.signal, 'background').catch(() => null);
      job.controller.signal.throwIfAborted();
      if (!job.request.asset.canDownload() || !lease.valid) throw new ImageFailure(job.request.scope.valid ? 'access_pending' : 'access_revoked', 'Image download is unavailable.');
      url = URL.createObjectURL(lease.blob);
      const link = document.createElement('a'); link.href = url;
      link.download = imageDownloadName(job.request.label, lease.mediaType, job.request.asset.resource?.resourceId ?? job.request.asset.key);
      link.click(); job.triggered = true; job.cleanup = cleanup;
      lease.release(); lease = handoff; handoff = null;
      job.timer = setTimeout(cleanup, 60_000);
      this.retain(job); job.resolve();
    } catch (error) { cleanup(); job.reject(error); }
  }
  private retain(job: Job) {
    this.retained.push(job);
    // Revoking the oldest retained URL early bounds page-held download Blobs
    // after the browser has already received each earlier download.
    while (this.retained.length > 2) this.retained.shift()?.cleanup?.();
    this.release(job);
  }
  private release(job: Job) {
    if (this.active !== job) return;
    this.active = null; const next = this.queue.shift(); if (next) this.start(next);
  }
  private finish(job: Job) {
    if (job.timer) clearTimeout(job.timer); job.timer = null; job.cleanup = null; job.unsubscribe();
    const at = this.retained.indexOf(job); if (at >= 0) this.retained.splice(at, 1);
    this.release(job);
  }
  close() {
    for (const job of [...this.queue]) job.controller.abort(new ImageFailure('access_revoked', 'Image access has ended.'));
    this.active?.controller.abort(new ImageFailure('access_revoked', 'Image access has ended.'));
    for (const job of [...this.retained]) job.controller.abort(new ImageFailure('access_revoked', 'Image access has ended.'));
  }
}
export const imageDownloads = new ImageDownloadQueue();
