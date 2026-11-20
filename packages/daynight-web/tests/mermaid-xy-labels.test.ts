import mermaid from 'mermaid';
import { describe, expect, it } from 'vitest';

const labeledLine = (orientation: string) => `xychart ${orientation}
title "Trend"
x-axis [Mon, Tue, Wed]
y-axis 0 --> 20
line [0 "Low point", 10 "Middle point", 20 "High point"]`;

describe('XY line labels', () => {
  it.each(['vertical', 'horizontal'])('parses labels and preserves their values in %s orientation', async orientation => {
    mermaid.initialize({ startOnLoad: false });
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(labeledLine(orientation));
    const db = diagram.db as unknown as { getXYChartData(): { plots: { pointLabels?: string[]; data: [string, number][] }[] }; getChartConfig(): { chartOrientation: string } };
    expect(db.getChartConfig().chartOrientation).toBe(orientation);
    expect(db.getXYChartData().plots[0]?.pointLabels).toEqual(['Low point', 'Middle point', 'High point']);
    expect(db.getXYChartData().plots[0]?.data.map(point => point[1])).toEqual([0, 10, 20]);
  });
});
