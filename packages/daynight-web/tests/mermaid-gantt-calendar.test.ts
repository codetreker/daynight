import mermaid from 'mermaid';
import { describe, expect, it } from 'vitest';

interface GanttTask { startTime: Date; endTime: Date }
interface GanttDb { getTasks(): GanttTask[]; getSections(): string[] }

describe('pinned Mermaid Gantt calendar', () => {
  it('preserves excluded weekends and explicit included dates through the npm entry', async () => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(`gantt
 dateFormat YYYY-MM-DD
 excludes weekends
 includes 2026-01-03
 section Work
 Work :2026-01-01, 3d`);
    expect(diagram.type).toBe('gantt');
    const db = diagram.db as GanttDb;
    expect(db.getSections()).toEqual(['Work']);
    expect(db.getTasks()[0]).toMatchObject({ startTime: new Date(2026, 0, 1), endTime: new Date(2026, 0, 5) });
    expect(db.getTasks()[0]?.endTime).toEqual(new Date(2026, 0, 5));
  });
});
