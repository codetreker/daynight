import { ApiError } from '../../api/client';
import { terminalEnvelope, type TerminalCommand, type TerminalResult, type TerminalSessionApi, type TerminalSessionState } from '../../api/terminal-sessions';
import { SESSION_V2_LIMITS, canonicalSessionJson, exact, seq, uuid, choice, bool } from '../../../../daynight/src/session/v2/values';
import type { SessionV2Key, SessionV2Payloads } from '../../../../daynight/src/session/v2/types';

export type TerminalClientSnapshot = {
  phase: 'loading' | 'ready' | 'disconnected' | 'unavailable' | 'error';
  session: TerminalSessionState | null; pending: boolean; ownsControl: boolean;
  result: SessionV2Payloads['operation_result'] | null; error: unknown | null; unknownAcknowledged: boolean;
};
type Options = { api: TerminalSessionApi; claimId: string; userId: string; browserClientId?: string; isCurrent?: () => boolean; storage?: Storage | null };
type TrackedCommand = Pick<TerminalCommand, 'sessionId' | 'claimId' | 'executionGeneration' | 'type'> & { payload: { operationId: string; controlEpoch: string } };
type Pending = { command: TrackedCommand; generation: number; startedAt: number };
// Native conversation identity may be enriched without changing the execution target.
export const sameTerminalFence = (a: TerminalSessionState, b: TerminalSessionState) => a.sessionId === b.sessionId && a.claimId === b.claimId && a.executionGeneration === b.executionGeneration && a.connectionEpoch === b.connectionEpoch && canonicalSessionJson({ ...a.binding, nativeSessionId: null }) === canonicalSessionJson({ ...b.binding, nativeSessionId: null });
const terminal = (state: SessionV2Payloads['operation_result']['state']) => state === 'transport_completed' || state === 'rejected' || state === 'unknown';
const admissionRefusals = ['input_busy', 'stale_fence', 'lease_expired', 'automation_suspended'] as const;

