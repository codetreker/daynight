import { ApiError } from '../../api/client';
import { terminalEnvelope, type TerminalCommand, type TerminalResult, type TerminalSessionApi, type TerminalSessionState } from '../../api/terminal-sessions';
import { SESSION_V2_LIMITS, canonicalSessionJson, exact, seq, uuid, choice, bool } from '../../../../daynight/src/session/v2/values';
import type { SessionV2Key, SessionV2Payloads } from '../../../../daynight/src/session/v2/types';

export type TerminalClientSnapshot = {
  phase: 'loading' | 'ready' | 'disconnected' | 'unavailable' | 'error';
  availability: 'not_registered' | 'not_applicable' | null;
  transport: 'paused' | 'connecting' | 'connected' | 'disconnected';
  session: TerminalSessionState | null; pending: boolean; inputReady: boolean; ownsControl: boolean;
  result: SessionV2Payloads['operation_result'] | null; error: unknown | null; unknownAcknowledged: boolean;
};
type Options = { api: TerminalSessionApi; claimId: string; userId: string; browserClientId?: string; isCurrent?: () => boolean; storage?: Storage | null };
type TrackedCommand = Pick<TerminalCommand, 'sessionId' | 'claimId' | 'executionGeneration' | 'type'> & { payload: { operationId: string; controlEpoch: string } };
type Pending = { command: TrackedCommand; generation: number; startedAt: number };
// Native conversation identity may be enriched without changing the execution target.
export const sameTerminalFence = (a: TerminalSessionState, b: TerminalSessionState) => a.sessionId === b.sessionId && a.claimId === b.claimId && a.executionGeneration === b.executionGeneration && a.connectionEpoch === b.connectionEpoch && canonicalSessionJson({ ...a.binding, nativeSessionId: null }) === canonicalSessionJson({ ...b.binding, nativeSessionId: null });
const sameAdmissionState = (a: TerminalSessionState, b: TerminalSessionState) => sameTerminalFence(a, b)
  && canonicalSessionJson(a.owner) === canonicalSessionJson(b.owner)
  && a.binding.nativeSessionId === b.binding.nativeSessionId && a.connected === b.connected
  && canonicalSessionJson(a.control) === canonicalSessionJson(b.control)
  && canonicalSessionJson(a.capabilities) === canonicalSessionJson(b.capabilities);
const terminal = (state: SessionV2Payloads['operation_result']['state']) => state === 'transport_completed' || state === 'rejected' || state === 'unknown';
const admissionRefusals = ['input_busy', 'stale_fence', 'lease_expired', 'automation_suspended'] as const;

