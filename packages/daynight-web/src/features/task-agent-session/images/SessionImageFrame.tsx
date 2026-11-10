import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { SessionResource } from '../../../api/types';
import type { DecodedImageLease, ImageAssetAdapter, VerifiedImageLease } from './image-store';
import { ImageFailure } from './image-store';
import { imageDownloads } from './image-download';
import { useSessionImageScope } from './SessionImageScope';
import { imageIssue, useImageMessages, type ImageIssue } from './image-messages';

export type ImagePresentation = 'standalone' | 'linked' | 'actions';
function useNearViewport(ref: { readonly current: HTMLElement | null }, active: boolean): boolean {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const node = ref.current;
    if (!active || !node) return;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const root = node.closest('.session-timeline');
    const observer = new IntersectionObserver(entries => { setNear(entries.some(entry => entry.isIntersecting)); }, { root, rootMargin: '100% 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, active]);
  return near;
}
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  useEffect(() => { const changed = () => setVisible(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed); }, []);
  return visible;
}
type ImageState = { readonly asset: ImageAssetAdapter; readonly decoded: DecodedImageLease | null; readonly loading: boolean; readonly error: ImageIssue | null };

/** Frames retain geometry when bytes or decoder slots are unavailable. */
export function SessionImageFrame({ asset: suppliedAsset, resource, label, active, resourceAccess = 'live', presentation = 'standalone', mediaKey, error, onInvalidResource }: {
  readonly asset?: ImageAssetAdapter | null; readonly resource?: SessionResource | undefined; readonly label: string; readonly active: boolean;
  readonly resourceAccess?: 'live' | 'none'; readonly presentation?: ImagePresentation; readonly mediaKey?: string; readonly error?: string;
  readonly onInvalidResource?: () => void;
}) {
  const context = useSessionImageScope(), m = useImageMessages();
  let asset: ImageAssetAdapter | null = null, invalidDescriptor = false, resourceChanged = false;
  try { asset = resourceAccess === 'none' ? null : suppliedAsset ?? (resource ? context?.scope?.asset(resource) ?? null : null); }
  catch (error) { invalidDescriptor = true; resourceChanged = error instanceof ImageFailure && error.code === 'resource_changed'; }
  useEffect(() => { if (resourceChanged) onInvalidResource?.(); }, [resourceChanged, onInvalidResource]);
  const node = useRef<HTMLSpanElement>(null), button = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<ImageState | null>(null), [retry, setRetry] = useState(0), [downloading, setDownloading] = useState(false), [downloadError, setDownloadError] = useState<ImageIssue | null>(null);
  const downloadRequest = useRef<AbortController | null>(null);
  const pageVisible = usePageVisible();
  const enabled = active && (context?.active ?? false) && !context?.suspended && pageVisible && resourceAccess === 'live';
  const near = useNearViewport(node, enabled && presentation !== 'actions');
  const displayed = state?.asset === asset ? state : null;
  const canRead = (context?.readAdmitted ?? false) && (asset?.canRead() ?? false);
  const canDownload = (context?.readAdmitted ?? false) && (asset?.canDownload() ?? false);
  const keepCurrentRead = displayed?.loading || displayed?.decoded !== null && displayed?.decoded !== undefined;
  const read = enabled && near && presentation !== 'actions' && (canRead || keepCurrentRead) && (context?.previewAssetKey === null || context?.previewAssetKey === asset?.key);
  useEffect(() => {
    if (!read || !asset) return;
    const pending = new AbortController(); let lease: VerifiedImageLease | null = null, decoded: DecodedImageLease | null = null, unsubscribeLease: (() => void) | null = null, unsubscribeDecoded: (() => void) | null = null;
    const invalidate = () => { pending.abort(); setState(null); };
    const unsubscribe = asset.subscribeInvalidation(invalidate);
    setState({ asset, decoded: null, loading: true, error: null });
    void asset.acquire(pending.signal, 'background').then(async value => {
      lease = value;
      if (pending.signal.aborted) { value.release(); lease = null; return; }
      unsubscribeLease = value.subscribeInvalidation(invalidate);
      try {
        const image = await value.decode(pending.signal, 'background');
        if (pending.signal.aborted || !image.valid) { image.release(); return; }
        decoded = image;
        unsubscribeDecoded = image.subscribeInvalidation(() => setState({ asset, decoded: null, loading: false, error: null }));
        setState({ asset, decoded: image, loading: false, error: null });
      } catch (error) { if (!pending.signal.aborted) setState({ asset, decoded: null, loading: false, error: imageIssue(error, 'decodeFailed') }); }
    }, error => { if (!pending.signal.aborted) setState({ asset, decoded: null, loading: false, error: imageIssue(error, 'readFailed') }); });
    return () => { pending.abort(); unsubscribe(); unsubscribeLease?.(); unsubscribeDecoded?.(); decoded?.release(); lease?.release(); setState(null); };
  }, [read, asset, retry]);
  useEffect(() => {
    if (!enabled) downloadRequest.current?.abort();
    return () => downloadRequest.current?.abort();
  }, [enabled, asset]);

  const width = displayed?.decoded?.valid ? displayed.decoded.width : resource?.width, height = displayed?.decoded?.valid ? displayed.decoded.height : resource?.height;
  const ratio = width && height ? Math.max(0.5, Math.min(3, width / height)) : 4 / 3;
  const image = read && displayed?.decoded?.valid ? displayed.decoded : null;
  const style = { '--session-image-ratio': ratio } as CSSProperties;
  const description = resourceAccess === 'none' ? m.cached : invalidDescriptor ? m.corrupt : resource?.status === 'pending' ? m.pending : displayed?.error ? m[displayed.error] : asset ? displayed?.loading ? m.loading : m.preview : error || resource?.error || m.unavailable;
  const open = (trigger: HTMLElement | null) => {
    if (!enabled || !asset || !context || !canRead) return;
    context.preview.open({ scope: asset.scope, asset, label: label || resource?.name || m.stage, trigger,
      fallbackFocus: () => node.current?.closest('details')?.querySelector<HTMLElement>('summary') ?? context.rootRef.current?.querySelector<HTMLElement>('.session-timeline') ?? null });
  };
  const download = () => {
    if (!enabled || !asset || !canDownload || downloading) return;
    downloadRequest.current?.abort();
    const pending = new AbortController(); downloadRequest.current = pending; setDownloading(true); setDownloadError(null);
    void imageDownloads.download({ scope: asset.scope, asset, label: label || resource?.name || m.stage, signal: pending.signal }).catch(error => {
      if (!pending.signal.aborted) setDownloadError(imageIssue(error, 'downloadFailed'));
    }).finally(() => { if (downloadRequest.current === pending) setDownloading(false); });
  };
  const visual = <span className="session-image-canvas" style={style} data-media-key={image ? undefined : mediaKey}>
    {image ? <img src={image.url} alt={label || resource?.name || m.stage} width={image.width} height={image.height} draggable={false} data-media-key={mediaKey} /> : <span className="session-image-placeholder" role={displayed?.error ? 'alert' : 'status'}>{description}</span>}
  </span>;
  return <span ref={node} className={`session-image-frame session-image-${presentation}`} data-image-id={mediaKey}>
    {presentation === 'actions' ? null : presentation === 'linked' || !asset || resourceAccess === 'none' ? visual : <button className="session-image-open" type="button" ref={button} aria-label={`${m.preview}: ${label || resource?.name || m.stage}`} disabled={!enabled || !canRead} onClick={event => open(event.currentTarget)}>{visual}</button>}
    {presentation !== 'linked' ? <span className="session-image-caption"><span className="session-image-name" title={label || resource?.name}>{label || resource?.name}</span>{asset && resourceAccess === 'live' ? <span className="session-image-actions">
      {presentation === 'actions' ? <button className="button" type="button" aria-label={`${m.preview}: ${label || resource?.name || m.stage}`} disabled={!enabled || !canRead} onClick={event => open(event.currentTarget)}>{m.preview}</button> : null}
      {displayed?.error ? <button className="button" type="button" disabled={!enabled || !canRead} onClick={() => setRetry(value => value + 1)}>{m.retry}</button> : null}
      <button className="button" type="button" aria-label={`${m.downloadImage}: ${label || resource?.name || m.stage}`} disabled={!enabled || !canDownload || downloading} onClick={download}>{downloading ? m.downloading : m.download}</button>
    </span> : null}</span> : null}
    {downloadError ? <span className="session-image-error" role="alert">{m[downloadError]}</span> : null}
  </span>;
}
