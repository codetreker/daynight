export type ReadbackTask = { id?: string; parentId?: string };
export type CacheProbe = { version: number; result: 'version-error' | 'opened' | 'aborted' | 'other-error' | 'timeout' };

// This function runs in the browser. Aborting every upgrade also preserves the
// database if its state changes between enumeration and the versioned open.
export async function probeHigherTaskCache(): Promise<CacheProbe | null> {
  if (typeof indexedDB.databases !== 'function') return null;
  const databases = await indexedDB.databases();
  const version = databases.find(item => item.name === 'daynight-task-cache')?.version;
  if (version === undefined || !Number.isSafeInteger(version) || version <= 13) return null;
  const result = await new Promise<CacheProbe['result']>((resolve) => {
    let settled = false;
    const finish = (value: CacheProbe['result']): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const request = indexedDB.open('daynight-task-cache', 13);
    const timer = setTimeout(() => finish('timeout'), 2_000);
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onsuccess = () => { request.result.close(); finish('opened'); };
    request.onerror = () => finish(request.error?.name === 'VersionError' ? 'version-error' : request.error?.name === 'AbortError' ? 'aborted' : 'other-error');
  });
  return { version, result };
}

// Keep each observation separate so a failed restored readback identifies its
// owner without recording browser content or CLI output.
export async function verifyRecoveryReadback(input: {
  phase: (value: string) => Promise<void>;
  navigate: () => Promise<void>;
  heading: () => Promise<void>;
  readTask: () => Promise<ReadbackTask>;
  readAttachment: () => Promise<string>;
  leave: () => Promise<void>;
  child: string;
  goal: string;
}): Promise<void> {
  await input.phase('verify-web-navigation'); await input.navigate();
  await input.phase('verify-web-heading'); await input.heading();
  await input.phase('verify-cli-task'); const current = await input.readTask();
  await input.phase('verify-task-comparison');
  if (current.id !== input.child || current.parentId !== input.goal) throw new Error('Cross-client Task readback mismatch.');
  await input.phase('verify-cli-attachment'); const attachment = await input.readAttachment();
  await input.phase('verify-attachment-comparison');
  if (attachment !== 'paired122') throw new Error('Cross-client attachment mismatch.');
  await input.phase('verify-web-leave'); await input.leave();
}

export function recoveryFailureDetail(error: unknown, phase: string, navigation?: { status?: number; taskStatus?: number; route: 'expected' | 'login' | 'other' | 'unknown'; cache?: CacheProbe | null }): string | undefined {
  const message = error instanceof Error ? error.message : '';
  const apiStatus = message.match(/^Fixture API creation failed \((\d{3})\)\.$/)?.[1];
  if (apiStatus) return `api-status-${apiStatus}`;
  const cli = message.match(/^CLI (project|task|login) (create|show|delete|attachment|--no-browser) failed \(exit=(\d+|null)\)\.$/);
  if (cli) return `cli-${cli[1]}-${cli[2]!.replaceAll('-', '')}-exit-${cli[3]}`;
  if (phase === 'verify-task-comparison' && message === 'Cross-client Task readback mismatch.') return 'task-mismatch';
  if (phase === 'verify-attachment-comparison' && message === 'Cross-client attachment mismatch.') return 'attachment-mismatch';
  if (phase === 'verify-web-navigation' || phase === 'verify-web-leave') {
    const code = message.match(/\bnet::(ERR_[A-Z_]+)\b/)?.[1];
    if (code && ['ERR_ABORTED', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_FAILED', 'ERR_TIMED_OUT'].includes(code)) return `net-${code.toLowerCase().replaceAll('_', '-')}`;
  }
  if (phase === 'verify-web-heading' && navigation) {
    const status = navigation.status;
    const task = navigation.taskStatus;
    const statusValue = status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : 'none';
    const taskValue = task !== undefined && Number.isInteger(task) && task >= 100 && task <= 599 ? String(task) : 'none';
    const cache = navigation.cache;
    const cacheDetail = cache && Number.isSafeInteger(cache.version) && cache.version > 13 && ['version-error', 'opened', 'aborted', 'other-error', 'timeout'].includes(cache.result)
      ? `-cache-${cache.version}-open-${cache.result}` : '';
    return `web-status-${statusValue}-route-${navigation.route}-task-${taskValue}${cacheDetail}`;
  }
  return undefined;
}
