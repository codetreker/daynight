import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownContent } from '../src/features/task-detail/MarkdownContent';
import { MermaidDiagram } from '../src/ui/markdown/mermaid/MermaidDiagram';
import { MermaidSourceError, renderMermaidDiagram } from '../src/ui/markdown/mermaid/MermaidRenderer';
import { createLocaleRender } from './helpers/renderWithLocale';

const engine = vi.hoisted(() => ({ initialize: vi.fn(), detectType: vi.fn(), render: vi.fn(), mermaidAPI: { getDiagramFromText: vi.fn() } }));
vi.mock('mermaid', () => ({ default: engine }));

const render = createLocaleRender('zh-CN');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="440" height="180" viewBox="0 0 440 180"><text>开始</text></svg>';
const result = { svg, diagramType: 'flowchart-v2' };
const sizes = { xs: 12, sm: 14, lg: 18 };
let measured = { ...sizes };
let notifyResize: (() => void) | undefined;
const source = 'flowchart TD\nA[开始] --> B{是否通过？}\nB -->|是| C[完成]';
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
};
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();

beforeEach(() => {
  measured = { ...sizes };
  notifyResize = undefined;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notifyResize = callback; }
    observe() {}
    disconnect() { notifyResize = undefined; }
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains('mermaid-size-xs') ? measured.xs : this.classList.contains('mermaid-size-sm') ? measured.sm : measured.lg;
    return { width } as DOMRect;
  });
  engine.initialize.mockReset();
  engine.detectType.mockReset().mockImplementation((text: string) => text.trimStart().startsWith('mindmap') ? 'mindmap' : 'flowchart-v2');
  engine.render.mockReset().mockResolvedValue(result);
  engine.mermaidAPI.getDiagramFromText.mockReset().mockResolvedValue({ type: 'flowchart-v2', db: { getVertices: () => new Map(), getData: () => ({ nodes: [], edges: [] }) } });
  createObjectURL.mockReset().mockReturnValue('blob:flowchart');
  revokeObjectURL.mockReset();
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
});

