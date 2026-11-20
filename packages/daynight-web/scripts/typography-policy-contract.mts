export const typographyOwner = 'src/styles/typography.css';
export const scale = new Map([
  ['--text-xs', '.75rem'], ['--text-sm', '.875rem'], ['--text-base', '1rem'],
  ['--text-lg', '1.125rem'], ['--text-xl', '1.375rem'], ['--text-2xl', '1.75rem'],
]);
export const bridges = new Map([
  ['--text-metadata', 'var(--text-xs)'], ['--text-interface', 'var(--text-sm)'],
  ['--text-reading', 'var(--text-base)'], ['--text-section-heading', 'var(--text-lg)'],
  ['--text-detail-heading', 'var(--text-xl)'], ['--text-page-heading', 'var(--text-2xl)'],
  ['--text-terminal', 'var(--text-xs)'], ['--text-touch-field', 'max(var(--text-base),16px)'],
]);
export const retired = new Set([...bridges.keys(), '--selection-control-font-size', '--selection-control-count-font-size', '--native-select-font-size']);
export type TypographyOccurrence = {
  path: string;
  category: 'legacy-reference' | 'legacy-definition' | 'legacy-mermaid-size' | 'invalid';
  context: string;
  value: string;
  line: number;
  column: number;
  message: string;
};
export const occurrenceDiagnostic = (item: TypographyOccurrence): string => `${item.path}:${item.line}:${item.column}: typography ownership: ${item.message} [${item.context}: ${item.value}]`;
export const retiredIn = (text: string): string[] => [...new Set(text.match(/--[\w-]+/g) ?? [])].filter(name => retired.has(name)).sort();
