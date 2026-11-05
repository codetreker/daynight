import { DEFAULT_SESSION_DISPLAY_MODE, type SessionDisplayMode } from './display-mode';

/** Identity from an authenticated account and its verified Session snapshot. */
export type SessionDisplayBinding = { readonly userId: string; readonly sessionId: string } | null;
export type SessionDisplayPreferenceIssue = { readonly kind: 'read' | 'invalid' | 'write' };
export type SessionDisplayPreferenceSnapshot = {
  readonly mode: SessionDisplayMode;
  readonly issue: SessionDisplayPreferenceIssue | null;
};
export type SessionDisplayPreferenceStorage = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;
export type SessionDisplayPreference = {
  readonly getSnapshot: () => SessionDisplayPreferenceSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setMode: (mode: SessionDisplayMode) => void;
  readonly retrySave: () => void;
};
export type SessionDisplayPreferenceStore = {
  readonly get: (binding: SessionDisplayBinding) => SessionDisplayPreference;
  readonly remove: (binding: SessionDisplayBinding) => void;
};

const defaultSnapshot: SessionDisplayPreferenceSnapshot = Object.freeze({ mode: DEFAULT_SESSION_DISPLAY_MODE, issue: null });
const issues = {
  read: Object.freeze({ kind: 'read' as const }),
  invalid: Object.freeze({ kind: 'invalid' as const }),
  write: Object.freeze({ kind: 'write' as const }),
};
const inactivePreference: SessionDisplayPreference = {
  getSnapshot: () => defaultSnapshot,
  subscribe: () => () => {},
  setMode: () => {},
  retrySave: () => {},
};

function readPreference(key: string, getStorage: () => SessionDisplayPreferenceStorage): SessionDisplayPreferenceSnapshot {
  let saved: string | null;
  try { saved = getStorage().getItem(key); }
  catch { return Object.freeze({ mode: DEFAULT_SESSION_DISPLAY_MODE, issue: issues.read }); }
  if (saved === null) return Object.freeze({ ...defaultSnapshot });
  try {
    const mode: unknown = JSON.parse(saved);
    if (mode === 'standard' || mode === 'conversation') return Object.freeze({ mode, issue: null });
  } catch { /* Invalid JSON and unrecognized enums share one recoverable issue. */ }
  return Object.freeze({ mode: DEFAULT_SESSION_DISPLAY_MODE, issue: issues.invalid });
}

type OwnedPreference = SessionDisplayPreference & { invalidate(): void };
function createPreference(key: string, getStorage: () => SessionDisplayPreferenceStorage, initial?: SessionDisplayPreferenceSnapshot): OwnedPreference {
  let snapshot = initial ?? readPreference(key, getStorage);
  let invalidated = false;
  const listeners = new Set<() => void>();
  const save = (mode: SessionDisplayMode) => {
    if (invalidated) return;
    const previous = snapshot;
    // Storage failure must never roll back the reader's current in-memory choice.
    snapshot = Object.freeze({ mode, issue: previous.issue });
    let issue: SessionDisplayPreferenceIssue | null = null;
    try { getStorage().setItem(key, JSON.stringify(mode)); }
    catch { issue = issues.write; }
    if (previous.mode === mode && previous.issue === issue) { snapshot = previous; return; }
    snapshot = Object.freeze({ mode, issue });
    for (const listener of listeners) listener();
  };
  return {
    invalidate: () => { invalidated = true; snapshot = defaultSnapshot; for (const listener of listeners) listener(); },
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setMode: mode => { if (mode !== snapshot.mode) save(mode); },
    retrySave: () => { if (snapshot.issue !== null) save(snapshot.mode); },
  };
}

/**
 * Owns page-local preferences independently of Session clients and operation state.
 * Entries retain only mode/issue kind after unsubscribe, including unsaved choices.
 * Null never accesses storage. No cross-tab listener or implicit default write is installed.
 */
export function createSessionDisplayPreferenceStore(
  getStorage: () => SessionDisplayPreferenceStorage = () => window.localStorage,
): SessionDisplayPreferenceStore {
  const preferences = new Map<string, OwnedPreference>();
  const removed = new Set<string>();
  return {
    remove: binding => {
      if (binding === null) return;
      const key = `daynight.web.session.display.v1:${JSON.stringify([binding.userId, binding.sessionId])}`;
      preferences.get(key)?.invalidate(); preferences.delete(key); removed.add(key);
      try { getStorage().removeItem?.(key); } catch { /* The invalidated in-memory entry cannot revive a saved preference. */ }
    },
    get: binding => {
      if (binding === null) return inactivePreference;
      const key = `daynight.web.session.display.v1:${JSON.stringify([binding.userId, binding.sessionId])}`;
      let preference = preferences.get(key);
      if (preference === undefined) {
        preference = createPreference(key, getStorage, removed.has(key) ? defaultSnapshot : undefined);
        preferences.set(key, preference);
      }
      return preference;
    },
  };
}
