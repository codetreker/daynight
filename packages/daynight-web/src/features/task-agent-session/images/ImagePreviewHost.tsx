import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react';
import { acquireBodyScrollLock } from '../../../app/useBodyScrollLock';
import { dialogFocusables } from '../../task-detail/focus';
import { containSessionScroll } from '../containSessionScroll';
import type { DecodedImageLease, VerifiedImageLease } from './image-store';
import { imageDownloads } from './image-download';
import { ImagePreviewController, type ImagePreviewRequest, type PreviewCloseReason } from './image-preview';
import { imageIssue, useImageMessages, type ImageIssue } from './image-messages';

type Loaded = { readonly request: ImagePreviewRequest; readonly lease: VerifiedImageLease | null; readonly decoded: DecodedImageLease | null; readonly error: ImageIssue | null };
const timelineLocks = new WeakMap<HTMLElement, { count: number; readonly overflow: string; readonly priority: string; readonly top: number; readonly left: number; readonly previewLocked: string | null }>();
function lockTimelines(root: HTMLElement): () => void {
  const releases = [...root.querySelectorAll<HTMLElement>('.session-timeline')].map(element => {
    let lock = timelineLocks.get(element);
    if (!lock) {
      lock = { count: 0, overflow: element.style.getPropertyValue('overflow'), priority: element.style.getPropertyPriority('overflow'), top: element.scrollTop, left: element.scrollLeft, previewLocked: element.getAttribute('data-image-preview-locked') };
      timelineLocks.set(element, lock); element.style.setProperty('overflow', 'hidden'); element.setAttribute('data-image-preview-locked', 'true');
    }
    lock.count++;
    return () => {
      if (--lock.count !== 0) return;
      if (lock.overflow) element.style.setProperty('overflow', lock.overflow, lock.priority); else element.style.removeProperty('overflow');
      element.scrollTop = lock.top; element.scrollLeft = lock.left;
      if (lock.previewLocked === null) element.removeAttribute('data-image-preview-locked'); else element.setAttribute('data-image-preview-locked', lock.previewLocked);
      timelineLocks.delete(element);
    };
  });
  return () => { releases.forEach(release => release()); };
}
function validFocus(root: HTMLElement, target: HTMLElement | null): target is HTMLElement {
  if (!target?.isConnected || !root.contains(target) || target.closest('[hidden], [inert]') || target.matches(':disabled')) return false;
  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.contentVisibility === 'hidden') return false;
  }
  return true;
}

