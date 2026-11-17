import { useEffect, useId, useMemo, useRef } from 'react';
import Markdown, { defaultUrlTransform, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../../i18n/LocaleProvider';
import { Context } from './markdown-context';
import { components, isFootnote } from './markdown-nodes';
import { chatBreaks, imageNodes, type ImageValidation } from './markdown-plugins';
import type { MarkdownViewProps } from './types';
import './markdown.css';

export type { Components, ExtraProps } from 'react-markdown';

const documentPlugins = [remarkGfm];
const chatPlugins = [remarkGfm, chatBreaks];

export const MarkdownView = ({ text, resources, className = '', labels }: MarkdownViewProps) => {
  const { messages } = useI18n();
  const prefix = `markdown-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}-`;
  const references = new WeakMap<object, string>();
  const positions = resources.kind === 'chat' && resources.images.kind === 'controlled' ? resources.images.positions : null;
  // Equivalent metadata must retain validation identity across ordinary parent updates.
  const encoded = positions === null ? null : JSON.stringify(positions);
  const validation = useMemo<ImageValidation>(() => ({ valid: encoded === null }), [text, encoded]);
  const plugins = useMemo<NonNullable<Options['remarkPlugins']>>(() => encoded === null
    ? (resources.kind === 'chat' ? chatPlugins : documentPlugins)
    : [remarkGfm, [imageNodes, { positions: JSON.parse(encoded), validation }], chatBreaks], [encoded, validation, resources.kind]);
  const onInvalid = useRef(resources.kind === 'chat' && resources.images.kind === 'controlled' ? resources.images.onInvalid : undefined);
  onInvalid.current = resources.kind === 'chat' && resources.images.kind === 'controlled' ? resources.images.onInvalid : undefined;
  const notified = useRef<ImageValidation | null>(null);
  useEffect(() => {
    if (!validation.valid && notified.current !== validation) {
      notified.current = validation;
      onInvalid.current?.();
    }
  }, [validation]);
  return <Context value={{ prefix, references, resources, validation, resourceUnavailable: labels?.resourceUnavailable ?? messages.markdown.resourceUnavailable,
    tableLabel: labels?.table ?? messages.markdown.table, codeLabel: messages.markdown.code }}>
    <div className={`markdown-content markdown-${resources.kind} ${className}`}><Markdown remarkPlugins={plugins}
      remarkRehypeOptions={{ clobberPrefix: prefix, footnoteLabel: messages.markdown.footnoteLabel, footnoteBackLabel: messages.markdown.footnoteBackLabel }}
      urlTransform={(value, key, node) => {
        if (key === 'href' && isFootnote(node) && value.startsWith(`#${prefix}`)) return value;
        if (resources.kind === 'chat') return key === 'href' && /^(https?:|mailto:)/i.test(value) ? defaultUrlTransform(value) : '';
        if (key === 'href' || key === 'src') references.set(node, value);
        const resolved = resources.resolveUrl(value);
        return resolved === null ? '' : defaultUrlTransform(resolved);
      }} components={components}>{text}</Markdown></div>
  </Context>;
};
