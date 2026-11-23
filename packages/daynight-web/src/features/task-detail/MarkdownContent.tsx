import { useState, type MouseEvent } from 'react';
import { MarkdownView } from '../../ui/markdown/MarkdownView';
import { MarkdownAttachmentImage } from './MarkdownAttachmentImage';
import { resolveAttachmentReference, type MarkdownAttachmentBase } from './attachments/model';

type MarkdownContentProps = {
  readonly text: string;
  readonly className: string;
  readonly resolveUrl: (value: string) => string | null;
  readonly attachmentBase: MarkdownAttachmentBase;
  readonly remotePaused?: boolean;
  readonly onLinkClick?: (value: string, event: MouseEvent<HTMLAnchorElement>) => void;
};

const MarkdownImageSource = ({ url, alt, title, paused }: { readonly url: string; readonly alt: string; readonly title: string | undefined; readonly paused: boolean }) => {
  const [loaded, setLoaded] = useState(false);
  return <img src={paused && !loaded ? undefined : url} alt={alt} title={title} onLoad={() => { if (!paused) setLoaded(true); }} />;
};

export const MarkdownContent = ({ text, className, resolveUrl, attachmentBase, onLinkClick, remotePaused = false }: MarkdownContentProps) =>
  <MarkdownView text={text} className={className} resources={{
    kind: 'document', paused: remotePaused, resolveUrl, ...(onLinkClick ? { onLinkClick } : {}),
    renderImage: ({ sourceUrl, url, alt, title }) => resolveAttachmentReference(sourceUrl, attachmentBase).kind === 'relative' && url !== ''
      ? <MarkdownAttachmentImage key={url} src={url} alt={alt} title={title} remotePaused={remotePaused} />
      : <MarkdownImageSource key={url} url={url} alt={alt} title={title} paused={remotePaused} />,
  }} />;
