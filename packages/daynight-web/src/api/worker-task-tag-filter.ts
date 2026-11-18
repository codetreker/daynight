import { array, malformed, record } from './parse';
import { normalizeTagName, tagNameKey } from './task-tags';

export type WorkerTaskTagFilter = { readonly names: readonly string[]; readonly match: 'any' | 'all' };

const scalarCompare = (left: string, right: string): number => {
  const a = Array.from(left, c => c.codePointAt(0)!), b = Array.from(right, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
};

export const parseWorkerTaskTagFilter = (value: unknown): WorkerTaskTagFilter => {
  const data = record(value);
  if (data.match !== 'any' && data.match !== 'all') return malformed();
  const names = new Map<string, string>();
  for (const raw of array(data.names, item => typeof item === 'string' ? item : malformed())) {
    const name = normalizeTagName(raw);
    if (name === null) return malformed();
    const key = tagNameKey(name);
    if (!names.has(key)) names.set(key, name);
  }
  const keys = [...names.keys()].sort(scalarCompare);
  return { names: keys.map(key => names.get(key)!), match: keys.length === 0 ? 'any' : data.match };
};

export const taskTagFilterSemantics = (filter: WorkerTaskTagFilter): string => {
  const normalized = parseWorkerTaskTagFilter(filter);
  return JSON.stringify([normalized.match, normalized.names.map(tagNameKey)]);
};

export const taskTagFilterDigest = async (semantics: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(semantics)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
