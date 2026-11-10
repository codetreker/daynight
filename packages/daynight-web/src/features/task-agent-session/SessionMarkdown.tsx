import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseMarkdownImageMetadata, type ImagePart, type ImageUnavailablePart, type MarkdownImageMetadata } from '../../../../daynight/src/session/image-values';
import { ChatMarkdown, type ChatImageNode, type ChatImagePresentation } from '../../ui/ChatMarkdown';
import { useI18n } from '../../i18n/LocaleProvider';
import { useSessionMessages } from './messages';
import { useTimelineMessages } from './timeline-messages';

export type SessionImageRenderer = (part: ImagePart | ImageUnavailablePart, presentation: ChatImagePresentation) => ReactNode;
export type SessionMarkdownProps = {
  readonly text: string;
  readonly metadata?: MarkdownImageMetadata;
  readonly renderImage?: SessionImageRenderer;
  readonly resourceAccess?: 'live' | 'none';
  readonly onInvalidBindings?: () => void;
};

const link = (href: string | null): string | null => href !== null && /^(https?:|mailto:)/i.test(href) ? href : null;

/** Bindings are admitted only for the exact body; neither labels nor source URLs grant resource access. */
export function SessionMarkdown({ text, metadata, renderImage, resourceAccess = 'live', onInvalidBindings }: SessionMarkdownProps) {
  const messages = useSessionMessages(), labels = useTimelineMessages(), { locale } = useI18n();
  // Semantic identity keeps ordinary history rerenders from restarting a verified frame.
  const encoded = metadata === undefined ? null : JSON.stringify(metadata);
  const input = useMemo(() => {
    if (encoded === null) return { text, metadata: null, invalid: false };
    try { return { text, metadata: parseMarkdownImageMetadata(JSON.parse(encoded), text, true), invalid: false }; }
    catch { return { text, metadata: null, invalid: true }; }
  }, [text, encoded]);
  const [verified, setVerified] = useState<typeof input | null>(null);
  const [rejected, setRejected] = useState<typeof input | null>(null);
  const callback = useRef(onInvalidBindings); callback.current = onInvalidBindings;
  const notified = useRef<typeof input | null>(null);
  const invalid = useCallback(() => {
    if (resourceAccess === 'none' || notified.current === input) return;
    notified.current = input;
    setRejected(input);
    callback.current?.();
  }, [input, resourceAccess]);
  useEffect(() => {
    if (resourceAccess === 'none') return;
    if (input.invalid) { invalid(); return; }
    if (!input.metadata || verified === input) return;
    let current = true;
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.text)).then(result => {
      if (!current) return;
      const digest = Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
      if (digest === input.metadata!.textSha256) setVerified(input);
      else invalid();
    }).catch(() => { if (current) invalid(); });
    return () => { current = false; };
  }, [input, resourceAccess, verified, invalid]);

  const admitted = resourceAccess === 'live' && verified === input ? input.metadata : null;
  const bindings = admitted?.complete && !admitted.truncated ? admitted.bindings : null;
  const byPosition = useMemo(() => new Map(bindings?.map(binding => [`${binding.start}/${binding.end}`, binding])), [bindings]);
  const draw = useCallback((node: ChatImageNode, presentation: ChatImagePresentation) => {
    const binding = byPosition.get(`${node.start}/${node.end}`);
    if (binding && renderImage) return renderImage(binding.part, presentation);
    return presentation === 'actions' ? null : <span className="session-resource-unavailable">{node.alt} — {messages.resourceUnavailable}</span>;
  }, [byPosition, renderImage, messages.resourceUnavailable]);
  const [retainedOpen, setRetainedOpen] = useState(false);
  const retained = input.metadata?.retainedImages ?? [];
  return <>
    {resourceAccess === 'live' && rejected === input ? <span className="session-resource-unavailable" role="status">{locale === 'zh-CN' ? '图片引用验证失败。' : 'Image references could not be verified.'}</span> : null}
    <ChatMarkdown text={text} className="session-markdown" resourceUnavailable={messages.resourceUnavailable} tableLabel={labels.table}
      {...(bindings && renderImage ? { imagePositions: bindings, renderImage: draw, onInvalidImages: invalid } : {})} />
    {retained.length ? <details className="session-retained-images" open={retainedOpen} onToggle={event => setRetainedOpen(event.currentTarget.open)}>
      <summary>{locale === 'zh-CN' ? '较早版本图片' : 'Earlier images'}</summary>
      {retainedOpen ? retained.map(binding => {
        const href = link(binding.linkHref), part = binding.part;
        return <span key={binding.imageId} className="session-retained-image">{admitted && renderImage
          ? href ? <><a href={href} target="_blank" rel="noopener noreferrer">{renderImage(part, 'linked')}</a>{renderImage(part, 'actions')}</> : renderImage(part, 'standalone')
          : <span className="session-resource-unavailable">{part.label} — {messages.resourceUnavailable}</span>}</span>;
      }) : null}
    </details> : null}
  </>;
}
