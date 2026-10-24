import mermaid from 'mermaid';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { renderMermaidFlowchart } from '../src/features/task-detail/MermaidRenderer';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"></svg>';
let render: MockInstance<typeof mermaid.render>;

beforeEach(() => { render = vi.spyOn(mermaid, 'render').mockResolvedValue({ svg, diagramType: 'flowchart-v2' }); });
afterEach(() => { expect(document.querySelector('.mermaid-render-staging')).toBeNull(); });

describe('pinned Mermaid parser preflight', () => {
  it.each([
    'flowchart TD\nA[开始] --> B{是否通过？}\nB -->|是| C[完成]',
    'graph LR\nA[Left] --> B[Right]',
    'flowchart TD\nA["literal @{ text"] --> B',
    'flowchart TD\nA@{ shape: rect, label: "Modern metadata" } --> B',
  ])('preserves supported flowchart syntax without confusing labels and metadata: %s', async (source) => {
    await expect(renderMermaidFlowchart(source, new AbortController().signal)).resolves.toBe(svg);
    expect(render).toHaveBeenCalledOnce();
  });

  it.each([
    'flowchart TD\nA@{ img: "/held.svg", label: "Old" } --> B',
    String.raw`flowchart TD
A@{ "im\u0067": "/held.svg", label: "Escaped key" } --> B`,
  ])('refuses parsed image nodes before entering the resource-loading renderer: %s', async (source) => {
    await expect(renderMermaidFlowchart(source, new AbortController().signal)).rejects.toMatchObject({ issue: 'image' });
    expect(render).not.toHaveBeenCalled();
    await expect(renderMermaidFlowchart('flowchart LR\nCurrent --> Content', new AbortController().signal)).resolves.toBe(svg);
    expect(render).toHaveBeenCalledOnce();
  });

  it('keeps the parser refusal of the internal imageSquare shape before rendering', async () => {
    await expect(renderMermaidFlowchart('flowchart TD\nA@{ shape: imageSquare } --> B', new AbortController().signal)).rejects.toThrow('Shape names should be lowercase');
    expect(render).not.toHaveBeenCalled();
  });
});
