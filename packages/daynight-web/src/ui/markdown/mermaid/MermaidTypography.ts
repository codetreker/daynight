export interface MermaidSizes {
  readonly xs: number;
  readonly sm: number;
  readonly lg: number;
}

// The probes live outside the reader so hidden tabs still produce measurable sizes.
export const observeMermaidSizes = (onChange: (sizes: MermaidSizes) => void): (() => void) => {
  const container = document.createElement('div');
  container.className = 'mermaid-size-probes';
  container.setAttribute('aria-hidden', 'true');
  const probes = (['xs', 'sm', 'lg'] as const).map(size => {
    const probe = document.createElement('span');
    probe.className = `mermaid-size-probe mermaid-size-${size}`;
    container.append(probe);
    return probe;
  });
  document.body.append(container);
  let previous: MermaidSizes | undefined;
  const measure = () => {
    const [xs, sm, lg] = probes.map(probe => probe.getBoundingClientRect().width);
    if (!xs || !sm || !lg) return;
    if (previous?.xs === xs && previous.sm === sm && previous.lg === lg) return;
    previous = { xs, sm, lg };
    onChange(previous);
  };
  const observer = new ResizeObserver(measure);
  probes.forEach(probe => observer.observe(probe));
  measure();
  return () => { observer.disconnect(); container.remove(); };
};
