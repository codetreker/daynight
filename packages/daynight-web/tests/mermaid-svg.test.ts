import { describe, expect, it } from 'vitest';
import { sizeMermaidSvg } from '../src/features/task-detail/MermaidSvg';

describe('Mermaid image dimensions', () => {
  it('uses the viewBox without changing its origin or unrelated styles', () => {
    const result = sizeMermaidSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="-4 5 400.5 200" style="background: red; max-width: 400px; color: blue"><text>Label</text></svg>');
    const root = new DOMParser().parseFromString(result, 'image/svg+xml').documentElement;
    expect(root.getAttribute('width')).toBe('400.5');
    expect(root.getAttribute('height')).toBe('200');
    expect(root.getAttribute('viewBox')).toBe('-4 5 400.5 200');
    expect(root.getAttribute('style')).toContain('background: red');
    expect(root.getAttribute('style')).toContain('color: blue');
    expect(root.getAttribute('style')).not.toContain('max-width');
  });
  it.each(['<svg/>', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 10"/>', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 NaN 10"/>', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">', '<html/>'])('rejects invalid SVG dimensions: %s', (svg) => {
    expect(() => sizeMermaidSvg(svg)).toThrow();
  });
});
