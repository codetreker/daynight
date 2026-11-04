import { sameStartupReport, type SessionStartupReport } from '../../../../daynight/src/session/startup';
import { liveHistoryAllowed } from './presentation';
import type { SessionArchive, SessionArchiveStatus } from '../../../../daynight/src/session/archive';
import { ApiError, isAbortError } from '../../api/client';
import type { BotSessionBinding, SessionApi, SessionChannel } from '../../api/sessions';
import { SESSION_PROTOCOL, assertSessionFence, sessionFence, sessionFenceKey, parseSessionOperation, type InteractionResponse, type SessionCommand, type SessionInteraction, type SessionOperation, type SessionSnapshot } from '../../../../daynight/src/session/protocol';
import type { BrowserMessage, TimelinePage } from '../../../../daynight/src/session/controller-protocol';
import { applySessionEvent, emptySessionState, hydrateSession, mergeTimeline, hasPendingResponse, sessionCancelGate, sessionRespondGate, sessionSendGate, sessionControlGate, type SessionState } from './state';

export type SessionDraft = { readonly text: string; readonly revision: string; readonly submission: { readonly operationId: string; readonly revision: string; readonly kind?: 'send_message' | 'execute_command' } | null };
const emptyDraft = (): SessionDraft => ({ text: '', revision: crypto.randomUUID(), submission: null });
const draftPrefix = (userId: string) => `daynight:session-draft:${userId}:`;
export function clearSessionDrafts(userId: string): void {
  try { const storage = window.sessionStorage; for (let i = storage.length - 1; i >= 0; i--) { const key = storage.key(i); if (key?.startsWith(draftPrefix(userId))) storage.removeItem(key); } } catch { /* Unavailable browser storage cannot retain new drafts. */ }
}

export type SessionSettingIntent = { readonly operationId: string; readonly settingId: string; readonly value: string; readonly confirmedValue: string | null };
type CommandInput = { [K in SessionCommand['kind']]: Pick<Extract<SessionCommand, { kind: K }>, 'kind' | 'payload'> }[SessionCommand['kind']];
export type SessionViewState = {
  readonly startupReport: SessionStartupReport | null;
  readonly environmentConnected: boolean;
  readonly errorCode: string | null;
  readonly archiveState: SessionArchiveStatus['state'] | 'loading' | null;
  readonly settingIntents: ReadonlyMap<string, SessionSettingIntent>;
  readonly draft: SessionDraft;
  readonly state: SessionState; readonly status: 'loading' | 'ready' | 'not_registered' | 'unavailable' | 'error';
  readonly connected: boolean; readonly authPaused: boolean; readonly error: string | null; readonly hasOlder: boolean; readonly loadingOlder: boolean;
  readonly historyError: string | null; readonly checking: ReadonlySet<string>;
  readonly historyReady: boolean; readonly historyRevision: number; readonly connectionGeneration: number;
};
type Options = { readonly api: SessionApi; readonly userId: string; readonly isCurrent: () => boolean; readonly isPaused?: () => boolean; readonly onPrincipalMismatch: () => void; readonly onInvalidate?: () => void; readonly storage: Storage | null } & (
  { readonly projectId: string; readonly taskId: string; readonly claimId: string; readonly testSessionId?: never; readonly bot?: never } |
  { readonly testSessionId: string; readonly bot?: BotSessionBinding; readonly projectId?: never; readonly taskId?: never; readonly claimId?: never }
);
const errorCode = (error: unknown): string => error instanceof ApiError ? error.code : 'unknown';
const sameExecution = (left: SessionSnapshot, right: SessionSnapshot): boolean => sessionFenceKey(left) === sessionFenceKey(right) && left.identity.controllerInstanceId === right.identity.controllerInstanceId;
const historyIdentity = (s: SessionSnapshot): string => `${sessionFenceKey(s)}:${s.historyEpoch}:${s.connectionEpoch}:${s.sessionRevision}`;
const reportMatches = (report: SessionStartupReport, s: SessionSnapshot): boolean => report.sessionId === s.sessionId && report.claimId === s.claimId && report.executionGeneration === s.executionGeneration && report.controllerInstanceId === s.identity.controllerInstanceId;
const message = (error: unknown): string => error instanceof Error ? error.message : 'Session request failed.';
const terminalFailure = (operation: SessionOperation) => ['failed', 'rejected', 'expired'].includes(operation.state);
const accepted = (operation: SessionOperation) => operation.state === 'confirmed' || ['send_message', 'execute_command'].includes(operation.kind) && operation.state === 'provider_accepted';
const uncertain = (operation: SessionOperation) => !terminalFailure(operation) && !accepted(operation);
class HistoryCursorError extends Error {}

