import type { MermaidConfig } from 'mermaid';
import type { FlowDB } from 'mermaid/dist/diagrams/flowchart/flowDb.js';

export type MermaidSourceIssue = 'configuration' | 'unsupported' | 'tooLarge' | 'image';

export class MermaidSourceError extends Error {
  constructor(readonly issue: MermaidSourceIssue) {
    super(`Mermaid source rejected: ${issue}`);
  }
}

const maxTextSize = 50_000;
const configuration: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  htmlLabels: false,
  layout: 'dagre',
  maxTextSize,
  maxEdges: 500,
  theme: 'base',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
  themeVariables: {
    primaryColor: '#f0f0fc',
    primaryTextColor: '#344258',
    primaryBorderColor: '#8b89b6',
    lineColor: '#737d8e',
    secondaryColor: '#f7f8fa',
    tertiaryColor: '#ffffff',
    edgeLabelBackground: '#ffffff',
    fontSize: '14px',
  },
  flowchart: { htmlLabels: false, useMaxWidth: false },
};

let queue = Promise.resolve();

export const renderMermaidFlowchart = (source: string, signal: AbortSignal): Promise<string> => {
  const result = queue.then(async () => {
    signal.throwIfAborted();
    if (source.length > maxTextSize) throw new MermaidSourceError('tooLarge');
    if (/^\s*---(?:\s|$)/.test(source) || /%%\s*\{/.test(source)) throw new MermaidSourceError('configuration');
    const diagram = source.replace(/^\s*%%[^\n]*(?:\n|$)/gm, '').trimStart();
    if (!/^(?:flowchart|graph)\b/.test(diagram)) throw new MermaidSourceError('unsupported');
    const { default: mermaid } = await import('mermaid');
    signal.throwIfAborted();
    mermaid.initialize(configuration);
    // The pinned internal parser exposes nodes omitted by the public parse result.
    // Image shapes await external decoding and could block every queued chart.
    // https://github.com/mermaid-js/mermaid/blob/1fb7869866dd619168d840291c9c54b4f129758b/packages/mermaid/src/rendering-util/rendering-elements/shapes/imageSquare.ts#L15-L18
    const parsed = await mermaid.mermaidAPI.getDiagramFromText(source);
    signal.throwIfAborted();
    if (parsed.type !== 'flowchart' && parsed.type !== 'flowchart-v2') throw new MermaidSourceError('unsupported');
    if ([...(parsed.db as FlowDB).getVertices().values()].some((vertex) => vertex.img || vertex.type === 'imageSquare')) throw new MermaidSourceError('image');
    const staging = document.createElement('div');
    staging.className = 'mermaid-render-staging';
    staging.setAttribute('aria-hidden', 'true');
    staging.inert = true;
    // Detail tabs can be hidden while mounted. Mermaid needs measurable text
    // independently of the reader's visibility and available width.
    staging.style.cssText = 'position:fixed;left:-100000px;top:0;width:1600px;visibility:hidden;pointer-events:none';
    document.body.append(staging);
    try {
      const rendered = await mermaid.render(`daynight-flowchart-${crypto.randomUUID()}`, source, staging);
      signal.throwIfAborted();
      if (rendered.diagramType !== 'flowchart' && rendered.diagramType !== 'flowchart-v2') throw new MermaidSourceError('unsupported');
      return rendered.svg;
    } finally {
      staging.remove();
    }
  });
  // Mermaid shares configuration and parser state. A rejected chart must not
  // prevent the next independent chart from running through the same queue.
  queue = result.then(() => undefined, () => undefined);
  return result;
};
