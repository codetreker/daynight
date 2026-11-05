// @vitest-environment jsdom
import mermaid from 'mermaid';
import { beforeAll, describe, expect, it } from 'vitest';
import { identifyMermaidType, inspectMermaidDiagram, preflightBlock, type StableMermaidType } from '../src/features/task-detail/MermaidPolicy';

const items = (n: number): number[] => Array.from({ length: n }, (_, index) => index);
const samples: ReadonlyArray<[StableMermaidType, (n: number) => string]> = [
  ['flowchart', (n) => 'flowchart TD\n' + items(n).map((i) => `A${i}`).join('\n')],
  ['sequence', (n) => 'sequenceDiagram\n' + items(n).map((i) => `participant A${i}`).join('\n')],
  ['class', (n) => 'classDiagram\n' + items(n).map((i) => `class A${i}`).join('\n')],
  ['state', (n) => 'stateDiagram-v2\n' + items(n).map((i) => `A${i}: State ${i}`).join('\n')],
  ['er', (n) => 'erDiagram\n' + items(n).map((i) => `A${i} {\n string id\n}`).join('\n')],
  ['gantt', (n) => 'gantt\ndateFormat YYYY-MM-DD\n' + items(n).map((i) => `A${i} :2026-01-01, 1d`).join('\n')],
  ['journey', (n) => 'journey\nsection S\n' + items(n).map((i) => `Task${i}: 5: actor`).join('\n')],
  ['pie', (n) => 'pie\n' + items(n).map((i) => `"A${i}" : 1`).join('\n')],
  ['quadrant', (n) => 'quadrantChart\n' + items(n).map((i) => `A${i}: [0.2, 0.3]`).join('\n')],
  ['requirement', (n) => 'requirementDiagram\n' + items(n).map((i) => `requirement A${i} {\nid: ${i}\ntext: "hello"\nrisk: low\nverifymethod: test\n}`).join('\n')],
  ['xy', (n) => 'xychart\nbar [' + items(n).map(() => '1').join(',') + ']'],
  ['block', (n) => 'block\n' + items(n).map((i) => `A${i}`).join(' ')],
  ['packet', (n) => 'packet\n' + items(n).map((i) => `${i}: "A${i}"`).join('\n')],
  // The column itself is a Kanban node.
  ['kanban', (n) => 'kanban\ntodo[To do]\n' + items(n - 1).map((i) => `  A${i}[Task]`).join('\n')],
  ['eventmodeling', (n) => 'eventmodeling\n' + items(n).map((i) => `tf ${i} ui X${i}`).join('\n')],
];

beforeAll(() => {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', layout: 'dagre', maxEdges: 500 });
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 20, height: 20 }) });
});

describe('real SDK complexity boundaries', () => {
  it.each([
    { name: 'only spaces', source: (spaces: number) => `block\nspace:${spaces}`, atLimit: 500 },
    { name: 'ordinary node and spaces', source: (spaces: number) => `block\nA space:${spaces}`, atLimit: 499 },
    { name: 'nested composite and spaces', source: (spaces: number) => `block\nblock:group\nA space:${spaces}\nend`, atLimit: 498 },
  ])('counts $name at the exact limit', async ({ source, atLimit }) => {
    for (const spaces of [atLimit, atLimit + 1]) {
      const text = source(spaces);
      // A single space:501 is rejected before the parser can expand it.
      if (spaces > 500) {
        await expect(preflightBlock(text, mermaid)).rejects.toMatchObject({ issue: 'complexity' });
        continue;
      }
      await preflightBlock(text, mermaid);
      const parsed = await mermaid.mermaidAPI.getDiagramFromText(text);
      if (spaces === atLimit) expect(() => inspectMermaidDiagram('block', parsed)).not.toThrow();
      else expect(() => inspectMermaidDiagram('block', parsed)).toThrow(expect.objectContaining({ issue: 'complexity' }));
    }
  });

  it('refuses deep Block layout work with the real parser', async () => {
    const source = 'block\n' + items(26).map((i) => `block:group${i}`).join('\n') + '\nA\n' + items(26).map(() => 'end').join('\n');
    await preflightBlock(source, mermaid);
    const parsed = await mermaid.mermaidAPI.getDiagramFromText(source);
    expect(() => inspectMermaidDiagram('block', parsed)).toThrow(expect.objectContaining({ issue: 'complexity' }));
  });

  it('does not count unrendered class placeholders or repeated nodes', async () => {
    const source = 'block\n' + items(500).map((i) => `A${i}`).join(' ') + '\nA0\n' + items(501).map((i) => `class missing${i} demo`).join('\n');
    await preflightBlock(source, mermaid);
    const parsed = await mermaid.mermaidAPI.getDiagramFromText(source);
    expect(() => inspectMermaidDiagram('block', parsed)).not.toThrow();
  });

  it.each(samples)('accepts 500 and refuses 501 structures for %s', async (type, source) => {
    for (const n of [500, 501]) {
      const text = source(n);
      expect(text.length).toBeLessThanOrEqual(50_000);
      expect(identifyMermaidType(text, mermaid)).toBe(type);
      if (type === 'block') await preflightBlock(text, mermaid);
      const parsed = await mermaid.mermaidAPI.getDiagramFromText(text);
      if (n === 500) expect(() => inspectMermaidDiagram(type, parsed)).not.toThrow();
      else expect(() => inspectMermaidDiagram(type, parsed)).toThrow(expect.objectContaining({ issue: 'complexity' }));
    }
  }, 30_000);
});
