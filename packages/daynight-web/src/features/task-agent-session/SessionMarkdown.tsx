import { memo, useId } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSessionMessages } from './messages';
import { useTimelineMessages } from './timeline-messages';

// Soft breaks in chat preserve the author's lines; code nodes remain untouched.
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };
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

export const SessionMarkdown = memo(function SessionMarkdown({ text }: { readonly text: string }) {
  const prefix = `session-markdown-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}-`;
  const m = useSessionMessages(), labels = useTimelineMessages();
  return <div className="markdown-content session-markdown"><Markdown remarkPlugins={plugins} remarkRehypeOptions={{ clobberPrefix: prefix }}
    urlTransform={(url, key, node) => {
      if (key !== 'href') return '';
      if (/^(https?:|mailto:)/i.test(url)) return url;
      // Only generated footnote links can address this Markdown instance.
      return (Object.hasOwn(node.properties, 'dataFootnoteRef') || Object.hasOwn(node.properties, 'dataFootnoteBackref')) && url.startsWith(`#${prefix}`) ? url : '';
    }} components={{
      img: ({ alt }) => <span className="session-resource-unavailable">{alt} — {m.resourceUnavailable}</span>,
      a: ({ node: _node, href, children, 'aria-describedby': describedBy, ...rest }) => href
        ? <a {...rest} href={href} aria-describedby={describedBy === 'footnote-label' ? `${prefix}footnote-label` : describedBy}
            {...(href.startsWith('#') ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>{children}</a>
        : <span>{children}</span>,
      h2: ({ node: _node, id, ...rest }) => <h2 {...rest} id={id === 'footnote-label' ? `${prefix}footnote-label` : id} />,
      table: ({ children }) => <div className="markdown-table" role="region" aria-label={labels.table} tabIndex={0}><table>{children}</table></div>,
    }}>{text}</Markdown></div>;
});
