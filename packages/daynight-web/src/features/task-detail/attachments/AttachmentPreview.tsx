import { useRef, useState } from 'react';
import { ApiError, authRequestsPaused, previewLoginUrl } from '../../../api/client';
import { useI18n } from '../../../i18n/LocaleProvider';
import type { Attachment } from '../../../api/types';
import { MarkdownContent } from '../MarkdownContent';
import { attachmentKind, resolveAttachmentUrl } from './model';

export type NativePreviewSource = { readonly updatedAt: string; readonly reloadRevision: number };

export type AttachmentPreviewState = {
  readonly scope: string;
  readonly path: string | null;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly text: string | null;
  readonly error: unknown;
  readonly nativeSource?: NativePreviewSource;
};

type AttachmentPreviewProps = {
  readonly attachment: Attachment;
  readonly preview: AttachmentPreviewState;
  readonly paused?: boolean;
  readonly url: string;
  readonly previewRoot: string;
  readonly onRetry: () => void;
};

const TrustedFrame = ({ url, title, paused }: { readonly url: string; readonly title: string; readonly paused: boolean }) => {
  const { messages } = useI18n();
  const m = messages.inspection.attachments;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loadedFrame, setLoadedFrame] = useState(false);
  const canStart = !paused && !authRequestsPaused();
  const started = useRef(canStart);
  if (canStart) started.current = true;
  const established = () => {
    const frame = frameRef.current;
    if (frame === null) return false;
    try {
      const document = frame.contentDocument;
      return document === null || document.URL !== 'about:blank';
    } catch { return true; }
  };
  const loaded = () => {
    if (!canStart && !loadedFrame && !established()) return;
    setLoadedFrame(true);
  };

  return <div className="attachment-native">
    {!loadedFrame && !paused && <p className="attachment-state attachment-native-state" role="status">{m.previewLoading}</p>}
    {started.current && <iframe className="attachment-frame" ref={frameRef} src={!canStart && !loadedFrame && !established() ? undefined : url} title={title} tabIndex={0} onLoad={loaded} />}
  </div>;
};

const NativeStatus = ({ status, onRetry }: { readonly status: 'loading' | 'ready' | 'error'; readonly onRetry: () => void }) => {
  const { messages } = useI18n();
  const m = messages.inspection.attachments;
  return status === 'ready' ? null : status === 'loading'
    ? <p className="attachment-state attachment-native-state" role="status">{m.previewLoading}</p>
    : <div className="attachment-state attachment-native-state attachment-error" role="alert"><p>{m.previewLoadError}</p><div className="attachment-error-actions"><button className="button" type="button" onClick={onRetry}>{m.retryPreview}</button><a className="button" href={previewLoginUrl()} target="_blank" rel="noopener noreferrer">{m.previewSignIn}</a></div></div>;
};

const ImagePreview = ({ url, path, paused }: { readonly url: string; readonly path: string; readonly paused: boolean }) => {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [revision, setRevision] = useState(0);
  return <div>{(!paused || status === 'ready') && <NativeStatus status={status} onRetry={() => { if (!paused) { setStatus('loading'); setRevision((value) => value + 1); } }} />}{status !== 'error' && (!paused || status === 'ready') && <img key={revision} className="attachment-image" src={url} alt={path} onLoad={() => setStatus('ready')} onError={() => setStatus('error')} />}</div>;
};

const PreviewContent = ({ attachment, preview, url, previewRoot, onRetry, paused = false }: AttachmentPreviewProps) => {
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
    <MarkdownContent className="attachment-markdown" attachmentBase={{ kind: 'document', path: attachment.path }} remotePaused={paused} text={preview.text!} resolveUrl={(value) => resolveAttachmentUrl(value, attachment.path, previewRoot)} />
  );
  if (kind === 'text') return <pre className="attachment-text">{preview.text}</pre>;
  if (kind === 'image') return <ImagePreview key={url} url={url} path={attachment.path} paused={paused} />;
  if (kind === 'pdf' || kind === 'html') {
    if (preview.nativeSource === undefined) return null;
    const key = JSON.stringify([preview.scope, preview.path, preview.nativeSource.updatedAt, preview.nativeSource.reloadRevision, url]);
    return <TrustedFrame key={key} url={url} title={m.frameTitle({ kind: kind === 'pdf' ? 'PDF' : 'HTML', path: attachment.path })} paused={paused} />;
  }
  return <p className="attachment-state">{m.unsupportedPreview}</p>;
};

export const AttachmentPreview = (props: AttachmentPreviewProps) => {
  const kind = attachmentKind(props.attachment);
  const native = props.preview.status === 'ready' && (kind === 'html' || kind === 'pdf');
  return <div tabIndex={native ? undefined : 0} className={`attachment-preview-body${native ? ' attachment-preview-body-native' : ''}`}><PreviewContent {...props} /></div>;
};
