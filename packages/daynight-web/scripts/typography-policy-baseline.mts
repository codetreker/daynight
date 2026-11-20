import { occurrenceDiagnostic, type TypographyOccurrence } from './typography-policy-contract.mts';

export type TypographyBaselineEntry = Pick<TypographyOccurrence, 'path' | 'category' | 'context' | 'value'> & { owner: string; count: number };
export const typographyBaselinePath = 'scripts/typography-policy-baseline.json';
const key = (item: Pick<TypographyOccurrence, 'path' | 'category' | 'context' | 'value'>): string => JSON.stringify([item.path, item.category, item.context, item.value]);

export const readTypographyBaseline = (text: string): TypographyBaselineEntry[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('Typography baseline must be an array.');
  const seen = new Set<string>();
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'category,context,count,owner,path,value'
      || typeof item.path !== 'string' || !/^src\/[^\\]+\.(?:css|tsx?)$/.test(item.path) || item.path.split('/').includes('..')
      || !['legacy-reference', 'legacy-definition', 'legacy-mermaid-size'].includes(item.category)
      || typeof item.context !== 'string' || typeof item.value !== 'string' || typeof item.owner !== 'string' || !/^[A-J]$/.test(item.owner)
      || !Number.isSafeInteger(item.count) || item.count < 1) throw new Error('Invalid typography baseline entry.');
    const identity = key(item);
    if (seen.has(identity)) throw new Error('Duplicate typography baseline entry.');
    seen.add(identity);
  }
  if (JSON.stringify(parsed) !== JSON.stringify([...parsed].sort((a, b) => key(a).localeCompare(key(b), 'en')))) throw new Error('Typography baseline entries must be deterministically sorted.');
  return parsed;
};

export const compareTypographyBaseline = (occurrences: readonly TypographyOccurrence[], baseline: readonly TypographyBaselineEntry[], zeroLegacy: boolean): string[] => {
  const diagnostics = occurrences.filter(item => item.category === 'invalid' || zeroLegacy).map(occurrenceDiagnostic);
  if (zeroLegacy) return diagnostics;
  const actual = new Map<string, TypographyOccurrence[]>();
  for (const item of occurrences.filter(item => item.category !== 'invalid')) {
    const identity = key(item);
    actual.set(identity, [...actual.get(identity) ?? [], item]);
  }
  const expected = new Map(baseline.map(item => [key(item), item]));
  for (const [identity, items] of actual) {
    const allowed = expected.get(identity);
    if (allowed === undefined || items.length > allowed.count) diagnostics.push(`${occurrenceDiagnostic(items[0]!)} Unrecorded or increased legacy usage (${items.length}; allowed ${allowed?.count ?? 0}).`);
  }
  for (const item of baseline) {
    const count = actual.get(key(item))?.length ?? 0;
    if (count < item.count) diagnostics.push(`${item.path}:1:1: typography ownership: stale legacy baseline for ${item.context} (${item.count} recorded; ${count} actual); remove or reduce the entry.`);
  }
  return diagnostics;
};

export const inventoryTypography = (occurrences: readonly TypographyOccurrence[], owner: (path: string) => string): TypographyBaselineEntry[] => {
  const entries = new Map<string, TypographyBaselineEntry>();
  for (const item of occurrences.filter(item => item.category !== 'invalid')) {
    const identity = key(item);
    const entry = entries.get(identity);
    if (entry === undefined) entries.set(identity, { path: item.path, category: item.category, context: item.context, value: item.value, owner: owner(item.path), count: 1 });
    else entry.count++;
  }
  return [...entries.values()].sort((a, b) => key(a).localeCompare(key(b), 'en'));
};
