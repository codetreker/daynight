import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownContent } from '../src/features/task-detail/MarkdownContent';
import { MermaidFlowchart } from '../src/features/task-detail/MermaidFlowchart';
import { MermaidSourceError, renderMermaidFlowchart } from '../src/features/task-detail/MermaidRenderer';
import { createLocaleRender } from './helpers/renderWithLocale';

const engine = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn(), mermaidAPI: { getDiagramFromText: vi.fn() } }));
vi.mock('mermaid', () => ({ default: engine }));

const render = createLocaleRender('zh-CN');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="440" height="180" viewBox="0 0 440 180"><text>开始</text></svg>';
const result = { svg, diagramType: 'flowchart-v2' };
const source = 'flowchart TD\nA[开始] --> B{是否通过？}\nB -->|是| C[完成]';
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
};
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();

beforeEach(() => {
  engine.initialize.mockReset();
  engine.render.mockReset().mockResolvedValue(result);
  engine.mermaidAPI.getDiagramFromText.mockReset().mockResolvedValue({ type: 'flowchart-v2', db: { getVertices: () => new Map() } });
  createObjectURL.mockReset().mockReturnValue('blob:flowchart');
  revokeObjectURL.mockReset();
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
});

describe('Markdown Mermaid flowcharts', () => {
  it('uses one shared block renderer while preserving ordinary Markdown and inert image output', async () => {
    const bindFunctions = vi.fn();
    engine.render.mockResolvedValue({ ...result, bindFunctions });
    const view = render(<MarkdownContent className="test-markdown" resolveUrl={(value) => value} text={`# Heading\n\n| A | B |\n| --- | --- |\n| C | D |\n\n\`inline\`\n\n\`\`\`typescript\nconst value = 1;\n\`\`\`\n\n\`\`\`mermaid\n${source}\n\`\`\``} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在渲染流程图');
    expect(screen.getByRole('heading')).toHaveTextContent('Heading');
    expect(screen.getByRole('table')).toHaveTextContent('CD');
    expect(view.container.querySelector('pre > code.language-typescript')).toHaveTextContent('const value = 1;');
    expect(screen.getByText('inline').tagName).toBe('CODE');
    await waitFor(() => expect(screen.getByRole('img', { name: '流程图' })).toHaveAttribute('src', 'blob:flowchart'));
    expect(screen.getByRole('region', { name: '流程图' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('查看 Mermaid 源码').closest('details')).not.toHaveAttribute('open');
    expect(engine.render).toHaveBeenCalledWith(expect.stringMatching(/^daynight-flowchart-/), `${source}\n`, expect.any(HTMLDivElement));
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
    render(<MarkdownContent className="test-markdown" resolveUrl={(value) => value} text={`正文\n\n\`\`\`mermaid\nflowchart TD\nbroken\n\`\`\`\n\n\`\`\`mermaid\n${source}\n\`\`\``} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('无法渲染此流程图'));
    await waitFor(() => expect(screen.getByRole('img', { name: '流程图' })).toBeInTheDocument());
    expect(screen.getByText('正文')).toBeVisible();
    expect(screen.getByText(/flowchart TD\s+broken/)).toBeVisible();
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
  });

  it('shows empty Mermaid fences as unsupported source without changing empty ordinary fences', async () => {
    const view = render(<MarkdownContent className="test-markdown" resolveUrl={(value) => value} text={'```mermaid\n```\n\n```text\n```'} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('仅支持 Mermaid 流程图'));
    expect(view.container.querySelectorAll('.mermaid-flowchart')).toHaveLength(1);
    expect(view.container.querySelector('pre > code.language-text')).toBeInTheDocument();
    expect(engine.render).not.toHaveBeenCalled();
  });

  it('discards an older in-flight render after source replacement before allocating an image URL', async () => {
    const old = deferred<typeof result>();
    engine.render.mockReturnValueOnce(old.promise);
    const view = render(<MermaidFlowchart source={source} />);
    await waitFor(() => expect(engine.render).toHaveBeenCalledOnce());
    view.rerender(<MermaidFlowchart source={'flowchart LR\nCurrent --> Content'} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
    await act(async () => { old.resolve(result); });
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
    expect(engine.render).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(screen.getByText(/flowchart LR\s+Current --> Content/)).toBeInTheDocument();
  });

  it('removes a ready image immediately on replacement and revokes its previous URL', async () => {
    const view = render(<MermaidFlowchart source={source} />);
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
    const previousImage = screen.getByRole('img');
    const next = deferred<typeof result>();
    engine.render.mockReturnValueOnce(next.promise);
    view.rerender(<MermaidFlowchart source={'graph LR\nNew --> Diagram'} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:flowchart');
    await act(async () => { next.resolve(result); });
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
    fireEvent.error(previousImage);
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disposes pending work on unmount and exposes image-decoding failure with current-language source', async () => {
    const pending = deferred<typeof result>();
    engine.render.mockReturnValueOnce(pending.promise);
    const first = render(<MermaidFlowchart source={source} />);
    await waitFor(() => expect(engine.render).toHaveBeenCalledOnce());
    first.unmount();
    await act(async () => { pending.resolve(result); });
    expect(createObjectURL).not.toHaveBeenCalled();
    const next = render(<MermaidFlowchart source={source} />);
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('alert')).toHaveTextContent('无法渲染此流程图');
    expect(next.container.querySelector('pre > code')?.textContent).toBe(source);
    expect(next.container.querySelector('pre > code')).toBeVisible();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:flowchart');
    next.setLocale('en');
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to render this flowchart');
  });

  it.each([{ img: '/held.svg' }, { type: 'imageSquare' }])('explains image-node refusal locally while keeping its source inspectable: %o', async (vertex) => {
    engine.mermaidAPI.getDiagramFromText.mockResolvedValueOnce({ type: 'flowchart-v2', db: { getVertices: () => new Map([['A', vertex]]) } });
    const imageSource = 'flowchart TD\nA@{ img: "/held.svg" } --> B';
    const view = render(<MermaidFlowchart source={imageSource} />);
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
    { text: 'sequenceDiagram\nAlice->>Bob: Hello', issue: 'unsupported' },
    { text: '', issue: 'unsupported' },
    { text: `flowchart TD\n${'A'.repeat(50_000)}`, issue: 'tooLarge' },
  ])('refuses $issue before allowing source to configure or enter Mermaid', async ({ text, issue }) => {
    await expect(renderMermaidFlowchart(text, new AbortController().signal)).rejects.toMatchObject({ issue });
    expect(engine.initialize).not.toHaveBeenCalled();
    expect(engine.render).not.toHaveBeenCalled();
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
  });

  it('serializes configuration and rendering, uses fixed safety settings and cleans staging on success', async () => {
    const pending = deferred<typeof result>();
    engine.render.mockReturnValueOnce(pending.promise);
    const first = renderMermaidFlowchart(source, new AbortController().signal);
    const second = renderMermaidFlowchart('%% comment\n\ngraph LR\nA --> B', new AbortController().signal);
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

  it('skips an aborted queued diagram and preserves renderer errors without poisoning later work', async () => {
    const pending = deferred<typeof result>();
    engine.render.mockReturnValueOnce(pending.promise);
    const first = renderMermaidFlowchart(source, new AbortController().signal);
    const controller = new AbortController();
    const second = renderMermaidFlowchart(source, controller.signal);
    const aborted = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    pending.resolve(result);
    await first;
    await aborted;
    expect(engine.render).toHaveBeenCalledOnce();
    const cause = new Error('render failed');
    engine.render.mockRejectedValueOnce(cause);
    await expect(renderMermaidFlowchart(source, new AbortController().signal)).rejects.toBe(cause);
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
    await expect(renderMermaidFlowchart(source, new AbortController().signal)).resolves.toBe(svg);
  });

  it('refuses unexpected engine diagram types and preserves typed source errors', async () => {
    engine.render.mockResolvedValueOnce({ ...result, diagramType: 'error' });
    await expect(renderMermaidFlowchart(source, new AbortController().signal)).rejects.toBeInstanceOf(MermaidSourceError);
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
  });

  it('stops after asynchronous module loading when the reader is disposed before initialization', async () => {
    const controller = new AbortController();
    const pending = renderMermaidFlowchart(source, controller.signal);
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.initialize).not.toHaveBeenCalled();
    expect(engine.render).not.toHaveBeenCalled();
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
  });

  it('disposes an in-flight parser before it can create staging or render a stale diagram', async () => {
    const parsed = deferred<{ type: string; db: { getVertices: () => Map<string, never> } }>();
    engine.mermaidAPI.getDiagramFromText.mockReturnValueOnce(parsed.promise);
    const controller = new AbortController();
    const pending = renderMermaidFlowchart(source, controller.signal);
    await waitFor(() => expect(engine.mermaidAPI.getDiagramFromText).toHaveBeenCalledOnce());
    controller.abort();
    parsed.resolve({ type: 'flowchart-v2', db: { getVertices: () => new Map<string, never>() } });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.render).not.toHaveBeenCalled();
    expect(document.querySelector('.mermaid-render-staging')).toBeNull();
    await expect(renderMermaidFlowchart(source, new AbortController().signal)).resolves.toBe(svg);
  });
});
