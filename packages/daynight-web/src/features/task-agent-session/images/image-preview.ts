import type { ImageAssetAdapter, ImageScope } from './image-store';

export type PreviewCloseReason = 'user' | 'owner_inactive' | 'identity_changed' | 'access_revoked' | 'asset_removed' | 'host_disposed';
export type ImagePreviewRequest = {
  readonly scope: ImageScope;
  readonly asset: ImageAssetAdapter;
  readonly label: string;
  readonly trigger: HTMLElement | null;
  readonly fallbackFocus: () => HTMLElement | null;
};
type Host = { close(request: ImagePreviewRequest | null, reason: PreviewCloseReason): void; suspend(): void; focus(): void };

/** Local display commands never grant authority to read an asset. */
export class ImagePreviewController {
  private request: ImagePreviewRequest | null = null;
  private readonly listeners = new Set<() => void>();
  private host: Host | null = null;
  constructor(private readonly admitted: (scope: ImageScope) => boolean) {}
  readonly snapshot = (): ImagePreviewRequest | null => this.request;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly open = (request: ImagePreviewRequest): void => {
    if (!this.admitted(request.scope) || request.asset.scope !== request.scope || !request.asset.canRead() || modalSuspensions > 0) return;
    if (this.request?.scope === request.scope && this.request.asset.key === request.asset.key) { this.host?.focus(); return; }
    this.request = request; this.publish();
  };
  readonly close = (reason: PreviewCloseReason): void => {
    if (!this.request) return;
    const request = this.request; this.request = null;
    this.host?.close(request, reason); this.publish();
  };
  attach(host: Host): () => void {
    this.host = host; hosts.add(host);
    if (modalSuspensions > 0) host.suspend();
    return () => { hosts.delete(host); if (this.host === host) this.host = null; };
  }
  private publish(): void { for (const listener of this.listeners) listener(); }
}

const hosts = new Set<Host>(), modalListeners = new Set<() => void>();
let modalSuspensions = 0;
export const imagePreviewModalSnapshot = (): boolean => modalSuspensions > 0;
export const subscribeImagePreviewModals = (listener: () => void): (() => void) => { modalListeners.add(listener); return () => { modalListeners.delete(listener); }; };
/** Call before a higher modal takes focus. Native dialogs leave the top layer synchronously. */
export function suspendSessionImagePreviews(): () => void {
  modalSuspensions++;
  for (const host of hosts) host.suspend();
  for (const listener of modalListeners) listener();
  let released = false;
  return () => {
    if (released) return;
    released = true; modalSuspensions--;
    for (const listener of modalListeners) listener();
  };
}
