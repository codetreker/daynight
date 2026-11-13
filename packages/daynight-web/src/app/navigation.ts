import { readMyTasksHistory, type PageHistoryState } from './page-history';

export type BrowserLocation = { readonly pathname: string; readonly search: string; readonly hash: string; readonly entryId: string | null; readonly view: unknown };
export type WorkerConfigurationDraftScope = { readonly kind: 'worker-configuration'; readonly identity: object; readonly workerId: string };
export type PromptDraftScope = { readonly kind: 'user-prompt'; readonly identity: object } | { readonly kind: 'project-prompt'; readonly identity: object; readonly projectId: string };
export type DraftScope = { readonly kind?: 'task'; readonly identity: object; readonly projectId: string; readonly taskId: string } | WorkerConfigurationDraftScope | PromptDraftScope;
export type DirtyDraft = {
  readonly scope: DraftScope;
  readonly isDirty: () => boolean;
  readonly discard: () => void;
  readonly survives: (destination: URL, view?: unknown, entryId?: string) => boolean;
  readonly signal?: AbortSignal;
};
type Entry = { readonly url: URL; readonly index: number | null; readonly entryId: string | null; readonly view: unknown };
type Decision = { readonly kind: 'action'; readonly run: () => void; readonly drafts: readonly DirtyDraft[] }
  | { readonly kind: 'history'; readonly drafts: readonly DirtyDraft[] };
const namespace = '__daynightNavigation';
// Only the overview has a reloadable reading selection. Its resource identifiers
// remain subject to the current identity and project access checks on admission.
const overviewView = (url: URL, view: unknown): boolean => {
  if (url.pathname !== '/my-tasks' || typeof view !== 'object' || view === null || !('userId' in view) || typeof view.userId !== 'string') return false;
  try { return readMyTasksHistory(view, view.userId) !== null; } catch { return false; }
};
const restoredOverviewView = (url: URL, marker: unknown): unknown => {
  if (typeof marker !== 'object' || marker === null || !('resumeUrl' in marker) || marker.resumeUrl !== url.href ||
      !('session' in marker) || typeof marker.session !== 'string' || !('entryId' in marker) || typeof marker.entryId !== 'string' ||
      !('index' in marker) || typeof marker.index !== 'number' || !Number.isSafeInteger(marker.index) ||
      !('view' in marker) || !overviewView(url, marker.view)) return undefined;
  return marker.view;
};
// Page choices are structured-clone values. Compare their contents, not object
// identity, since a history traversal may deserialize a fresh copy.
const sameValue = (left: unknown, right: unknown, seen = new WeakMap<object, object>()): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (seen.has(left)) return seen.get(left) === right;
  seen.set(left, right);
  const keys = Object.keys(left), other = Object.keys(right);
  return keys.length === other.length && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) &&
    sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], seen));
};
const sameScope = (a: DraftScope, b: DraftScope): boolean => {
  if (a.identity !== b.identity) return false;
  if (a.kind === 'worker-configuration') return b.kind === 'worker-configuration' && a.workerId === b.workerId;
  if (a.kind === 'user-prompt') return b.kind === 'user-prompt';
  if (a.kind === 'project-prompt') return b.kind === 'project-prompt' && a.projectId === b.projectId;
  return (b.kind === undefined || b.kind === 'task') && a.projectId === b.projectId && a.taskId === b.taskId;
};

