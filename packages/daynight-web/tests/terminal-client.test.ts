import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { TerminalSessionClient } from '../src/features/task-agent-session/terminal-client';
import { parseTerminalSessionState, terminalEnvelope, type TerminalSessionApi, type TerminalSessionState, type TerminalResult } from '../src/api/terminal-sessions';
const fixture = (name: string) => JSON.parse(readFileSync(`../daynight/test/session/fixtures/v2/${name}.json`, 'utf8'));
const r = fixture('valid-registration'), owner = r.payload.owner, browser = '00000000-0000-4000-8000-000000000012';
function state(): TerminalSessionState { return parseTerminalSessionState({ status: 'registered', ...terminalEnvelope(r), owner, binding: r.payload.binding, connectionEpoch: '1', connected: true, capabilities: r.payload.capabilities, control: { ...fixture('valid-control').payload, state: 'automation', lease: null, availableActions: ['acquire_control'] }, snapshot: fixture('valid-snapshot').payload, ledger: fixture('valid-active-ledger').payload, archive: fixture('valid-status-pending').payload, recording: [] }, owner.projectId, owner.taskId, owner.serverOrigin); }
function harness(isCurrent?: () => boolean) {
  let current = state(); let receive: (s: TerminalSessionState) => void = () => {}; let disconnect: (e?: unknown) => void = () => {};
  const close = vi.fn();
  const result = (operationId: string): TerminalResult => ({ ...terminalEnvelope(current), type: 'operation_result', payload: { operationId, state: 'queued', errorCode: null } });
  const api: TerminalSessionApi = { current: vi.fn(async () => current), state: vi.fn(async () => current), history: vi.fn(), archive: vi.fn(), nativeArchive: vi.fn(), command: vi.fn(async (_id, _browser, m) => result(m.payload.operationId)), operation: vi.fn(async (_id, id) => result(id)), channel: vi.fn((_id, _browser, onState, onClose) => { receive = onState; disconnect = onClose; return { close }; }) };
  const client = new TerminalSessionClient({ api, claimId: r.claimId, userId: owner.ownerUserId, browserClientId: browser, ...(isCurrent ? { isCurrent } : {}) });
  return { client, api, close, publish(next = current) { current = next; receive(next); }, disconnect(error?: unknown) { disconnect(error); }, state: () => current, manual() { const next = state(); next.control = fixture('valid-control').payload; next.control!.lease!.expiresAt = '2099-01-01T00:00:00Z'; next.control!.availableActions = ['paste', 'keys', 'release_control', 'renew_control']; current = next; receive(next); } };
}
afterEach(() => { vi.useRealTimers(); window.sessionStorage.clear(); });
describe('terminal client control ownership', () => {
  it('only subscribes when visible and closes its read subscription on hiding', async () => {
    const h = harness(); expect(h.api.current).not.toHaveBeenCalled(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.publish();
    expect(h.client.getSnapshot().phase).toBe('ready'); h.client.setVisible(false); expect(h.close).toHaveBeenCalledOnce(); expect(h.client.getSnapshot().ownsControl).toBe(false); h.client.close();
  });
  it('does not enable input from a queued acquire and allows it only after Worker state confirms the lease', async () => {
    const h = harness(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.publish();
    void h.client.control('acquire_control'); await vi.waitFor(() => expect(h.api.command).toHaveBeenCalledOnce());
    expect(h.client.getSnapshot().ownsControl).toBe(false); expect(h.client.getSnapshot().pending).toBe(true);
    await h.client.paste('must not send'); expect(h.api.command).toHaveBeenCalledOnce(); h.client.close();
  });
  it('does not resend an input after a network failure and only queries its original operation', async () => {
    const h = harness(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.manual();
    vi.mocked(h.api.command).mockRejectedValue(new Error('lost response'));
    await h.client.paste('中文\nnext'); expect(h.api.command).toHaveBeenCalledOnce(); expect(h.client.getSnapshot().result?.state).toBe('unknown');
    const first = vi.mocked(h.api.command).mock.calls[0]![2]; await h.client.checkOperation();
    expect(h.api.operation).toHaveBeenCalledWith(r.sessionId, first.payload.operationId, expect.any(AbortSignal)); expect(h.api.command).toHaveBeenCalledOnce(); h.client.close();
  });
  it('rejects a stale claim and clears content on access invalidation', async () => {
    const h = harness(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.publish({ ...h.state(), claimId: owner.projectId });
    expect(h.client.getSnapshot().session).toBeNull(); expect(h.client.getSnapshot().ownsControl).toBe(false); h.client.invalidate(); expect(h.close).toHaveBeenCalled(); h.client.close();
  });
  it('does not dispatch oversized Unicode or accept another browser lease', async () => {
    const h = harness(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.manual();
    await h.client.paste('中'.repeat(6000)); expect(h.api.command).not.toHaveBeenCalled();
    const other = structuredClone(h.state()); other.control!.lease!.browserClientId = owner.worktreeId; h.publish(other); await h.client.key('Enter'); expect(h.api.command).not.toHaveBeenCalled(); h.client.close();
  });
  it('keeps a newer complete frame when a slower refresh returns an older sample', async () => {
    const h = harness(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce());
    const newer = state(); newer.snapshot!.frame.frameSeq = '8'; h.publish(newer); h.publish(state());
    expect(h.client.getSnapshot().session?.snapshot?.frame.frameSeq).toBe('8'); h.client.close();
  });
  it('ignores a late result after replacement binding and never restores the old control', async () => {
    const h = harness(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.manual();
    let resolve!: (r: TerminalResult) => void; vi.mocked(h.api.command).mockImplementation(() => new Promise(r => { resolve = r; }));
    const sending = h.client.paste('old target'); const command = vi.mocked(h.api.command).mock.calls[0]![2];
    const replacement = structuredClone(h.state()); replacement.connectionEpoch = '2'; replacement.control!.connectionEpoch = '2'; replacement.binding.terminalId = 'new-terminal'; replacement.snapshot = null; h.publish(replacement);
    resolve({ ...terminalEnvelope(command), type: 'operation_result', payload: { operationId: command.payload.operationId, state: 'transport_completed', errorCode: null } }); await sending;
    expect(h.client.getSnapshot().result?.state).toBe('unknown'); expect(h.client.getSnapshot().session?.snapshot).toBeNull(); h.client.close();
  });
  it('renews only the visible owning lease and cancels renewal when hidden', async () => {
    vi.useFakeTimers(); const h = harness(); h.client.setVisible(true); await vi.advanceTimersByTimeAsync(0); h.manual();
    await vi.advanceTimersByTimeAsync(10_000); expect(h.api.command).toHaveBeenCalledOnce();
    expect(vi.mocked(h.api.command).mock.calls[0]![2].payload).toMatchObject({ action: 'renew_control' });
    h.client.setVisible(false); await vi.advanceTimersByTimeAsync(30_000); expect(h.api.command).toHaveBeenCalledOnce(); h.client.close();
  });

  it('resumes observation after a temporary authentication gate without resurrecting its lease', async () => {
    let current = true; const h = harness(() => current); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.manual();
    current = false; h.client.setVisible(false); current = true; h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledTimes(2));
    expect(h.client.getSnapshot().ownsControl).toBe(false); h.publish(state()); expect(h.client.getSnapshot().phase).toBe('ready'); h.client.close();
  });
  it('blocks new input while its unknown receipt remains unresolved, until explicit acknowledgement', async () => {
    const h = harness(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.manual();
    vi.mocked(h.api.command).mockRejectedValue(new Error('lost receipt')); await h.client.paste('first'); await h.client.paste('second'); await h.client.control('renew_control'); expect(h.api.command).toHaveBeenCalledOnce();
    h.client.acknowledgeUnknown(); await h.client.paste('intentional next input'); expect(h.api.command).toHaveBeenCalledTimes(2); expect(vi.mocked(h.api.command).mock.calls[1]![2].payload.operationId).not.toBe(vi.mocked(h.api.command).mock.calls[0]![2].payload.operationId); h.client.close();
  });
  it('keeps a revoked input unknown when its late transport receipt arrives', async () => {
    const h = harness(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.manual();
    let resolve!: (r: TerminalResult) => void; vi.mocked(h.api.command).mockImplementation(() => new Promise(r => { resolve = r; }));
    const sending = h.client.paste('before revoke'); const command = vi.mocked(h.api.command).mock.calls[0]![2];
    const revoked = state(); revoked.control = { ...revoked.control!, state: 'suspended', controlEpoch: '2', lease: null, availableActions: ['acquire_control'] }; h.publish(revoked);
    resolve({ ...terminalEnvelope(command), type: 'operation_result', payload: { operationId: command.payload.operationId, state: 'transport_completed', errorCode: null } }); await sending;
    expect(h.client.getSnapshot().result?.state).toBe('unknown'); expect(h.client.getSnapshot().ownsControl).toBe(false); h.client.close();
  });

  it('restores a pending operation across refresh without storing its input or replaying it', async () => {
    const h = harness(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.manual(); vi.mocked(h.api.command).mockRejectedValue(new Error('lost'));
    await h.client.paste('secret-input-never-stored'); const original = vi.mocked(h.api.command).mock.calls[0]![2]; h.client.close();
    const stored = window.sessionStorage.getItem(`daynight:terminal-operation:${owner.ownerUserId}:${r.claimId}`); expect(stored).not.toContain('secret-input-never-stored'); expect(stored).toContain(original.payload.operationId);
    const replacement = harness(); expect(replacement.client.getSnapshot().result?.state).toBe('unknown'); replacement.client.setVisible(true); await vi.waitFor(() => expect(replacement.api.channel).toHaveBeenCalledOnce()); replacement.manual(); await replacement.client.paste('must remain blocked'); expect(replacement.api.command).not.toHaveBeenCalled();
    await replacement.client.checkOperation(); expect(replacement.api.operation).toHaveBeenCalledWith(r.sessionId, original.payload.operationId, expect.any(AbortSignal)); replacement.client.close();
  });
  it('preserves a safe permission error while clearing protected content', async () => {
    const h = harness(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.manual(); vi.mocked(h.api.state).mockRejectedValue(new ApiError('server', 403, 'permission_denied')); await h.client.refresh();
    expect(h.client.getSnapshot()).toMatchObject({ session: null, ownsControl: false, error: { code: 'permission_denied' } }); h.client.close();
  });
  it('does not send an operation when its intent cannot be retained', async () => {
    const h = harness(); const client = new TerminalSessionClient({ api: h.api, claimId: r.claimId, userId: owner.ownerUserId, browserClientId: browser, storage: null }); client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.manual(); await client.paste('cannot record intent');
    expect(h.api.command).not.toHaveBeenCalled(); expect(client.getSnapshot().error).toMatchObject({ code: 'operation_storage_unavailable' }); client.close(); h.client.close();
  });

  it('refuses input after lease expiry even before another channel event', async () => {
    vi.useFakeTimers(); const h = harness(); h.client.setVisible(true); await vi.advanceTimersByTimeAsync(0); h.manual(); const expiring = structuredClone(h.state()); expiring.control!.lease!.expiresAt = new Date(Date.now() + 500).toISOString(); h.publish(expiring); await vi.advanceTimersByTimeAsync(501); await h.client.paste('expired'); expect(h.api.command).not.toHaveBeenCalled(); h.client.close();
  });

  it('reconnects a disconnected viewer without replaying its pending input', async () => {
    vi.useFakeTimers(); const h = harness(); h.client.setVisible(true); await vi.advanceTimersByTimeAsync(0); h.manual(); await h.client.paste('one request'); h.disconnect(new Error('offline')); expect(h.client.getSnapshot().phase).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(1500); expect(h.api.channel).toHaveBeenCalledTimes(2); expect(h.api.command).toHaveBeenCalledOnce(); expect(h.client.getSnapshot().result?.state).toBe('unknown'); h.client.close();
  });
  it('stops automatic receipt polling at the input deadline and permits explicit readback', async () => {
    vi.useFakeTimers(); const h = harness(); h.client.setVisible(true); await vi.advanceTimersByTimeAsync(0); h.manual(); await h.client.paste('one request'); await vi.advanceTimersByTimeAsync(10_000);
    expect(h.client.getSnapshot()).toMatchObject({ pending: false, result: { state: 'unknown' } }); const queries = vi.mocked(h.api.operation).mock.calls.length; await vi.advanceTimersByTimeAsync(2000); expect(h.api.operation).toHaveBeenCalledTimes(queries); await h.client.checkOperation(); expect(h.api.operation).toHaveBeenCalledTimes(queries + 1); h.client.close();
  });
  it('continues discovery after the worker registers and reports read failures without stale control', async () => {
    vi.useFakeTimers(); const h = harness(); vi.mocked(h.api.current).mockResolvedValueOnce({ status: 'not_registered', protocol: r.protocol, claimId: r.claimId, agentControlMode: 'herdr' }); h.client.setVisible(true); await vi.advanceTimersByTimeAsync(0); expect(h.client.getSnapshot().phase).toBe('unavailable'); await vi.advanceTimersByTimeAsync(1500); h.manual();
    vi.mocked(h.api.state).mockRejectedValueOnce(new Error('read disconnected')); await h.client.refresh(); expect(h.client.getSnapshot()).toMatchObject({ phase: 'disconnected', ownsControl: false }); expect(h.close).toHaveBeenCalled(); h.client.close();
  });
  it('retains failed operation-query uncertainty and removes successful intents from storage', async () => {
    const h = harness(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.manual(); await h.client.paste('query only'); const command = vi.mocked(h.api.command).mock.calls[0]![2]; vi.mocked(h.api.operation).mockRejectedValueOnce(new Error('query failed')); await h.client.checkOperation(); expect(h.client.getSnapshot().result?.state).toBe('unknown');
    vi.mocked(h.api.operation).mockResolvedValueOnce({ ...terminalEnvelope(command), type: 'operation_result', payload: { operationId: command.payload.operationId, state: 'transport_completed', errorCode: null } }); await h.client.checkOperation(); expect(window.sessionStorage.getItem(`daynight:terminal-operation:${owner.ownerUserId}:${r.claimId}`)).toBeNull(); expect(h.api.command).toHaveBeenCalledOnce(); h.client.close();
  });

  it('bounds a stalled receipt GET by the original operation deadline without replaying it', async () => {
    vi.useFakeTimers(); const h = harness(); h.client.setVisible(true); await vi.advanceTimersByTimeAsync(0); h.publish();
    let receiptSignal!: AbortSignal;
    vi.mocked(h.api.operation).mockImplementation((_session, _operation, signal) => { receiptSignal = signal; return new Promise(() => {}); });
    await h.client.control('acquire_control');
    const command = vi.mocked(h.api.command).mock.calls[0]![2];
    await vi.advanceTimersByTimeAsync(500); expect(h.client.getSnapshot().pending).toBe(true);
    await vi.advanceTimersByTimeAsync(9500);
    expect(h.client.getSnapshot()).toMatchObject({ pending: false, result: { operationId: command.payload.operationId, state: 'unknown' } });
    expect(receiptSignal.aborted).toBe(true);
    expect(h.api.command).toHaveBeenCalledOnce(); expect(h.api.operation).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem(`daynight:terminal-operation:${owner.ownerUserId}:${r.claimId}`)).toContain(command.payload.operationId);
    h.client.close();
  });
  it('bounds explicit receipt readback even after the original deadline has elapsed', async () => {
    vi.useFakeTimers(); const h = harness(); h.client.setVisible(true); await vi.advanceTimersByTimeAsync(0); h.manual();
    vi.mocked(h.api.command).mockRejectedValue(new Error('lost response')); await h.client.paste('one request');
    await vi.advanceTimersByTimeAsync(11000);
    let receiptSignal!: AbortSignal;
    vi.mocked(h.api.operation).mockImplementation((_session, _operation, signal) => { receiptSignal = signal; return new Promise(() => {}); });
    let finished = false; const checking = h.client.checkOperation().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(10000);
    expect(finished).toBe(true); expect(receiptSignal.aborted).toBe(true);
    expect(h.client.getSnapshot().result?.state).toBe('unknown'); expect(h.api.command).toHaveBeenCalledOnce();
    await checking; h.client.close();
  });

  it('keeps an absent receipt unknown after independently verifying the original Session', async () => {
    const h = harness(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.manual();
    vi.mocked(h.api.command).mockRejectedValue(new ApiError('server', 409, 'input_busy')); await h.client.paste('not accepted');
    const command = vi.mocked(h.api.command).mock.calls[0]![2];
    vi.mocked(h.api.operation).mockRejectedValue(new ApiError('server', 404, 'not_found')); await h.client.checkOperation();
    expect(h.client.getSnapshot()).toMatchObject({ phase: 'ready', pending: false, error: null, result: { operationId: command.payload.operationId, state: 'unknown' } });
    expect(h.api.state).toHaveBeenCalledWith(command.sessionId, expect.any(AbortSignal));
    expect(h.api.current).toHaveBeenCalledOnce(); expect(h.api.command).toHaveBeenCalledOnce();
    h.client.acknowledgeUnknown(); expect(h.client.getSnapshot().unknownAcknowledged).toBe(true);
    await h.client.paste('new intentional input'); expect(h.api.command).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.api.command).mock.calls[1]![2].payload.operationId).not.toBe(command.payload.operationId); h.client.close();
  });
  it('ignores a failed old receipt query after acknowledgement and a new operation', async () => {
    const h = harness(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.manual();
    vi.mocked(h.api.command).mockRejectedValueOnce(new Error('lost response')); await h.client.paste('old');
    let reject!: (error: unknown) => void; vi.mocked(h.api.operation).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const checking = h.client.checkOperation(); h.client.acknowledgeUnknown(); await h.client.paste('new');
    const command = vi.mocked(h.api.command).mock.calls[1]![2]; reject(new ApiError('server', 404, 'not_found')); await checking;
    expect(h.client.getSnapshot()).toMatchObject({ phase: 'ready', pending: true, result: { operationId: command.payload.operationId, state: 'queued' } });
    expect(h.api.state).not.toHaveBeenCalled(); h.client.close();
  });

  it('does not continue automatic polling after an explicit missing-receipt readback', async () => {
    vi.useFakeTimers(); const h = harness(); h.client.setVisible(true); await vi.advanceTimersByTimeAsync(0); h.publish();
    await h.client.control('acquire_control'); vi.mocked(h.api.operation).mockRejectedValue(new ApiError('server', 404, 'not_found'));
    await h.client.checkOperation(); expect(h.client.getSnapshot().result?.state).toBe('unknown');
    await vi.advanceTimersByTimeAsync(2000); expect(h.api.operation).toHaveBeenCalledOnce(); h.client.close();
  });
  it('bounds a missing-receipt Session verification that never finishes', async () => {
    vi.useFakeTimers(); const h = harness(); h.client.setVisible(true); await vi.advanceTimersByTimeAsync(0); h.manual();
    vi.mocked(h.api.command).mockRejectedValue(new Error('lost response')); await h.client.paste('unknown');
    vi.mocked(h.api.operation).mockRejectedValue(new ApiError('server', 404, 'not_found'));
    let accessSignal!: AbortSignal; vi.mocked(h.api.state).mockImplementation((_id, signal) => { accessSignal = signal; return new Promise(() => {}); });
    let finished = false; const checking = h.client.checkOperation().then(() => { finished = true; }); await vi.advanceTimersByTimeAsync(10000);
    expect(finished).toBe(true); expect(accessSignal.aborted).toBe(true);
    expect(h.client.getSnapshot()).toMatchObject({ phase: 'ready', pending: false, result: { state: 'unknown' } });
    h.client.acknowledgeUnknown(); expect(h.client.getSnapshot().unknownAcknowledged).toBe(true); await checking; h.client.close();
  });
  it.each([401, 403, 404, 410])('invalidates when the original Session independently rejects access with %i', async status => {
    const h = harness(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.manual();
    vi.mocked(h.api.command).mockRejectedValue(new Error('lost response')); await h.client.paste('unknown');
    vi.mocked(h.api.operation).mockRejectedValue(new ApiError('server', 404, 'not_found')); vi.mocked(h.api.state).mockRejectedValue(new ApiError('server', status, 'permission_denied'));
    await h.client.checkOperation(); expect(h.client.getSnapshot()).toMatchObject({ phase: 'unavailable', session: null, ownsControl: false }); h.client.close();
  });
  it('ignores a late Session verification refusal after a new operation takes ownership', async () => {
    const h = harness(); h.client.setVisible(true); await vi.waitFor(() => expect(h.api.channel).toHaveBeenCalledOnce()); h.manual();
    vi.mocked(h.api.command).mockRejectedValueOnce(new Error('lost response')); await h.client.paste('old');
    vi.mocked(h.api.operation).mockRejectedValue(new ApiError('server', 404, 'not_found'));
    let reject!: (e: unknown) => void; vi.mocked(h.api.state).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const checking = h.client.checkOperation(); await vi.waitFor(() => expect(h.api.state).toHaveBeenCalledOnce());
    h.client.acknowledgeUnknown(); await h.client.paste('new'); const command = vi.mocked(h.api.command).mock.calls[1]![2];
    reject(new ApiError('server', 403, 'permission_denied')); await checking;
    expect(h.client.getSnapshot()).toMatchObject({ phase: 'ready', pending: true, result: { operationId: command.payload.operationId, state: 'queued' } }); h.client.close();
  });

  it('does not extend the pending operation deadline for a late explicit receipt query', async () => {
    vi.useFakeTimers(); const h = harness(); h.client.setVisible(true); await vi.advanceTimersByTimeAsync(0); h.publish();
    await h.client.control('acquire_control'); await vi.advanceTimersByTimeAsync(9000);
    let receiptSignal!: AbortSignal; vi.mocked(h.api.operation).mockImplementation((_session, _operation, signal) => { receiptSignal = signal; return new Promise(() => {}); });
    let finished = false; const checking = h.client.checkOperation().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(finished).toBe(true); expect(receiptSignal.aborted).toBe(true);
    expect(h.client.getSnapshot()).toMatchObject({ pending: false, result: { state: 'unknown' } });
    expect(h.api.command).toHaveBeenCalledOnce(); await checking; h.client.close();
  });

});
