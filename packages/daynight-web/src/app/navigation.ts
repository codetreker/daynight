export type BrowserLocation = { readonly pathname: string; readonly search: string; readonly hash: string };
export type WorkerConfigurationDraftScope = { readonly kind: 'worker-configuration'; readonly identity: object; readonly workerId: string };
export type DraftScope = { readonly kind?: 'task'; readonly identity: object; readonly projectId: string; readonly taskId: string } | WorkerConfigurationDraftScope;
export type DirtyDraft = {
  readonly scope: DraftScope;
  readonly isDirty: () => boolean;
  readonly discard: () => void;
  readonly survives: (destination: URL) => boolean;
  readonly signal?: AbortSignal;
};
type Entry = { readonly url: URL; readonly index: number | null };
type Decision = { readonly kind: 'action'; readonly run: () => void; readonly drafts: readonly DirtyDraft[] }
  | { readonly kind: 'history'; readonly drafts: readonly DirtyDraft[] };
const namespace = '__daynightNavigation';
const sameScope = (a: DraftScope, b: DraftScope) => a.identity === b.identity && (a.kind === 'worker-configuration'
  ? b.kind === 'worker-configuration' && a.workerId === b.workerId
  : b.kind !== 'worker-configuration' && a.projectId === b.projectId && a.taskId === b.taskId);

/** Owns admitted locations for one window. Raw popstate must never mount routes directly. */
export class BrowserNavigation {
  private session = crypto.randomUUID();
  private accepted: Entry;
  private observed: Entry;
  private location: BrowserLocation;
  private pending: Decision | null = null;
  private restoring = false;
  private readonly drafts = new Set<DirtyDraft>();
  private readonly admitting = new Set<DirtyDraft>();
  private readonly listeners = new Set<() => void>();
  private readonly decisions = new Set<() => void>();
  constructor(private readonly browser: Window) {
    const url = new URL(browser.location.href);
    this.writeState('replaceState', url, 0);
    this.accepted = this.observed = { url, index: 0 };
    this.location = this.toLocation(url);
    browser.addEventListener('popstate', this.traversed);
    browser.addEventListener('hashchange', this.traversed);
    browser.addEventListener('beforeunload', this.beforeUnload);
  }
  snapshot = (): BrowserLocation => this.location;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  decision = (): Decision | null => this.pending;
  subscribeDecision = (listener: () => void): (() => void) => { this.decisions.add(listener); return () => { this.decisions.delete(listener); }; };
  private notifyDecision(): void { for (const listener of this.decisions) listener(); }
  private toLocation(url: URL): BrowserLocation { return { pathname: url.pathname, search: url.search, hash: url.hash }; }
  private readEntry(): Entry {
    const url = new URL(this.browser.location.href);
    const marker: unknown = this.browser.history.state?.[namespace];
    const valid = typeof marker === 'object' && marker !== null && 'session' in marker && marker.session === this.session &&
      'index' in marker && Number.isSafeInteger(marker.index) && 'href' in marker && marker.href === url.href;
    return { url, index: valid ? (marker as { index: number }).index : null };
  }
  private writeState(method: 'pushState' | 'replaceState', url: URL, index: number): void {
    const state: unknown = this.browser.history.state;
    this.browser.history[method]({ ...(typeof state === 'object' && state !== null ? state : {}),
      [namespace]: { session: this.session, index, href: url.href } }, '', url.href);
  }
  private adopt(entry: Entry): void {
    this.accepted = entry;
    if (this.location.pathname === entry.url.pathname && this.location.search === entry.url.search && this.location.hash === entry.url.hash) return;
    this.location = this.toLocation(entry.url);
    for (const listener of this.listeners) listener();
  }
  private blockers(destination?: URL): DirtyDraft[] {
    return [...this.drafts].filter((draft) => !this.admitting.has(draft) && draft.isDirty() && (destination === undefined || !draft.survives(destination)));
  }
  /** Remove a captured fragment from both history and the admitted navigation snapshot. */
  clearCapturedFragment(): void {
    const current = this.readEntry();
    const url = new URL(current.url);
    url.hash = '';
    if (current.index === null) this.session = crypto.randomUUID();
    this.writeState('replaceState', url, current.index ?? 0);
    const clean = this.readEntry();
    this.accepted = this.observed = clean;
    // Capture can run while React initializes a child; do not notify subscribers during render.
    this.location = this.toLocation(clean.url);
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
    this.observed = this.readEntry();
    this.adopt(this.observed);
  }
  navigate(to: string, replace = false): void {
    const url = new URL(to, this.browser.location.href);
    if (url.origin !== this.browser.location.origin) throw new DOMException('Application navigation requires the same origin.', 'SecurityError');
    this.request(() => {
      const current = this.readEntry();
      // Only application writes allocate an index. Unindexed traversal itself is never repaired.
      if (current.index === null) this.session = crypto.randomUUID();
      const index = current.index === null ? 0 : replace ? current.index : current.index + 1;
      this.writeState(replace ? 'replaceState' : 'pushState', url, index);
      this.observed = this.readEntry();
      this.adopt(this.observed);
    }, this.blockers(url));
  }
  /** Local detail close/relation changes use the same gate before changing keyed content. */
  requestAction = (action: () => void): void => this.request(action, this.blockers());
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
  cancel = (): void => {
    if (this.pending === null) return;
    const history = this.pending.kind === 'history';
    this.pending = null;
    this.notifyDecision();
    if (history) {
      this.restoring = true;
      this.restore();
    }
  };
  private restore(): void {
    const from = this.accepted.index;
    const current = this.observed.index;
    if (from === null || current === null) {
      this.restoring = false;
      this.adopt(this.observed);
    } else if (from === current) this.restoring = false;
    else this.browser.history.go(from - current);
  }
  private traversed = (): void => {
    const entry = this.readEntry();
    if (entry.url.href === this.observed.url.href && entry.index === this.observed.index) return;
    this.observed = entry;
    if (this.restoring) { this.restore(); return; }
    // Native fragments and foreign/unindexed entries retain their native, unguarded behavior.
    if (entry.index === null || this.accepted.index === null) {
      this.pending = null;
      this.notifyDecision();
      this.adopt(entry);
      return;
    }
    const drafts = this.blockers(entry.url);
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
    this.drafts.clear(); this.listeners.clear(); this.decisions.clear();
    if (owner === this) owner = undefined;
  }
}

let owner: BrowserNavigation | undefined;
export const browserNavigation = (): BrowserNavigation => owner ??= new BrowserNavigation(window);
