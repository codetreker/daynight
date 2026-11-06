import type { DependencySnapshot, GeometryExpectation } from './helpers/dependency-geometry';

export const d = 'M100,50 L188,50 Q200,50 200,62 L200,88 Q200,100 212,100 L238,100 Q250,100 250,88 L250,62 Q250,50 262,50 L300,50';
export const color = 'rgb(171, 178, 199)';
export const expected: GeometryExpectation = { nodes: [{ id: 'source' }, { id: 'target' }], edges: [{ id: 'source->target', source: 'source', target: 'target', external: true }] };
export const snapshot = (): DependencySnapshot => ({
  nodes: [{ id: 'source', left: 0, top: 0, right: 100, bottom: 100 }, { id: 'target', left: 300, top: 0, right: 400, bottom: 100 }],
  edges: [{ id: 'source->target', source: 'source', target: 'target', d, external: 'true', stroke: 'none', fill: 'none', color, bodyMatrix: [1, 0, 0, 1, 0, 0], bodyVisible: true, marker: '#arrow', canonicalVisible: true, pieces: [
    { d, matrix: [1, 0, 0, 1, 0, 0], line: false, phase: 0, dash: '5px, 4px', stroke: color, width: 1.5, cap: 'butt', join: 'miter', hidden: true },
  ] }],
  markers: [{ id: 'arrow', orient: 'auto-start-reverse', units: 'strokeWidth', viewBox: '-10 -10 20 20', width: '16', height: '16', refX: '0', refY: '0', points: '-5,-4 0,0 -5,4 -5,-4', stroke: color, fill: color, strokeWidth: 1, cap: 'round', join: 'round' }],
  declaredPieces: 1, viewport: true, passive: true,
});
