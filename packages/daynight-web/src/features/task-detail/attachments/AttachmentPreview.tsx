import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ApiError } from '../../../api/client';
import { useI18n } from '../../../i18n/LocaleProvider';
import type { Attachment } from '../../../api/types';
import { dialogFocusables } from '../focus';
import { MarkdownContent } from '../MarkdownContent';
import { attachmentKind, resolveAttachmentUrl } from './model';

export type AttachmentPreviewState = {
  readonly path: string | null;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly text: string | null;
  readonly error: unknown;
};

export type AttachmentKeyboardOwner = {
  readonly root: RefObject<HTMLElement | null>;
  readonly onEscape: () => void;
  readonly isActive?: () => boolean;
};

type AttachmentPreviewProps = {
  readonly attachment: Attachment;
  readonly preview: AttachmentPreviewState;
  readonly paused?: boolean;
  readonly url: string;
  readonly previewRoot: string;
  readonly onRetry: () => void;
  readonly keyboardOwner?: AttachmentKeyboardOwner;
};

const TrustedFrame = ({ url, title, keyboardOwner, paused }: { readonly url: string; readonly title: string; readonly keyboardOwner: AttachmentKeyboardOwner | undefined; readonly paused: boolean }) => {
  const { messages } = useI18n();
  const m = messages.inspection.attachments;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loadedFrame, setLoadedFrame] = useState(false);
  const started = useRef(!paused);
  if (!paused) started.current = true;
  const [frameDocument, setFrameDocument] = useState<Document | null>(null);
  const owner = useRef(keyboardOwner);
  owner.current = keyboardOwner;
  const ownerRoot = keyboardOwner?.root;

  useLayoutEffect(() => {
    const frameWindow = frameDocument?.defaultView;
    if (frameDocument === null || frameWindow === null || frameWindow === undefined || ownerRoot === undefined) return;
    const pending = new Set<() => void>();
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape' && event.key !== 'Tab') return;
      const controller = new frameWindow.AbortController();
      let timeout: number;
      const release = () => {
        window.clearTimeout(timeout);
        controller.abort();
        pending.delete(release);
      };
      const complete = (bubbled: KeyboardEvent) => {
        if (bubbled !== event) return;
        release();
        if (event.defaultPrevented) return;
        const currentOwner = owner.current!;
        if (currentOwner.root.current === null || currentOwner.isActive?.() === false) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          currentOwner.onEscape();
        } else {
          const inner = dialogFocusables(frameDocument);
          const active = frameDocument.activeElement;
          if (inner.length !== 0 && (event.shiftKey ? active !== inner[0] : active !== inner[inner.length - 1])) return;
          const frame = frameRef.current!;
          const outer = dialogFocusables(currentOwner.root.current!);
          const index = outer.indexOf(frame);
          const target = outer[(index + (event.shiftKey ? -1 : 1) + outer.length) % outer.length]!;
          event.preventDefault();
          target.focus();
        }
      };
      // Register after the embedded application's current Window consumers. Abort
      // releases the listener even after navigation makes its Window inaccessible.
      pending.add(release);
      frameWindow.addEventListener('keydown', complete, { signal: controller.signal });
      timeout = window.setTimeout(release, 0);
    };
    frameDocument.addEventListener('keydown', keyDown);
    return () => {
      frameDocument.removeEventListener('keydown', keyDown);
      for (const release of pending) release();
    };

  }, [frameDocument, ownerRoot]);

  const loaded = () => {
    if (paused && !loadedFrame) return;
    setLoadedFrame(true);
    setFrameDocument(frameRef.current!.contentDocument);
  };

  return <div className="attachment-native">
    {!loadedFrame && !paused && <p className="attachment-state attachment-native-state" role="status">{m.previewLoading}</p>}
    {started.current && <iframe className="attachment-frame" ref={frameRef} src={paused && !loadedFrame ? undefined : url} title={title} tabIndex={0} onLoad={loaded} />}
  </div>;
};

const NativeStatus = ({ status, onRetry }: { readonly status: 'loading' | 'ready' | 'error'; readonly onRetry: () => void }) => {
  const { messages } = useI18n();
  const m = messages.inspection.attachments;
  return status === 'ready' ? null : status === 'loading'
    ? <p className="attachment-state attachment-native-state" role="status">{m.previewLoading}</p>
    : <div className="attachment-state attachment-native-state attachment-error" role="alert"><p>{m.previewLoadError}</p><button className="button" type="button" onClick={onRetry}>{m.retryPreview}</button></div>;
};

const ImagePreview = ({ url, path, paused }: { readonly url: string; readonly path: string; readonly paused: boolean }) => {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [revision, setRevision] = useState(0);
  return <div>{(!paused || status === 'ready') && <NativeStatus status={status} onRetry={() => { if (!paused) { setStatus('loading'); setRevision((value) => value + 1); } }} />}{status !== 'error' && (!paused || status === 'ready') && <img key={revision} className="attachment-image" src={url} alt={path} onLoad={() => setStatus('ready')} onError={() => setStatus('error')} />}</div>;
};

const PreviewContent = ({ attachment, preview, url, previewRoot, onRetry, keyboardOwner, paused = false }: AttachmentPreviewProps) => {
  const { messages } = useI18n();
  const m = messages.inspection.attachments;
  const kind = attachmentKind(attachment);
  if (preview.status === 'loading') return <p className="attachment-state" role="status">{m.previewLoading}</p>;
  if (preview.status === 'error') return (
    <div className="attachment-state attachment-error" role="alert">
      <p>{m.previewReadError}</p>
      {preview.error instanceof ApiError && preview.error.requestId !== null && <p className="request-id">{messages.common.requestId}{' '}<code>{preview.error.requestId}</code></p>}
      <button className="button" type="button" disabled={paused} onClick={onRetry}>{m.retryPreview}</button>
    </div>
  );
  if (preview.status !== 'ready') return null;
  if (kind === 'markdown') return (
    <MarkdownContent className="attachment-markdown" remotePaused={paused} text={preview.text!} resolveUrl={(value) => resolveAttachmentUrl(value, attachment.path, previewRoot)} />
  );
  if (kind === 'text') return <pre className="attachment-text">{preview.text}</pre>;
  if (kind === 'image') return <ImagePreview key={url} url={url} path={attachment.path} paused={paused} />;
  if (kind === 'pdf' || kind === 'html') return <TrustedFrame key={url} url={url} title={m.frameTitle({ kind: kind === 'pdf' ? 'PDF' : 'HTML', path: attachment.path })} keyboardOwner={keyboardOwner} paused={paused} />;
  return <p className="attachment-state">{m.unsupportedPreview}</p>;
};

export const AttachmentPreview = (props: AttachmentPreviewProps) => {
  const kind = attachmentKind(props.attachment);
  const native = props.preview.status === 'ready' && (kind === 'html' || kind === 'pdf');
  return <div tabIndex={native ? undefined : 0} className={`attachment-preview-body${native ? ' attachment-preview-body-native' : ''}`}><PreviewContent {...props} /></div>;
};
