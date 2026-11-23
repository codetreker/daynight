import type { MermaidConfig } from 'mermaid';
import { identifyMermaidType, inspectMermaidDiagram, matchesMermaidType, MermaidPolicyError, preflightBlock } from './MermaidPolicy';
import { sizeMermaidSvg } from './MermaidSvg';
import type { MermaidSizes } from './MermaidTypography';

export type MermaidSourceIssue = 'configuration' | 'unsupported' | 'tooLarge' | 'complexity' | 'image';

export class MermaidSourceError extends Error {
  constructor(readonly issue: MermaidSourceIssue, options?: ErrorOptions) {
    super(`Mermaid source rejected: ${issue}`, options);
  }
}

const maxTextSize = 50_000;
const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';

// Mermaid lays out the packet from fixed cell dimensions before painting text.
// Derive those dimensions from the same measured sizes and actual packet labels.
// https://github.com/mermaid-js/mermaid/blob/1fb7869866dd619168d840291c9c54b4f129758b/packages/mermaid/src/diagrams/packet/renderer.ts#L8-L20
const packetGeometry = (db: unknown, sizes: MermaidSizes) => {
  const packet = db as { getPacket(): { start: number; end: number; label: string }[][]; getDiagramTitle(): string };
  const context = document.createElement('canvas').getContext('2d');
  if (!context) throw new Error('Unable to measure packet text');
  const width = (text: string, size: number) => {
    context.font = `${size}px ${fontFamily}`;
    return context.measureText(text).width;
  };
  const paddingX = Math.max(4, sizes.sm / 2);
  let bitWidth = Math.max(32, width(packet.getDiagramTitle(), sizes.lg) / 32 + paddingX);
  for (const row of packet.getPacket()) for (const block of row) {
    const bits = block.end - block.start + 1;
    bitWidth = Math.max(bitWidth, (width(block.label, sizes.sm) + paddingX * 2) / bits,
      width(String(block.start), sizes.xs) + paddingX, width(String(block.end), sizes.xs) + paddingX);
  }
  return { bitWidth, rowHeight: Math.max(32, sizes.sm * 1.5, sizes.lg * 1.5), paddingX, paddingY: Math.max(16, sizes.xs * 1.5) };
};

// Mermaid fixes its number marker at radius 6. Measure every possible number
// in each range so the marker and the spacing also fit user-selected numbering.
const sequenceGeometry = (db: unknown, sizes: MermaidSizes) => {
  const sequence = db as { LINETYPE: { AUTONUMBER: number }; getDiagramTitle(): string; getMessages(): { type: number; message: { start?: number; step?: number } }[] };
  const messages = sequence.getMessages();
  const hasNumbers = messages.some(message => message.type === sequence.LINETYPE.AUTONUMBER);
  const title = sequence.getDiagramTitle();
  if (!hasNumbers && !title) return { radius: 0, marginX: 50, marginY: 10 };
  const context = document.createElement('canvas').getContext('2d');
  if (!context) throw new Error('Unable to measure sequence numbers');
  context.font = `${sizes.lg}px ${fontFamily}`;
  const titleWidth = title ? context.measureText(title).width : 0;
  context.font = `${sizes.xs}px sans-serif`;
  let value = 1, step = 1, radius = hasNumbers ? 6 : 0;
  for (const message of messages) {
    if (message.type === sequence.LINETYPE.AUTONUMBER) {
      value = message.message.start || value;
      step = message.message.step || step;
    } else {
      const metrics = context.measureText(String(value));
      const height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent || sizes.xs;
      radius = Math.max(radius, Math.hypot(metrics.width / 2 + 2, height / 2 + 2));
      value = Math.round((value + step) * 100) / 100;
    }
  }
  return { radius, marginX: Math.max(50, radius + 10, titleWidth + 10), marginY: Math.max(10, radius ? radius + 10 : 0, title ? sizes.lg : 0) };
};

