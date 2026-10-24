import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import { MermaidSourceError, renderMermaidFlowchart, type MermaidSourceIssue } from './MermaidRenderer';

type DiagramState =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly url: string }
  | { readonly status: 'error'; readonly issue: MermaidSourceIssue | 'failed' };

export const MermaidFlowchart = ({ source }: { readonly source: string }) => {
  const { messages } = useI18n();
  const text = messages.inspection.mermaid;
  const [rendered, setRendered] = useState<{ readonly source: string; readonly state: DiagramState }>({ source, state: { status: 'pending' } });
  const state: DiagramState = rendered.source === source ? rendered.state : { status: 'pending' };

  useEffect(() => {
    const controller = new AbortController();
    let url: string | null = null;
    void renderMermaidFlowchart(source, controller.signal).then((svg) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      setRendered({ source, state: { status: 'ready', url } });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setRendered({ source, state: { status: 'error', issue: error instanceof MermaidSourceError ? error.issue : 'failed' } });
    });
    return () => {
      controller.abort();
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [source]);

  const code = <pre><code className="language-mermaid">{source}</code></pre>;
  return <div className="mermaid-flowchart">
    {state.status === 'pending' && <p role="status">{text.loading}</p>}
    {state.status === 'ready' && <div className="mermaid-diagram" role="region" aria-label={text.diagram} tabIndex={0}>
      <img src={state.url} alt={text.diagram} onError={() => {
        URL.revokeObjectURL(state.url);
        setRendered((current) => current.source === source && current.state.status === 'ready' && current.state.url === state.url
          ? { source, state: { status: 'error', issue: 'failed' } }
          : current);
      }} />
    </div>}
    {state.status === 'error' ? <><p role="alert">{text[state.issue]}</p>{code}</> : <details><summary>{text.source}</summary>{code}</details>}
  </div>;
};
