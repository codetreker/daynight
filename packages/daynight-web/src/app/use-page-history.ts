import { useLayoutEffect, useRef } from 'react';
import { useBrowserLocation } from './browser-location';
import { browserNavigation } from './navigation';
import { accountHistory, readAccountHistory, workerHistory, readWorkerHistory, type AccountTab, type WorkerSection } from './page-history';
import { parseAuthRoute } from './router';

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

/** Only the active Worker consumes its identity- and resource-bound selection. */
export function useWorkerHistory(userId: string, workerId: string, active: boolean) {
  const location = useBrowserLocation();
  const navigation = browserNavigation();
  const retained = useRef<{ userId: string; workerId: string; section: WorkerSection }>({ userId, workerId, section: 'overview' });
  if (retained.current.userId !== userId || retained.current.workerId !== workerId) retained.current = { userId, workerId, section: 'overview' };
  const route = parseAuthRoute(location.pathname, location.search);
  const onPage = active && route.kind === 'worker' && route.workerId === workerId;
  let selected: WorkerSection | null = null;
  let error = false;
  if (onPage) {
    try { selected = readWorkerHistory(location.view, userId, workerId); }
    catch { error = true; }
  }
  const section = !onPage || location.entryId === null ? retained.current.section : selected ?? 'overview';
  useLayoutEffect(() => {
    if (!onPage || error) return;
    retained.current.section = section;
    if (location.entryId !== null && selected === null) navigation.setView(workerHistory(userId, workerId, section), { replace: true });
  }, [onPage, error, section, selected, location.entryId, navigation, userId, workerId]);
  const select = (next: WorkerSection, replace = false) => {
    if (!onPage || error) return;
    if (location.entryId !== null && selected === null) navigation.setView(workerHistory(userId, workerId, section), { replace: true });
    if (next !== section) navigation.setView(workerHistory(userId, workerId, next), { replace });
  };
  return { section, select, error };
}
