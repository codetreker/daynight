import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TimelineEntry } from '../../api/types';

export type InvalidImageBindings = (entryId: string, revision: string) => void;

/** A malformed entry can request one owner refresh; presentation remounts cannot retry it. */
export function useInvalidImageBindings(owner: object | null, identity: string | null, entries: readonly TimelineEntry[], admitted: boolean, refresh: () => void): InvalidImageBindings {
  const queue = useMemo(() => ({ pending: new Set<string>(), attempted: new Set<string>() }), [owner, identity]);
  const [revision, notify] = useState(0);
  const invalid = useCallback<InvalidImageBindings>((entryId, entryRevision) => {
    if (!owner || !identity) return;
    const key = JSON.stringify([entryId, entryRevision]);
    if (queue.attempted.has(key) || queue.pending.has(key)) return;
    queue.pending.add(key); notify(value => value + 1);
  }, [owner, identity, queue]);
  useEffect(() => {
    if (!admitted || queue.pending.size === 0) return;
    const current = new Set(entries.map(entry => JSON.stringify([entry.entryId, entry.revision])));
    let needed = false;
    for (const key of queue.pending) {
      queue.pending.delete(key);
      if (!current.has(key)) continue;
      queue.attempted.add(key); needed = true;
    }
    // Record attempts before refreshing because the owner may synchronously publish.
    if (needed) refresh();
  }, [queue, revision, admitted, entries, refresh]);
  return invalid;
}