/** One native modal, located inside its owner and outside the timeline viewport. */
export function ImagePreviewHost({ controller, rootRef, active, suspended, readAdmitted }: {
  readonly controller: ImagePreviewController; readonly rootRef: RefObject<HTMLElement | null>; readonly active: boolean; readonly suspended: boolean; readonly readAdmitted: boolean;
}) {
  const request = useSyncExternalStore(controller.subscribe, controller.snapshot), m = useImageMessages();
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null), stage = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [mode, setMode] = useState<'fit' | 'original'>('fit'), [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null), [downloading, setDownloading] = useState(false), [downloadError, setDownloadError] = useState<ImageIssue | null>(null);
  const downloadRequest = useRef<AbortController | null>(null), releaseTimeline = useRef<(() => void) | null>(null);
  const releaseBody = useRef<(() => void) | null>(null);
  const current = useRef({ active, suspended, request }); current.current = { active, suspended, request };
  const retainedPosition = useRef({ top: 0, left: 0 });
  const visible = request !== null && active && !suspended && request.scope.valid;
  const displayed = loaded?.request === request ? loaded : null;
  const decoded = displayed?.decoded?.valid ? displayed.decoded : null;
  const canRead = readAdmitted && (request?.asset.canRead() ?? false);

  useLayoutEffect(() => controller.attach({
    close(closed, reason: PreviewCloseReason) {
      dialog.current?.close();
      releaseTimeline.current?.(); releaseTimeline.current = null;
      releaseBody.current?.(); releaseBody.current = null;
      if (reason !== 'user') downloadRequest.current?.abort();
      if (reason !== 'user' || !closed || !current.current.active || current.current.suspended) return;
      const root = rootRef.current;
      if (!root || root.closest('[hidden], [inert]') || !closed.scope.valid) return;
      const trigger = validFocus(root, closed.trigger) ? closed.trigger : closed.fallbackFocus();
      if (validFocus(root, trigger)) trigger.focus({ preventScroll: true });
    },
    suspend() {
      if (stage.current) retainedPosition.current = { top: stage.current.scrollTop, left: stage.current.scrollLeft };
      dialog.current?.close();
      dialog.current?.querySelector('img')?.removeAttribute('src');
      downloadRequest.current?.abort();
      releaseTimeline.current?.(); releaseTimeline.current = null;
      releaseBody.current?.(); releaseBody.current = null;
    },
    focus() { if (dialog.current?.open) closeButton.current?.focus({ preventScroll: true }); },
  }), [controller, rootRef]);

  useLayoutEffect(() => {
    const node = dialog.current, root = rootRef.current;
    if (!node) return;
    if (!visible || !root || !root.contains(node) || root.closest('[hidden], [inert]')) {
      if (node.open) node.close();
      return;
    }
    if (!node.open) {
      if (!canRead) return;
      node.showModal(); closeButton.current?.focus({ preventScroll: true });
      if (stage.current) { stage.current.scrollTop = retainedPosition.current.top; stage.current.scrollLeft = retainedPosition.current.left; }
    }
    releaseTimeline.current ??= lockTimelines(root);
    releaseBody.current ??= acquireBodyScrollLock(true);
  }, [visible, request, rootRef, canRead]);
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node || !visible) return;
    const releaseGestures = containSessionScroll(node, () => null);
    return () => {
      releaseGestures(); releaseTimeline.current?.(); releaseTimeline.current = null;
      releaseBody.current?.(); releaseBody.current = null;
      if (node.open) node.close();
    };
  }, [visible, request, rootRef]);

  useEffect(() => {
    if (!request) { setLoaded(null); return; }
    const pending = new AbortController(); let lease: VerifiedImageLease | null = null, decodedLease: DecodedImageLease | null = null, unsubscribeLease: (() => void) | null = null, unsubscribeDecoded: (() => void) | null = null;
    setLoaded({ request, lease: null, decoded: null, error: null }); setMode('fit'); setDownloadError(null);
    retainedPosition.current = { top: 0, left: 0 };
    const unsubscribe = request.asset.subscribeInvalidation(() => controller.close('asset_removed'));
    void request.asset.acquire(pending.signal, 'preview').then(async value => {
      lease = value;
      if (pending.signal.aborted) { value.release(); lease = null; return; }
      setLoaded({ request, lease: value, decoded: null, error: null });
      unsubscribeLease = value.subscribeInvalidation(() => { pending.abort(); setLoaded({ request, lease: null, decoded: null, error: 'readFailed' }); });
      try {
        const image = await value.decode(pending.signal, 'preview');
        if (pending.signal.aborted || !image.valid) { image.release(); return; }
        decodedLease = image;
        unsubscribeDecoded = image.subscribeInvalidation(() => setLoaded({ request, lease: value, decoded: null, error: 'decodeFailed' }));
        setLoaded({ request, lease: value, decoded: image, error: null });
      } catch (error) {
        if (!pending.signal.aborted) setLoaded({ request, lease: value, decoded: null, error: imageIssue(error, 'decodeFailed') });
      }
    }, error => { if (!pending.signal.aborted) setLoaded({ request, lease: null, decoded: null, error: imageIssue(error, 'readFailed') }); });
    return () => { pending.abort(); unsubscribe(); unsubscribeLease?.(); unsubscribeDecoded?.(); decodedLease?.release(); lease?.release(); };
  }, [request, retry, controller]);

  useEffect(() => {
    if (!active) downloadRequest.current?.abort();
    return () => { downloadRequest.current?.abort(); };
  }, [active]);
  useLayoutEffect(() => {
    if (!visible || !dialog.current) return;
    const node = dialog.current, viewport = window.visualViewport;
    const resize = () => {
      node.style.setProperty('--image-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
      node.style.setProperty('--image-viewport-width', `${viewport?.width ?? window.innerWidth}px`);
      node.style.setProperty('--image-viewport-top', `${viewport?.offsetTop ?? 0}px`);
      node.style.setProperty('--image-viewport-left', `${viewport?.offsetLeft ?? 0}px`);
    };
    resize(); window.addEventListener('resize', resize); viewport?.addEventListener('resize', resize); viewport?.addEventListener('scroll', resize);
    return () => { window.removeEventListener('resize', resize); viewport?.removeEventListener('resize', resize); viewport?.removeEventListener('scroll', resize); };
  }, [visible]);

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); controller.close('user'); }
    else if (event.key === 'Tab') {
      const controls = dialogFocusables(event.currentTarget), first = controls[0], last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      event.stopPropagation();
    } else if (event.target === stage.current && ['PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
      const node = stage.current!; event.preventDefault(); event.stopPropagation();
      node.scrollTop = event.key === 'Home' ? 0 : event.key === 'End' ? node.scrollHeight : node.scrollTop + (event.key === 'PageUp' ? -1 : 1) * node.clientHeight;
    }
  };
  const download = () => {
    if (!request || !visible || !readAdmitted || downloading || !request.asset.canDownload()) return;
    downloadRequest.current?.abort();
    const pending = new AbortController(); downloadRequest.current = pending; setDownloading(true); setDownloadError(null);
    void imageDownloads.download({ scope: request.scope, asset: request.asset, label: request.label, signal: pending.signal }).catch(error => {
      if (!pending.signal.aborted) setDownloadError(imageIssue(error, 'downloadFailed'));
    }).finally(() => { if (downloadRequest.current === pending) setDownloading(false); });
  };
  return <dialog ref={dialog} className="session-image-preview" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown} onCancel={event => { event.preventDefault(); event.stopPropagation(); controller.close('user'); }}>
    {request ? <>
    <header className="session-image-preview-heading"><h2 id={titleId} title={request?.label}>{request?.label || m.stage}</h2><button className="button" type="button" ref={closeButton} aria-label={m.close} onClick={() => controller.close('user')}>×</button></header>
    <div className="session-image-preview-controls"><button className="button" type="button" aria-pressed={mode === 'fit'} onClick={() => setMode('fit')}>{m.fit}</button><button className="button" type="button" aria-pressed={mode === 'original'} onClick={() => setMode('original')}>{m.original}</button><button className="button" type="button" aria-label={`${m.downloadImage}: ${request?.label || m.stage}`} disabled={!visible || !readAdmitted || !request?.asset.canDownload() || downloading} onClick={download}>{downloading ? m.downloading : m.download}</button></div>
    <div ref={stage} className={`session-image-preview-stage ${mode}`} tabIndex={0} role="region" aria-label={m.stage}>
      {visible && decoded ? <img src={decoded.url} alt={request.label} width={decoded.width} height={decoded.height} draggable={false} /> : null}
      {visible && !decoded ? <div className="session-image-preview-status" role={displayed?.error ? 'alert' : 'status'}>{displayed?.error ? m[displayed.error] : m.loading}{displayed?.error ? <button className="button" type="button" disabled={!canRead} onClick={() => setRetry(value => value + 1)}>{m.retry}</button> : null}</div> : null}
    </div>
    {downloadError ? <p className="session-image-error" role="alert">{m[downloadError]}</p> : null}
    </> : null}
  </dialog>;
}
