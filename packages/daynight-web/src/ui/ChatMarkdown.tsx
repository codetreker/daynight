import { createContext, Fragment, memo, useContext, useEffect, useId, useMemo, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Soft breaks in chat preserve the author's lines; code nodes remain untouched.
type MarkdownNode = { type: string; value?: string; identifier?: string; position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } }; children?: MarkdownNode[] };
function chatBreaks() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text' || !child.value?.includes('\n')) { visit(child); return [child]; }
        return child.value.split(/\r?\n/).flatMap((value, index) => index ? [{ type: 'break' }, { type: 'text', value }] : [{ type: 'text', value }]);
      });
    };
    visit(tree);
  };
}
const plugins = [remarkGfm, chatBreaks];

export type ChatImagePosition = { readonly start: number; readonly end: number };
export type ChatImageNode = ChatImagePosition & { readonly alt: string };
export type ChatImagePresentation = 'standalone' | 'linked' | 'actions';
export type ChatImageRenderer = (node: ChatImageNode, presentation: ChatImagePresentation) => ReactNode;
type ImageValidation = { valid: boolean };
type ChatContext = {
  readonly prefix: string;
  readonly resourceUnavailable: string;
  readonly tableLabel: string;
  readonly renderImage: ChatImageRenderer | undefined;
  readonly validation: ImageValidation;
};
const Context = createContext<ChatContext>(null!);
const LinkedImage = createContext(false);
const position = (node: { position?: MarkdownNode['position'] } | undefined): ChatImagePosition | null => {
  const start = node?.position?.start.offset, end = node?.position?.end.offset;
  return typeof start === 'number' && typeof end === 'number' && start < end ? { start, end } : null;
};
const positionKey = ({ start, end }: ChatImagePosition) => `${start}/${end}`;

/** Match supplied positions against the actual CommonMark/GFM nodes before any frame renders. */
function imageNodes(options: { readonly positions: readonly ChatImagePosition[]; readonly validation: ImageValidation }) {
  return (tree: MarkdownNode) => {
    const definitions = new Set<string>(), images = new Set<string>();
    const walk = (node: MarkdownNode, visit: (node: MarkdownNode) => void) => { visit(node); node.children?.forEach(child => walk(child, visit)); };
    walk(tree, node => { if (node.type === 'definition' && node.identifier) definitions.add(node.identifier); });
    walk(tree, node => {
      if (node.type !== 'image' && !(node.type === 'imageReference' && node.identifier && definitions.has(node.identifier))) return;
      const span = position(node);
      if (span) images.add(positionKey(span));
    });
    options.validation.valid = options.positions.every(span => images.has(positionKey(span)));
  };
}

const components: Components = {
  img: function ChatImage({ node, alt }) {
    const { renderImage, validation, resourceUnavailable } = useContext(Context), linked = useContext(LinkedImage);
    const span = position(node);
    return validation.valid && renderImage && span
      ? renderImage({ ...span, alt: alt ?? '' }, linked ? 'linked' : 'standalone')
      : <span className="session-resource-unavailable">{alt} — {resourceUnavailable}</span>;
  },
  a: function ChatLink({ node, href, children, 'aria-describedby': describedBy, ...rest }) {
    const { prefix, renderImage, validation } = useContext(Context);
    const images: ChatImageNode[] = [];
    const collect = (child: NonNullable<typeof node>['children'][number]) => {
      if (child.type !== 'element') return;
      const span = position(child);
      if (child.tagName === 'img' && span) images.push({ ...span, alt: String(child.properties.alt ?? '') });
      else child.children.forEach(collect);
    };
    if (renderImage && validation.valid) node?.children.forEach(collect);
    return <><LinkedImage.Provider value={true}>{href
      ? <a {...rest} href={href} aria-describedby={describedBy === 'footnote-label' ? `${prefix}footnote-label` : describedBy}
          {...(href.startsWith('#') ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>{children}</a>
      : <span>{children}</span>}</LinkedImage.Provider>{images.map(image => <Fragment key={positionKey(image)}>{renderImage!(image, 'actions')}</Fragment>)}</>;
  },
  h2: function ChatHeading({ node: _node, id, ...rest }) {
    const { prefix } = useContext(Context);
    return <h2 {...rest} id={id === 'footnote-label' ? `${prefix}footnote-label` : id} />;
  },
  table: function ChatTable({ children }) {
    const { tableLabel } = useContext(Context);
    return <div className="markdown-table" role="region" aria-label={tableLabel} tabIndex={0}><table>{children}</table></div>;
  },
};

export const ChatMarkdown = memo(function ChatMarkdown({ text, className = '', resourceUnavailable, tableLabel, imagePositions, renderImage, onInvalidImages }: {
  readonly text: string; readonly className?: string; readonly resourceUnavailable: string; readonly tableLabel: string;
  readonly imagePositions?: readonly ChatImagePosition[];
  readonly renderImage?: ChatImageRenderer;
  readonly onInvalidImages?: () => void;
}) {
  const prefix = `chat-markdown-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}-`;
  const validation = useMemo<ImageValidation>(() => ({ valid: imagePositions === undefined }), [text, imagePositions]);
  const remarkPlugins = useMemo<NonNullable<Options['remarkPlugins']>>(() => imagePositions ? [...plugins, [imageNodes, { positions: imagePositions, validation }]] : plugins, [imagePositions, validation]);
  useEffect(() => { if (!validation.valid) onInvalidImages?.(); }, [validation, onInvalidImages]);
  return <Context.Provider value={{ prefix, resourceUnavailable, tableLabel, renderImage, validation }}><div className={`markdown-content ${className}`}><Markdown remarkPlugins={remarkPlugins} remarkRehypeOptions={{ clobberPrefix: prefix }}
    urlTransform={(url, key, node) => {
      if (key !== 'href') return '';
      if (/^(https?:|mailto:)/i.test(url)) return url;
      // Only generated footnote links can address this Markdown instance.
      return (Object.hasOwn(node.properties, 'dataFootnoteRef') || Object.hasOwn(node.properties, 'dataFootnoteBackref')) && url.startsWith(`#${prefix}`) ? url : '';
    }} components={components}>{text}</Markdown></div></Context.Provider>;
});
