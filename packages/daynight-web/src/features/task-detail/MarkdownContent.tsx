import { createContext, useContext, useState, type ComponentPropsWithoutRef, type MouseEvent } from 'react';
import Markdown, { defaultUrlTransform, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidDiagram } from './MermaidDiagram';
import '../../styles/markdown.css';

type MarkdownContentProps = {
  readonly text: string;
  readonly className: string;
  readonly resolveUrl: (value: string) => string | null;
  readonly remotePaused?: boolean;
  readonly onLinkClick?: (value: string, event: MouseEvent<HTMLAnchorElement>) => void;
};

type MarkdownLinks = { readonly references: WeakMap<object, string>; readonly onLinkClick: MarkdownContentProps['onLinkClick']; readonly remotePaused: boolean };
const MarkdownLinksContext = createContext<MarkdownLinks | null>(null);
const MarkdownLink = ({ node, ...props }: ComponentPropsWithoutRef<'a'> & ExtraProps) => {
  const links = useContext(MarkdownLinksContext)!;
  const blocked = links.remotePaused && !props.href?.startsWith('#');
  return <a {...props} href={blocked ? undefined : props.href} aria-disabled={blocked || undefined} role={blocked ? "link" : undefined} tabIndex={blocked ? 0 : undefined} onClick={(event) => links.onLinkClick?.(links.references.get(node!)!, event)} />;
};
const MarkdownImage = ({ node: _node, ...props }: ComponentPropsWithoutRef<'img'> & ExtraProps) => {
  const { remotePaused } = useContext(MarkdownLinksContext)!;
  return <MarkdownImageSource key={props.src} {...props} remotePaused={remotePaused} />;
};
const MarkdownImageSource = ({ remotePaused, ...props }: ComponentPropsWithoutRef<'img'> & { readonly remotePaused: boolean }) => {
  const [loaded, setLoaded] = useState(false);
  return <img {...props} src={remotePaused && !loaded ? undefined : props.src} onLoad={() => setLoaded(true)} />;
};
const MarkdownTable = ({ node: _node, ...props }: ComponentPropsWithoutRef<'table'> & ExtraProps) => <div className="markdown-table"><table {...props} /></div>;
const MarkdownPre = ({ node, ...props }: ComponentPropsWithoutRef<'pre'> & ExtraProps) => {
  const code = node?.children[0];
  if (code?.type === 'element' && code.tagName === 'code' && Array.isArray(code.properties.className) && code.properties.className.includes('language-mermaid')) {
    const source = code.children.filter((child) => child.type === 'text').map((child) => child.value).join('');
    return <MermaidDiagram key={source} source={source} />;
  }
  return <pre {...props} />;
};
const components = { a: MarkdownLink, img: MarkdownImage, table: MarkdownTable, pre: MarkdownPre };

export const MarkdownContent = ({ text, className, resolveUrl, onLinkClick, remotePaused = false }: MarkdownContentProps) => {
  const references = new WeakMap<object, string>();
  return <div className={`markdown-content ${className}`}>
    <MarkdownLinksContext value={{ references, onLinkClick, remotePaused }}><Markdown remarkPlugins={[remarkGfm]} urlTransform={(value, key, node) => {
      if (key === 'href') references.set(node, value);
      const resolved = resolveUrl(value);
      return resolved === null ? '' : defaultUrlTransform(resolved);
    }} components={components}>{text}</Markdown></MarkdownLinksContext>
  </div>;
};
