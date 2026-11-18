import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BarChart, type BarChartPoint } from '../../src/ui/bar-chart';

const original: BarChartPoint[] = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, label: `Category ${i} with a complete long label`, axisLabel: `Short ${i}`, value: BigInt(i) * 10000000000000000n }));
function Host() {
  const [points, setPoints] = useState(original);
  window.refreshChart = () => setPoints(current => current.map(point => ({ ...point })));
  return <main style={{ maxWidth: 700, margin: '16px auto' }}>
    <button onClick={() => setPoints(original.map(p => ({ ...p, value: p.value / 2n })))}>Filter</button>
    <button onClick={() => setPoints(original.slice(2, 8).map(p => ({ ...p, axisLabel: p.label })))}>Shorten</button>
    <button onClick={() => setPoints(original.slice(2, 9).map(p => ({ ...p, axisLabel: p.label })))}>Seven</button>
    <button onClick={() => setPoints(original.map(p => ({ ...p, value: 0n })))}>Zero</button>
    <BarChart label="Categories" points={points} domainMax={290000000000000000n} formatValue={v => `${v} items`} />
    <button>After</button>
    <BarChart label="All zero" points={[{ key: 'one', label: 'One', value: 0n }]} domainMax={0n} formatValue={v => `${v}`} />
  </main>;
}
declare global { interface Window { refreshChart: () => void } }
createRoot(document.getElementById('root')!).render(<Host />);
