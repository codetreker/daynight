import { createContext, useContext, type ComponentPropsWithoutRef, type MouseEvent } from 'react';
import Markdown, { defaultUrlTransform, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidFlowchart } from './MermaidFlowchart';
import '../../styles/markdown.css';

type MarkdownContentProps = {
  readonly text: string;
  readonly className: string;
  readonly resolveUrl: (value: string) => string | null;
  readonly onLinkClick?: (value: string, event: MouseEvent<HTMLAnchorElement>) => void;
};

type MarkdownLinks = { readonly references: WeakMap<object, string>; readonly onLinkClick: MarkdownContentProps['onLinkClick'] };
const MarkdownLinksContext = createContext<MarkdownLinks | null>(null);
const MarkdownLink = ({ node, ...props }: ComponentPropsWithoutRef<'a'> & ExtraProps) => {
  const links = useContext(MarkdownLinksContext)!;
  return <a {...props} onClick={(event) => links.onLinkClick?.(links.references.get(node!)!, event)} />;
};
const MarkdownTable = ({ node: _node, ...props }: ComponentPropsWithoutRef<'table'> & ExtraProps) => <div className="markdown-table"><table {...props} /></div>;
const MarkdownPre = ({ node, ...props }: ComponentPropsWithoutRef<'pre'> & ExtraProps) => {
  const code = node?.children[0];
  if (code?.type === 'element' && code.tagName === 'code' && Array.isArray(code.properties.className) && code.properties.className.includes('language-mermaid')) {
    const source = code.children.filter((child) => child.type === 'text').map((child) => child.value).join('');
    return <MermaidFlowchart key={source} source={source} />;
  }
  return <pre {...props} />;
};
const components = { a: MarkdownLink, table: MarkdownTable, pre: MarkdownPre };

export const MarkdownContent = ({ text, className, resolveUrl, onLinkClick }: MarkdownContentProps) => {
  const references = new WeakMap<object, string>();
  return <div className={`markdown-content ${className}`}>
    <MarkdownLinksContext value={{ references, onLinkClick }}><Markdown remarkPlugins={[remarkGfm]} urlTransform={(value, key, node) => {
      if (key === 'href') references.set(node, value);
      const resolved = resolveUrl(value);
      return resolved === null ? '' : defaultUrlTransform(resolved);
    }} components={components}>{text}</Markdown></MarkdownLinksContext>
  </div>;
};
