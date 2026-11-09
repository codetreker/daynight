import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// A child timeout bounds synchronous SDK work even if the package patch stops applying.
const probe = String.raw`
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
const { default: mermaid } = await import('mermaid');
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
const header = 'gantt\ndateFormat YYYY-MM-DD\nexcludes 9999-12-31\n';
const inputs = {
 duration: header + 'A :2026-01-01, 10000000d',
 range: 'gantt\ndateFormat DD/MM/YYYY\nexcludes 31/12/9999\nA :01/01/2026, 01/01/2500',
 cumulative: header + 'A :2026-01-01, 30000d\nB :2026-01-01, 30000d',
};
if (process.argv[1] === 'boundary') {
  const within = await mermaid.mermaidAPI.getDiagramFromText(header + 'A :2026-01-01, 50000d');
  if (within.db.getTasks().length !== 1) throw new Error('50,000 steps rejected');
  const repeated = await mermaid.mermaidAPI.getDiagramFromText(header + 'A :2026-01-01, 30000d');
  if (repeated.db.getTasks().length !== 1 || repeated.db.getTasks().length !== 1) throw new Error('getter budget did not reset');
  inputs.boundary = header + 'A :2026-01-01, 50001d';
}
const diagram = await mermaid.mermaidAPI.getDiagramFromText(inputs[process.argv[1]]);
try { diagram.db.getTasks(); throw new Error('work limit was not enforced'); }
catch (error) { if (error.name !== 'GanttCalendarWorkLimitError') throw error; }
const normal = await mermaid.mermaidAPI.getDiagramFromText(header + 'A :2026-01-01, 1d');
if (normal.db.getTasks().length !== 1 || normal.db.getTasks().length !== 1) throw new Error('budget did not reset');
const next = await mermaid.mermaidAPI.getDiagramFromText('flowchart TD\nA --> B');
if (next.type !== 'flowchart-v2') throw new Error('later diagram failed');
`;

describe('Gantt calendar work limit in the published npm entry', () => {
  it.each(['duration', 'range', 'cumulative', 'boundary'])('bounds %s and permits subsequent diagrams', (scenario) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, scenario], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }, 35_000);
});
