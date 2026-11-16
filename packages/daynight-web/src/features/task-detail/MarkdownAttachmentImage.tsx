import { useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { previewLoginUrl } from '../../api/client';
import { useI18n } from '../../i18n/LocaleProvider';

export const MarkdownAttachmentImage = ({ remotePaused, ...props }: ComponentPropsWithoutRef<'img'> & { readonly remotePaused: boolean }) => {
  const { messages } = useI18n();
  const m = messages.inspection.attachments;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [revision, setRevision] = useState(0);
  const image = useRef<HTMLImageElement>(null);

  if (status === 'error') return <span className="markdown-image-error" role="alert" aria-label={props.alt || undefined}>
    <span>{m.markdownImageLoadError}</span>
    <span className="markdown-image-error-actions"><button className="button" type="button" disabled={remotePaused} onClick={(event) => {
      event.preventDefault();
      event.stopPropagation();
      if (remotePaused) return;
      setRevision((value) => value + 1);
      setStatus('loading');
    }}>{m.retryMarkdownImage}</button><a className="button" href={previewLoginUrl()} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>{m.previewSignIn}</a></span>
  </span>;

  return <img {...props} key={revision} ref={image} src={remotePaused && status !== 'ready' ? undefined : props.src}
    onLoad={(event) => { if (!remotePaused && event.currentTarget === image.current) setStatus('ready'); }}
    onError={(event) => { if (!remotePaused && event.currentTarget === image.current) setStatus('error'); }} />;
};