/** Owns admitted locations for one window. Raw popstate must never mount routes directly. */
export class BrowserNavigation {
  private session = crypto.randomUUID();
  // Browser history state is serialized; exact URL checks stay in this window's memory.
  private readonly urls = new Map<number, { readonly url: string; readonly entryId: string }>();
  private accepted: Entry;
  private observed: Entry;
  private location: BrowserLocation;
  private pending: Decision | null = null;
  private restoring = false;
  private afterRestore: { readonly drafts: readonly DirtyDraft[]; readonly run: () => void } | null = null;
  private readonly drafts = new Set<DirtyDraft>();
  private readonly admitting = new Set<DirtyDraft>();
  private readonly listeners = new Set<() => void>();
  private readonly decisions = new Set<() => void>();
  constructor(private readonly browser: Window) {
    const url = new URL(browser.location.href);
    const restored = restoredOverviewView(url, browser.history.state?.[namespace]);
    this.writeState('replaceState', url, 0, crypto.randomUUID(), restored);
    this.accepted = this.observed = this.readEntry();
    this.location = this.toLocation(this.accepted);
    browser.addEventListener('popstate', this.traversed);
    browser.addEventListener('hashchange', this.traversed);
    browser.addEventListener('beforeunload', this.beforeUnload);
  }
  snapshot = (): BrowserLocation => this.location;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  decision = (): Decision | null => this.pending;
  subscribeDecision = (listener: () => void): (() => void) => { this.decisions.add(listener); return () => { this.decisions.delete(listener); }; };
  private notifyDecision(): void { for (const listener of this.decisions) listener(); }
  private toLocation(entry: Entry): BrowserLocation { return { pathname: entry.url.pathname, search: entry.url.search, hash: entry.url.hash, entryId: entry.entryId, view: entry.view }; }
  private readEntry(): Entry {
    const url = new URL(this.browser.location.href);
    const marker: unknown = this.browser.history.state?.[namespace];
    const valid = typeof marker === 'object' && marker !== null && 'session' in marker && marker.session === this.session &&
      'index' in marker && typeof marker.index === 'number' && Number.isSafeInteger(marker.index) &&
      'entryId' in marker && typeof marker.entryId === 'string' &&
      this.urls.get(marker.index)?.url === url.href && this.urls.get(marker.index)?.entryId === marker.entryId;
    return valid ? { url, index: (marker as { index: number }).index, entryId: (marker as { entryId: string }).entryId,
      view: 'view' in marker ? marker.view : undefined } : { url, index: null, entryId: null, view: undefined };
  }
  private writeState(method: 'pushState' | 'replaceState', url: URL, index: number, entryId: string, view?: unknown): void {
    const state: unknown = this.browser.history.state;
    this.browser.history[method]({ ...(typeof state === 'object' && state !== null ? state : {}),
      [namespace]: { session: this.session, index, entryId, ...(view === undefined ? {} : { view }), ...(overviewView(url, view) ? { resumeUrl: url.href } : {}) } }, '', url.href);
    this.urls.set(index, { url: url.href, entryId });
  }
  /** Scrub a consumed fragment without treating cleanup as a new route or numbering native entries. */
  clearFragment(): void {
    const current = this.readEntry();
    if (current.url.hash === '') return;
    const url = new URL(current.url);
    url.hash = '';
    if (current.index !== null) this.writeState('replaceState', url, current.index, current.entryId!, current.view);
    else {
      let state: unknown = this.browser.history.state;
      if (typeof state === 'object' && state !== null) {
        const preserved: Record<string, unknown> = { ...state };
        delete preserved[namespace];
        state = preserved;
      }
      this.browser.history.replaceState(state, '', url.href);
    }
    this.observed = this.readEntry();
    this.adopt(this.observed);
  }
  private adopt(entry: Entry): void {
    this.accepted = entry;
    if (this.location.pathname === entry.url.pathname && this.location.search === entry.url.search && this.location.hash === entry.url.hash &&
      this.location.entryId === entry.entryId && sameValue(this.location.view, entry.view)) return;
    this.location = this.toLocation(entry);
    for (const listener of this.listeners) listener();
  }
  private blockers(destination?: URL, view?: unknown, entryId?: string): DirtyDraft[] {
    return [...this.drafts].filter((draft) => !this.admitting.has(draft) && draft.isDirty() && (destination === undefined ||
      !(entryId === undefined ? draft.survives(destination, view) : draft.survives(destination, view, entryId))));
  }
  /** Register live readers; unregistering releases ownership and never decides to discard. */
  register(draft: DirtyDraft): () => void {
    if (draft.signal?.aborted) { draft.discard(); return () => {}; }
    this.drafts.add(draft);
    const retired = () => this.retireScope(draft.scope);
    draft.signal?.addEventListener('abort', retired, { once: true });
    return () => {
      draft.signal?.removeEventListener('abort', retired);
      this.drafts.delete(draft);
      if (this.afterRestore?.drafts.includes(draft)) this.afterRestore = null;
      if (this.pending?.drafts.includes(draft)) {
        // An expired request grants no authority to adopt, discard or traverse during cleanup.
        this.pending = null;
        this.notifyDecision();
      }
    };
  }
  /** Revocation clears private drafts immediately and cannot be cancelled by a leave choice. */
  retireScope(scope: DraftScope): void {
    const retired = [...this.drafts].filter((draft) => sameScope(draft.scope, scope));
    if (retired.length === 0) return;
    for (const draft of retired) this.drafts.delete(draft);
    if (this.pending?.drafts.some((draft) => sameScope(draft.scope, scope))) {
      this.pending = null;
      this.notifyDecision();
    }
    for (const draft of retired) draft.discard();
    // A history destination has already arrived; revocation never keeps private content mounted.
    this.restoring = false;
    this.afterRestore = null;
    this.observed = this.readEntry();
    this.adopt(this.observed);
  }
  navigate(to: string, replace = false, view?: PageHistoryState): void {
    const url = new URL(to, this.browser.location.href);
    if (url.origin !== this.browser.location.origin) throw new DOMException('Application navigation requires the same origin.', 'SecurityError');
    if (url.href === this.accepted.url.href) return;
    this.request(() => {
      const current = this.readEntry();
      // Only application writes allocate an index. Unindexed traversal itself is never repaired.
      if (current.index === null) { this.session = crypto.randomUUID(); this.urls.clear(); }
      const index = current.index === null ? 0 : replace ? current.index : current.index + 1;
      this.writeState(replace ? 'replaceState' : 'pushState', url, index, replace && current.entryId !== null ? current.entryId : crypto.randomUUID(), view);
      this.observed = this.readEntry();
      this.adopt(this.observed);
    }, this.blockers(url, view));
  }
  /** Commit a reading choice only after the same admission used by route changes. */
  setView(view: PageHistoryState, options: { readonly replace?: boolean; readonly onCommit?: () => void } = {}): void {
    if (sameValue(this.accepted.view, view)) return;
    const url = new URL(this.accepted.url);
    this.request(() => {
      const current = this.readEntry();
      if (current.index === null) { this.session = crypto.randomUUID(); this.urls.clear(); }
      const index = current.index === null ? 0 : options.replace ? current.index : current.index + 1;
      this.writeState(options.replace ? 'replaceState' : 'pushState', url, index,
        options.replace && current.entryId !== null ? current.entryId : crypto.randomUUID(), view);
      this.observed = this.readEntry();
      this.adopt(this.observed);
      options.onCommit?.();
    }, this.blockers(url, view));
  }
  /** Local detail close/relation changes use the same gate before changing keyed content. */
  requestAction = (action: () => void): void => this.request(action, this.blockers());
  requestScopeAction = (scope: DraftScope, action: () => void): void => this.request(action, this.blockers().filter((draft) => sameScope(draft.scope, scope)));
  private request(run: () => void, drafts: readonly DirtyDraft[]): void {
    if (this.pending !== null || this.restoring) return;
    if (drafts.length === 0) { run(); return; }
    this.pending = { kind: 'action', run, drafts };
    this.notifyDecision();
  }
  confirm = (): void => {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    for (const draft of pending.drafts) {
      draft.discard();
    }
    this.notifyDecision();
    if (pending.kind === 'action') {
      // Discard can schedule React state; its render need not precede a nested route call.
      for (const draft of pending.drafts) this.admitting.add(draft);
      try { pending.run(); }
      finally { this.admitting.clear(); }
    }
    else this.adopt(this.observed);
  };
  cancel = (): void => this.cancelAndRestore();
  cancelAndRestore = (onRestored?: () => void): void => {
    const pending = this.pending;
    if (pending === null) return;
    const history = pending.kind === 'history';
    this.pending = null;
    this.notifyDecision();
    if (history) {
      this.afterRestore = onRestored === undefined ? null : { drafts: pending.drafts, run: onRestored };
      this.restoring = true;
      this.restore();
    } else onRestored?.();
  };
  private finishRestore(): void {
    this.restoring = false;
    const callback = this.afterRestore;
    this.afterRestore = null;
    callback?.run();
  }
  private restore(): void {
    const from = this.accepted.index;
    const current = this.observed.index;
    if (from === null || current === null) {
      this.adopt(this.observed);
      this.finishRestore();
    } else if (from === current) this.finishRestore();
    else this.browser.history.go(from - current);
  }
  private traversed = (): void => {
    const entry = this.readEntry();
    if (entry.url.href === this.observed.url.href && entry.index === this.observed.index && entry.entryId === this.observed.entryId && sameValue(entry.view, this.observed.view)) return;
    this.observed = entry;
    if (this.restoring) { this.restore(); return; }
    // Native fragments and foreign/unindexed entries retain their native, unguarded behavior.
    if (entry.index === null || this.accepted.index === null) {
      this.pending = null;
      this.notifyDecision();
      this.adopt(entry);
      return;
    }
    const drafts = this.blockers(entry.url, entry.view, entry.entryId ?? undefined);
    if (drafts.length === 0) {
      this.pending = null;
      this.notifyDecision();
      this.adopt(entry);
    } else {
      this.pending = { kind: 'history', drafts };
      this.notifyDecision();
    }
  };
  private beforeUnload = (event: BeforeUnloadEvent): void => {
    if (this.blockers().length === 0) return;
    event.preventDefault();
    event.returnValue = '';
  };
  dispose(): void {
    this.browser.removeEventListener('popstate', this.traversed);
    this.browser.removeEventListener('hashchange', this.traversed);
    this.browser.removeEventListener('beforeunload', this.beforeUnload);
    this.afterRestore = null;
    this.urls.clear(); this.drafts.clear(); this.listeners.clear(); this.decisions.clear();
    if (owner === this) owner = undefined;
  }
}

let owner: BrowserNavigation | undefined;
export const browserNavigation = (): BrowserNavigation => owner ??= new BrowserNavigation(window);
