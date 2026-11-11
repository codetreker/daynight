import { OperationRequestError, imageCommandNotDispatched } from './operation-error';
import { sameStartupReport, type SessionStartupReport } from '../../../../daynight/src/session/startup';
import { liveHistoryAllowed } from './presentation';
import { sessionArchiveReferences, type SessionArchiveStatus } from '../../../../daynight/src/session/archive';
import type { SessionResourceClient } from '../../../../daynight/src/session/resource-client';
import { ApiError, isAbortError, readAuthRequestGeneration } from '../../api/client';
import { pageImageStore, type ImageScope } from './images/image-store';
import { ImageDraftController, type ImageDraftContext } from './drafts/image-draft-controller';
import { clearImageDraftScope } from './drafts/draft-store-cleanup';
import { draftOwnerKey } from './drafts/draft-store-identity';
import { IndependentSessionReadDenied, type BotSessionBinding, type SessionApi, type SessionChannel, type LoadedSessionArchive } from '../../api/sessions';
import { clearSessionDisplayPreference } from './useSessionDisplayPreference';
import { SESSION_PROTOCOL, assertSessionFence, sessionFence, sessionFenceKey, parseSessionOperation, type InteractionResponse, type SessionCommand, type SessionFence, type SessionInteraction, type SessionOperation, type SessionSnapshot } from '../../../../daynight/src/session/protocol';
import type { BrowserMessage, TimelinePage } from '../../../../daynight/src/session/controller-protocol';
import { applySessionEvent, emptySessionState, hydrateSession, mergeTimeline, hasPendingResponse, sessionCancelGate, sessionRespondGate, sessionSendGate, sessionControlGate, type SessionState } from './state';

export type SessionDraft = { readonly text: string; readonly revision: string; readonly submission: { readonly operationId: string; readonly revision: string; readonly kind?: 'send_message' | 'execute_command' } | null };
const emptyDraft = (): SessionDraft => ({ text: '', revision: crypto.randomUUID(), submission: null });
const draftPrefix = (userId: string) => `daynight:session-draft:${userId}:`;
export function clearSessionDrafts(userId: string): void {
  try { const storage = window.sessionStorage; for (let i = storage.length - 1; i >= 0; i--) { const key = storage.key(i); if (key?.startsWith(draftPrefix(userId))) storage.removeItem(key); } } catch { /* Unavailable browser storage cannot retain new drafts. */ }
}

/** Clear one independent Session's raw storage, including visits through its old Test URL. */
export function clearIndependentSessionStorage(userId: string, sessionId: string, storage?: Storage | null): void {
  const draft = `${draftPrefix(userId)}test:${sessionId}:`, operations = `daynight:session-operations:${userId}:${sessionId}:`;
  try {
    const disk = storage === undefined ? window.sessionStorage : storage;
    if (!disk) return;
    for (let i = disk.length - 1; i >= 0; i--) {
      const key = disk.key(i);
      if (key && (key.startsWith(draft) || key.startsWith(operations))) {
        try { disk.removeItem(key); } catch { /* Continue clearing the remaining owned keys. */ }
      }
    }
  } catch { /* Session admission still prevents restoring inaccessible deleted history. */ }
}

