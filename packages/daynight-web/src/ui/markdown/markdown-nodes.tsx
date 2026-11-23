import { Fragment, useContext, type ComponentPropsWithoutRef } from 'react';
import type { Components, ExtraProps } from './MarkdownView';
import { Context, LinkedImage } from './markdown-context';
import { position, positionKey } from './markdown-plugins';
import { MermaidDiagram } from './mermaid/MermaidDiagram';
import type { MarkdownImageNode } from './types';

export const isFootnote = (node: NonNullable<ExtraProps['node']>) =>
  Object.hasOwn(node.properties, 'dataFootnoteRef') || Object.hasOwn(node.properties, 'dataFootnoteBackref');

export const components: Components = {
  a: function MarkdownLink({ node, href, children, 'aria-describedby': describedBy, ...props }) {
    const { prefix, references, resources, validation } = useContext(Context);
    const footnote = node !== undefined && isFootnote(node);
    const description = describedBy === 'footnote-label' ? `${prefix}footnote-label` : describedBy;
    if (resources.kind === 'document') {
      const blocked = resources.paused && !href?.startsWith('#');
      return <a {...props} href={blocked ? undefined : href} aria-describedby={description}
        aria-disabled={blocked || undefined} role={blocked ? 'link' : undefined} tabIndex={blocked ? 0 : undefined}
        onClick={footnote ? undefined : event => {
          if (blocked) { event.preventDefault(); return; }
          resources.onLinkClick?.(references.get(node!)!, event);
        }}>{children}</a>;
    }
    const images: MarkdownImageNode[] = [];
    const collect = (child: NonNullable<typeof node>['children'][number]) => {
      if (child.type !== 'element') return;
      const span = position(child);
      if (child.tagName === 'img' && span) images.push({ ...span, alt: String(child.properties.alt ?? '') });
      else child.children.forEach(collect);
    };
    const controlled = resources.images.kind === 'controlled' && validation.valid ? resources.images : null;
    if (controlled) node?.children.forEach(collect);
    return <><LinkedImage.Provider value={true}>{href
      ? <a {...props} href={href} aria-describedby={description} {...(footnote ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>{children}</a>
      : <span>{children}</span>}</LinkedImage.Provider>{images.map(image => <Fragment key={positionKey(image)}>{controlled!.render(image, 'actions')}</Fragment>)}</>;
  },
  img: function MarkdownImage({ node, src, alt, title }) {
    const { references, resources, validation, resourceUnavailable } = useContext(Context);
    const linked = useContext(LinkedImage);
    if (resources.kind === 'document') return resources.renderImage({ sourceUrl: references.get(node!)!, url: src ?? '', alt: alt ?? '', title: title ?? undefined });
    const span = position(node);
    return validation.valid && resources.images.kind === 'controlled' && span
      ? resources.images.render({ ...span, alt: alt ?? '' }, linked ? 'linked' : 'standalone')
      : <span className="markdown-resource-unavailable">{alt} — {resourceUnavailable}</span>;
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