describe('Markdown Mermaid flowcharts', () => {
  it('uses one shared block renderer while preserving ordinary Markdown and inert image output', async () => {
    const bindFunctions = vi.fn();
    engine.render.mockResolvedValue({ ...result, bindFunctions });
    const view = render(<MarkdownContent attachmentBase={{ kind: 'root' }} className="test-markdown" resolveUrl={(value) => value} text={`# Heading\n\n| A | B |\n| --- | --- |\n| C | D |\n\n\`inline\`\n\n\`\`\`typescript\nconst value = 1;\n\`\`\`\n\n\`\`\`mermaid\n${source}\n\`\`\``} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在渲染图表');
    expect(screen.getByRole('heading')).toHaveTextContent('Heading');
    expect(screen.getByRole('table')).toHaveTextContent('CD');
    expect(view.container.querySelector('pre > code.language-typescript')).toHaveTextContent('const value = 1;');
    expect(screen.getByText('inline').tagName).toBe('CODE');
    await waitFor(() => expect(screen.getByRole('img', { name: '图表' })).toHaveAttribute('src', 'blob:flowchart'));
    expect(screen.getByRole('region', { name: '图表' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('查看 Mermaid 源码').closest('details')).not.toHaveAttribute('open');
    expect(engine.render).toHaveBeenCalledWith(expect.stringMatching(/^daynight-diagram-/), `${source}\n`, expect.any(HTMLDivElement));
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(view.container.querySelector('svg')).toBeNull();
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
    expect(bindFunctions).not.toHaveBeenCalled();
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:flowchart');
  });

  it('isolates an invalid chart and leaves its source, other charts and prose readable', async () => {
    engine.render.mockImplementation(async (_id: string, text: string) => {
      if (text.includes('broken')) throw new Error('parser failure');
      return result;
    });
    render(<MarkdownContent attachmentBase={{ kind: 'root' }} className="test-markdown" resolveUrl={(value) => value} text={`正文\n\n\`\`\`mermaid\nflowchart TD\nbroken\n\`\`\`\n\n\`\`\`mermaid\n${source}\n\`\`\``} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('无法渲染此图表'));
    await waitFor(() => expect(screen.getByRole('img', { name: '图表' })).toBeInTheDocument());
    expect(screen.getByText('正文')).toBeVisible();
    expect(screen.getByText(/flowchart TD\s+broken/)).toBeVisible();
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
  });

  it('shows empty Mermaid fences as unsupported source without changing empty ordinary fences', async () => {
    const view = render(<MarkdownContent attachmentBase={{ kind: 'root' }} className="test-markdown" resolveUrl={(value) => value} text={'```mermaid\n```\n\n```text\n```'} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('不支持此 Mermaid 图表类型'));
    expect(view.container.querySelectorAll('.mermaid-chart')).toHaveLength(1);
    expect(view.container.querySelector('pre > code.language-text')).toBeInTheDocument();
    expect(engine.render).not.toHaveBeenCalled();
  });

  it('discards an older in-flight render after source replacement before allocating an image URL', async () => {
    const old = deferred<typeof result>();
    engine.render.mockReturnValueOnce(old.promise);
    const view = render(<MermaidDiagram source={source} />);
    await waitFor(() => expect(engine.render).toHaveBeenCalledOnce());
    view.rerender(<MermaidDiagram source={'flowchart LR\nCurrent --> Content'} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
    await act(async () => { old.resolve(result); });
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
    expect(engine.render).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(screen.getByText(/flowchart LR\s+Current --> Content/)).toBeInTheDocument();
  });

  it('removes a ready image immediately on replacement and revokes its previous URL', async () => {
    const view = render(<MermaidDiagram source={source} />);
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
    const previousImage = screen.getByRole('img');
    const next = deferred<typeof result>();
    engine.render.mockReturnValueOnce(next.promise);
    view.rerender(<MermaidDiagram source={'graph LR\nNew --> Diagram'} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:flowchart');
    await act(async () => { next.resolve(result); });
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
    fireEvent.error(previousImage);
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retains the current image while sizes change and discards stale renders', async () => {
    createObjectURL.mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:next');
    const view = render(<MermaidDiagram source={source} />);
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:first'));
    const stale = deferred<typeof result>();
    const latest = deferred<typeof result>();
    engine.render.mockReturnValueOnce(stale.promise).mockReturnValueOnce(latest.promise);
    await act(async () => { measured = { xs: 18, sm: 21, lg: 27 }; notifyResize?.(); });
    await waitFor(() => expect(engine.render).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:first');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => { measured = { xs: 9, sm: 10.5, lg: 13.5 }; notifyResize?.(); });
    await act(async () => { stale.resolve(result); });
    await waitFor(() => expect(engine.render).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:first');
    await act(async () => { latest.resolve(result); });
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:next'));
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:first');
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:next');
    expect(document.querySelector('.mermaid-size-probes')).toBeNull();
  });

  it('shows the source and releases the previous image if a same-source resize fails', async () => {
    const view = render(<MermaidDiagram source={source} />);
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
    engine.render.mockRejectedValueOnce(new Error('render failed'));
    await act(async () => { measured = { xs: 18, sm: 21, lg: 27 }; notifyResize?.(); });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('无法渲染此图表'));
    expect(view.container.querySelector('pre > code')?.textContent).toBe(source);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:flowchart');
    view.unmount();
  });

  it('disposes pending work on unmount and exposes image-decoding failure with current-language source', async () => {
    const pending = deferred<typeof result>();
    engine.render.mockReturnValueOnce(pending.promise);
    const first = render(<MermaidDiagram source={source} />);
    await waitFor(() => expect(engine.render).toHaveBeenCalledOnce());
    first.unmount();
    await act(async () => { pending.resolve(result); });
    expect(createObjectURL).not.toHaveBeenCalled();
    const next = render(<MermaidDiagram source={source} />);
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('alert')).toHaveTextContent('无法渲染此图表');
    expect(next.container.querySelector('pre > code')?.textContent).toBe(source);
    expect(next.container.querySelector('pre > code')).toBeVisible();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:flowchart');
    next.setLocale('en');
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to render this diagram');
  });

  it.each([{ img: '/held.svg' }, { type: 'imageSquare' }])('explains image-node refusal locally while keeping its source inspectable: %o', async (vertex) => {
    engine.mermaidAPI.getDiagramFromText.mockResolvedValueOnce({ type: 'flowchart-v2', db: { getVertices: () => new Map([['A', vertex]]), getData: () => ({ nodes: [], edges: [] }) } });
    const imageSource = 'flowchart TD\nA@{ img: "/held.svg" } --> B';
    const view = render(<MermaidDiagram source={imageSource} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('不支持图片节点'));
    expect(view.container.querySelector('pre > code')?.textContent).toBe(imageSource);
    expect(engine.render).not.toHaveBeenCalled();
  });
});

describe('Mermaid rendering ownership', () => {
  it.each([
    { text: '---\nconfig:\n  securityLevel: loose\n---\nflowchart TD\nA --> B', issue: 'configuration' },
    { text: '%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\nA --> B', issue: 'configuration' },
    { text: 'flowchart TD\n%%{init: {"theme":"dark"}}%%\nA --> B', issue: 'configuration' },
    { text: 'mindmap\n root', issue: 'unsupported' },
    { text: '', issue: 'unsupported' },
    { text: `flowchart TD\n${'A'.repeat(50_000)}`, issue: 'tooLarge' },
  ])('refuses $issue before allowing source to configure or enter Mermaid', async ({ text, issue }) => {
    await expect(renderMermaidDiagram(text, new AbortController().signal, sizes)).rejects.toMatchObject({ issue });
    expect(engine.render).not.toHaveBeenCalled();
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
  });

  it('serializes configuration and rendering, uses fixed safety settings and cleans staging on success', async () => {
    const pending = deferred<typeof result>();
    engine.render.mockReturnValueOnce(pending.promise);
    const first = renderMermaidDiagram(source, new AbortController().signal, sizes);
    const second = renderMermaidDiagram('%% comment\n\ngraph LR\nA --> B', new AbortController().signal, sizes);
    await waitFor(() => expect(engine.render).toHaveBeenCalledOnce());
    expect(engine.initialize).toHaveBeenCalledOnce();
    expect(engine.initialize).toHaveBeenCalledWith(expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true, layout: 'dagre', maxTextSize: 50_000, maxEdges: 500, flowchart: { htmlLabels: false, useMaxWidth: false } }));
    const staging = document.querySelector('.mermaid-render-staging')!;
    expect(staging).toHaveAttribute('aria-hidden', 'true');
    expect(staging).not.toHaveAttribute('hidden');
    pending.resolve(result);
    await expect(first).resolves.toBe(svg);
    await expect(second).resolves.toBe(svg);
    expect(engine.initialize).toHaveBeenCalledTimes(2);
    expect(engine.render.mock.calls[0]?.[0]).not.toBe(engine.render.mock.calls[1]?.[0]);
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
  });

  it('configures all independent diagram sizes from the measured scale', async () => {
    await renderMermaidDiagram(source, new AbortController().signal, sizes);
    expect(engine.initialize).toHaveBeenCalledWith(expect.objectContaining({
      fontSize: 14,
      themeVariables: expect.objectContaining({ fontSize: '14px', pieTitleTextSize: '18px', pieSectionTextSize: '14px', pieLegendTextSize: '14px', packet: { byteFontSize: '12px', labelFontSize: '14px', titleFontSize: '18px' } }),
      sequence: expect.objectContaining({ actorFontSize: 14, noteFontSize: 14, messageFontSize: 14 }),
      er: { fontSize: 14 }, requirement: { fontSize: 14 },
      gantt: { fontSize: 14, sectionFontSize: 14 }, journey: { taskFontSize: 14, titleFontSize: '18px' },
      quadrantChart: { titleFontSize: 18, xAxisLabelFontSize: 12, yAxisLabelFontSize: 12, quadrantLabelFontSize: 14, pointLabelFontSize: 14 },
      xyChart: { titleFontSize: 18, legendFontSize: 14, xAxis: { labelFontSize: 12, titleFontSize: 14 }, yAxis: { labelFontSize: 12, titleFontSize: 14 } },
    }));
  });

  it('measures parsed packet labels before giving the renderer its cell geometry', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (text: string) => ({ width: text.length * 20 }) } as never);
    engine.detectType.mockReturnValueOnce('packet');
    engine.mermaidAPI.getDiagramFromText.mockResolvedValueOnce({ type: 'packet', db: { getPacket: () => [[{ start: 0, end: 0, label: 'long label' }]], getDiagramTitle: () => 'Packet' } });
    engine.render.mockResolvedValueOnce({ ...result, diagramType: 'packet' });
    await renderMermaidDiagram('packet\n0: "long label"', new AbortController().signal, sizes);
    const config = engine.initialize.mock.calls.at(-1)?.[0];
    expect(config.packet.bitWidth).toBeGreaterThan(200);
    expect(config.packet.rowHeight).toBeGreaterThanOrEqual(18);
    expect(config.packet.paddingY).toBeGreaterThanOrEqual(12);
  });

  it('reserves sequence marker geometry for the full selected numbering range', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (text: string) => ({ width: text.length * 20, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }) } as never);
    engine.detectType.mockReturnValueOnce('sequence');
    const db = { LINETYPE: { AUTONUMBER: 26 }, getDiagramTitle: () => 'Sequence title', getActors: () => new Map(), getMessages: () => [
      { type: 26, message: { start: 999, step: 1 } }, { type: 0, message: {} }, { type: 0, message: {} },
    ] };
    engine.mermaidAPI.getDiagramFromText.mockResolvedValueOnce({ type: 'sequence', db });
    engine.render.mockResolvedValueOnce({ ...result, diagramType: 'sequence' });
    await renderMermaidDiagram('sequenceDiagram\nautonumber 999\nA->>B: One\nA->>B: Two', new AbortController().signal, sizes);
    const config = engine.initialize.mock.calls.at(-1)?.[0];
    expect(config.themeCSS).toContain('.sequenceNumber { font-size: 12px;');
    expect(config.sequence.actorMargin).toBeGreaterThan(80);
    expect(config.sequence.boxMargin).toBeGreaterThan(80);
    expect(config.sequence.diagramMarginX).toBeGreaterThan(200);
    expect(config.themeCSS).toContain('circle { r:');
  });

  it('selects ELK only for its explicit flowchart entry', async () => {
    engine.detectType.mockReturnValueOnce('flowchart-elk');
    engine.mermaidAPI.getDiagramFromText.mockResolvedValueOnce({ type: 'flowchart-elk', db: { getVertices: () => new Map(), getData: () => ({ nodes: [], edges: [] }) } });
    engine.render.mockResolvedValueOnce({ ...result, diagramType: 'flowchart-elk' });
    await renderMermaidDiagram('flowchart-elk LR\nA --> B', new AbortController().signal, sizes);
    expect(engine.initialize).toHaveBeenNthCalledWith(2, expect.objectContaining({ layout: 'elk' }));
    await renderMermaidDiagram(source, new AbortController().signal, sizes);
    expect(engine.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ layout: 'dagre' }));
  });

  it('skips an aborted queued diagram and preserves renderer errors without poisoning later work', async () => {
    const pending = deferred<typeof result>();
    engine.render.mockReturnValueOnce(pending.promise);
    const first = renderMermaidDiagram(source, new AbortController().signal, sizes);
    const controller = new AbortController();
    const second = renderMermaidDiagram(source, controller.signal, sizes);
    const aborted = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    pending.resolve(result);
    await first;
    await aborted;
    expect(engine.render).toHaveBeenCalledOnce();
    const cause = new Error('render failed');
    engine.render.mockRejectedValueOnce(cause);
    await expect(renderMermaidDiagram(source, new AbortController().signal, sizes)).rejects.toBe(cause);
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
    await expect(renderMermaidDiagram(source, new AbortController().signal, sizes)).resolves.toBe(svg);
  });

  it('reports an XY label layout limit as complexity and permits the next diagram', async () => {
    const cause = new Error('XY chart label layout exceeds the available canvas');
    cause.name = 'XYChartLabelLayoutLimitError';
    engine.render.mockRejectedValueOnce(cause);
    await expect(renderMermaidDiagram(source, new AbortController().signal, sizes)).rejects.toMatchObject({ issue: 'complexity', cause });
    await expect(renderMermaidDiagram(source, new AbortController().signal, sizes)).resolves.toBe(svg);
  });

  it('refuses unexpected engine diagram types and preserves typed source errors', async () => {
    engine.render.mockResolvedValueOnce({ ...result, diagramType: 'error' });
    await expect(renderMermaidDiagram(source, new AbortController().signal, sizes)).rejects.toBeInstanceOf(MermaidSourceError);
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
  });

  it('stops after asynchronous module loading when the reader is disposed before initialization', async () => {
    const controller = new AbortController();
    const pending = renderMermaidDiagram(source, controller.signal, sizes);
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.initialize).not.toHaveBeenCalled();
    expect(engine.render).not.toHaveBeenCalled();
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
  });

  it('disposes an in-flight parser before it can create staging or render a stale diagram', async () => {
    const parsed = deferred<{ type: string; db: { getVertices: () => Map<string, never>; getData: () => { nodes: never[]; edges: never[] } } }>();
    engine.mermaidAPI.getDiagramFromText.mockReturnValueOnce(parsed.promise);
    const controller = new AbortController();
    const pending = renderMermaidDiagram(source, controller.signal, sizes);
    await waitFor(() => expect(engine.mermaidAPI.getDiagramFromText).toHaveBeenCalledOnce());
    controller.abort();
    parsed.resolve({ type: 'flowchart-v2', db: { getVertices: () => new Map<string, never>(), getData: () => ({ nodes: [], edges: [] }) } });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.render).not.toHaveBeenCalled();
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
    await expect(renderMermaidDiagram(source, new AbortController().signal, sizes)).resolves.toBe(svg);
  });
});