/** Owns one visible viewer, never a native attach or an automatic input retry. */
export class TerminalSessionClient {
  readonly browserClientId: string;
  private view: TerminalClientSnapshot = { phase: 'loading', availability: null, transport: 'paused', session: null, pending: false, inputReady: false, ownsControl: false, result: null, error: null, unknownAcknowledged: false };
  private listeners = new Set<() => void>();
  private visible = false;
  private ended = false;
  private accountRefreshSuspended = false;
  private generation = 0;
  private channel: { close(): void } | null = null;
  private channelState: TerminalSessionState | null = null;
  private channelRevision = 0;
  private needsReconciliation = false;
  private requests = new Set<AbortController>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private reconciling: number | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private pendingOperation: Pending | null = null;
  private leaseKey: string | null = null;
  private leaseSeq = 0n;
  private opening = false;
  private interrupted = false;
  private storage: Storage | null = null;
  private persistenceError: unknown | null = null;
  private readonly storageKey: string;
  constructor(private readonly options: Options) {
    this.browserClientId = options.browserClientId ?? crypto.randomUUID();
    this.storageKey = `daynight:terminal-operation:${options.userId}:${options.claimId}`;
    try {
      this.storage = options.storage === undefined ? window.sessionStorage : options.storage;
      const saved = this.storage?.getItem(this.storageKey);
      if (saved) {
        const o = exact(JSON.parse(saved), ['sessionId', 'claimId', 'executionGeneration', 'type', 'operationId', 'controlEpoch', 'acknowledged']);
        const command = { sessionId: uuid(o.sessionId), claimId: uuid(o.claimId), executionGeneration: seq(o.executionGeneration), type: choice(o.type, ['operation', 'control_request'] as const), payload: { operationId: uuid(o.operationId), controlEpoch: seq(o.controlEpoch) } };
        if (command.claimId !== options.claimId) throw new ApiError('protocol');
        this.pendingOperation = { command, generation: 0, startedAt: 0 };
        this.view = { ...this.view, result: { operationId: command.payload.operationId, state: 'unknown', errorCode: 'input_unknown' }, unknownAcknowledged: bool(o.acknowledged) };
      }
    } catch (error) { this.persistenceError = error; this.view = { ...this.view, phase: 'error', error }; }
  }
  private persist(pending: Pending | null, acknowledged = false): boolean {
    try {
      if (this.storage === null) throw new ApiError('protocol', null, 'operation_storage_unavailable');
      if (pending === null) this.storage.removeItem(this.storageKey);
      else { const c = pending.command; this.storage.setItem(this.storageKey, JSON.stringify({ sessionId: c.sessionId, claimId: c.claimId, executionGeneration: c.executionGeneration, type: c.type, operationId: c.payload.operationId, controlEpoch: c.payload.controlEpoch, acknowledged })); }
      return true;
    } catch (error) { this.persistenceError = error; this.publish({ phase: 'error', error }); return false; }
  }
  getSnapshot = (): TerminalClientSnapshot => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private owned() { return !this.ended; }
  private live(generation = this.generation) { return this.owned() && !this.accountRefreshSuspended && this.visible && (this.options.isCurrent?.() ?? true) && generation === this.generation; }
  private channelMatches(state: TerminalSessionState | null) {
    const channel = this.channelState;
    return state !== null && channel !== null && sameAdmissionState(state, channel);
  }
  private channelConfirmed() {
    return !this.needsReconciliation && this.view.transport === 'connected' && this.channelMatches(this.view.session);
  }
  private isOwner() { return this.view.session?.owner.ownerUserId === this.options.userId; }
  private ownsLease() { const lease = this.view.session?.control?.lease; return this.isOwner() && this.live() && this.channelConfirmed() && this.view.phase === 'ready' && this.view.session?.connected === true && this.view.session.control?.state === 'manual' && lease?.holderUserId === this.options.userId && lease.browserClientId === this.browserClientId && Date.parse(lease.expiresAt) > Date.now(); }
  private publish(change: Partial<TerminalClientSnapshot>) {
    this.view = { ...this.view, ...change, ...(this.persistenceError === null ? {} : { error: this.persistenceError, phase: 'error' as const }) };
    this.view = { ...this.view, inputReady: this.isOwner() && this.live() && this.channelConfirmed(), ownsControl: this.ownsLease() };
    for (const listener of this.listeners) listener();
  }
  private request() { const controller = new AbortController(); this.requests.add(controller); return controller; }
  private forget(controller: AbortController) { this.requests.delete(controller); }
  private stopTransport() {
    this.generation++; this.opening = false; this.interrupted = false;
    this.channelState = null; this.needsReconciliation = false;
    this.channel?.close(); this.channel = null;
    for (const c of this.requests) c.abort(); this.requests.clear();
    if (this.pollTimer !== null) clearTimeout(this.pollTimer); this.pollTimer = null;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer); this.reconcileTimer = null; this.reconciling = null;
    if (this.renewTimer !== null) clearInterval(this.renewTimer); this.renewTimer = null;
    if (this.view.pending && this.pendingOperation !== null) this.publish({ pending: false, result: { operationId: this.pendingOperation.command.payload.operationId, state: 'unknown', errorCode: 'input_unknown' } });
  }
  setVisible = (visible: boolean): void => {
    if (!this.owned() || this.accountRefreshSuspended) return;
    if (this.visible === visible) {
      // A transient admission gate can close when a timer fires between visibility checks.
      if (visible && this.channel === null && this.reconnectTimer === null && !this.opening && (this.interrupted || this.view.availability !== 'not_applicable')) void this.start();
      else if (visible && this.channel !== null) this.scheduleReconciliation();
      return;
    }
    this.visible = visible;
    if (!visible) { this.stopTransport(); this.publish({ transport: 'paused' }); }
    else void this.start();
  };
  /** Stop this viewer until page refresh, retaining its last presentation and local operation state. */
  suspendForAccountRefresh = (): void => {
    this.accountRefreshSuspended = true; this.visible = false;
    this.stopTransport();
    if (this.owned()) this.publish({ transport: 'paused' });
  };
  private receive(next: TerminalSessionState, generation: number, source: 'read' | 'channel', readRevision = this.channelRevision) {
    if (!this.live(generation)) return;
    const received = next;
    if (next.claimId !== this.options.claimId) { this.invalidate(new ApiError('protocol', null, 'stale_fence')); return; }
    const previous = this.view.session;
    if (previous !== null && (BigInt(next.executionGeneration) < BigInt(previous.executionGeneration) || BigInt(next.connectionEpoch) < BigInt(previous.connectionEpoch))) return;
    if (previous !== null && sameTerminalFence(previous, next)) {
      if (previous.binding.nativeSessionId !== null) {
        if (next.binding.nativeSessionId === null) return;
        if (next.binding.nativeSessionId !== previous.binding.nativeSessionId) { this.invalidate(new ApiError('protocol', null, 'stale_fence')); return; }
      }
      if (previous.control && (next.control === null || BigInt(next.control.controlEpoch) < BigInt(previous.control.controlEpoch))) next = { ...next, control: previous.control };
      if (source === 'read' && readRevision < this.channelRevision && this.channelState !== null && sameTerminalFence(next, this.channelState) && next.connected !== this.channelState.connected) {
        // The read and a newer channel event disagree about connectivity. Keep the
        // last presented state until another read resolves their ordering.
        this.needsReconciliation = true; next = { ...next, connected: previous.connected };
      }
      const oldLease = next.control?.lease, freshLease = previous.control?.lease;
      // A read begun before the channel's renewal may finish after it. Preserve only
      // that newer expiry, and only when every other control field agrees.
      if (source === 'read' && readRevision < this.channelRevision && oldLease && freshLease && this.channelState !== null
        && sameTerminalFence(previous, this.channelState) && canonicalSessionJson(previous.control) === canonicalSessionJson(this.channelState.control)
        && Date.parse(oldLease.expiresAt) < Date.parse(freshLease.expiresAt)
        && canonicalSessionJson({ ...next.control, lease: { ...oldLease, expiresAt: freshLease.expiresAt } }) === canonicalSessionJson(previous.control)) {
        next = { ...next, control: previous.control };
      }
      const before = previous.snapshot, after = next.snapshot;
      if (before && after && (BigInt(after.segmentOrdinal) < BigInt(before.segmentOrdinal) || after.segmentId === before.segmentId && BigInt(after.frame.frameSeq) < BigInt(before.frame.frameSeq))) next = { ...next, snapshot: { ...before, binding: next.binding } };
    }
    if (previous !== null && previous.sessionId !== next.sessionId) { this.invalidate(new ApiError('protocol', null, 'stale_fence')); return; }
    if (source === 'read' && readRevision === this.channelRevision) this.needsReconciliation = false;
    if (previous !== null && (!sameTerminalFence(previous, next) || this.pendingOperation?.command.type === 'operation' && previous.control?.controlEpoch !== next.control?.controlEpoch)) {
      if (this.view.pending && this.pendingOperation !== null) {
        if (this.pollTimer !== null) clearTimeout(this.pollTimer); this.pollTimer = null;
        this.publish({ pending: false, result: { operationId: this.pendingOperation.command.payload.operationId, state: 'unknown', errorCode: 'input_unknown' } });
        if (!this.live(generation)) return;
        this.pendingOperation = { ...this.pendingOperation, generation: -1 };
      }
    }
    // Binding enrichment can preserve the lease and its accepted input sequence.
    const lease = next.control?.lease;
    const key = lease === null || lease === undefined ? null : `${lease.leaseId}:${lease.controlEpoch}`;
    if (key !== this.leaseKey) { this.leaseKey = key; this.leaseSeq = 0n; }
    if (source === 'channel') {
      if (this.channelState === null || !sameAdmissionState(this.channelState, received)) this.channelRevision++;
      this.channelState = received;
    }
    const phase = !next.connected ? 'disconnected' : source === 'channel' || !this.needsReconciliation && this.view.transport === 'connected' && this.channelMatches(next) ? 'ready' : this.view.session === null ? 'loading' : this.view.phase;
    this.publish({ session: next, availability: null, phase, ...(source === 'channel' ? { transport: 'connected' as const, error: null } : {}) });
    this.scheduleReconciliation();
  }
  private async start() {
    if (!this.live() || this.opening) return;
    this.opening = true; this.interrupted = false; const generation = this.generation, controller = this.request();
    if (this.view.session !== null || this.view.phase === 'loading') this.publish({ transport: 'connecting', ...(this.view.phase === 'loading' ? { error: null } : {}) });
    try {
      if (!this.live(generation)) return;
      const current = this.view.session === null ? await this.options.api.current(controller.signal) : await this.options.api.state(this.view.session.sessionId, controller.signal);
      if (!this.live(generation)) return;
      if (current.status !== 'registered') {
        if (current.status === 'not_registered' && current.claimId !== this.options.claimId) { this.invalidate(new ApiError('protocol', null, 'stale_fence')); return; }
        if (this.view.phase !== 'unavailable' || this.view.availability !== current.status || this.view.error !== null || this.view.transport !== 'disconnected') this.publish({ phase: 'unavailable', availability: current.status, transport: 'disconnected', session: null, error: null });
        if (current.status === 'not_registered') this.scheduleReconnect();
        return;
      }
      if (current.claimId !== this.options.claimId) { this.invalidate(new ApiError('protocol', null, 'stale_fence')); return; }
      if (this.view.transport !== 'connecting') this.publish({ transport: 'connecting' });
      this.receive(current, generation, 'read');
      if (!this.live(generation) || this.view.session === null) return;
      const channel = this.options.api.channel(this.view.session.sessionId, this.browserClientId, state => this.receive(state, generation, 'channel'), error => {
        if (!this.live(generation)) return;
        this.stopTransport(); if (this.accountRefreshSuspended) return;
        this.publish({ phase: 'disconnected', transport: 'disconnected', error: error ?? null }); this.scheduleReconnect();
      });
      if (!this.live(generation)) { channel.close(); return; }
      this.channel = channel;
      this.renewTimer = setInterval(() => { if (!this.live()) { this.stopTransport(); this.publish({ transport: 'paused' }); return; } this.publish({}); if (this.view.ownsControl && !this.view.pending) void this.control('renew_control'); }, SESSION_V2_LIMITS.leaseRenewMs);
    } catch (error) { if (this.live(generation)) this.failure(error); }
    finally { this.forget(controller); if (generation === this.generation) { this.opening = false; if (this.owned() && this.visible && !this.live(generation)) this.interrupted = true; } }
  }
  private scheduleReconnect() {
    if (!this.live() || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (!this.live() && this.owned() && this.visible) this.interrupted = true; else void this.start(); }, 1500);
  }
  private scheduleReconciliation() {
    if (!this.live() || this.view.transport !== 'connected' || this.channelConfirmed()) {
      if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer); this.reconcileTimer = null;
      return;
    }
    if (this.reconcileTimer !== null || this.reconciling !== null) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      if (!this.live() || this.view.transport !== 'connected' || this.channelConfirmed()) return;
      const generation = this.generation; this.reconciling = generation;
      void this.refreshState(true).finally(() => {
        if (this.reconciling === generation) this.reconciling = null;
        if (this.live(generation)) this.scheduleReconciliation();
      });
    }, 1500);
  }
  private failure(error: unknown) {
    if (error instanceof ApiError && ([401, 403, 404, 410].includes(error.status ?? 0) || error.code === 'principal_mismatch')) { this.invalidate(error); return; }
    this.stopTransport(); if (this.accountRefreshSuspended) return;
    this.publish({ phase: this.view.session === null ? 'error' : 'disconnected', transport: 'disconnected', error });
    this.scheduleReconnect();
  }
  refresh = (): Promise<void> => this.refreshState(false);
  private async refreshState(bounded: boolean): Promise<void> {
    if (!this.live()) return;
    if (this.channel === null || this.view.session === null) {
      if (this.opening) return;
      if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
      await this.start(); return;
    }
    const generation = this.generation, controller = this.request(), readRevision = this.channelRevision;
    try {
      const read = () => this.options.api.state(this.view.session!.sessionId, controller.signal);
      this.receive(bounded ? await this.boundedRequest(controller, 10_000, read) : await read(), generation, 'read', readRevision);
    }
    catch (error) { if (this.live(generation)) this.failure(error); }
    finally { this.forget(controller); }
  }
  private admitted(action: string): TerminalSessionState | null {
    const state = this.view.session;
    if (!this.isOwner() || !this.live() || !this.channelConfirmed() || this.view.phase !== 'ready' || this.view.pending || this.view.result?.state === 'unknown' && !this.view.unknownAcknowledged || state === null || !state.connected || !state.capabilities.observe || !state.capabilities.control || !state.capabilities.archive || !state.control?.availableActions.some(a => a === action)) return null;
    return state;
  }
  control = async (action: SessionV2Payloads['control_request']['action'], confirmation: { draftHandled?: boolean; initialUnknownDisposition?: 'delivered_continue' | null } = {}): Promise<void> => {
    const state = this.admitted(action); if (state === null || state.control === null) return;
    if ((action === 'renew_control' || action === 'release_control') && !this.ownsLease()) return;
    await this.dispatch({ ...terminalEnvelope(state), type: 'control_request', payload: { operationId: crypto.randomUUID(), connectionEpoch: state.connectionEpoch, controlEpoch: state.control.controlEpoch, action, browserClientId: this.browserClientId, leaseId: action === 'acquire_control' ? null : state.control.lease?.leaseId ?? null, draftHandled: confirmation.draftHandled ?? false, initialUnknownDisposition: confirmation.initialUnknownDisposition ?? null } });
  };
  paste = async (text: string): Promise<void> => {
    if (text.length === 0 || !text.isWellFormed() || new TextEncoder().encode(text).length > SESSION_V2_LIMITS.inputMaxBytes) { this.publish({ error: new ApiError('protocol', null, 'invalid_payload') }); return; }
    await this.input('paste', { text });
  };
  key = async (key: SessionV2Key): Promise<void> => { await this.input('keys', { key }); };
  private async input(kind: 'paste' | 'keys', payload: { text: string } | { key: SessionV2Key }) {
    const state = this.admitted(kind); if (state === null || state.control?.lease == null || state.snapshot === null || !this.ownsLease()) return;
    this.leaseSeq++;
    const base = { operationId: crypto.randomUUID(), connectionEpoch: state.connectionEpoch, segmentId: state.snapshot.segmentId, binding: state.snapshot.binding, controlEpoch: state.control.controlEpoch, leaseId: state.control.lease.leaseId, leaseSeq: String(this.leaseSeq) };
    const operation = kind === 'paste' ? { ...base, kind, payload: payload as { text: string } } : { ...base, kind, payload: payload as { key: SessionV2Key } };
    await this.dispatch({ ...terminalEnvelope(state), type: 'operation', payload: operation });
  }
  private markUnknown(pending: Pending, error: unknown = null) {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer); this.pollTimer = null;
    this.publish({ pending: false, result: { operationId: pending.command.payload.operationId, state: 'unknown', errorCode: 'input_unknown' }, error });
  }
  private async boundedRequest<T>(controller: AbortController, timeoutMs: number, run: () => Promise<T>): Promise<T> {
    // Abort must settle recovery even if a transport never acknowledges cancellation.
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    const timeout = setTimeout(() => controller.abort(new Error('The operation receipt timed out.')), Math.max(0, timeoutMs));
    try { return await Promise.race([run(), cancelled]); }
    finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', abort); }
  }
  private async dispatch(command: TerminalCommand) {
    const pending = { command, generation: this.generation, startedAt: Date.now() }; if (!this.persist(pending)) return; this.pendingOperation = pending;
    this.publish({ pending: true, unknownAcknowledged: false, result: { operationId: command.payload.operationId, state: 'queued', errorCode: null }, error: null });
    if (!this.live(pending.generation)) {
      if (this.pendingOperation === pending) {
        if (this.persist(null)) { this.pendingOperation = null; this.publish({ pending: false, result: null }); }
        else this.markUnknown(pending, this.persistenceError);
      }
      return;
    }
    const controller = this.request();
    try {
      const result = await this.boundedRequest(controller, SESSION_V2_LIMITS.inputTimeoutMs, () => this.options.api.command(command.sessionId, this.browserClientId, command, controller.signal));
      if (this.live(pending.generation) && this.pendingOperation === pending) this.admitResult(result, pending);
    } catch (error) {
      if (this.live(pending.generation) && this.pendingOperation === pending) {
        if (error instanceof ApiError && ([401, 403, 404, 410].includes(error.status ?? 0) || error.code === 'principal_mismatch')) { this.invalidate(error); return; }
        // These command-route refusals precede insertion into the relay operation ledger.
        const refusal = error instanceof ApiError && error.kind === 'server' && error.status === 409 ? admissionRefusals.find(code => code === error.code) : undefined;
        if (refusal !== undefined) {
          if (this.pollTimer !== null) clearTimeout(this.pollTimer); this.pollTimer = null;
          this.pendingOperation = null; this.persist(null);
          this.publish({ pending: false, result: { operationId: command.payload.operationId, state: 'rejected', errorCode: refusal }, error });
          void this.refresh(); return;
        }
        this.markUnknown(pending, error);
      }
    } finally { this.forget(controller); }
  }
  private admitResult(result: TerminalResult, pending: Pending) {
    const command = pending.command;
    if (result.sessionId !== command.sessionId || result.claimId !== command.claimId || result.executionGeneration !== command.executionGeneration || result.payload.operationId !== command.payload.operationId) { this.invalidate(); return; }
    if (!terminal(result.payload.state) && Date.now() - pending.startedAt >= SESSION_V2_LIMITS.inputTimeoutMs) { this.markUnknown(pending); return; }
    const generation = this.generation;
    this.publish({ pending: !terminal(result.payload.state), result: result.payload });
    if (terminal(result.payload.state)) { if (this.pollTimer !== null) clearTimeout(this.pollTimer); this.pollTimer = null; if (result.payload.state !== 'unknown') this.persist(null); void this.refresh(); return; }
    if (!this.live(generation)) return;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => { this.pollTimer = null; void this.queryOperation(true); }, Math.min(500, SESSION_V2_LIMITS.inputTimeoutMs - (Date.now() - pending.startedAt)));
  }
  checkOperation = (): Promise<void> => this.queryOperation(false);
  private async queryOperation(automatic: boolean): Promise<void> {
    const pending = this.pendingOperation; if (!this.live() || pending === null) return;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer); this.pollTimer = null;
    const generation = this.generation, controller = this.request(), original = this.view.session;
    const ownsQuery = () => this.live(generation) && this.pendingOperation === pending && (original === null || this.view.session !== null && sameTerminalFence(original, this.view.session) && (pending.command.type !== 'operation' || original.control?.controlEpoch === this.view.session.control?.controlEpoch));
    const remaining = automatic || this.view.pending ? pending.startedAt + SESSION_V2_LIMITS.inputTimeoutMs - Date.now() : SESSION_V2_LIMITS.inputTimeoutMs;
    try {
      const result = await this.boundedRequest(controller, remaining, async () => {
        try { return await this.options.api.operation(pending.command.sessionId, pending.command.payload.operationId, controller.signal); }
        catch (error) {
          if (controller.signal.aborted || !ownsQuery() || !(error instanceof ApiError) || error.status !== 404 || error.code === 'principal_mismatch') throw error;
          // A receipt row may never have existed. Only the original Session read can establish access loss.
          const session = await this.options.api.state(pending.command.sessionId, controller.signal);
          if (!ownsQuery()) return null;
          if (session.sessionId !== pending.command.sessionId || session.claimId !== pending.command.claimId || session.executionGeneration !== pending.command.executionGeneration) throw new ApiError('protocol', null, 'stale_fence');
          return null;
        }
      });
      if (!ownsQuery()) return;
      if (result === null) this.markUnknown(pending);
      else this.admitResult(result, pending);
    } catch (error) {
      if (ownsQuery()) {
        this.markUnknown(pending, error);
        if (ownsQuery() && error instanceof ApiError && ([401, 403, 404, 410].includes(error.status ?? 0) || error.code === 'principal_mismatch')) this.invalidate(error);
      }
    } finally { this.forget(controller); }
  }
  acknowledgeUnknown = (): void => { if (!this.owned() || this.view.result?.state !== 'unknown' || !this.persist(this.pendingOperation, true)) return; this.publish({ unknownAcknowledged: true, pending: false, error: null }); };
  invalidate = (reason: unknown = new ApiError('server', 403, 'permission_denied')): void => { this.ended = true; this.visible = false; this.stopTransport(); this.pendingOperation = null; this.publish({ phase: 'unavailable', availability: null, transport: 'disconnected', session: null, pending: false, ownsControl: false, result: null, error: reason }); };
  close = (): void => { this.ended = true; this.visible = false; this.stopTransport(); this.listeners.clear(); };
}