const buildMermaidConfiguration = (sizes: MermaidSizes, packet?: ReturnType<typeof packetGeometry>, sequence = false, sequenceLayout = { radius: 0, marginX: 50, marginY: 10 }): MermaidConfig => {
  const configuration: MermaidConfig = {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    htmlLabels: false,
    layout: 'dagre',
    maxTextSize,
    maxEdges: 500,
    theme: 'base',
    // Sequence's bounds initialization applies the root fontSize to its text settings.
    fontSize: sizes.sm,
    fontFamily,
    themeVariables: {
      primaryColor: '#f0f0fc',
      primaryTextColor: '#344258',
      primaryBorderColor: '#8b89b6',
      lineColor: '#737d8e',
      secondaryColor: '#f7f8fa',
      tertiaryColor: '#ffffff',
      edgeLabelBackground: '#ffffff',
      fontSize: `${sizes.sm}px`,
      pieTitleTextSize: `${sizes.lg}px`,
      pieSectionTextSize: `${sizes.sm}px`,
      pieLegendTextSize: `${sizes.sm}px`,
      packet: { byteFontSize: `${sizes.xs}px`, labelFontSize: `${sizes.sm}px`, titleFontSize: `${sizes.lg}px` },
    },
    themeCSS: sequence ? `
      .flowchartTitleText, .classTitleText, .statediagramTitleText, .titleText { font-size: ${sizes.lg}px; }
      g.grid .tick text { font-size: ${sizes.xs}px; }
      .vertText, g.classGroup text, .classLabel .label, .edgeTerminals,
      g.stateGroup text, g.noteGroup text, .stateLabel text, .edgeLabel .label { font-size: ${sizes.sm}px; }
      text:not([class]) { font-size: ${sizes.lg}px; text-anchor: middle; translate: ${sequenceLayout.marginX * 2}px 0; }
      .sequenceNumber { font-size: ${sizes.xs}px; dominant-baseline: central; translate: 0 -4px; }
      marker[id$="-sequencenumber"] { overflow: visible; }
      marker[id$="-sequencenumber"] circle { r: ${sequenceLayout.radius}px; }
    ` : `
      .flowchartTitleText, .classTitleText, .statediagramTitleText, .titleText { font-size: ${sizes.lg}px; }
      g.grid .tick text { font-size: ${sizes.xs}px; }
      .vertText, g.classGroup text, .classLabel .label, .edgeTerminals,
      g.stateGroup text, g.noteGroup text, .stateLabel text, .edgeLabel .label { font-size: ${sizes.sm}px; }
    `,
    flowchart: { htmlLabels: false, useMaxWidth: false },
    er: { fontSize: sizes.sm },
    requirement: { fontSize: sizes.sm },
    sequence: { actorFontSize: sizes.sm, noteFontSize: sizes.sm, messageFontSize: sizes.sm, actorMargin: Math.max(50, sequenceLayout.radius * 2 + 10), diagramMarginX: sequenceLayout.marginX, diagramMarginY: sequenceLayout.marginY, boxMargin: Math.max(10, sequenceLayout.radius * 2 + 10) },
    gantt: { fontSize: sizes.sm, sectionFontSize: sizes.sm },
    journey: { taskFontSize: sizes.sm, titleFontSize: `${sizes.lg}px` },
    quadrantChart: { titleFontSize: sizes.lg, xAxisLabelFontSize: sizes.xs, yAxisLabelFontSize: sizes.xs, quadrantLabelFontSize: sizes.sm, pointLabelFontSize: sizes.sm },
    xyChart: { titleFontSize: sizes.lg, legendFontSize: sizes.sm, xAxis: { labelFontSize: sizes.xs, titleFontSize: sizes.sm }, yAxis: { labelFontSize: sizes.xs, titleFontSize: sizes.sm } },
  };
  if (packet) configuration.packet = packet;
  return configuration;
};

let queue = Promise.resolve();

export const renderMermaidDiagram = (source: string, signal: AbortSignal, sizes: MermaidSizes): Promise<string> => {
  const result = queue.then(async () => {
    signal.throwIfAborted();
    if (source.length > maxTextSize) throw new MermaidSourceError('tooLarge');
    if (/^\s*---(?:\s|$)/.test(source) || /%%\s*\{/.test(source)) throw new MermaidSourceError('configuration');
    const { default: mermaid } = await import('mermaid');
    signal.throwIfAborted();
    const configuration = buildMermaidConfiguration(sizes);
    mermaid.initialize(configuration);
    let type;
    try {
      type = identifyMermaidType(source, mermaid);
      // Mermaid's detector selects ELK on a config copy; the renderer reads the
      // global config. Keep the explicit variant and normal flowcharts distinct.
      if (type === 'flowchart-elk') { configuration.layout = 'elk'; mermaid.initialize(configuration); }
      // Sequence titles are the only unclassified top-level text in this diagram.
      // https://github.com/mermaid-js/mermaid/blob/1fb7869866dd619168d840291c9c54b4f129758b/packages/mermaid/src/diagrams/sequence/sequenceRenderer.ts#L1450-L1455
      if (type === 'sequence') mermaid.initialize(buildMermaidConfiguration(sizes, undefined, true));
      if (type === 'block') await preflightBlock(source, mermaid);
      signal.throwIfAborted();
      const parsed = await mermaid.mermaidAPI.getDiagramFromText(source);
      signal.throwIfAborted();
      inspectMermaidDiagram(type, parsed);
      if (type === 'packet') mermaid.initialize(buildMermaidConfiguration(sizes, packetGeometry(parsed.db, sizes)));
      if (type === 'sequence') mermaid.initialize(buildMermaidConfiguration(sizes, undefined, true, sequenceGeometry(parsed.db, sizes)));
    } catch (error) {
      if (error instanceof MermaidPolicyError) throw new MermaidSourceError(error.issue, { cause: error });
      if (error instanceof Error && ((error.name === 'GanttCalendarWorkLimitError' || error.name === 'XYChartLabelLayoutLimitError') || /^Edge limit exceeded\. \d+ edges found, but the limit is 500\./.test(error.message))) throw new MermaidSourceError('complexity', { cause: error });
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
      if (error instanceof Error && ((error.name === 'GanttCalendarWorkLimitError' || error.name === 'XYChartLabelLayoutLimitError') || /^Edge limit exceeded\. \d+ edges found, but the limit is 500\./.test(error.message))) throw new MermaidSourceError('complexity', { cause: error });
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
