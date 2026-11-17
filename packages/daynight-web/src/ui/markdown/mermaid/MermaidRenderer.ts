import type { MermaidConfig } from 'mermaid';
import { identifyMermaidType, inspectMermaidDiagram, matchesMermaidType, MermaidPolicyError, preflightBlock } from './MermaidPolicy';
import { sizeMermaidSvg } from './MermaidSvg';

export type MermaidSourceIssue = 'configuration' | 'unsupported' | 'tooLarge' | 'complexity' | 'image';

export class MermaidSourceError extends Error {
  constructor(readonly issue: MermaidSourceIssue, options?: ErrorOptions) {
    super(`Mermaid source rejected: ${issue}`, options);
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

export const renderMermaidDiagram = (source: string, signal: AbortSignal): Promise<string> => {
  const result = queue.then(async () => {
    signal.throwIfAborted();
    if (source.length > maxTextSize) throw new MermaidSourceError('tooLarge');
    if (/^\s*---(?:\s|$)/.test(source) || /%%\s*\{/.test(source)) throw new MermaidSourceError('configuration');
    const { default: mermaid } = await import('mermaid');
    signal.throwIfAborted();
    mermaid.initialize(configuration);
    let type;
    try {
      type = identifyMermaidType(source, mermaid);
      // Mermaid's detector selects ELK on a config copy; the renderer reads the
      // global config. Keep the explicit variant and normal flowcharts distinct.
      if (type === 'flowchart-elk') mermaid.initialize({ ...configuration, layout: 'elk' });
      if (type === 'block') await preflightBlock(source, mermaid);
      signal.throwIfAborted();
      const parsed = await mermaid.mermaidAPI.getDiagramFromText(source);
      signal.throwIfAborted();
      inspectMermaidDiagram(type, parsed);
    } catch (error) {
      if (error instanceof MermaidPolicyError) throw new MermaidSourceError(error.issue, { cause: error });
      if (error instanceof Error && (error.name === 'GanttCalendarWorkLimitError' || /^Edge limit exceeded\. \d+ edges found, but the limit is 500\./.test(error.message))) throw new MermaidSourceError('complexity', { cause: error });
      throw error;
    }
    const staging = document.createElement('div');
    staging.className = 'mermaid-render-staging';
    staging.setAttribute('aria-hidden', 'true');
    staging.inert = true;
    // Detail tabs can be hidden while mounted. Mermaid needs measurable text
    // independently of the reader's visibility and available width.
    staging.style.cssText = 'position:fixed;left:-100000px;top:0;width:1600px;visibility:hidden;pointer-events:none';
    document.body.append(staging);
    try {
      const rendered = await mermaid.render(`daynight-diagram-${crypto.randomUUID()}`, source, staging);
      signal.throwIfAborted();
      if (!matchesMermaidType(type, rendered.diagramType)) throw new MermaidSourceError('unsupported');
      return sizeMermaidSvg(rendered.svg);
    } catch (error) {
      if (error instanceof Error && (error.name === 'GanttCalendarWorkLimitError' || /^Edge limit exceeded\. \d+ edges found, but the limit is 500\./.test(error.message))) throw new MermaidSourceError('complexity', { cause: error });
      throw error;
    } finally {
      staging.remove();
    }
  });
  // Mermaid shares configuration and parser state. A rejected chart must not
  // prevent the next independent chart from running through the same queue.
  queue = result.then(() => undefined, () => undefined);
  return result;
};
