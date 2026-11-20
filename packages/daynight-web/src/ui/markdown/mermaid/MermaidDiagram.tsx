import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../i18n/LocaleProvider';
import { MermaidSourceError, renderMermaidDiagram, type MermaidSourceIssue } from './MermaidRenderer';
import { observeMermaidSizes, type MermaidSizes } from './MermaidTypography';
import './mermaid-typography.css';

type DiagramState =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly url: string }
  | { readonly status: 'error'; readonly issue: MermaidSourceIssue | 'failed' };

export const MermaidDiagram = ({ source }: { readonly source: string }) => {
  const { messages } = useI18n();
  const text = messages.markdown.mermaid;
  const [sizes, setSizes] = useState<MermaidSizes>();
  const [rendered, setRendered] = useState<{ readonly source: string; readonly state: DiagramState }>({ source, state: { status: 'pending' } });
  const urls = useRef(new Set<string>());
  const state: DiagramState = rendered.source === source ? rendered.state : { status: 'pending' };

  useEffect(() => observeMermaidSizes(setSizes), []);
  useEffect(() => () => {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
  }, []);
  // Retire only URLs no longer presented after React commits the replacement.
  useEffect(() => {
    const retained = state.status === 'ready' ? state.url : null;
    for (const url of urls.current) if (url !== retained) {
      URL.revokeObjectURL(url);
      urls.current.delete(url);
    }
  }, [source, rendered, state.status]);

  useEffect(() => {
    if (!sizes) return;
    const controller = new AbortController();
    void renderMermaidDiagram(source, controller.signal, sizes).then((svg) => {
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      urls.current.add(url);
      setRendered({ source, state: { status: 'ready', url } });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setRendered({ source, state: { status: 'error', issue: error instanceof MermaidSourceError ? error.issue : 'failed' } });
    });
    return () => { controller.abort(); };
  }, [source, sizes]);

  const code = <pre role="region" aria-label={messages.markdown.code} tabIndex={0}><code className="language-mermaid">{source}</code></pre>;
  return <div className="mermaid-chart">
    {state.status === 'pending' && <p role="status">{text.loading}</p>}
    {state.status === 'ready' && <div className="mermaid-diagram" role="region" aria-label={text.diagram} tabIndex={0}>
      <img src={state.url} alt={text.diagram} onError={() => {
        setRendered((current) => current.source === source && current.state.status === 'ready' && current.state.url === state.url
          ? { source, state: { status: 'error', issue: 'failed' } }
          : current);
      }} />
    </div>}
    {state.status === 'error' ? <><p role="alert">{text[state.issue]}</p>{code}</> : <details><summary>{text.source}</summary>{code}</details>}
  </div>;
};
