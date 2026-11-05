import mermaid from 'mermaid';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { identifyMermaidType, inspectMermaidDiagram, matchesMermaidType, preflightBlock, type StableMermaidType } from '../src/features/task-detail/MermaidPolicy';

const samples: ReadonlyArray<[StableMermaidType, string]> = [
  ['flowchart', 'flowchart TD\nA[开始] --> B[完成]'],
  ['flowchart', 'graph LR\nA --> B'],
  ['flowchart-elk', 'flowchart-elk LR\nA --> B'],
  ['sequence', 'sequenceDiagram\nAlice->>Bob: Hello'],
  ['class', 'classDiagram\nProject --> Task'],
  ['state', 'stateDiagram-v2\n[*] --> Ready'],
  ['state', 'stateDiagram\n[*] --> Ready'],
  ['er', 'erDiagram\nPROJECT ||--o{ TASK : contains'],
  ['gantt', 'gantt\ndateFormat YYYY-MM-DD\nsection work\nTask :2026-01-01, 2d'],
  ['journey', 'journey\nsection work\nTask: 5: Alice'],
  ['pie', 'pie\n"A": 1'],
  ['quadrant', 'quadrantChart\nA: [0.2, 0.3]'],
  ['requirement', 'requirementDiagram\nrequirement sample {\nid: 1\ntext: "hello"\nrisk: low\nverifymethod: test\n}'],
  ['xy', 'xychart\nx-axis [a, b]\nbar [1, 2]'],
  ['block', 'block\ncolumns 2\nA B\nA --> B'],
  ['packet', 'packet\n0-7: "Header"'],
  ['kanban', 'kanban\ntodo[To do]\n  a[Task]'],
  ['eventmodeling', 'eventmodeling\ntf 01 ui Example'],
];

beforeAll(() => {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', layout: 'dagre', maxEdges: 500 });
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 20, height: 20 }) });
});

describe('fixed Mermaid policies', () => {
  it.each(samples)('accepts the real SDK parser contract for %s', async (type, source) => {
    expect(identifyMermaidType(source, mermaid)).toBe(type);
    if (type === 'block') await preflightBlock(source, mermaid);
    const parsed = await mermaid.mermaidAPI.getDiagramFromText(source);
    expect(matchesMermaidType(type, parsed.type)).toBe(true);
    expect(() => inspectMermaidDiagram(type, parsed)).not.toThrow();
  });

  it.each(['xychart-beta\nbar [1]', 'block-beta\nA', 'packet-beta\n0-1: "A"', 'gitGraph\ncommit', 'flowchart-elkish LR\nA --> B', 'sequenceDiagramExtra\nA->>B: x'])('rejects unsupported or experimental entry %s', (source) => {
    expect(() => identifyMermaidType(source, mermaid)).toThrow(expect.objectContaining({ issue: 'unsupported' }));
  });

  it('does not accept an ELK parser ID for the Dagre entry or the reverse', () => {
    expect(matchesMermaidType('flowchart', 'flowchart-elk')).toBe(false);
    expect(matchesMermaidType('flowchart-elk', 'flowchart-v2')).toBe(false);
  });

  it('respects leading SDK comments and does not erase the rest of the source', () => {
    expect(identifyMermaidType('  %% comment\r\n\nflowchart TD\nA["%% text"]', mermaid)).toBe('flowchart');
  });

  it('uses the real parser to reject image metadata without rejecting ordinary metadata', async () => {
    const parse = (source: string) => mermaid.mermaidAPI.getDiagramFromText(source);
    const ordinary = await parse('flowchart TD\nA@{ shape: rect, label: "literal @{" } --> B');
    expect(() => inspectMermaidDiagram('flowchart', ordinary)).not.toThrow();
    const image = await parse(String.raw`flowchart TD
A@{ "im\u0067": "https://example.invalid/x.png" } --> B`);
    expect(() => inspectMermaidDiagram('flowchart', image)).toThrow(expect.objectContaining({ issue: 'image' }));
  });

  it('uses a fresh Block lexer to reject expansion before parsing while accepting label text', async () => {
    await expect(preflightBlock('block\ncolumns 500\nA:500 space:250 space:250\nB["space:999 columns 999"]\n%% space:999', mermaid)).resolves.toBeUndefined();
    for (const source of ['block\nspace:501', 'block\nspace:300 space:201', 'block\nA:501', 'block\ncolumns 501', 'block\ncolumns 0', 'block\nspace:999999999999999999999999']) {
      await expect(preflightBlock(source, mermaid)).rejects.toMatchObject({ issue: 'complexity' });
    }
    await expect(preflightBlock('block\ncolumns auto\nA', mermaid)).resolves.toBeUndefined();
  });

  it('counts structures separately and rejects broken SDK contracts', () => {
    const nodes = Array.from({ length: 500 }, () => ({}));
    const parsed = (n: unknown, e: unknown) => ({ type: 'classDiagram', db: { getData: () => ({ nodes: n, edges: e }) } });
    expect(() => inspectMermaidDiagram('class', parsed(nodes, nodes))).not.toThrow();
    expect(() => inspectMermaidDiagram('class', parsed([...nodes, {}], []))).toThrow(expect.objectContaining({ issue: 'complexity' }));
    expect(() => inspectMermaidDiagram('class', parsed([], [...nodes, {}]))).toThrow(expect.objectContaining({ issue: 'complexity' }));
    expect(() => inspectMermaidDiagram('class', parsed(null, []))).toThrow('Unexpected Mermaid 12.2.0');
  });

  it('reads Journey tasks once before its derived actors', () => {
    const tasks = vi.fn(() => [{}]);
    const actors = vi.fn(() => { expect(tasks).toHaveBeenCalledOnce(); return ['Alice']; });
    inspectMermaidDiagram('journey', { type: 'journey', db: { getTasks: tasks, getActors: actors, getSections: () => [] } });
    expect(tasks).toHaveBeenCalledOnce();
  });

  it('counts XY data and categories, packet fields, and Event Modeling structures independently', () => {
    const x = Array(501).fill(1);
    const xy = { type: 'xychart', db: { getXYChartData: () => ({ plots: [{ data: x }], xAxis: { type: 'linear' }, yAxis: { type: 'linear' } }) } };
    expect(() => inspectMermaidDiagram('xy', xy)).toThrow(expect.objectContaining({ issue: 'complexity' }));
    const packet = { type: 'packet', db: { getPacket: () => [x] } };
    expect(() => inspectMermaidDiagram('packet', packet)).toThrow(expect.objectContaining({ issue: 'complexity' }));
    const event = { type: 'eventmodeling', db: { getState: () => ({ boxes: [], relations: x, swimlanes: {} }) } };
    expect(() => inspectMermaidDiagram('eventmodeling', event)).toThrow(expect.objectContaining({ issue: 'complexity' }));
  });
});
