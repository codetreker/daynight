export const typographyOwner = 'src/styles/typography.css';
export const scale = new Map([
  ['--text-xs', '.75rem'], ['--text-sm', '.875rem'], ['--text-base', '1rem'],
  ['--text-lg', '1.125rem'], ['--text-xl', '1.375rem'], ['--text-2xl', '1.75rem'],
]);
export const retired = new Set([
  '--text-metadata', '--text-interface', '--text-reading', '--text-section-heading',
  '--text-detail-heading', '--text-page-heading', '--text-terminal', '--text-touch-field',
  '--selection-control-font-size', '--selection-control-count-font-size', '--native-select-font-size',
]);
export type TypographyOccurrence = {
  path: string;
  category: 'legacy-reference' | 'legacy-definition' | 'invalid';
  context: string;
  value: string;
  line: number;
  column: number;
  message: string;
};
export const occurrenceDiagnostic = (item: TypographyOccurrence): string => `${item.path}:${item.line}:${item.column}: typography ownership: ${item.message} [${item.context}: ${item.value}]`;
export const retiredIn = (text: string): string[] => [...new Set(text.match(/--[\w-]+/g) ?? [])].filter(name => retired.has(name)).sort();
