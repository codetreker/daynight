import { createContext, useContext, useId, type ComponentPropsWithoutRef } from 'react';
import Markdown, { defaultUrlTransform, type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../../i18n/LocaleProvider';
import { MermaidDiagram } from './mermaid/MermaidDiagram';
import type { MarkdownResources, MarkdownViewProps } from './types';
import './markdown.css';

const plugins = [remarkGfm];
type ContextValue = {
  readonly prefix: string;
  readonly references: WeakMap<object, string>;
  readonly resources: MarkdownResources;
  readonly tableLabel: string;
  readonly codeLabel: string;
};
const Context = createContext<ContextValue>(null!);
const isFootnote = (node: NonNullable<ExtraProps['node']>) =>
  Object.hasOwn(node.properties, 'dataFootnoteRef') || Object.hasOwn(node.properties, 'dataFootnoteBackref');

const components: Components = {
  a: function MarkdownLink({ node, href, 'aria-describedby': describedBy, ...props }) {
    const { prefix, references, resources } = useContext(Context);
    const footnote = node !== undefined && isFootnote(node);
    const blocked = resources.paused && !href?.startsWith('#');
    return <a {...props} href={blocked ? undefined : href} aria-describedby={describedBy === 'footnote-label' ? `${prefix}footnote-label` : describedBy}
      aria-disabled={blocked || undefined} role={blocked ? 'link' : undefined} tabIndex={blocked ? 0 : undefined}
      onClick={footnote ? undefined : event => {
        if (blocked) { event.preventDefault(); return; }
        resources.onLinkClick?.(references.get(node!)!, event);
      }} />;
  },
  img: function MarkdownImage({ node, src, alt, title }) {
    const { references, resources } = useContext(Context);
    return resources.renderImage({ sourceUrl: references.get(node!)!, url: src ?? '', alt: alt ?? '', title: title ?? undefined });
  },
  h2: function MarkdownHeading({ node: _node, id, ...props }) {
    const { prefix } = useContext(Context);
    return <h2 {...props} id={id === 'footnote-label' ? `${prefix}footnote-label` : id} />;
  },
  table: function MarkdownTable({ node: _node, ...props }) {
    const { tableLabel } = useContext(Context);
    return <div className="markdown-table" role="region" aria-label={tableLabel} tabIndex={0}><table {...props} /></div>;
  },
  pre: function MarkdownPre({ node, ...props }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
    const { codeLabel } = useContext(Context);
    const code = node?.children[0];
    if (code?.type === 'element' && code.tagName === 'code' && Array.isArray(code.properties.className) && code.properties.className.includes('language-mermaid')) {
      const source = code.children.filter(child => child.type === 'text').map(child => child.value).join('');
      return <MermaidDiagram key={source} source={source} />;
    }
    return <pre {...props} role="region" aria-label={codeLabel} tabIndex={0} />;
  },
};

export const MarkdownView = ({ text, resources, className = '', labels }: MarkdownViewProps) => {
  const { messages } = useI18n();
  const prefix = `markdown-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}-`;
  const references = new WeakMap<object, string>();
  return <Context value={{ prefix, references, resources, tableLabel: labels?.table ?? messages.markdown.table, codeLabel: messages.markdown.code }}>
    <div className={`markdown-content markdown-document ${className}`}><Markdown remarkPlugins={plugins}
      remarkRehypeOptions={{ clobberPrefix: prefix, footnoteLabel: messages.markdown.footnoteLabel, footnoteBackLabel: messages.markdown.footnoteBackLabel }}
      urlTransform={(value, key, node) => {
        if (key === 'href' && isFootnote(node) && value.startsWith(`#${prefix}`)) return value;
        if (key === 'href' || key === 'src') references.set(node, value);
        const resolved = resources.resolveUrl(value);
        return resolved === null ? '' : defaultUrlTransform(resolved);
      }} components={components}>{text}</Markdown></div>
  </Context>;
};
