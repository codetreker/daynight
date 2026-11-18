import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import './bar-chart.css';

export interface BarChartPoint {
  key: string;
  label: string;
  value: bigint;
  axisLabel?: string;
}

export interface BarChartProps {
  label: string;
  points: readonly BarChartPoint[];
  domainMax: bigint;
  formatValue: (value: bigint) => string;
}

/** A single nonempty series of uniquely keyed, nonnegative integer values. */
export function BarChart({ label, points, domainMax, formatValue }: BarChartProps) {
  if (points.length === 0 || domainMax < 0n || new Set(points.map(point => point.key)).size !== points.length ||
      points.some(point => point.value < 0n || point.value > domainMax)) {
    throw new Error('BarChart requires nonempty, uniquely keyed nonnegative values within domainMax');
  }
  const id = useId();
  const plotRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const pointerFocus = useRef(false);
  const [selectedKey, setSelectedKey] = useState(points[0]!.key);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const foundIndex = points.findIndex(point => point.key === selectedKey);
  const selectedIndex = Math.max(0, foundIndex);
  if (foundIndex < 0) setSelectedKey(points[0]!.key);
  const selected = points[selectedIndex]!;
  const revealSelected = () => {
    const plot = plotRef.current;
    if (!plot || document.activeElement !== plot) return;
    const scroller = plot.parentElement;
    const point = plot.children[selectedIndex];
    if (!scroller || !point) return;
    const bounds = scroller.getBoundingClientRect();
    const target = point.getBoundingClientRect();
    if (target.left < bounds.left) scroller.scrollLeft += target.left - bounds.left;
    else if (target.right > bounds.right) scroller.scrollLeft += target.right - bounds.right;
  };
  useLayoutEffect(revealSelected, [selectedIndex, selected.key, points.length]);
  useLayoutEffect(() => {
    const scroller = scrollRef.current, labels = labelsRef.current;
    if (!scroller || !labels) return;
    const update = () => {
      const bounds = scroller.getBoundingClientRect();
      for (const element of Array.from(labels.children)) {
        const label = element as HTMLElement, box = label.getBoundingClientRect();
        label.style.visibility = box.left >= bounds.left - 1 && box.right <= bounds.right + 1 ? '' : 'hidden';
      }
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(scroller);
    return () => { scroller.removeEventListener('scroll', update); window.removeEventListener('resize', update); observer?.disconnect(); };
  }, [points]);
  const shown = points.find(point => point.key === hoveredKey) ?? selected;
  const reading = (point: BarChartPoint) => `${point.label}: ${formatValue(point.value)}`;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next = selectedIndex;
    switch (event.key) {
      case 'ArrowRight': case 'ArrowDown': next = Math.min(points.length - 1, next + 1); break;
      case 'ArrowLeft': case 'ArrowUp': next = Math.max(0, next - 1); break;
      case 'Home': next = 0; break;
      case 'End': next = points.length - 1; break;
      default: return;
    }
    event.preventDefault();
    setHoveredKey(null);
    setSelectedKey(points[next]!.key);
  };
  const labelCount = Math.min(5, points.length);
  const labelIndices = Array.from({ length: labelCount }, (_, index) => labelCount === 1 ? 0 : Math.round(index * (points.length - 1) / (labelCount - 1)));
  const positions = labelIndices.map((index, labelIndex) => labelIndex === 0 ? 0 : labelIndex === labelCount - 1 ? 100 : (index + 0.5) * 100 / points.length);
  const spacing = Math.min(100, ...positions.slice(1).map((position, index) => position - positions[index]!));
  const gridStyle = { '--bar-chart-columns': points.length, '--bar-chart-label-width': `${Math.min(99 / labelCount, spacing * 0.6)}%` } as CSSProperties;
  return <div className="bar-chart">
    <output className="bar-chart__reading" aria-live="polite" aria-atomic="true">{reading(shown)}</output>
    <div className="bar-chart__grid">
      <div className="bar-chart__scale" aria-hidden="true"><span>{formatValue(domainMax)}</span><span>{formatValue(0n)}</span></div>
      <div className="bar-chart__scroll" ref={scrollRef} style={gridStyle}>
      <div className="bar-chart__plot" ref={plotRef} role="listbox" aria-orientation="horizontal" tabIndex={0} aria-label={label} aria-activedescendant={`${id}-${selectedIndex}`} onPointerDown={() => { pointerFocus.current = true; }}
        onPointerCancel={() => { pointerFocus.current = false; }} onBlur={() => { pointerFocus.current = false; }}
        onFocus={() => { if (!pointerFocus.current) revealSelected(); pointerFocus.current = false; }} onKeyDown={onKeyDown} onPointerLeave={() => setHoveredKey(null)}>
        {points.map((point, index) => {
          // Divide while still in bigint: converting either operand first can overflow.
          const height = domainMax === 0n ? 0 : Number(point.value * 10000n / domainMax) / 100;
          return <div key={point.key} className="bar-chart__point" data-zero={point.value === 0n || undefined}
            data-selected={point.key === selected.key || undefined} role="option" id={`${id}-${index}`} aria-label={reading(point)} aria-selected={point.key === selected.key}
            style={{ '--bar-chart-height': `${height}%` } as CSSProperties}
            onPointerEnter={event => { if (event.pointerType !== 'touch') setHoveredKey(point.key); }}
            onClick={event => { setSelectedKey(point.key); setHoveredKey(null); event.currentTarget.parentElement?.focus(); }} />;
        })}
      </div>
      <div className="bar-chart__labels" ref={labelsRef} aria-hidden="true">{labelIndices.map((index, labelIndex) => <span key={points[index]!.key}
        style={{ left: `${positions[labelIndex]}%`,
          transform: labelIndex === 0 ? 'none' : labelIndex === labelIndices.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
        {points[index]!.axisLabel ?? points[index]!.label}</span>)}</div>
      </div>
    </div>
  </div>;
}