/** Owns one visible viewer, never a native attach or an automatic input retry. */
export class TerminalSessionClient {
  readonly browserClientId: string;
  private view: TerminalClientSnapshot = { phase: 'loading', session: null, pending: false, ownsControl: false, result: null, error: null, unknownAcknowledged: false };
  private listeners = new Set<() => void>();
  private visible = false;
  private ended = false;
  private generation = 0;
  private channel: { close(): void } | null = null;
  private requests = new Set<AbortController>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private pendingOperation: Pending | null = null;
  private leaseKey: string | null = null;
  private leaseSeq = 0n;
  private opening = false;
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
  private live(generation = this.generation) { return this.owned() && this.visible && (this.options.isCurrent?.() ?? true) && generation === this.generation; }
  private ownsLease() { const lease = this.view.session?.control?.lease; return this.live() && this.view.phase === 'ready' && this.view.session?.connected === true && this.view.session.control?.state === 'manual' && lease?.holderUserId === this.options.userId && lease.browserClientId === this.browserClientId && Date.parse(lease.expiresAt) > Date.now(); }
  private publish(change: Partial<TerminalClientSnapshot>) {
    this.view = { ...this.view, ...change, ...(this.persistenceError === null ? {} : { error: this.persistenceError, phase: 'error' as const }) };
    this.view = { ...this.view, ownsControl: this.ownsLease() };
    for (const listener of this.listeners) listener();
  }
  private request() { const controller = new AbortController(); this.requests.add(controller); return controller; }
  private forget(controller: AbortController) { this.requests.delete(controller); }
  private stopTransport() {
    this.generation++; this.opening = false;
    this.channel?.close(); this.channel = null;
    for (const c of this.requests) c.abort(); this.requests.clear();
    if (this.pollTimer !== null) clearTimeout(this.pollTimer); this.pollTimer = null;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    if (this.renewTimer !== null) clearInterval(this.renewTimer); this.renewTimer = null;
    if (this.view.pending && this.pendingOperation !== null) this.publish({ pending: false, result: { operationId: this.pendingOperation.command.payload.operationId, state: 'unknown', errorCode: 'input_unknown' } });
  }
  setVisible = (visible: boolean): void => {
    if (!this.owned()) return;
    if (this.visible === visible) { if (visible && this.channel === null) void this.start(); return; }
    this.visible = visible;
    if (!visible) { this.stopTransport(); this.publish({ phase: 'disconnected', ownsControl: false }); }
    else void this.start();
  };
  private receive(next: TerminalSessionState, generation: number, phase?: 'loading') {
    if (!this.live(generation)) return;
    if (next.claimId !== this.options.claimId) { this.invalidate(new ApiError('protocol', null, 'stale_fence')); return; }
    const previous = this.view.session;
    if (previous !== null && (BigInt(next.executionGeneration) < BigInt(previous.executionGeneration) || BigInt(next.connectionEpoch) < BigInt(previous.connectionEpoch))) return;
    if (previous !== null && sameTerminalFence(previous, next)) {
      if (previous.binding.nativeSessionId !== null) {
        if (next.binding.nativeSessionId === null) return;
        if (next.binding.nativeSessionId !== previous.binding.nativeSessionId) { this.invalidate(new ApiError('protocol', null, 'stale_fence')); return; }
      }
      if (previous.control && (next.control === null || BigInt(next.control.controlEpoch) < BigInt(previous.control.controlEpoch))) next = { ...next, control: previous.control };
      const before = previous.snapshot, after = next.snapshot;
      if (before && after && (BigInt(after.segmentOrdinal) < BigInt(before.segmentOrdinal) || after.segmentId === before.segmentId && BigInt(after.frame.frameSeq) < BigInt(before.frame.frameSeq))) next = { ...next, snapshot: { ...before, binding: next.binding } };
    }
    if (previous !== null && previous.sessionId !== next.sessionId) { this.invalidate(new ApiError('protocol', null, 'stale_fence')); return; }
    if (previous !== null && (!sameTerminalFence(previous, next) || this.pendingOperation?.command.type === 'operation' && previous.control?.controlEpoch !== next.control?.controlEpoch)) {
      if (this.view.pending && this.pendingOperation !== null) {
        if (this.pollTimer !== null) clearTimeout(this.pollTimer); this.pollTimer = null;
        this.publish({ pending: false, result: { operationId: this.pendingOperation.command.payload.operationId, state: 'unknown', errorCode: 'input_unknown' } });
        this.pendingOperation = { ...this.pendingOperation, generation: -1 };
      }
    }
    // Binding enrichment can preserve the lease and its accepted input sequence.
    const lease = next.control?.lease;
    const key = lease === null || lease === undefined ? null : `${lease.leaseId}:${lease.controlEpoch}`;
    if (key !== this.leaseKey) { this.leaseKey = key; this.leaseSeq = 0n; }
    this.publish({ session: next, phase: phase ?? (next.connected ? 'ready' : 'disconnected'), error: null });
  }
  private async start() {
    if (!this.live() || this.opening) return;
    this.opening = true; const generation = this.generation, controller = this.request();
    this.publish({ phase: 'loading', error: null });
    try {
      const current = this.view.session === null ? await this.options.api.current(controller.signal) : await this.options.api.state(this.view.session.sessionId, controller.signal);
      if (!this.live(generation)) return;
      if (current.status !== 'registered') { this.publish({ phase: 'unavailable', session: null }); this.scheduleReconnect(); return; }
      if (current.claimId !== this.options.claimId) { this.invalidate(new ApiError('protocol', null, 'stale_fence')); return; }
      this.receive(current, generation, 'loading');
      if (!this.live(generation) || this.view.session === null) return;
      this.channel = this.options.api.channel(this.view.session.sessionId, this.browserClientId, state => this.receive(state, generation), error => {
        if (!this.live(generation)) return;
        this.stopTransport(); this.publish({ phase: 'disconnected', error: error ?? null }); this.scheduleReconnect();
      });
      this.renewTimer = setInterval(() => { if (!this.live()) { this.stopTransport(); this.publish({ phase: 'disconnected' }); return; } this.publish({}); if (this.view.ownsControl && !this.view.pending) void this.control('renew_control'); }, SESSION_V2_LIMITS.leaseRenewMs);
    } catch (error) { if (this.live(generation)) this.failure(error); }
    finally { this.forget(controller); if (generation === this.generation) this.opening = false; }
  }
  private scheduleReconnect() {
    if (!this.live() || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.start(); }, 1500);
  }
  private failure(error: unknown) {
    if (error instanceof ApiError && ([401, 403, 404, 410].includes(error.status ?? 0) || error.code === 'principal_mismatch')) { this.invalidate(error); return; }
    this.stopTransport(); this.publish({ phase: this.view.session === null ? 'error' : 'disconnected', error });
    this.scheduleReconnect();
  }
  refresh = async (): Promise<void> => {
    if (!this.live()) return;
    if (this.channel === null || this.view.session === null) { await this.start(); return; }
    const generation = this.generation, controller = this.request();
    try { this.receive(await this.options.api.state(this.view.session.sessionId, controller.signal), generation); }
    catch (error) { if (this.live(generation)) this.failure(error); }
    finally { this.forget(controller); }
  };
  private admitted(action: string): TerminalSessionState | null {
    const state = this.view.session;
    if (!this.live() || this.view.phase !== 'ready' || this.view.pending || this.view.result?.state === 'unknown' && !this.view.unknownAcknowledged || state === null || !state.connected || !state.capabilities.observe || !state.capabilities.control || !state.capabilities.archive || !state.control?.availableActions.some(a => a === action)) return null;
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
    this.publish({ pending: !terminal(result.payload.state), result: result.payload });
    if (terminal(result.payload.state)) { if (this.pollTimer !== null) clearTimeout(this.pollTimer); this.pollTimer = null; if (result.payload.state !== 'unknown') this.persist(null); void this.refresh(); return; }
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
        if (error instanceof ApiError && ([401, 403, 404, 410].includes(error.status ?? 0) || error.code === 'principal_mismatch')) this.invalidate(error);
      }
    } finally { this.forget(controller); }
  }
  acknowledgeUnknown = (): void => { if (!this.owned() || this.view.result?.state !== 'unknown' || !this.persist(this.pendingOperation, true)) return; this.publish({ unknownAcknowledged: true, pending: false, error: null }); };
  invalidate = (reason: unknown = new ApiError('server', 403, 'permission_denied')): void => { this.ended = true; this.visible = false; this.stopTransport(); this.pendingOperation = null; this.publish({ phase: 'unavailable', session: null, pending: false, ownsControl: false, result: null, error: reason }); };
  close = (): void => { this.ended = true; this.visible = false; this.stopTransport(); this.listeners.clear(); };
}