export class TaskSessionClient {
  private view: SessionViewState = { environmentConnected: false, startupReport: null, errorCode: null, archiveState: null, settingIntents: new Map(), draft: emptyDraft(), state: emptySessionState(), status: 'loading', connected: false, authPaused: false, error: null, hasOlder: false, loadingOlder: false, historyError: null, checking: new Set(), historyReady: false, historyRevision: 0, connectionGeneration: 0 };
  private archive: SessionArchive | null = null;
  private listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private invalidated = false;
  private connection: SessionChannel | null = null;
  private connectionGeneration = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private availabilityRunning = false;
  private observationTimer: ReturnType<typeof setTimeout> | null = null;
  private observationRequest: AbortController | null = null;
  private lastStartupReport: SessionStartupReport | null = null;
  private currentReadFailure: { message: string; code: string } | null = null;
  private historyFailureIdentity: string | null = null;
  private historyFailureError: { message: string; code: string } | null = null;
  private channelAuthenticated = false;
  private suspensionTimer: ReturnType<typeof setTimeout> | null = null;
  private suspendedMessages: BrowserMessage[] = [];
  private suspendedBytes = 0;
  private suspendedUntil = 0;
  private admissionWaiters = new Set<() => void>();
  private cursor: string | null = null;
  private before: string | null = null;
  private beforeCursors = new Set<string>();
  private olderRequest: AbortController | null = null;
  private hydrating = false;
  private historyRequest: AbortController | null = null;
  private buffer: Extract<BrowserMessage, { type: 'event' }>[] = [];
  private hydrated = false;
  private replaceHistory = false;
  private replayThrough = '0';
  private retries = 0;
  private draftKey: string | null = null;
  private operationPolls = new Set<ReturnType<typeof setTimeout>>();
  constructor(private readonly options: Options) {}
  snapshot = (): SessionViewState => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private owned = (): boolean => !this.lifetime.signal.aborted && this.options.isCurrent();
  private paused = (): boolean => this.options.isPaused?.() ?? false;
  private live = (): boolean => this.owned() && !this.paused();
  syncAvailability = (): void => {
    if (this.lifetime.signal.aborted) return;
    if (!this.owned()) { if (this.availabilityRunning || this.view.authPaused) this.pause(); return; }
    if (this.paused()) { this.suspend(); return; }
    if (this.view.authPaused) {
      if (Date.now() >= this.suspendedUntil) { this.disconnect(); this.publish({ connected: false }); }
      this.clearSuspensionTimer();
      this.publish({ authPaused: false });
      const queued = this.suspendedMessages; this.suspendedMessages = []; this.suspendedBytes = 0;
      const generation = this.connectionGeneration;
      for (const value of queued) this.receive(value, generation);
      for (const resume of [...this.admissionWaiters]) resume();
      this.reconcile();
    }
    if (!this.availabilityRunning) void this.start();
  };
  private clearSuspensionTimer() {
    if (this.suspensionTimer !== null) clearTimeout(this.suspensionTimer);
    this.suspensionTimer = null;
  }
  // Identity revalidation freezes publication and input, not the live transport.
  // Bounds force cursor replay without advancing past unconsumed messages.
  private suspend() {
    if (this.view.authPaused) return;
    this.publish({ authPaused: true });
    this.suspendedUntil = Date.now() + 60_000;
    this.suspensionTimer = setTimeout(() => {
      this.suspensionTimer = null;
      this.disconnect(); this.publish({ connected: false });
    }, 60_000);
  }
  private admitted(): boolean {
    if (this.view.authPaused && !this.paused()) this.syncAvailability();
    return this.live();
  }
  private async admit(signal: AbortSignal = this.lifetime.signal): Promise<boolean> {
    while (this.owned() && this.paused() && !signal.aborted) {
      this.suspend();
      await new Promise<void>(resolve => {
        const resume = () => { this.admissionWaiters.delete(resume); signal.removeEventListener('abort', resume); resolve(); };
        this.admissionWaiters.add(resume); signal.addEventListener('abort', resume, { once: true });
      });
    }
    return this.admitted() && !signal.aborted;
  }
  private publish(change: Partial<SessionViewState>) {
    if (this.lifetime.signal.aborted) return;
    const previous = this.view.state.snapshot, next = change.state?.snapshot;
    if (previous && change.state && (!next || sessionFenceKey(previous) !== sessionFenceKey(next) || previous.historyEpoch !== next.historyEpoch)) {
      this.cancelOlder(); this.cancelHydration(); this.before = null; this.beforeCursors.clear();
      change = { ...change, loadingOlder: false, historyError: null };
    } else if (previous && next && previous.connectionEpoch !== next.connectionEpoch) {
      this.cancelOlder(); this.cancelHydration(); change = { ...change, loadingOlder: false };
    }
    if (change.state) change = { ...change, environmentConnected: next !== null && next !== undefined && (next.connectionState === 'connected' || next.connectionState === 'synchronizing' || previous !== null && sameExecution(previous, next) && this.view.environmentConnected) };
    if (next && this.historyFailureIdentity !== null && this.historyFailureIdentity !== historyIdentity(next) && liveHistoryAllowed(next, this.view.startupReport)) {
      if (this.historyFailureError && this.view.error === this.historyFailureError.message && this.view.errorCode === this.historyFailureError.code) change = { ...change, error: null, status: 'ready' };
      this.historyFailureIdentity = null; this.historyFailureError = null;
    }
    if (change.error === null) change = { ...change, errorCode: null };
    if (this.currentReadFailure && change.error === null) change = { ...change, status: 'error', error: this.currentReadFailure.message, errorCode: this.currentReadFailure.code };
    if (change.state && (!next || this.lastStartupReport && !reportMatches(this.lastStartupReport, next))) {
      this.lastStartupReport = null; change = { ...change, startupReport: null };
    }
    this.view = { ...this.view, ...change };
    if (this.view.connected && (this.currentReadFailure || !this.view.state.snapshot || !this.historyAllowed(this.view.state.snapshot) || BigInt(this.view.state.lastEventSeq) < BigInt(this.replayThrough))) this.view = { ...this.view, connected: false };
    this.view = { ...this.view, connectionGeneration: this.connectionGeneration, historyReady: this.hydrated && !this.hydrating && this.view.connected && this.view.status === 'ready' && !this.view.state.recoveryRequired && this.view.state.snapshot !== null && this.historyAllowed(this.view.state.snapshot) };
    const snapshot = this.view.state.snapshot;
    if (snapshot) this.bindDraft(snapshot);
    const draft = this.view.draft, operation = draft.submission && this.view.state.operations.get(draft.submission.operationId);
    if (operation && ['send_message', 'execute_command'].includes(operation.kind) && (accepted(operation) || terminalFailure(operation))) {
      this.view = { ...this.view, draft: accepted(operation) && draft.revision === draft.submission!.revision ? emptyDraft() : { ...draft, submission: null } };
      this.persistDraft();
    }
    for (const listener of this.listeners) listener();
  }
  private draftScopePrefix(): string {
    return `${draftPrefix(this.options.userId)}${this.options.bot ? `bot:${this.options.bot.botId}:${this.options.bot.sessionId}` : this.options.testSessionId !== undefined ? `test:${this.options.testSessionId}` : `task:${this.options.projectId}:${this.options.taskId}`}:`;
  }
  private bindDraft(snapshot: SessionSnapshot) {
    const prefix = this.draftScopePrefix();
    const key = `${prefix}${sessionFenceKey(snapshot)}`;
    if (key === this.draftKey) return;
    this.draftKey = key;
    this.view = { ...this.view, settingIntents: new Map() };
    let draft = emptyDraft();
    try {
      const storage = this.options.storage;
      // An authenticated current snapshot selects the execution; obsolete generations
      // cannot be revived by navigating back to a previously mounted composer.
      if (storage) for (let i = storage.length - 1; i >= 0; i--) { const previous = storage.key(i); if (previous?.startsWith(prefix) && previous !== key) storage.removeItem(previous); }
      // Cold Bot panes retain only lightweight state for the authenticated fence.
      // A new generation must not accumulate or restore obsolete uncertain inputs.
      if (storage && this.options.bot) {
        const operationPrefix = `daynight:session-operations:${this.options.userId}:${snapshot.sessionId}:`;
        const currentOperationKey = this.storageKey(snapshot);
        for (let i = storage.length - 1; i >= 0; i--) { const previous = storage.key(i); if (previous?.startsWith(operationPrefix) && previous !== currentOperationKey) storage.removeItem(previous); }
      }
      const stored: unknown = JSON.parse(storage?.getItem(key) ?? 'null');
      if (stored && typeof stored === 'object' && 'text' in stored && typeof stored.text === 'string' && 'revision' in stored && typeof stored.revision === 'string' && 'submission' in stored) {
        const submission = stored.submission;
        if (submission === null || typeof submission === 'object' && 'operationId' in submission && typeof submission.operationId === 'string' && 'revision' in submission && typeof submission.revision === 'string') draft = { text: stored.text, revision: stored.revision, submission: submission === null ? null : { operationId: submission.operationId as string, revision: submission.revision as string, ...('kind' in submission && submission.kind === 'execute_command' ? { kind: 'execute_command' as const } : {}) } };
      }
    } catch { /* A missing or malformed saved draft never authorizes a send. */ }
    this.view = { ...this.view, draft };
  }
  private persistDraft() {
    if (!this.draftKey) return;
    try { if (this.view.draft.text || this.view.draft.submission) this.options.storage?.setItem(this.draftKey, JSON.stringify(this.view.draft)); else this.options.storage?.removeItem(this.draftKey); } catch { /* Keep editable text in memory if storage is unavailable. */ }
  }
  setDraft = (text: string): void => {
    if (this.lifetime.signal.aborted || !this.view.state.snapshot || this.view.draft.text === text) return;
    this.publish({ draft: { ...this.view.draft, text, revision: crypto.randomUUID() } }); this.persistDraft();
  };
  private matches(s: SessionSnapshot): boolean {
    if (s.identity.agentControlMode !== 'web') return false;
    if (this.options.testSessionId !== undefined) {
      const bot = this.options.bot;
      return s.sessionId === this.options.testSessionId && s.testExecutionId !== undefined && s.identity.ownerUserId === this.options.userId &&
        (!bot || bot.ownerUserId === this.options.userId && bot.sessionId === s.sessionId && bot.testExecutionId === s.testExecutionId);
    }
    return s.claimId !== undefined && s.claimId === this.options.claimId && s.identity.projectId === this.options.projectId && s.identity.taskId === this.options.taskId;
  }
  private sameSession(s: SessionSnapshot): boolean { return this.view.state.snapshot !== null && sessionFenceKey(this.view.state.snapshot) === sessionFenceKey(s); }
  private sameHistory(s: SessionSnapshot): boolean { return this.sameSession(s) && this.view.state.snapshot?.historyEpoch === s.historyEpoch && this.view.state.snapshot.connectionEpoch === s.connectionEpoch; }
  private cancelOlder(): void { this.olderRequest?.abort(); this.olderRequest = null; }
  private storageKey(s: SessionSnapshot) { return `daynight:session-operations:${this.options.userId}:${s.sessionId}:${s.claimId ?? `test:${s.testExecutionId}`}:${s.executionGeneration}`; }
  private persist() {
    const s = this.view.state.snapshot; if (!s) return;
    try { this.options.storage?.setItem(this.storageKey(s), JSON.stringify([...this.view.state.operations.values()].filter(uncertain).slice(-200).map(operation => ({ operation, interaction: this.view.state.responseTargets.get(operation.operationId), setting: [...this.view.settingIntents.values()].find(intent => intent.operationId === operation.operationId) })))); } catch { /* The in-memory receipt remains usable when browser storage is unavailable. */ }
  }
  private restore() {
    const s = this.view.state.snapshot; if (!s) return;
    try {
      const raw: unknown = JSON.parse(this.options.storage?.getItem(this.storageKey(s)) ?? '[]');
      if (!Array.isArray(raw) || raw.length > 200) return;
      const operations = new Map(this.view.state.operations), responseTargets = new Map(this.view.state.responseTargets), settingIntents = new Map(this.view.settingIntents);
      for (const value of raw) {
        const wrapped = value !== null && typeof value === 'object' && 'operation' in value;
        const operation = parseSessionOperation(wrapped ? value.operation : value);
        assertSessionFence(operation, sessionFence(s)); operations.set(operation.operationId, operation);
        const setting = wrapped && 'setting' in value ? value.setting : undefined;
        if (operation.kind === 'update_setting' && setting && typeof setting === 'object' && 'settingId' in setting && typeof setting.settingId === 'string' && setting.settingId.length <= 256 && 'value' in setting && typeof setting.value === 'string' && setting.value.length <= 4096 && 'confirmedValue' in setting && (setting.confirmedValue === null || typeof setting.confirmedValue === 'string')) settingIntents.set(setting.settingId, { operationId: operation.operationId, settingId: setting.settingId, value: setting.value, confirmedValue: setting.confirmedValue });
        const target = wrapped && 'interaction' in value ? value.interaction : undefined;
        if (operation.kind === 'interaction_response' && target !== null && typeof target === 'object' && 'interactionId' in target && 'revision' in target && typeof target.interactionId === 'string' && target.interactionId.length > 0 && target.interactionId.length <= 512 && typeof target.revision === 'string' && /^[1-9][0-9]{0,19}$/.test(target.revision)) responseTargets.set(operation.operationId, { interactionId: target.interactionId, revision: target.revision });
      }
      this.publish({ settingIntents, state: { ...this.view.state, operations, responseTargets } });
    } catch { /* Invalid receipts never authorize a native operation. */ }
  }
  private restoreDraftOperation() {
    const s = this.view.state.snapshot, submission = this.view.draft.submission;
    if (!s || !submission || this.view.state.operations.has(submission.operationId)) return;
    try {
      // Draft and receipt writes can fail independently. Retain the exact operation
      // as uncertain until its receipt is queried; a saved draft never replays input.
      const operation = parseSessionOperation({ protocol: SESSION_PROTOCOL, ...sessionFence(s), operationId: submission.operationId, kind: submission.kind ?? 'send_message', state: 'unknown', providerResult: null, error: null });
      this.putOperation(operation);
    } catch { /* Corrupt local metadata cannot create an operation. */ }
  }
  async start(): Promise<void> {
    if (!this.live()) return;
    this.disconnect();
    this.availabilityRunning = true;
    const generation = this.connectionGeneration;
    this.currentReadFailure = null;
    this.publish({ connected: false, error: null, loadingOlder: false });
    try {
      let current = await this.options.api.current(this.lifetime.signal);
      if (!(this.paused() ? await this.admit() : this.admitted()) || generation !== this.connectionGeneration) return;
      if (current.status !== 'registered') {
        this.publish({ startupReport: null, status: current.status === 'not_registered' && current.claimId === this.options.claimId ? 'not_registered' : 'unavailable' });
        if (this.view.status === 'not_registered') this.schedule(3000);
        return;
      }
      if (!this.matches(current.session)) { this.invalidate(); return; }
      const previous = this.view.state.snapshot;
      if (previous && previous.sessionId === current.session.sessionId && BigInt(current.session.executionGeneration) < BigInt(previous.executionGeneration)) throw new ApiError('protocol');
      if (previous && sameExecution(previous, current.session) && BigInt(previous.sessionRevision) > BigInt(current.session.sessionRevision)) current = { ...current, session: previous };
      if (previous && (sessionFenceKey(previous) !== sessionFenceKey(current.session) || previous.historyEpoch !== current.session.historyEpoch)) {
        this.cursor = null; this.hydrated = false; this.replaceHistory = true; this.replayThrough = '0';
        if (sessionFenceKey(previous) !== sessionFenceKey(current.session)) this.publish({ state: emptySessionState() });
        else this.publish({ connected: false, state: { ...this.view.state, recoveryRequired: true } });
      }
      this.publish({ state: { ...this.view.state, snapshot: current.session }, status: 'ready' });
      this.acceptStartupReport(current.session, current.startupReport);
      this.restoreHistoryFailure(current.session);
      if (current.session.lifecycle !== 'active') { await this.loadArchive(current.session, generation); return; }
      this.archive = null; this.publish({ archiveState: null });
      this.scheduleObservation(generation);
      this.connection = this.options.api.channel(current.session.sessionId, this.hydrated ? this.cursor : null, (value) => this.receive(value, generation), (error) => {
        if (generation !== this.connectionGeneration || !this.owned()) return;
        if (error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) { this.invalidate(error); return; }
        if (this.paused()) { this.suspend(); this.disconnect(); this.publish({ connected: false }); return; }
        this.channelAuthenticated = false;
        this.cancelOlder(); this.publish({ connected: false, loadingOlder: false, error: error ? message(error) : null, errorCode: error ? errorCode(error) : null });
        const snapshot = this.view.state.snapshot;
        if (snapshot && !this.hydrated && !this.hydrating && this.historyAllowed(snapshot)) { this.hydrating = true; void this.hydrate(snapshot, generation, false); }
        this.schedule();
      });
    } catch (error) {
      if (generation !== this.connectionGeneration || !this.owned() || isAbortError(error)) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) { this.invalidate(error); return; }
      if (!(this.paused() ? await this.admit() : this.admitted()) || generation !== this.connectionGeneration) return;
      this.publish({ startupReport: null, connected: false, status: 'error', error: message(error), errorCode: errorCode(error) }); this.schedule();
    }
  }
  private restoreHistoryFailure(snapshot: SessionSnapshot): void {
    if (this.historyFailureIdentity === historyIdentity(snapshot) && this.historyFailureError) this.publish({ status: 'error', error: this.historyFailureError.message, errorCode: this.historyFailureError.code });
  }
  private historyAllowed(snapshot: SessionSnapshot): boolean {
    return liveHistoryAllowed(snapshot, this.view.startupReport) && this.historyFailureIdentity !== historyIdentity(snapshot);
  }
  private acceptStartupReport(snapshot: SessionSnapshot, report: SessionStartupReport | null | undefined): void {
    if (report && !reportMatches(report, snapshot)) throw new ApiError('protocol');
    const previous = this.lastStartupReport;
    if (report && previous && reportMatches(previous, snapshot)) {
      if (BigInt(report.revision) < BigInt(previous.revision)) { this.publish({ startupReport: previous }); return; }
      if (report.revision === previous.revision && !sameStartupReport(previous, report)) throw new ApiError('protocol');
    }
    this.lastStartupReport = report ?? null;
    this.publish({ startupReport: report ?? null });
    if (!this.historyAllowed(snapshot)) { this.cancelOlder(); this.publish({ connected: false, loadingOlder: false }); }
  }
  private scheduleObservation(generation: number): void {
    if (this.observationTimer !== null) clearTimeout(this.observationTimer);
    if (this.options.testSessionId !== undefined || !this.owned() || this.view.state.snapshot?.lifecycle !== 'active') return;
    this.observationTimer = setTimeout(() => { this.observationTimer = null; void this.observeCurrent(generation); }, 3000);
  }
  private async observeCurrent(generation: number): Promise<void> {
    const snapshot = this.view.state.snapshot;
    if (!snapshot || generation !== this.connectionGeneration || !this.owned()) return;
    if (this.paused()) { this.scheduleObservation(generation); return; }
    const request = new AbortController(); this.observationRequest = request;
    const currentRequest = () => this.owned() && this.observationRequest === request && generation === this.connectionGeneration && this.view.state.snapshot !== null && sameExecution(snapshot, this.view.state.snapshot);
    try {
      const current = await this.options.api.current(AbortSignal.any([request.signal, this.lifetime.signal]));
      if (!currentRequest() || !(await this.admit(request.signal)) || !currentRequest()) return;
      if (current.status !== 'registered' || !this.matches(current.session)) { this.invalidate(); return; }
      const latest = this.view.state.snapshot!;
      if (sessionFenceKey(current.session) !== sessionFenceKey(latest) || current.session.historyEpoch !== latest.historyEpoch) {
        if (current.session.sessionId === latest.sessionId && BigInt(current.session.executionGeneration) < BigInt(latest.executionGeneration)) return;
        void this.start(); return;
      }
      const previousFailure = this.currentReadFailure; this.currentReadFailure = null;
      this.acceptStartupReport(latest, current.startupReport);
      if (BigInt(current.session.sessionRevision) > BigInt(latest.sessionRevision)) {
        if (BigInt(current.session.lastEventSeq) > BigInt(this.replayThrough)) this.replayThrough = current.session.lastEventSeq;
        this.publish({ state: { ...this.view.state, snapshot: current.session } });
      }
      if (previousFailure && this.view.error === previousFailure.message && this.view.errorCode === previousFailure.code) { this.publish({ error: null, status: 'ready' }); this.restoreHistoryFailure(this.view.state.snapshot!); }
      const selected = this.view.state.snapshot!;
      if (selected.lifecycle !== 'active') { this.beginArchive(selected); return; }
      if (!this.historyAllowed(selected)) { this.cancelOlder(); this.publish({ connected: false, loadingOlder: false }); }
      else if (this.channelAuthenticated && !this.hydrating && !this.hydrated) this.startHydration(selected, generation);
      else if (this.channelAuthenticated && this.hydrated && !this.hydrating && !this.view.state.recoveryRequired && BigInt(this.view.state.lastEventSeq) >= BigInt(this.replayThrough)) this.publish({ connected: true });
    } catch (error) {
      if (!currentRequest() || isAbortError(error)) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) { this.invalidate(error); return; }
      if (!(await this.admit(request.signal)) || !currentRequest()) return;
      this.currentReadFailure = { message: message(error), code: errorCode(error) };
      this.publish({ startupReport: null, connected: false, status: 'error', ...(this.view.error && this.view.errorCode !== 'controller_offline' ? {} : { error: message(error), errorCode: errorCode(error) }) });
    } finally {
      if (this.observationRequest === request) { this.observationRequest = null; if (generation === this.connectionGeneration) this.scheduleObservation(generation); }
    }
  }
  private startHydration(snapshot: SessionSnapshot, generation: number): void {
    if (this.hydrating || !this.historyAllowed(snapshot)) return;
    this.hydrating = true; this.buffer = []; void this.hydrate(snapshot, generation);
  }
  private schedule(delay = Math.min(1000 * 2 ** this.retries++, 15_000)) {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.availabilityRunning = false; void this.start(); }, delay);
  }
  private receive(value: BrowserMessage, generation: number) {
    if (generation !== this.connectionGeneration || this.lifetime.signal.aborted) return;
    if (!this.owned()) { this.pause(); return; }
    if (value.type === 'snapshot') {
      if (value.userId !== this.options.userId) { this.invalidate(); this.options.onPrincipalMismatch(); return; }
      if (!this.matches(value.snapshot)) { this.invalidate(); return; }
    }
    if (this.view.authPaused && !this.paused()) {
      this.syncAvailability();
      if (generation !== this.connectionGeneration || !this.owned()) return;
    }
    if (this.paused()) {
      this.suspend();
      if (Date.now() >= this.suspendedUntil) { this.disconnect(); this.publish({ connected: false }); return; }
      const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (this.suspendedMessages.length >= 1000 || this.suspendedBytes + bytes > 4 * 1024 * 1024) { this.disconnect(); this.publish({ connected: false }); }
      else { this.suspendedMessages.push(value); this.suspendedBytes += bytes; }
      return;
    }
    if (value.type === 'reset_required') { this.cancelOlder(); this.beforeCursors.clear(); this.cursor = null; this.hydrated = false; this.publish({ connected: false, loadingOlder: false, state: { ...this.view.state, recoveryRequired: true }, error: value.reason, errorCode: 'reset_required' }); this.schedule(0); return; }
    if (value.type === 'snapshot') {
      const previous = this.view.state.snapshot;
      if (previous && previous.sessionId === value.snapshot.sessionId && BigInt(value.snapshot.executionGeneration) < BigInt(previous.executionGeneration)) return;
      const s = previous && sameExecution(previous, value.snapshot) && BigInt(previous.sessionRevision) > BigInt(value.snapshot.sessionRevision) ? previous : value.snapshot;
      if (previous && (sessionFenceKey(previous) !== sessionFenceKey(s) || previous.historyEpoch !== s.historyEpoch)) {
        this.hydrated = false; this.cursor = null; this.replayThrough = '0';
        const sameExecution = sessionFenceKey(previous) === sessionFenceKey(s);
        this.replaceHistory = true;
        this.publish({ connected: false, state: sameExecution ? { ...this.view.state, recoveryRequired: true } : emptySessionState() });
      }
      this.publish({ state: { ...this.view.state, snapshot: s }, status: 'ready' });
      if (s.lifecycle !== 'active') { this.beginArchive(s); return; }
      this.channelAuthenticated = true;
      this.cursor = value.cursor; if (BigInt(s.lastEventSeq) > BigInt(this.replayThrough)) this.replayThrough = s.lastEventSeq;
      if (!this.historyAllowed(s)) { this.publish({ connected: false }); return; }
      if (!this.hydrated) this.startHydration(s, generation);
      else { this.publish({ connected: BigInt(this.view.state.lastEventSeq) >= BigInt(this.replayThrough), error: null }); this.retries = 0; this.reconcile(); }
      return;
    }
    const bound = this.view.state.snapshot;
    if (!bound || sessionFenceKey(value.event) !== sessionFenceKey(bound)) return;
    if (this.hydrating) { if (this.buffer.length >= 1000) { this.disconnect(); this.hydrated = false; this.cursor = null; this.schedule(); } else this.buffer.push(value); return; }
    if (!this.hydrated) {
      // Waiting snapshots are observations, not proof that missing timeline events
      // have been materialized. A later usable state starts a complete tail read.
      if (value.event.kind === 'snapshot' && BigInt(value.event.payload.sessionRevision) > BigInt(bound.sessionRevision)) {
        this.publish({ state: { ...this.view.state, snapshot: value.event.payload } });
        if (value.event.payload.lifecycle !== 'active') { this.beginArchive(value.event.payload); return; }
        this.startHydration(value.event.payload, generation);
      }
      return;
    }
    this.apply(value);
  }
  private apply(value: Extract<BrowserMessage, { type: 'event' }>) {
    const s = this.view.state.snapshot;
    if (!s || sessionFenceKey(value.event) !== sessionFenceKey(s)) return;
    const state = applySessionEvent(this.view.state, value.event);
    this.publish({ state });
    if (state.snapshot && state.snapshot.lifecycle !== 'active') { this.beginArchive(state.snapshot); return; }
    if (state.recoveryRequired) { this.cancelOlder(); this.beforeCursors.clear(); this.hydrated = false; this.cursor = null; this.publish({ connected: false, loadingOlder: false }); this.schedule(0); }
    else { this.cursor = value.cursor; if (!this.hydrating && BigInt(state.lastEventSeq) >= BigInt(this.replayThrough)) this.publish({ connected: this.historyAllowed(state.snapshot!) }); }
    if (value.event.kind === 'operation') this.persist();
  }
  private beginArchive(snapshot: SessionSnapshot) {
    this.disconnect(); this.availabilityRunning = true;
    void this.loadArchive(snapshot, this.connectionGeneration);
  }
  private async loadArchive(snapshot: SessionSnapshot, generation: number): Promise<void> {
    this.publish({ connected: false, hasOlder: false, loadingOlder: false, archiveState: 'loading', error: null });
    try {
      const status = await this.options.api.archive(snapshot.sessionId, this.lifetime.signal);
      if (!(await this.admit()) || generation !== this.connectionGeneration) return;
      this.publish({ archiveState: status.state });
      if (status.state === 'pending' || status.state === 'unavailable' && snapshot.lifecycle === 'draining') { this.schedule(3000); return; }
      if (status.state !== 'ready') return;
      // A ready receipt is not a loaded archive: keep the placeholder until its
      // identity and contents have been checked against the current execution.
      this.publish({ archiveState: 'loading' });
      // Finalization can establish an ID whose live state was never delivered.
      // Bind the ready archive to a fresh authenticated terminal snapshot.
      const current = await this.options.api.current(this.lifetime.signal);
      if (!(await this.admit()) || generation !== this.connectionGeneration) return;
      if (current.status !== 'registered' || !this.matches(current.session)) { this.invalidate(); return; }
      if (sessionFenceKey(current.session) !== sessionFenceKey(snapshot) || current.session.lifecycle === 'active') { void this.start(); return; }
      const finalSnapshot = current.session;
      const archive = await this.options.api.archiveContent(snapshot.sessionId, this.lifetime.signal);
      if (!(await this.admit()) || generation !== this.connectionGeneration) return;
      assertSessionFence(archive, sessionFence(finalSnapshot));
      if (archive.provider !== finalSnapshot.identity.provider || archive.controllerId !== finalSnapshot.identity.controllerId || archive.controllerInstanceId !== finalSnapshot.identity.controllerInstanceId || archive.nativeSessionId !== finalSnapshot.identity.nativeSessionId) throw new ApiError('protocol');
      this.archive = archive;
      const resources = archive.resources.map(({ resource, data }) => data === null && resource.status === 'available' ? { ...resource, status: 'unavailable' as const } : resource);
      const state = hydrateSession(emptySessionState(), finalSnapshot, archive.entries, resources);
      this.publish({ archiveState: 'ready', state, status: 'ready', connected: false, error: null });
    } catch (error) {
      if (!this.owned() || generation !== this.connectionGeneration || isAbortError(error)) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) { this.invalidate(error); return; }
      if (!(await this.admit()) || generation !== this.connectionGeneration) return;
      this.publish({ archiveState: 'failed', error: message(error), errorCode: errorCode(error), connected: false });
    }
  }
  private validatePage(page: TimelinePage, snapshot: SessionSnapshot) {
    if (page.sessionId !== snapshot.sessionId || page.historyEpoch !== snapshot.historyEpoch) throw new ApiError('protocol');
    if (page.hasMoreBefore && !page.beforeCursor) throw new HistoryCursorError('Session history returned an empty pagination cursor.');
  }
  private cancelHydration(): void { this.historyRequest?.abort(); this.historyRequest = null; this.hydrating = false; this.buffer = []; }
  private async hydrate(snapshot: SessionSnapshot, generation: number, online = true) {
    const request = new AbortController(); this.historyRequest = request;
    const currentRequest = () => this.owned() && this.historyRequest === request && generation === this.connectionGeneration && this.sameHistory(snapshot);
    try {
      const page = await this.options.api.timeline(snapshot.sessionId, 'tail', null, AbortSignal.any([request.signal, this.lifetime.signal]));
      if (!currentRequest() || !(this.paused() ? await this.admit(request.signal) : this.admitted()) || !currentRequest()) return;
      this.validatePage(page, snapshot);
      if (BigInt(page.lastEventSeq) < BigInt(snapshot.lastEventSeq)) throw new ApiError('protocol');
      const previous = this.replaceHistory ? { ...this.view.state, entries: [], resources: new Map() } : this.view.state;
      // A current read can publish a newer state while this tail is in flight.
      // Materializing history cannot roll back that accepted connection or activity.
      const latest = this.view.state.snapshot!;
      const selected = BigInt(latest.sessionRevision) > BigInt(snapshot.sessionRevision) ? latest : snapshot;
      let state = hydrateSession(previous, selected, page.items, page.resources);
      this.replaceHistory = false;
      state = { ...state, lastEventSeq: page.lastEventSeq };
      // The tail may include events newer than the initial WS snapshot. Replay only their
      // latest state receipts while retaining the page's already materialized timeline.
      for (const item of this.buffer) {
        if (item.event.kind === 'snapshot' && BigInt(item.event.eventSeq) <= BigInt(page.lastEventSeq) && BigInt(item.event.payload.sessionRevision) > BigInt(state.snapshot!.sessionRevision)) state = { ...state, snapshot: item.event.payload };
        if (item.event.kind === 'operation' && BigInt(item.event.eventSeq) <= BigInt(page.lastEventSeq)) state = { ...state, operations: new Map(state.operations).set(item.event.payload.operationId, item.event.payload) };
      }
      this.before = page.beforeCursor; this.beforeCursors = new Set(page.beforeCursor ? [page.beforeCursor] : []); this.hydrated = online; this.hydrating = false;
      this.publish({ state, status: 'ready', hasOlder: page.hasMoreBefore, connected: online, historyError: null, historyRevision: this.view.historyRevision + 1, error: online ? null : this.view.error });
      if (state.snapshot && state.snapshot.lifecycle !== 'active') { this.beginArchive(state.snapshot); return; }
      const buffered = this.buffer; this.buffer = [];
      if (online) for (const item of buffered) { this.apply(item); if (generation !== this.connectionGeneration) return; }
      this.restore(); this.restoreDraftOperation(); this.reconcile(); this.retries = 0;
    } catch (error) {
      if (!currentRequest() || isAbortError(error)) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) { this.invalidate(error); return; }
      if (!(this.paused() ? await this.admit() : this.admitted()) || generation !== this.connectionGeneration) return;
      this.hydrating = false; this.publish({ connected: false, status: 'error', error: message(error), errorCode: errorCode(error) });
      if (error instanceof ApiError && error.code === 'controller_offline') { this.historyFailureIdentity = historyIdentity(snapshot); this.historyFailureError = { message: message(error), code: errorCode(error) }; return; }
      if (error instanceof HistoryCursorError) {
        this.historyFailureIdentity = historyIdentity(snapshot); this.historyFailureError = { message: message(error), code: errorCode(error) };
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
      } else this.schedule();
    } finally { if (this.historyRequest === request) this.historyRequest = null; }
  }
  async loadOlder(): Promise<void> {
    const snapshot = this.view.state.snapshot;
    if (!snapshot || !this.live() || !this.view.historyReady || !this.historyAllowed(snapshot) || !snapshot.synchronized || snapshot.connectionState !== 'connected' || snapshot.lifecycle !== 'active' || !this.before || this.view.loadingOlder || !this.view.hasOlder) return;
    const generation = this.connectionGeneration, before = this.before, request = new AbortController();
    this.olderRequest = request;
    const current = () => this.owned() && this.olderRequest === request && generation === this.connectionGeneration && this.sameHistory(snapshot);
    this.publish({ loadingOlder: true, historyError: null });
    try {
      const page = await this.options.api.timeline(snapshot.sessionId, 'before', before, AbortSignal.any([request.signal, this.lifetime.signal]));
      if (!current() || !(this.paused() ? await this.admit(request.signal) : this.admitted()) || !current()) return;
      this.validatePage(page, snapshot);
      if (page.hasMoreBefore && (page.beforeCursor === before || this.beforeCursors.has(page.beforeCursor!))) throw new HistoryCursorError('Session history pagination did not advance.');
      const resources = new Map(this.view.state.resources); for (const resource of page.resources) if (!resources.has(resource.resourceId)) resources.set(resource.resourceId, resource);
      this.before = page.beforeCursor;
      if (page.beforeCursor) this.beforeCursors.add(page.beforeCursor);
      this.publish({ state: { ...this.view.state, entries: mergeTimeline(this.view.state.entries, page.items), resources }, hasOlder: page.hasMoreBefore, historyRevision: this.view.historyRevision + 1 });
    } catch (error) {
      if (!current() || isAbortError(error)) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) { this.invalidate(error); return; }
      if (!(this.paused() ? await this.admit(request.signal) : this.admitted()) || !current()) return;
      if (error instanceof ApiError && error.code === 'controller_offline') {
        this.historyFailureIdentity = historyIdentity(snapshot); this.historyFailureError = { message: message(error), code: errorCode(error) };
        this.publish({ connected: false, status: 'error', error: message(error), errorCode: errorCode(error), historyError: null }); return;
      }
      this.publish({ historyError: message(error) });
      if (error instanceof ApiError && error.code === 'reset_required') { this.beforeCursors.clear(); this.hydrated = false; this.cursor = null; this.schedule(0); }
    } finally { if (this.olderRequest === request) { this.olderRequest = null; this.publish({ loadingOlder: false }); } }
  }
  send = (text: string): Promise<void> => {
    this.admitted();
    if (!this.live() || !text.trim() || text.trimStart().startsWith('/') || !sessionSendGate(this.view.state, this.view.connected)) return Promise.reject(new Error('Sending is not currently allowed.'));
    return this.execute({ kind: 'send_message', payload: { content: [{ type: 'text', text }], expectedTurnId: this.view.state.snapshot!.activity === 'working' ? this.view.state.snapshot!.currentTurnId : null } });
  };
  updateSetting = (settingId: string, value: string, revision: string): Promise<void> => {
    this.admitted();
    const controls = this.view.state.snapshot?.controls, setting = controls?.settings.find(setting => setting.id === settingId);
    if (!this.live() || !sessionControlGate(this.view.state, this.view.connected) || controls?.revision !== revision || !setting?.mutable || !setting.options.some(option => option.value === value)) return Promise.reject(new Error('This setting changed or is unavailable. Refresh the controls.'));
    return this.execute({ kind: 'update_setting', payload: { settingId, value, expectedControlsRevision: revision } });
  };
  executeCommand = (commandId: string, args: string, revision: string, draftText?: string): Promise<void> => {
    this.admitted();
    const s = this.view.state.snapshot, command = s?.controls?.commands.find(command => command.id === commandId);
    if (!this.live() || !sessionControlGate(this.view.state, this.view.connected) || s?.controls?.revision !== revision || !command?.available) return Promise.reject(new Error('This command changed or is unavailable. Refresh the commands.'));
    return this.execute({ kind: 'execute_command', payload: { commandId, arguments: args, expectedControlsRevision: revision, expectedTurnId: s.currentTurnId } }, draftText);
  };
  refreshControls = (): Promise<void> => {
    this.admitted();
    if (!this.live() || !sessionControlGate(this.view.state, this.view.connected)) return Promise.reject(new Error('Session controls are unavailable.'));
    return this.execute({ kind: 'refresh_controls', payload: {} });
  };
  cancel = (): Promise<void> => {
    this.admitted();
    if (!this.live() || !sessionCancelGate(this.view.state, this.view.connected)) return Promise.reject(new Error('Cancellation is not currently allowed.'));
    return this.execute({ kind: 'cancel', payload: { expectedTurnId: this.view.state.snapshot!.currentTurnId! } });
  };
  respond = (interaction: SessionInteraction, response: InteractionResponse): Promise<void> => {
    this.admitted();
    if (!this.live() || !sessionRespondGate(this.view.state, this.view.connected, interaction) || interaction.state !== 'pending') return Promise.reject(new Error('This interaction is no longer available.'));
    const current = this.view.state.entries.find((entry) => entry.kind === 'interaction' && entry.interaction.interactionId === interaction.interactionId);
    if (!current || current.kind !== 'interaction' || current.interaction.revision !== interaction.revision || current.interaction.state !== 'pending') return Promise.reject(new Error('This interaction changed. Refresh the session.'));
    return this.execute({ kind: 'interaction_response', payload: { interactionId: interaction.interactionId, interactionRevision: interaction.revision, submissionId: crypto.randomUUID(), response } });
  };
  private putOperation(operation: SessionOperation, target?: Pick<SessionInteraction, 'interactionId' | 'revision'>) { this.publish({ state: { ...this.view.state, operations: new Map(this.view.state.operations).set(operation.operationId, operation), responseTargets: target ? new Map(this.view.state.responseTargets).set(operation.operationId, target) : this.view.state.responseTargets } }); this.persist(); }
  private async execute(input: CommandInput, draftText?: string): Promise<void> {
    const s = this.view.state.snapshot;
    if (!this.live() || !s || (input.kind === 'interaction_response' ? hasPendingResponse(this.view.state, { interactionId: input.payload.interactionId, revision: input.payload.interactionRevision }) : [...this.view.state.operations.values()].some((op) => op.kind === input.kind && uncertain(op)))) throw new Error('Check the original pending operation before continuing.');
    const command: SessionCommand = { protocol: SESSION_PROTOCOL, ...sessionFence(s), requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), ...input };
    const pending: SessionOperation = { protocol: SESSION_PROTOCOL, ...sessionFence(s), operationId: command.operationId, kind: command.kind, state: 'unknown', providerResult: null, error: null };
    if ((command.kind === 'send_message' && command.payload.content[0]?.type === 'text' && this.view.draft.text.trim() === command.payload.content[0].text) || (command.kind === 'execute_command' && draftText !== undefined && this.view.draft.text === draftText)) {
      this.view = { ...this.view, draft: { ...this.view.draft, submission: { operationId: command.operationId, revision: this.view.draft.revision, kind: command.kind as 'send_message' | 'execute_command' } } }; this.persistDraft();
    }
    if (command.kind === 'update_setting') {
      const setting = s.controls?.settings.find(setting => setting.id === command.payload.settingId);
      this.view = { ...this.view, settingIntents: new Map(this.view.settingIntents).set(command.payload.settingId, { operationId: command.operationId, settingId: command.payload.settingId, value: command.payload.value, confirmedValue: setting?.value ?? null }) };
    }
    this.putOperation(pending, command.kind === 'interaction_response' ? { interactionId: command.payload.interactionId, revision: command.payload.interactionRevision } : undefined);
    try {
      const receipt = await this.options.api.command(s.sessionId, command, this.lifetime.signal);
      if (!(this.paused() ? await this.admit() : this.admitted()) || !this.sameSession(s)) throw new Error('The active session changed.');
      assertSessionFence(receipt, sessionFence(s)); this.putOperation(receipt);
    } catch (error) {
      if (this.owned() && this.sameSession(s) && error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) this.invalidate(error);
      if (!(this.paused() ? await this.admit() : this.admitted())) throw error;
      if (this.sameSession(s) && error instanceof ApiError && error.kind === 'server' && error.status !== null && error.status < 500) this.putOperation({ ...pending, state: 'rejected', error: { code: error.code, message: error.message } });
      throw error;
    }
    const deadline = Date.now() + 30_000;
    while ((this.paused() ? await this.admit() : this.admitted()) && this.sameSession(s)) {
      const operation = this.view.state.operations.get(command.operationId)!;
      if (accepted(operation)) return;
      if (terminalFailure(operation)) throw new Error(operation.error?.message ?? 'The provider rejected the operation.');
      if (operation.state === 'unknown' || Date.now() >= deadline) { this.putOperation({ ...operation, state: 'unknown' }); throw new Error('Delivery outcome is unknown. Check the original operation.'); }
      await this.delay(750);
      if (!(this.paused() ? await this.admit() : this.admitted())) break;
      try { await this.checkOperation(command.operationId); } catch { /* Only queries are retried; native inputs are never replayed. */ }
    }
    throw new Error('The active session changed.');
  }
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.operationPolls.delete(timer); this.lifetime.signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, ms); this.operationPolls.add(timer); this.lifetime.signal.addEventListener('abort', finish, { once: true });
    });
  }
  checkOperation = async (id: string): Promise<void> => {
    const snapshot = this.view.state.snapshot;
    if (!snapshot || !this.live() || this.view.checking.has(id)) return;
    const checking = new Set(this.view.checking).add(id); this.publish({ checking });
    try {
      const operation = await this.options.api.operation(snapshot.sessionId, id, this.lifetime.signal);
      if (!(this.paused() ? await this.admit() : this.admitted()) || !this.sameSession(snapshot)) return;
      assertSessionFence(operation, sessionFence(snapshot)); this.putOperation(operation);
    } catch (error) {
      if (this.owned() && this.sameSession(snapshot) && error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) this.invalidate(error);
      await this.admit();
      throw error;
    } finally { this.publish({ checking: new Set([...this.view.checking].filter((value) => value !== id)) }); }
  };
  private reconcile() { for (const operation of this.view.state.operations.values()) if (uncertain(operation)) void this.checkOperation(operation.operationId).catch(() => {}); }
  resource = async (id: string, signal: AbortSignal): Promise<Blob> => {
    const s = this.view.state.snapshot;
    if (!this.live() || !s || this.view.state.resources.get(id)?.status !== 'available') throw new Error('Resource unavailable.');
    const combinedSignal = AbortSignal.any([signal, this.lifetime.signal]);
    combinedSignal.throwIfAborted();
    if (s.lifecycle !== 'active') {
      const archived = this.archive?.resources.find(item => item.resource.resourceId === id);
      if (this.view.archiveState !== 'ready' || !archived || archived.data === null) throw new Error('Resource unavailable.');
      const bytes = Uint8Array.from(atob(archived.data), character => character.charCodeAt(0));
      combinedSignal.throwIfAborted();
      return new Blob([bytes], { type: archived.resource.mediaType ?? 'application/octet-stream' });
    }
    const blob = await this.options.api.resource(s.sessionId, id, combinedSignal).catch((error: unknown) => {
      if (this.owned() && this.sameSession(s) && error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) this.invalidate(error);
      throw error;
    });
    if (!(this.paused() ? await this.admit(combinedSignal) : this.admitted()) || combinedSignal.aborted || !this.sameSession(s)) throw new Error('The active session changed.');
    return blob;
  };
  refresh = (): void => { if (!this.live()) return; this.historyFailureIdentity = null; this.historyFailureError = null; this.cursor = null; this.hydrated = false; void this.start(); };
  pause = (): void => {
    this.disconnect(); this.clearSuspensionTimer(); this.publish({ connected: false, authPaused: false });
    for (const resume of [...this.admissionWaiters]) resume();
  };
  private disconnect() {
    this.cancelHydration();
    this.observationRequest?.abort(); this.observationRequest = null;
    if (this.observationTimer !== null) clearTimeout(this.observationTimer);
    this.observationTimer = null; this.channelAuthenticated = false;
    this.availabilityRunning = false; this.connectionGeneration++; this.cancelOlder(); this.connection?.close(); this.connection = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null; this.hydrating = false; this.buffer = []; this.suspendedMessages = []; this.suspendedBytes = 0;
    this.publish({ connected: false, loadingOlder: false });
  }
  invalidate = (error?: unknown): void => {
    if (this.invalidated || this.lifetime.signal.aborted) return;
    this.invalidated = true;
    const sessionId = this.view.state.snapshot?.sessionId ?? this.options.testSessionId;
    try {
      const storage = this.options.storage;
      const operationPrefix = sessionId ? `daynight:session-operations:${this.options.userId}:${sessionId}:` : null;
      if (storage) for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key && (operationPrefix !== null && key.startsWith(operationPrefix) || key.startsWith(this.draftScopePrefix()))) storage.removeItem(key);
      }
    } catch { /* Identity isolation remains enforced in memory. */ }
    this.draftKey = null; this.view = { ...this.view, draft: emptyDraft(), error: error === undefined ? null : message(error), errorCode: error === undefined ? null : errorCode(error) };
    this.close();
    this.options.onInvalidate?.();
  };
  close = (): void => { this.lastStartupReport = null; this.currentReadFailure = null; this.archive = null; this.disconnect(); this.clearSuspensionTimer(); this.publish({ startupReport: null, error: this.invalidated ? this.view.error : null, errorCode: this.invalidated ? this.view.errorCode : null, archiveState: null, settingIntents: new Map(), state: emptySessionState(), connected: false, status: 'unavailable' }); this.lifetime.abort(); for (const timer of this.operationPolls) clearTimeout(timer); this.operationPolls.clear(); this.listeners.clear(); };
}