export type SessionSettingIntent = { readonly operationId: string; readonly settingId: string; readonly value: string; readonly confirmedValue: string | null };
/** Coverage belongs to applied history, never to a later current snapshot. */
export type SessionHistoryCoverage = {
  readonly firstEntrySeq: string | null;
  readonly throughEntrySeq: string;
  readonly completeBefore: boolean;
  readonly lastEventSeq: string;
};
type CommandInput = { [K in SessionCommand['kind']]: Pick<Extract<SessionCommand, { kind: K }>, 'kind' | 'payload'> }[SessionCommand['kind']];
export type SessionViewState = {
  readonly actionAdmitted: boolean;
  readonly startupReport: SessionStartupReport | null;
  readonly environmentConnected: boolean;
  readonly errorCode: string | null;
  readonly archiveState: SessionArchiveStatus['state'] | 'loading' | null;
  readonly operationProgress: ReadonlyMap<string, 'sending' | 'waiting'>;
  readonly settingIntents: ReadonlyMap<string, SessionSettingIntent>;
  readonly draft: SessionDraft;
  readonly state: SessionState; readonly status: 'loading' | 'ready' | 'not_registered' | 'unavailable' | 'error';
  readonly connected: boolean; readonly authPaused: boolean; readonly error: string | null; readonly hasOlder: boolean; readonly loadingOlder: boolean;
  readonly historyError: string | null; readonly checking: ReadonlySet<string>;
  readonly historyReady: boolean; readonly historyRevision: number; readonly connectionGeneration: number;
  readonly historyLoaded: boolean;
  /** Accepted history can be observed only outside replacement and recovery. */
  readonly historySettled: boolean;
  readonly historyCoverage: SessionHistoryCoverage | null;
};
type Options = { readonly api: SessionApi; readonly userId: string; readonly initialActionAdmitted?: boolean; readonly isCurrent: () => boolean; readonly isPaused?: () => boolean; readonly onPrincipalMismatch: () => void; readonly onInvalidate?: () => void; readonly storage: Storage | null } & (
  { readonly projectId: string; readonly taskId: string; readonly claimId: string; readonly ownerUserId: string; readonly testSessionId?: never; readonly bot?: never } |
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
type CurrentReadFlight = { readonly kind: 'start' | 'observation' | 'archive'; readonly controller: AbortController; readonly generation: number; readonly archive: { readonly snapshot: SessionSnapshot; readonly generation: number } | null };

export class TaskSessionClient {
  private view: SessionViewState = { actionAdmitted: true, operationProgress: new Map(), environmentConnected: false, startupReport: null, errorCode: null, archiveState: null, settingIntents: new Map(), draft: emptyDraft(), state: emptySessionState(), status: 'loading', connected: false, authPaused: false, error: null, hasOlder: false, loadingOlder: false, historyError: null, checking: new Set(), historyReady: false, historyLoaded: false, historySettled: false, historyCoverage: null, historyRevision: 0, connectionGeneration: 0 };
  private archive: LoadedSessionArchive | null = null;
  private media: { readonly key: string; readonly client: SessionResourceClient } | null = null;
  private images: {
    readonly key: string; readonly scope: ImageScope;
    readonly references: Map<string, { readonly entry: SessionState['entries'][number]; readonly resources: ReadonlySet<string> }>;
    entries: SessionState['entries'] | null; coverage: SessionHistoryCoverage | null;
  } | null = null;
  private listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private invalidated = false;
  private connection: SessionChannel | null = null;
  private connectionGeneration = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private availabilityRunning = false;
  private currentReadVisible = false;
  private currentReadFlight: CurrentReadFlight | null = null;
  private deferredStart = false;
  private deferredArchive: { readonly snapshot: SessionSnapshot; readonly generation: number } | null = null;
  private observationTimer: ReturnType<typeof setTimeout> | null = null;
  private observationRequest: AbortController | null = null;
  private lastStartupReport: SessionStartupReport | null = null;
  private currentReadFailure: { message: string; code: string } | null = null;
  private currentErrorVisible = false;
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
  private imageDraftProjected = false;
  private operationPolls = new Set<ReturnType<typeof setTimeout>>();
  private progressTimers = new Map<string, readonly ReturnType<typeof setTimeout>[]>();
  private draftAdmission = { active: false, current: false };
  private imageOperationIds = new Set<string>();
  readonly imageDrafts: ImageDraftController;
  constructor(private readonly options: Options) {
    this.view = { ...this.view, actionAdmitted: options.initialActionAdmitted ?? true };
    this.imageDrafts = new ImageDraftController({
      getContext: this.imageDraftContext,
      dispatch: command => this.dispatchFrozenDraft(command),
      query: (fence, id, signal) => this.observeImageOperation(fence, id, signal),
      createAsset: (blob, id, byteRevision) => {
        const scope = this.imageScope();
        if (!scope) throw new Error('Image access has ended.');
        return pageImageStore.createLocalAsset(scope, { key: JSON.stringify([id, byteRevision]), blob });
      },
      isDefinitiveNotDispatched: imageCommandNotDispatched,
      commandIssue: payload => {
        const s = this.view.state.snapshot, command = s?.controls?.commands.find(candidate => candidate.id === payload.commandId);
        return !this.canInteract() || !this.live() || !this.view.actionAdmitted || !sessionControlGate(this.view.state, this.view.connected) || s?.controls?.revision !== payload.expectedControlsRevision || s.currentTurnId !== payload.expectedTurnId || !command?.available ? 'image_command_unavailable' : null;
      },
      legacy: () => {
        const key = this.draftKey, draft = this.view.draft;
        return key ? { ...draft, onImported: () => { this.options.storage?.removeItem(key); } } : null;
      },
    });
    this.imageDrafts.subscribe(() => {
      if (this.lifetime.signal.aborted) return;
      const draft = this.imageDrafts.getSnapshot();
      if (draft.submission && !this.imageOperationIds.has(draft.submission.operationId)) {
        this.imageOperationIds.add(draft.submission.operationId);
        // Migration removes the old draft key only after adoption. Persist its
        // receipt routing now so a reload cannot query it as an unrelated operation.
        this.persist();
      }
      if (draft.active) {
        this.imageDraftProjected = true;
        this.view = { ...this.view, draft: { text: draft.text, revision: draft.revision, submission: draft.submission ? { operationId: draft.submission.operationId, revision: draft.submission.draftRevision, kind: draft.submission.kind } : null } };
      } else if (this.imageDraftProjected) {
        this.imageDraftProjected = false;
        this.view = { ...this.view, draft: emptyDraft() };
      }
      for (const listener of this.listeners) listener();
    });
  }
  setImageDraftAdmission = (active: boolean, current: boolean): void => {
    if (this.draftAdmission.active === active && this.draftAdmission.current === current) return;
    this.draftAdmission = { active, current };
    void this.imageDrafts.sync();
  };
  private imageDraftContext = (): ImageDraftContext | null => {
    const snapshot = this.view.state.snapshot;
    if (!snapshot || snapshot.lifecycle !== 'active' || !this.owned() || this.invalidated || !this.canInteract()) return null;
    const target = { serverOrigin: window.location.origin, actorUserId: this.options.userId, fence: sessionFence(snapshot), expectedNativeSessionId: snapshot.identity.nativeSessionId };
    const resolver = this.options.testSessionId !== undefined
      ? { kind: 'session' as const, sessionId: snapshot.sessionId, testExecutionId: snapshot.testExecutionId! }
      : { kind: 'task' as const, projectId: this.options.projectId, taskId: this.options.taskId };
    const self = this;
    return {
      identity: { target, resolver }, target,
      get resources() { return self.resourceClient(snapshot); },
      capabilities: snapshot.capabilities.images ?? null,
      active: this.draftAdmission.active && this.draftAdmission.current && this.live(),
      canEdit: this.canInteract() && this.owned() && !this.paused() && !this.view.authPaused,
      canSend: this.draftAdmission.active && this.draftAdmission.current && this.live() && !this.view.authPaused && this.view.actionAdmitted && sessionSendGate(this.view.state, this.view.connected),
      mode: snapshot.activity === 'working' ? 'steer' : 'send', expectedTurnId: snapshot.activity === 'working' ? snapshot.currentTurnId : null,
      authorizationGeneration: String(readAuthRequestGeneration()),
    };
  };
  private resourceClient(snapshot: SessionSnapshot): SessionResourceClient {
    const key = JSON.stringify([sessionFenceKey(snapshot), readAuthRequestGeneration()]);
    if (this.media?.key !== key) {
      void this.media?.client.close();
      this.media = { key, client: this.options.api.resources(sessionFence(snapshot), () => this.owned() && this.sameSession(snapshot)) };
    }
    return this.media.client;
  }
  snapshot = (): SessionViewState => this.view;
  /** One authenticated resource scope follows this retained client, independent of presentation. */
  imageScope = (): ImageScope | null => {
    const snapshot = this.view.state.snapshot;
    if (!snapshot || this.lifetime.signal.aborted || this.view.status === 'unavailable') return null;
    const generation = readAuthRequestGeneration();
    const key = JSON.stringify([sessionFenceKey(snapshot), snapshot.identity.nativeSessionId, generation]);
    if (this.images?.key !== key) {
      void this.images?.scope.invalidate();
      const current = () => generation === readAuthRequestGeneration() && this.live() && this.sameSession(snapshot) && this.view.state.snapshot?.identity.nativeSessionId === snapshot.identity.nativeSessionId;
      this.images = { key, references: new Map(), entries: null, coverage: null, scope: pageImageStore.createScope({
        identity: { serverOrigin: window.location.origin, actorUserId: this.options.userId, authorizationGeneration: String(generation + 1), owner: { kind: 'session', fence: sessionFence(snapshot), nativeSessionId: snapshot.identity.nativeSessionId } },
        canRead: current, canDownload: current, read: this.resource,
      }) };
    }
    this.reconcileImageReferences();
    return this.images.scope;
  };
  private reconcileImageReferences(): void {
    const images = this.images, { state, historyCoverage: coverage, historySettled } = this.view;
    if (!images || !historySettled || images.entries === state.entries && images.coverage === coverage) return;
    images.entries = state.entries; images.coverage = coverage;
    const present = new Set(state.entries.map(entry => entry.entryId));
    for (const entry of state.entries) {
      if (images.references.get(entry.entryId)?.entry === entry) continue;
      images.references.set(entry.entryId, { entry, resources: sessionArchiveReferences([entry], false).resources });
    }
    // A replacement tail proves only its covered interval; older or later
    // retained rows can still own an open preview until their history is known.
    if (coverage) for (const [id, known] of images.references) {
      const seq = BigInt(known.entry.entrySeq);
      const covered = seq <= BigInt(coverage.throughEntrySeq) && (coverage.completeBefore || coverage.firstEntrySeq !== null && seq >= BigInt(coverage.firstEntrySeq));
      if (!present.has(id) && covered) images.references.delete(id);
    }
    const retained = new Set<string>();
    for (const known of images.references.values()) for (const resourceId of known.resources) retained.add(resourceId);
    images.scope.retainResources(retained);
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  setActionAdmission = (admitted: boolean): void => {
    if (this.view.actionAdmitted !== admitted) this.publish({ actionAdmitted: admitted });
  };
  private owned = (): boolean => !this.lifetime.signal.aborted && this.options.isCurrent();
  private paused = (): boolean => this.options.isPaused?.() ?? false;
  private live = (): boolean => this.owned() && !this.paused();
  syncAvailability = (): void => {
    if (this.lifetime.signal.aborted) return;
    if (this.draftAdmission.active || this.imageDrafts.getSnapshot().active) void this.imageDrafts.sync();
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
      if (this.options.testSessionId === undefined) this.resumeCurrentReads();
    }
    if (!this.currentReadsVisible() || this.currentReadFlight !== null) return;
    if (!this.availabilityRunning) void this.start();
  };
  private currentReadsVisible(): boolean { return this.options.testSessionId !== undefined || this.currentReadVisible; }
  /** Current reads follow the Task panel's visibility; transport ownership remains independent. */
  setCurrentReadVisible = (visible: boolean): void => {
    if (this.options.testSessionId !== undefined || this.currentReadVisible === visible) return;
    this.currentReadVisible = visible;
    if (!visible) {
      if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; this.deferredStart = true; }
      if (this.observationTimer !== null) clearTimeout(this.observationTimer);
      this.observationTimer = null;
      if (this.currentReadFlight !== null) {
        if (this.currentReadFlight.kind === 'start') this.deferredStart = true;
        if (this.currentReadFlight.archive !== null) this.deferredArchive = this.currentReadFlight.archive;
        this.currentReadFlight.controller.abort();
      }
      return;
    }
    this.resumeCurrentReads();
  };
  private beginCurrentRead(kind: CurrentReadFlight['kind'], generation: number, archive: CurrentReadFlight['archive'] = null): CurrentReadFlight {
    const flight = { kind, generation, archive, controller: new AbortController() };
    if (this.options.testSessionId === undefined) {
      if (this.currentReadFlight !== null) throw new Error('A Task current read is already in progress.');
      this.currentReadFlight = flight;
    }
    return flight;
  }
  private currentReadCurrent(flight: CurrentReadFlight): boolean {
    return !flight.controller.signal.aborted && this.currentReadsVisible() && (this.options.testSessionId !== undefined || this.currentReadFlight === flight);
  }
  private finishCurrentRead(flight: CurrentReadFlight): void {
    if (this.currentReadFlight !== flight) return;
    this.currentReadFlight = null;
    this.resumeCurrentReads(flight.kind === 'observation' || this.connection !== null);
  }
  private resumeCurrentReads(observe = true): void {
    if (!this.live() || !this.currentReadsVisible() || this.currentReadFlight !== null) return;
    const archive = this.deferredArchive;
    if (archive !== null) {
      this.deferredArchive = null;
      if (archive.generation === this.connectionGeneration) void this.bindReadyArchive(archive.snapshot, archive.generation);
      return;
    }
    if (this.deferredStart) { this.deferredStart = false; void this.start(); return; }
    if (observe && this.availabilityRunning && this.view.state.snapshot !== null) this.scheduleObservation(this.connectionGeneration);
  }
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
  private publish(change: Partial<SessionViewState>, errorOwner: 'current' | 'other' = 'other') {
    if (this.lifetime.signal.aborted) return;
    const previous = this.view.state.snapshot, next = change.state?.snapshot;
    if (previous && change.state && (!next || sessionFenceKey(previous) !== sessionFenceKey(next) || previous.identity.nativeSessionId !== next.identity.nativeSessionId)) {
      void this.images?.scope.invalidate(); this.images = null;
      // The visible text belongs to the same exact owner as its image items.
      // Retire that projection before publishing a different native target.
      if (this.imageDraftProjected) { this.imageDraftProjected = false; change = { ...change, draft: emptyDraft() }; }
    }
    if (previous && change.state && (!next || sessionFenceKey(previous) !== sessionFenceKey(next) || previous.historyEpoch !== next.historyEpoch)) {
      this.cancelOlder(); this.cancelHydration(); this.before = null; this.beforeCursors.clear();
      change = { ...change, historyLoaded: change.historyLoaded ?? false, historyCoverage: change.historyCoverage ?? null, loadingOlder: false, historyError: null };
    } else if (previous && next && previous.connectionEpoch !== next.connectionEpoch) {
      this.cancelOlder(); this.cancelHydration(); change = { ...change, loadingOlder: false };
    }
    if (change.state) change = { ...change, environmentConnected: next !== null && next !== undefined && (next.connectionState === 'connected' || next.connectionState === 'synchronizing' || previous !== null && sameExecution(previous, next) && this.view.environmentConnected) };
    if (next && this.historyFailureIdentity !== null && this.historyFailureIdentity !== historyIdentity(next) && liveHistoryAllowed(next, this.view.startupReport)) {
      if (this.historyFailureError && this.view.error === this.historyFailureError.message && this.view.errorCode === this.historyFailureError.code) change = { ...change, error: null, status: 'ready' };
      this.historyFailureIdentity = null; this.historyFailureError = null;
    }
    if (change.error === null) change = { ...change, errorCode: null };
    if (this.currentReadFailure && change.error === null) {
      change = { ...change, status: 'error', error: this.currentReadFailure.message, errorCode: this.currentReadFailure.code };
      errorOwner = 'current';
    }
    if (change.error !== undefined) this.currentErrorVisible = change.error !== null && errorOwner === 'current';
    if (change.state && (!next || this.lastStartupReport && !reportMatches(this.lastStartupReport, next))) {
      this.lastStartupReport = null; change = { ...change, startupReport: null };
    }
    if (change.connected === false || previous && next && !sameExecution(previous, next) || next && (next.lifecycle !== 'active' || next.connectionState === 'disconnected')) {
      for (const id of this.view.operationProgress.keys()) this.clearProgressTimers(id);
      change = { ...change, operationProgress: new Map() };
    } else if (change.state && this.view.operationProgress.size) {
      const progress = new Map(this.view.operationProgress);
      for (const id of progress.keys()) {
        const operation = change.state.operations.get(id);
        if (!operation || !uncertain(operation)) { progress.delete(id); this.clearProgressTimers(id); }
      }
      change = { ...change, operationProgress: progress };
    }
    this.view = { ...this.view, ...change };
    if (this.view.connected && (this.currentReadFailure || !this.view.state.snapshot || !this.historyAllowed(this.view.state.snapshot) || BigInt(this.view.state.lastEventSeq) < BigInt(this.replayThrough))) this.view = { ...this.view, connected: false };
    this.view = { ...this.view, connectionGeneration: this.connectionGeneration, historySettled: this.view.historyLoaded && !this.hydrating && !this.replaceHistory && !this.view.state.recoveryRequired && this.view.state.snapshot !== null, historyReady: this.hydrated && !this.hydrating && this.view.connected && this.view.status === 'ready' && !this.view.state.recoveryRequired && this.view.state.snapshot !== null && this.historyAllowed(this.view.state.snapshot) };
    this.reconcileImageReferences();
    const snapshot = this.view.state.snapshot;
    if (snapshot) this.bindDraft(snapshot);
    const draft = this.view.draft, operation = draft.submission && this.view.state.operations.get(draft.submission.operationId);
    if (!this.imageDrafts.getSnapshot().active && operation && ['send_message', 'execute_command'].includes(operation.kind) && (accepted(operation) || terminalFailure(operation))) {
      this.view = { ...this.view, draft: accepted(operation) && draft.revision === draft.submission!.revision ? emptyDraft() : { ...draft, submission: null } };
      this.persistDraft();
    }
    if (this.draftAdmission.active || this.imageDrafts.getSnapshot().active) void this.imageDrafts.sync();
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
    this.imageDraftProjected = false;
    this.view = { ...this.view, settingIntents: new Map() };
    let draft = emptyDraft();
    try {
      const storage = this.options.storage;
      // Older targets remain isolated under their original keys. Their unknown
      // operations must survive until an authorized original-target query settles them.
      const stored: unknown = JSON.parse(storage?.getItem(key) ?? 'null');
      if (stored && typeof stored === 'object' && 'text' in stored && typeof stored.text === 'string' && 'revision' in stored && typeof stored.revision === 'string' && 'submission' in stored) {
        const submission = stored.submission;
        if (submission === null || typeof submission === 'object' && 'operationId' in submission && typeof submission.operationId === 'string' && 'revision' in submission && typeof submission.revision === 'string') draft = { text: stored.text, revision: stored.revision, submission: submission === null ? null : { operationId: submission.operationId as string, revision: submission.revision as string, ...('kind' in submission && submission.kind === 'execute_command' ? { kind: 'execute_command' as const } : {}) } };
      }
    } catch { /* A missing or malformed saved draft never authorizes a send. */ }
    this.view = { ...this.view, draft };
  }
  private persistDraft() {
    if (this.imageDrafts.getSnapshot().active || !this.draftKey) return;
    try { if (this.view.draft.text || this.view.draft.submission) this.options.storage?.setItem(this.draftKey, JSON.stringify(this.view.draft)); else this.options.storage?.removeItem(this.draftKey); } catch { /* Keep editable text in memory if storage is unavailable. */ }
  }
  setDraft = (text: string): void => {
    if (this.imageDrafts.getSnapshot().loading) return;
    if (this.imageDrafts.getSnapshot().active) { this.imageDrafts.setText(text); return; }
    if (!this.canInteract() || this.lifetime.signal.aborted || !this.view.state.snapshot || this.view.draft.text === text) return;
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
    try { this.options.storage?.setItem(this.storageKey(s), JSON.stringify([...this.view.state.operations.values()].filter(uncertain).slice(-200).map(operation => ({ operation, imageDraft: this.imageOperationIds.has(operation.operationId), interaction: this.view.state.responseTargets.get(operation.operationId), setting: [...this.view.settingIntents.values()].find(intent => intent.operationId === operation.operationId) })))); } catch { /* The in-memory receipt remains usable when browser storage is unavailable. */ }
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
        if (wrapped && 'imageDraft' in value && value.imageDraft === true && ['send_message', 'execute_command'].includes(operation.kind)) this.imageOperationIds.add(operation.operationId);
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
    if (!this.currentReadsVisible() || this.currentReadFlight !== null) { this.deferredStart = true; return; }
    this.deferredStart = false;
    this.disconnect();
    this.availabilityRunning = true;
    const generation = this.connectionGeneration;
    const flight = this.beginCurrentRead('start', generation), signal = AbortSignal.any([flight.controller.signal, this.lifetime.signal]);
    this.currentReadFailure = null;
    this.publish({ connected: false, error: null, loadingOlder: false });
    try {
      if (!this.currentReadCurrent(flight)) return;
      let current = await this.options.api.current(signal);
      if (!this.currentReadCurrent(flight) || !(this.paused() ? await this.admit(signal) : this.admitted()) || !this.currentReadCurrent(flight) || generation !== this.connectionGeneration) return;
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
      if (current.session.lifecycle !== 'active') { this.finishCurrentRead(flight); await this.loadArchive(current.session, generation); return; }
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
      if (!this.currentReadCurrent(flight) || generation !== this.connectionGeneration || !this.owned() || isAbortError(error)) return;
      if (error instanceof IndependentSessionReadDenied || error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) { this.invalidate(error); return; }
      if (!(this.paused() ? await this.admit(signal) : this.admitted()) || !this.currentReadCurrent(flight) || generation !== this.connectionGeneration) return;
      this.publish({ startupReport: null, connected: false, status: 'error', error: message(error), errorCode: errorCode(error) }); this.schedule();
    } finally { this.finishCurrentRead(flight); }
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
    if (!this.owned() || !this.currentReadsVisible() || this.currentReadFlight !== null || !this.view.state.snapshot || this.options.testSessionId === undefined && this.view.state.snapshot.lifecycle !== 'active') return;
    this.observationTimer = setTimeout(() => { this.observationTimer = null; void this.observeCurrent(generation); }, 3000);
  }
  private async observeCurrent(generation: number): Promise<void> {
    const snapshot = this.view.state.snapshot;
    if (!snapshot || generation !== this.connectionGeneration || !this.owned() || !this.currentReadsVisible() || this.currentReadFlight !== null) return;
    if (this.paused()) { this.scheduleObservation(generation); return; }
    const flight = this.beginCurrentRead('observation', generation), request = flight.controller; this.observationRequest = request;
    const currentRequest = () => this.currentReadCurrent(flight) && this.owned() && this.observationRequest === request && generation === this.connectionGeneration && this.view.state.snapshot !== null && sameExecution(snapshot, this.view.state.snapshot);
    try {
      const current = await this.options.api.current(AbortSignal.any([request.signal, this.lifetime.signal]));
      if (!currentRequest() || !(await this.admit(request.signal)) || !currentRequest()) return;
      if (current.status !== 'registered' || !this.matches(current.session)) { this.invalidate(); return; }
      const latest = this.view.state.snapshot!;
      if (sessionFenceKey(current.session) !== sessionFenceKey(latest) || current.session.historyEpoch !== latest.historyEpoch) {
        if (current.session.sessionId === latest.sessionId && BigInt(current.session.executionGeneration) < BigInt(latest.executionGeneration)) return;
        void this.start(); return;
      }
      this.currentReadFailure = null;
      this.acceptStartupReport(latest, current.startupReport);
      if (BigInt(current.session.sessionRevision) > BigInt(latest.sessionRevision)) {
        if (BigInt(current.session.lastEventSeq) > BigInt(this.replayThrough)) this.replayThrough = current.session.lastEventSeq;
        this.publish({ state: { ...this.view.state, snapshot: current.session } });
      }
      if (this.currentErrorVisible) { this.publish({ error: null, status: 'ready' }); this.restoreHistoryFailure(this.view.state.snapshot!); }
      const selected = this.view.state.snapshot!;
      if (selected.lifecycle !== 'active') {
        // Independent archives remain subject to Bot deletion. Revalidate their
        // authority without fetching immutable content again on every poll.
        if (this.options.testSessionId !== undefined && this.archive !== null) return;
        this.beginArchive(selected); return;
      }
      if (!this.historyAllowed(selected)) { this.cancelOlder(); this.publish({ connected: false, loadingOlder: false }); }
      else if (this.channelAuthenticated && !this.hydrating && !this.hydrated) this.startHydration(selected, generation);
      else if (this.channelAuthenticated && this.hydrated && !this.hydrating && !this.view.state.recoveryRequired && BigInt(this.view.state.lastEventSeq) >= BigInt(this.replayThrough)) this.publish({ connected: true });
    } catch (error) {
      if (!currentRequest() || isAbortError(error)) return;
      if (error instanceof IndependentSessionReadDenied || error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) { this.invalidate(error); return; }
      if (!(await this.admit(request.signal)) || !currentRequest()) return;
      const replaceError = this.currentErrorVisible || !this.view.error || this.view.errorCode === 'controller_offline';
      this.currentReadFailure = { message: message(error), code: errorCode(error) };
      this.publish({ startupReport: null, connected: false, status: 'error', ...(replaceError ? { error: message(error), errorCode: errorCode(error) } : {}) }, 'current');
    } finally {
      if (this.observationRequest === request) this.observationRequest = null;
      this.finishCurrentRead(flight);
      if (generation === this.connectionGeneration) this.scheduleObservation(generation);
    }
  }
  private startHydration(snapshot: SessionSnapshot, generation: number): void {
    if (this.hydrating || !this.historyAllowed(snapshot)) return;
    this.hydrating = true; this.buffer = []; this.publish({}); void this.hydrate(snapshot, generation);
  }
  private schedule(delay = Math.min(1000 * 2 ** this.retries++, 15_000)) {
    if (this.timer !== null) clearTimeout(this.timer);
    if (!this.currentReadsVisible()) { this.timer = null; this.deferredStart = true; return; }
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
    if (value.event.kind === 'operation' && value.event.payload.state === 'unknown') this.endOperationProgress(value.event.payload.operationId);
    let state = applySessionEvent(this.view.state, value.event);
    const sameHistory = state.snapshot !== null && sessionFenceKey(state.snapshot) === sessionFenceKey(s) && state.snapshot.historyEpoch === s.historyEpoch;
    if (!sameHistory) {
      this.replaceHistory = true;
      state = { ...state, recoveryRequired: true };
    }
    const coverage = this.view.historyCoverage;
    const applied = !state.recoveryRequired && BigInt(state.lastEventSeq) > BigInt(this.view.state.lastEventSeq);
    // An upsert verifies its own row, not the unread interval between it and a
    // loaded page. Only accepted pages may expand contiguous entry coverage.
    const historyCoverage = applied && coverage ? {
      ...coverage,
      lastEventSeq: state.lastEventSeq,
    } : sameHistory ? coverage : null;
    this.publish({ state, historyCoverage });
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
      await this.bindReadyArchive(snapshot, generation);
    } catch (error) {
      if (!this.owned() || generation !== this.connectionGeneration || isAbortError(error)) return;
      if (error instanceof IndependentSessionReadDenied || error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) { this.invalidate(error); return; }
      if (!(await this.admit()) || generation !== this.connectionGeneration) return;
      this.publish({ archiveState: 'failed', error: message(error), errorCode: errorCode(error), connected: false });
    } finally {
      if (this.options.testSessionId !== undefined && this.owned() && generation === this.connectionGeneration && this.timer === null) this.scheduleObservation(generation);
    }
  }
  private async bindReadyArchive(snapshot: SessionSnapshot, generation: number): Promise<void> {
    if (!this.owned() || generation !== this.connectionGeneration) return;
    const binding = { snapshot, generation };
    if (this.options.testSessionId === undefined && (!this.currentReadsVisible() || this.currentReadFlight !== null || this.paused())) { this.deferredArchive = binding; return; }
    const flight = this.beginCurrentRead('archive', generation, binding), signal = AbortSignal.any([flight.controller.signal, this.lifetime.signal]);
    // Finalization can establish an ID whose live state was never delivered.
    // A ready receipt remains a placeholder until its original execution is verified.
    this.publish({ archiveState: 'loading' });
    try {
      if (!this.currentReadCurrent(flight)) return;
      const current = await this.options.api.current(signal);
      if (!this.currentReadCurrent(flight) || !(await this.admit(signal)) || !this.currentReadCurrent(flight) || generation !== this.connectionGeneration) return;
      if (current.status !== 'registered' || !this.matches(current.session)) { this.invalidate(); return; }
      if (sessionFenceKey(current.session) !== sessionFenceKey(snapshot) || current.session.lifecycle === 'active') {
        this.finishCurrentRead(flight); void this.start(); return;
      }
      const finalSnapshot = current.session;
      const archive = await this.options.api.archiveContent(snapshot.sessionId, this.lifetime.signal);
      if (!this.currentReadCurrent(flight) || !(await this.admit(signal)) || !this.currentReadCurrent(flight) || generation !== this.connectionGeneration) return;
      assertSessionFence(archive, sessionFence(finalSnapshot));
      if (archive.provider !== finalSnapshot.identity.provider || archive.controllerId !== finalSnapshot.identity.controllerId || archive.controllerInstanceId !== finalSnapshot.identity.controllerInstanceId || archive.nativeSessionId !== finalSnapshot.identity.nativeSessionId) throw new ApiError('protocol');
      this.archive = archive;
      const resources = archive.schemaVersion === 3 ? archive.resources.map(({ resource }) => resource) : archive.resources.map(({ resource, data }) => data === null && resource.status === 'available' ? { ...resource, status: 'unavailable' as const } : resource);
      const state = hydrateSession(emptySessionState(), finalSnapshot, archive.entries, resources);
      this.replaceHistory = false;
      this.publish({ archiveState: 'ready', state, historyLoaded: true, historyCoverage: this.pageCoverage(archive.entries, finalSnapshot.lastTimelineSeq, finalSnapshot.lastEventSeq, true, null), status: 'ready', connected: false, error: null });
    } catch (error) {
      if (!this.currentReadCurrent(flight) || !this.owned() || generation !== this.connectionGeneration || isAbortError(error)) return;
      if (error instanceof IndependentSessionReadDenied || error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) { this.invalidate(error); return; }
      if (!(await this.admit(signal)) || !this.currentReadCurrent(flight) || generation !== this.connectionGeneration) return;
      this.publish({ archiveState: 'failed', error: message(error), errorCode: errorCode(error), connected: false });
    } finally { this.finishCurrentRead(flight); }
  }
  private validatePage(page: TimelinePage, snapshot: SessionSnapshot) {
    if (page.sessionId !== snapshot.sessionId || page.historyEpoch !== snapshot.historyEpoch) throw new ApiError('protocol');
    if (page.hasMoreBefore && !page.beforeCursor) throw new HistoryCursorError('Session history returned an empty pagination cursor.');
  }
  private cancelHydration(): void { this.historyRequest?.abort(); this.historyRequest = null; this.hydrating = false; this.buffer = []; }
  private pageCoverage(entries: SessionState['entries'], throughEntrySeq: string, lastEventSeq: string, completeBefore: boolean, previous: SessionHistoryCoverage | null): SessionHistoryCoverage {
    let first = previous?.firstEntrySeq ?? null, through = previous && BigInt(previous.throughEntrySeq) > BigInt(throughEntrySeq) ? previous.throughEntrySeq : throughEntrySeq;
    for (const entry of entries) {
      if (first === null || BigInt(entry.entrySeq) < BigInt(first)) first = entry.entrySeq;
      if (BigInt(entry.entrySeq) > BigInt(through)) through = entry.entrySeq;
    }
    return { firstEntrySeq: first, throughEntrySeq: through, completeBefore: completeBefore || (previous?.completeBefore ?? false), lastEventSeq: previous && BigInt(previous.lastEventSeq) > BigInt(lastEventSeq) ? previous.lastEventSeq : lastEventSeq };
  }
  private async hydrate(snapshot: SessionSnapshot, generation: number, online = true) {
    const request = new AbortController(); this.historyRequest = request;
    const currentRequest = () => this.owned() && this.historyRequest === request && generation === this.connectionGeneration && this.sameHistory(snapshot);
    try {
      const page = await this.options.api.timeline(snapshot.sessionId, 'tail', null, AbortSignal.any([request.signal, this.lifetime.signal]));
      if (!currentRequest() || !(this.paused() ? await this.admit(request.signal) : this.admitted()) || !currentRequest()) return;
      this.validatePage(page, snapshot);
      if (BigInt(page.lastEventSeq) < BigInt(snapshot.lastEventSeq)) throw new ApiError('protocol');
      const previous = this.replaceHistory ? { ...this.view.state, entries: [], resources: new Map(), lastEventSeq: '0' } : this.view.state;
      const lastEventSeq = BigInt(previous.lastEventSeq) > BigInt(page.lastEventSeq) ? previous.lastEventSeq : page.lastEventSeq;
      // A refreshed tail starts a new cursor chain. Previously accepted rows remain
      // authoritative by ID, but disjoint tails do not prove the interval between them.
      const coverage = this.pageCoverage(page.items, snapshot.lastTimelineSeq, lastEventSeq, !page.hasMoreBefore, null);
      // A current read can publish a newer state while this tail is in flight.
      // Materializing history cannot roll back that accepted connection or activity.
      const latest = this.view.state.snapshot!;
      const selected = BigInt(latest.sessionRevision) > BigInt(snapshot.sessionRevision) ? latest : snapshot;
      let state = hydrateSession(previous, selected, page.items, page.resources);
      this.replaceHistory = false;
      state = { ...state, lastEventSeq };
      // The tail may include events newer than the initial WS snapshot. Replay only their
      // latest state receipts while retaining the page's already materialized timeline.
      for (const item of this.buffer) {
        if (item.event.kind === 'snapshot' && BigInt(item.event.eventSeq) <= BigInt(page.lastEventSeq) && BigInt(item.event.payload.sessionRevision) > BigInt(state.snapshot!.sessionRevision)) state = { ...state, snapshot: item.event.payload };
        if (item.event.kind === 'operation' && BigInt(item.event.eventSeq) <= BigInt(page.lastEventSeq)) state = { ...state, operations: new Map(state.operations).set(item.event.payload.operationId, item.event.payload) };
      }
      if (state.snapshot!.historyEpoch !== snapshot.historyEpoch || sessionFenceKey(state.snapshot!) !== sessionFenceKey(snapshot)) throw new ApiError('protocol');
      this.before = page.beforeCursor; this.beforeCursors = new Set(page.beforeCursor ? [page.beforeCursor] : []); this.hydrated = online; this.hydrating = false;
      this.publish({ state, historyLoaded: true, historyCoverage: coverage, status: 'ready', hasOlder: page.hasMoreBefore, connected: online, historyError: null, historyRevision: this.view.historyRevision + 1, ...(online ? { error: null } : {}) });
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
      this.publish({ state: { ...this.view.state, entries: mergeTimeline(this.view.state.entries, page.items), resources }, historyCoverage: this.pageCoverage(page.items, '0', this.view.state.lastEventSeq, !page.hasMoreBefore, this.view.historyCoverage), hasOlder: page.hasMoreBefore, historyRevision: this.view.historyRevision + 1 });
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
  canInteract = (): boolean => this.options.testSessionId !== undefined || this.options.ownerUserId === this.options.userId;
  private async prepareDraftInput(): Promise<() => void> {
    if (!this.draftAdmission.active) return () => {};
    const original = this.imageDraftContext();
    if (!original || !original.canEdit) throw new Error('image_access_unavailable');
    const contentKey = () => {
      const draft = this.imageDrafts.getSnapshot();
      return draft.active ? JSON.stringify([draft.draftId, draft.text, draft.items.map(item => [item.draftImageId, item.imageId, item.byteRevision, item.label]), draft.rejectedCandidates, draft.overflowRejectedCount, draft.submission?.operationId]) : null;
    };
    const content = contentKey();
    await this.imageDrafts.refreshForSend();
    // The caller asserts after its own await, with no asynchronous gap between
    // checking the clicked content and handing it to the current send path.
    return () => {
      if (!this.view.actionAdmitted) throw new Error('Session actions are not currently admitted.');
      const current = this.imageDraftContext();
      if (!current || !current.canEdit || !this.draftAdmission.active || !this.draftAdmission.current || this.imageDrafts.getSnapshot().loading || draftOwnerKey(original.identity) !== draftOwnerKey(current.identity) || original.authorizationGeneration !== current.authorizationGeneration) throw new Error('image_access_unavailable');
      if (original.mode !== current.mode || original.expectedTurnId !== current.expectedTurnId || JSON.stringify(original.capabilities) !== JSON.stringify(current.capabilities)) throw new Error('image_capability_changed');
      if (content !== contentKey()) throw new Error('image_draft_restored');
    };
  }
  send = async (text: string): Promise<void> => {
    this.admitted();
    if (!this.view.actionAdmitted) throw new Error('Session actions are not currently admitted.');
    if (this.imageDrafts.getSnapshot().loading) throw new Error('image_draft_loading');
    if (this.draftAdmission.active) (await this.prepareDraftInput())();
    if (this.imageDrafts.getSnapshot().active) { this.imageDrafts.setText(text); return this.imageDrafts.send(); }
    this.admitted();
    if (!this.canInteract() || !this.live() || !text.trim() || !sessionSendGate(this.view.state, this.view.connected)) return Promise.reject(new Error('Sending is not currently allowed.'));
    return this.execute({ kind: 'send_message', payload: { content: [{ type: 'text', text }], expectedTurnId: this.view.state.snapshot!.activity === 'working' ? this.view.state.snapshot!.currentTurnId : null } });
  };
  updateSetting = (settingId: string, value: string, revision: string): Promise<void> => {
    this.admitted();
    const controls = this.view.state.snapshot?.controls, setting = controls?.settings.find(setting => setting.id === settingId);
    if (!this.canInteract() || !this.live() || !sessionControlGate(this.view.state, this.view.connected) || controls?.revision !== revision || !setting?.mutable || !setting.options.some(option => option.value === value)) return Promise.reject(new Error('This setting changed or is unavailable. Refresh the controls.'));
    return this.execute({ kind: 'update_setting', payload: { settingId, value, expectedControlsRevision: revision } });
  };
  executeCommand = async (commandId: string, args: string, revision: string, draftText?: string): Promise<void> => {
    this.admitted();
    if (!this.view.actionAdmitted) throw new Error('Session actions are not currently admitted.');
    if (this.imageDrafts.getSnapshot().loading) throw new Error('image_draft_loading');
    if (this.draftAdmission.active) (await this.prepareDraftInput())();
    const images = this.imageDrafts.getSnapshot();
    if (images.loading || images.executionBlocked || images.active && (images.readOnly || images.items.length || images.rejectedCandidates.length || images.overflowRejectedCount)) return Promise.reject(new Error('Resolve the saved image draft before executing a command.'));
    this.admitted();
    const s = this.view.state.snapshot, command = s?.controls?.commands.find(command => command.id === commandId);
    if (!this.canInteract() || !this.live() || !sessionControlGate(this.view.state, this.view.connected) || s?.controls?.revision !== revision || !command?.available) return Promise.reject(new Error('This command changed or is unavailable. Refresh the commands.'));
    if (images.active && draftText !== undefined) {
      const parsed = /^\/([^\s]+)(?:\s([\s\S]*))?$/u.exec(draftText.trimStart());
      if (images.text !== draftText || parsed?.[1] !== command.name || (parsed[2] ?? '') !== args || s.controls.commands.filter(candidate => candidate.name === command.name).length !== 1) throw new Error('image_command_unavailable');
      return this.imageDrafts.executeCommand({ commandId, arguments: args, expectedControlsRevision: revision, expectedTurnId: s.currentTurnId, draftText, commandName: command.name });
    }
    return this.execute({ kind: 'execute_command', payload: { commandId, arguments: args, expectedControlsRevision: revision, expectedTurnId: s.currentTurnId } }, draftText);
  };
  refreshControls = (): Promise<void> => {
    this.admitted();
    if (!this.canInteract() || !this.live() || !sessionControlGate(this.view.state, this.view.connected)) return Promise.reject(new Error('Session controls are unavailable.'));
    return this.execute({ kind: 'refresh_controls', payload: {} });
  };
  cancel = (): Promise<void> => {
    this.admitted();
    if (!this.canInteract() || !this.live() || !sessionCancelGate(this.view.state, this.view.connected)) return Promise.reject(new Error('Cancellation is not currently allowed.'));
    return this.execute({ kind: 'cancel', payload: { expectedTurnId: this.view.state.snapshot!.currentTurnId! } });
  };
  respond = (interaction: SessionInteraction, response: InteractionResponse): Promise<void> => {
    this.admitted();
    if (!this.canInteract() || !this.live() || !sessionRespondGate(this.view.state, this.view.connected, interaction) || interaction.state !== 'pending') return Promise.reject(new Error('This interaction is no longer available.'));
    const current = this.view.state.entries.find((entry) => entry.kind === 'interaction' && entry.interaction.interactionId === interaction.interactionId);
    if (!current || current.kind !== 'interaction' || current.interaction.revision !== interaction.revision || current.interaction.state !== 'pending') return Promise.reject(new Error('This interaction changed. Refresh the session.'));
    if (!this.view.actionAdmitted) return Promise.reject(new Error('Session actions are not currently admitted.'));
    return this.execute({ kind: 'interaction_response', payload: { interactionId: interaction.interactionId, interactionRevision: interaction.revision, submissionId: crypto.randomUUID(), response } });
  };
  private clearProgressTimers(id: string) {
    for (const timer of this.progressTimers.get(id) ?? []) clearTimeout(timer);
    this.progressTimers.delete(id);
  }
  private endOperationProgress(id: string) {
    this.clearProgressTimers(id);
    if (!this.view.operationProgress.has(id)) return;
    const progress = new Map(this.view.operationProgress); progress.delete(id);
    this.publish({ operationProgress: progress });
  }
  private beginOperationProgress(id: string) {
    // This evidence belongs to this page's live request, never to the saved ledger.
    this.view = { ...this.view, operationProgress: new Map(this.view.operationProgress).set(id, 'sending') };
    const slow = setTimeout(() => {
      if (!this.owned() || !this.view.operationProgress.has(id)) return;
      this.publish({ operationProgress: new Map(this.view.operationProgress).set(id, 'waiting') });
    }, 10_000);
    // Bound the display even if the command response itself never arrives.
    const deadline = setTimeout(() => this.endOperationProgress(id), 30_000);
    this.progressTimers.set(id, [slow, deadline]);
  }
  private putOperation(operation: SessionOperation, target?: Pick<SessionInteraction, 'interactionId' | 'revision'>) { this.publish({ state: { ...this.view.state, operations: new Map(this.view.state.operations).set(operation.operationId, operation), responseTargets: target ? new Map(this.view.state.responseTargets).set(operation.operationId, target) : this.view.state.responseTargets } }); this.persist(); }
  private async execute(input: CommandInput, draftText?: string): Promise<void> {
    if (!this.canInteract()) throw new Error("Only the Session owner can interact.");
    const s = this.view.state.snapshot;
    if (!this.live() || !s || (input.kind === 'interaction_response' ? hasPendingResponse(this.view.state, { interactionId: input.payload.interactionId, revision: input.payload.interactionRevision }) : [...this.view.state.operations.values()].some((op) => op.kind === input.kind && uncertain(op)))) throw new Error('Check the original pending operation before continuing.');
    if (!this.view.actionAdmitted) throw new Error('Session actions are not currently admitted.');
    const command: SessionCommand = { protocol: SESSION_PROTOCOL, ...sessionFence(s), requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), ...input };
    const pending: SessionOperation = { protocol: SESSION_PROTOCOL, ...sessionFence(s), operationId: command.operationId, kind: command.kind, state: 'unknown', providerResult: null, error: null };
    if ((command.kind === 'send_message' && command.payload.content[0]?.type === 'text' && this.view.draft.text.trim() === command.payload.content[0].text) || (command.kind === 'execute_command' && draftText !== undefined && this.view.draft.text === draftText)) {
      this.view = { ...this.view, draft: { ...this.view.draft, submission: { operationId: command.operationId, revision: this.view.draft.revision, kind: command.kind as 'send_message' | 'execute_command' } } }; this.persistDraft();
    }
    if (command.kind === 'update_setting') {
      const setting = s.controls?.settings.find(setting => setting.id === command.payload.settingId);
      this.view = { ...this.view, settingIntents: new Map(this.view.settingIntents).set(command.payload.settingId, { operationId: command.operationId, settingId: command.payload.settingId, value: command.payload.value, confirmedValue: setting?.value ?? null }) };
    }
    this.beginOperationProgress(command.operationId);
    this.putOperation(pending, command.kind === 'interaction_response' ? { interactionId: command.payload.interactionId, revision: command.payload.interactionRevision } : undefined);
    await this.dispatchCommand(command, s, false);
    const deadline = Date.now() + 30_000;
    while ((this.paused() ? await this.admit() : this.admitted()) && this.sameSession(s)) {
      const operation = this.view.state.operations.get(command.operationId)!;
      if (accepted(operation)) return;
      if (terminalFailure(operation)) throw new OperationRequestError(command.operationId, new Error(operation.error?.message ?? 'The provider rejected the operation.'));
      if (operation.state === 'unknown' || Date.now() >= deadline) { this.endOperationProgress(command.operationId); this.putOperation({ ...operation, state: 'unknown' }); throw new OperationRequestError(command.operationId, new Error('Delivery outcome is unknown. Check the original operation.')); }
      await this.delay(750);
      if (!(this.paused() ? await this.admit() : this.admitted())) break;
      try { await this.checkOperation(command.operationId); } catch { /* Only queries are retried; native inputs are never replayed. */ }
    }
    throw new OperationRequestError(command.operationId, new Error('The active session changed.'));
  }
  private async dispatchCommand(command: SessionCommand, s: SessionSnapshot, imageSubmission: boolean): Promise<SessionOperation> {
    const pending: SessionOperation = { protocol: SESSION_PROTOCOL, ...sessionFence(s), operationId: command.operationId, kind: command.kind, state: 'unknown', providerResult: null, error: null };
    try {
      const receipt = await this.options.api.command(s.sessionId, command, this.lifetime.signal);
      if (!(this.paused() ? await this.admit() : this.admitted()) || !this.sameSession(s)) throw new Error('The active session changed.');
      assertSessionFence(receipt, sessionFence(s));
      if (imageSubmission && (receipt.operationId !== command.operationId || receipt.kind !== command.kind)) throw new Error('The image receipt does not match the original operation.');
      if (receipt.state === 'unknown') this.endOperationProgress(command.operationId);
      this.putOperation(receipt);
      return receipt;
    } catch (error) {
      this.endOperationProgress(command.operationId);
      if (!imageSubmission && this.owned() && this.sameSession(s) && error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) this.invalidate(error);
      if (imageSubmission) {
        if (this.sameSession(s) && imageCommandNotDispatched(error)) this.putOperation({ ...pending, state: 'rejected', error: { code: error.code, message: error.message } });
        throw error;
      }
      if (!(this.paused() ? await this.admit() : this.admitted())) throw new OperationRequestError(command.operationId, error);
      if (!imageSubmission && this.sameSession(s) && error instanceof ApiError && error.kind === 'server' && error.status !== null && error.status < 500) this.putOperation({ ...pending, state: 'rejected', error: { code: error.code, message: error.message } });
      throw new OperationRequestError(command.operationId, error);
    }
  }
  /** Consumes the exact immutable command whose dispatch claim is already committed. */
  private async dispatchFrozenDraft(command: SessionCommand): Promise<SessionOperation> {
    const s = this.view.state.snapshot, context = this.imageDraftContext();
    if (!s || !context || !context.canEdit || !context.active || command.kind !== 'send_message' && command.kind !== 'execute_command') throw new Error('Image sending is unavailable.');
    assertSessionFence(command, sessionFence(s));
    if (command.kind === 'send_message') {
      if (!context.canSend) throw new Error('Image sending is unavailable.');
      const target = command.payload.target;
      if (command.payload.content.some(part => part.type === 'image') && (!target || !command.payload.draftId || !command.payload.draftRevision)) throw new Error('The saved image submission is incomplete.');
      if (target && (target.serverOrigin !== context.target.serverOrigin || target.actorUserId !== context.target.actorUserId || target.expectedNativeSessionId !== s.identity.nativeSessionId || command.payload.expectedTurnId !== context.expectedTurnId)) throw new Error('The active image target changed.');
      if (target) assertSessionFence(target.fence, sessionFence(s));
    } else {
      const native = s.controls?.commands.find(candidate => candidate.id === command.payload.commandId);
      if (!sessionControlGate(this.view.state, this.view.connected) || !this.view.actionAdmitted || s.controls?.revision !== command.payload.expectedControlsRevision || s.currentTurnId !== command.payload.expectedTurnId || !native?.available) throw new Error('image_command_unavailable');
    }
    this.imageOperationIds.add(command.operationId);
    this.beginOperationProgress(command.operationId);
    this.putOperation({ protocol: SESSION_PROTOCOL, ...sessionFence(s), operationId: command.operationId, kind: command.kind, state: 'unknown', providerResult: null, error: null });
    return this.dispatchCommand(command, s, true);
  }
  /** Missing receipts do not revoke access or erase an unresolved original intent. */
  observeImageOperation = async (fence: SessionFence, operationId: string, signal?: AbortSignal): Promise<SessionOperation> => {
    const requestSignal = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal;
    requestSignal.throwIfAborted();
    if (!(this.paused() ? await this.admit(requestSignal) : this.admitted())) throw new Error('Session access is unavailable.');
    const operation = parseSessionOperation(await this.options.api.operation(fence.sessionId, operationId, requestSignal));
    requestSignal.throwIfAborted();
    if (!(this.paused() ? await this.admit(requestSignal) : this.admitted())) throw new Error('Session access is unavailable.');
    assertSessionFence(operation, sessionFence(fence));
    if (operation.operationId !== operationId) throw new Error('The original operation does not match.');
    const snapshot = this.view.state.snapshot;
    if (snapshot && sessionFenceKey(snapshot) === sessionFenceKey(fence) && this.imageOperationIds.has(operationId)) {
      this.endOperationProgress(operationId);
      this.putOperation(operation);
    }
    return operation;
  };
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.operationPolls.delete(timer); this.lifetime.signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, ms); this.operationPolls.add(timer); this.lifetime.signal.addEventListener('abort', finish, { once: true });
    });
  }
  checkOperation = async (id: string): Promise<void> => {
    if (this.imageOperationIds.has(id)) { await this.imageDrafts.checkStatus(); return; }
    const snapshot = this.view.state.snapshot;
    if (!snapshot || !this.live() || this.view.checking.has(id)) return;
    const checking = new Set(this.view.checking).add(id); this.publish({ checking });
    try {
      const operation = await this.options.api.operation(snapshot.sessionId, id, this.lifetime.signal);
      if (!(this.paused() ? await this.admit() : this.admitted()) || !this.sameSession(snapshot)) return;
      assertSessionFence(operation, sessionFence(snapshot));
      if (operation.state === 'unknown') this.endOperationProgress(id);
      this.putOperation(operation);
    } catch (error) {
      const missingDraftReceipt = error instanceof ApiError && error.status === 404 && this.view.draft.submission?.operationId === id;
      if (!missingDraftReceipt && this.owned() && this.sameSession(snapshot) && error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) this.invalidate(error);
      await this.admit();
      throw error;
    } finally { this.publish({ checking: new Set([...this.view.checking].filter((value) => value !== id)) }); }
  };
  private reconcile() { for (const operation of this.view.state.operations.values()) if (uncertain(operation) && !this.imageOperationIds.has(operation.operationId)) void this.checkOperation(operation.operationId).catch(() => {}); }
  resource = async (id: string, signal: AbortSignal, onProgress?: () => void): Promise<Blob> => {
    const s = this.view.state.snapshot;
    if (!this.live() || !s || this.view.state.resources.get(id)?.status !== 'available') throw new Error('Resource unavailable.');
    const combinedSignal = AbortSignal.any([signal, this.lifetime.signal]);
    combinedSignal.throwIfAborted();
    const descriptor = this.view.state.resources.get(id)!;
    if (s.lifecycle !== 'active' && this.archive?.schemaVersion !== 3) {
      const archived = this.archive?.resources.find(item => item.resource.resourceId === id);
      if (this.view.archiveState !== 'ready' || !archived || archived.data === null) throw new Error('Resource unavailable.');
      const bytes = Uint8Array.from(atob(archived.data), character => character.charCodeAt(0));
      combinedSignal.throwIfAborted();
      onProgress?.();
      return new Blob([bytes], { type: archived.resource.mediaType ?? 'application/octet-stream' });
    }
    const load = async (): Promise<Blob> => {
      if (s.lifecycle === 'active' && !Object.hasOwn(descriptor, 'revision')) return this.options.api.resource(s.sessionId, id, combinedSignal, onProgress);
      return new Blob([await this.resourceClient(s).readResource(descriptor, combinedSignal, onProgress)], { type: descriptor.mediaType ?? 'application/octet-stream' });
    };
    const blob = await load().catch((error: unknown) => {
      if (this.owned() && this.sameSession(s) && error instanceof ApiError && [401, 403, 404, 410].includes(error.status ?? 0)) this.invalidate(error);
      throw error;
    });
    if (!(this.paused() ? await this.admit(combinedSignal) : this.admitted()) || combinedSignal.aborted || !this.sameSession(s)) throw new Error('The active session changed.');
    return blob;
  };
  refresh = (): void => { if (!this.live() || !this.currentReadsVisible()) return; this.historyFailureIdentity = null; this.historyFailureError = null; this.cursor = null; this.hydrated = false; void this.start(); };
  pause = (): void => {
    this.disconnect(); this.clearSuspensionTimer(); this.publish({ connected: false, authPaused: false });
    for (const resume of [...this.admissionWaiters]) resume();
  };
  private disconnect() {
    this.cancelHydration();
    this.currentReadFlight?.controller.abort();
    this.deferredStart = false; this.deferredArchive = null;
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
    void this.imageDrafts.revoke('revoked');
    const sessionId = this.view.state.snapshot?.sessionId ?? this.options.testSessionId;
    if (sessionId) void clearImageDraftScope({ origin: window.location.origin, actorUserId: this.options.userId, sessionId, reason: 'revoked' });
    if (sessionId) clearSessionDisplayPreference({ userId: this.options.userId, sessionId });
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
  close = (): void => { this.imageDrafts.close(); void this.images?.scope.invalidate(); this.images = null; void this.media?.client.close(); this.media = null; this.lastStartupReport = null; this.currentReadFailure = null; this.archive = null; this.disconnect(); this.clearSuspensionTimer(); this.publish({ startupReport: null, error: this.invalidated ? this.view.error : null, errorCode: this.invalidated ? this.view.errorCode : null, archiveState: null, settingIntents: new Map(), state: emptySessionState(), connected: false, status: 'unavailable' }); this.lifetime.abort(); for (const timer of this.operationPolls) clearTimeout(timer); this.operationPolls.clear(); this.listeners.clear(); };
}
