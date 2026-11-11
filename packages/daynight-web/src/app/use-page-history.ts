import { useLayoutEffect, useRef } from 'react';
import { useBrowserLocation } from './browser-location';
import { browserNavigation } from './navigation';
import { accountHistory, readAccountHistory, type AccountTab } from './page-history';

/** The active account page consumes only admitted, identity-bound selections. */
export function useAccountHistory(userId: string, active: boolean) {
  const location = useBrowserLocation();
  const navigation = browserNavigation();
  const retained = useRef<{ userId: string; tab: AccountTab }>({ userId, tab: 'profile' });
  if (retained.current.userId !== userId) retained.current = { userId, tab: 'profile' };
  const onPage = active && location.pathname === '/account';
  let selected: AccountTab | null = null;
  let error = false;
  if (onPage) {
    try { selected = readAccountHistory(location.view, userId); }
    catch { error = true; }
  }
  const tab = !onPage || location.entryId === null ? retained.current.tab : selected ?? 'profile';
  useLayoutEffect(() => {
    if (!onPage || error) return;
    retained.current.tab = tab;
    if (location.entryId !== null && selected === null) navigation.setView(accountHistory(userId, tab), { replace: true });
  }, [onPage, error, tab, selected, location.entryId, navigation, userId]);
  const select = (next: AccountTab, replace = false) => {
    if (!onPage || error) return;
    if (location.entryId !== null && selected === null) navigation.setView(accountHistory(userId, tab), { replace: true });
    if (next !== tab) navigation.setView(accountHistory(userId, next), { replace });
  };
  return { tab, select, error };
}
