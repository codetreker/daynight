import { canonicalId } from '../api/validation';

export type AccountTab = 'profile' | 'tokens' | 'prompt';
export type PageHistoryState = {
  readonly version: 1;
  readonly userId: string;
  readonly pageKey: 'account';
  readonly selection: { readonly tab: AccountTab };
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Returns null for a missing or differently scoped selection; rejects malformed state. */
export function readAccountHistory(value: unknown, userId: string): AccountTab | null {
  if (value === undefined) return null;
  if (!record(value) || !exact(value, ['version', 'userId', 'pageKey', 'selection']) || value.version !== 1 || typeof value.userId !== 'string' || canonicalId(value.userId) !== value.userId || typeof value.pageKey !== 'string') throw new Error('Invalid page navigation state.');
  if (value.userId !== userId || value.pageKey !== 'account') return null;
  const selection = value.selection;
  if (!record(selection) || !exact(selection, ['tab']) || (selection.tab !== 'profile' && selection.tab !== 'tokens' && selection.tab !== 'prompt')) throw new Error('Invalid account navigation state.');
  return selection.tab;
}

export const accountHistory = (userId: string, tab: AccountTab): PageHistoryState => ({ version: 1, userId, pageKey: 'account', selection: { tab } });
