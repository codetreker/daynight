import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/api/assistant-tasks';
import { invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { BOT_USER, BOT_TIME, botId, botResponse, botError } from './helpers/bots';

const admission = () => ({ userId: BOT_USER, onPrincipalMismatch: vi.fn() });
const signal = () => new AbortController().signal;
const taskId = botId(80), entryId = botId(81), holder = botId(82), operationId = botId(83);
const unowned = () => ({ holderBotId: null, credentialOperationId: null, claimGeneration: '0', claimState: 'unowned', claimedAt: null, renewedAt: null, leaseUntil: null, observedAt: BOT_TIME });
const task = () => ({ ...unowned(), id: taskId, ownerUserId: BOT_USER, application: '', name: 'Monitor work', purpose: 'Observe results', scope: 'My projects', kind: 'continuous', state: 'active', takeover: 'manual', trigger: null, version: '9007199254740993', manualVersion: '1', createdAt: BOT_TIME, updatedAt: BOT_TIME });
const manual = () => ({ taskId, version: '1', body: 'Inspect the original result.\nRetain its identity.', rules: {}, source: 'initial', proposalId: null, createdAt: BOT_TIME });
const appendix = () => ({ id: entryId, taskId, text: 'Keep evidence', sourceRecords: [botId(84)], authorBotId: holder, state: 'active', version: '2', createdAt: BOT_TIME, updatedAt: BOT_TIME });
const proposal = () => ({ id: entryId, taskId, baseVersion: '1', body: 'Updated manual', rules: {}, reason: 'Repeated evidence', evidenceRecords: [botId(84)], authorBotId: holder, widens: true, status: 'pending', decisionNote: '', createdAt: BOT_TIME, decidedAt: null });
const item = () => ({ id: entryId, taskId, key: 'check-1', episode: '1', state: 'open', category: 'failure', followerBotId: holder, appState: {}, version: '2', createdAt: BOT_TIME, updatedAt: BOT_TIME });
const record = () => ({ id: entryId, taskId, itemId: botId(84), author: 'bot', authorBotId: holder, kind: 'fact', text: 'The result was received.', refs: { operationId }, createdAt: BOT_TIME });
const event = () => ({ id: entryId, taskId, targetBotId: holder, type: 'escalation', payload: { itemId: botId(84) }, state: 'pending', attention: true, createdAt: BOT_TIME, deliveredAt: null, seenAt: null, ackOperationId: null });
const page = (items: unknown[]) => ({ items, nextCursor: null, observedAt: BOT_TIME });
const transferInput = () => ({ operationId, ifVersion: task().version, expectedGeneration: '0', targetBotId: holder });
const claimResult = () => ({ operation: { operationId, kind: 'transfer', taskId, actorBotId: null, requestFingerprint: 'a'.repeat(64), admittedAt: BOT_TIME, resultingVersion: '9007199254740994', resultingGeneration: '1', holderBotId: holder, credentialOperationId: null, leaseUntil: '2026-11-04T12:05:00Z' }, currentClaim: { ...unowned(), holderBotId: holder, claimGeneration: '1', claimState: 'pending', claimedAt: BOT_TIME, leaseUntil: '2026-11-04T12:05:00Z' } });
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe('assistant task application JSON precision', () => {
  const applicationJson = '{"externalId":9007199254740993,"nested":[-9007199254740993,{"decimal":1.234567890123456789,"large":1e400,"small":1e-400,"zero":-0}],"ordinary":[1,0.5,true,null,"9007199254740993"]}';
  const rawResponse = (source: string) => new Response(source, { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': BOT_USER } });
  const withApplicationJson = (value: unknown, key: string) => JSON.stringify(value).replace(`"${key}":null`, `"${key}":${applicationJson}`);

  it('round-trips numeric tokens and nested JSON without requiring browser raw JSON or reviver support', () => {
    const parsed = api.parseAssistantTaskJson(applicationJson);
    expect(api.stringifyAssistantTaskJson(parsed)).toBe(applicationJson);
    expect(api.stringifyAssistantTaskJson(api.parseAssistantTaskJson(api.stringifyAssistantTaskJson(parsed, 2)))).toBe(applicationJson);
    expect(api.stringifyAssistantTaskJson(parsed, 2)).toContain('"externalId": 9007199254740993');
    expect(() => JSON.stringify(parsed)).toThrow('stringifyAssistantTaskJson');
    expect(api.parseAssistantTaskJson('{"number":0.5,"count":1}')).toEqual({ number: 0.5, count: 1 });
    expect(api.stringifyAssistantTaskJson(api.parseAssistantTaskJson('{"__proto__":{"n":9007199254740993},"quote\\\"":1e20,"empty":[{},[]]}'))).toBe('{"__proto__":{"n":9007199254740993},"quote\\\"":1e20,"empty":[{},[]]}');
    for (const source of ['9007199254740993', '-9007199254740993', '1.234567890123456789', '1e400', '1e-400', '-0', '1e1']) expect(api.stringifyAssistantTaskJson(api.parseAssistantTaskJson(source))).toBe(source);
    for (const source of ['NaN', 'Infinity', '01', '[1,]', '{"x":1e}']) expect(() => api.parseAssistantTaskJson(source)).toThrow();
  });

  it('reads exact application numbers in records, items, manuals, proposals and event payloads', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(rawResponse(withApplicationJson(page([{ ...record(), refs: null }]), 'refs')))
      .mockResolvedValueOnce(rawResponse(withApplicationJson(page([{ ...item(), appState: null }]), 'appState')))
      .mockResolvedValueOnce(rawResponse(withApplicationJson({ ...manual(), rules: null }, 'rules')))
      .mockResolvedValueOnce(rawResponse(withApplicationJson(page([{ ...proposal(), rules: null }]), 'rules')))
      .mockResolvedValueOnce(rawResponse(withApplicationJson(page([{ ...event(), payload: null }]), 'payload')));
    vi.stubGlobal('fetch', fetch);
    const refs = (await api.listAssistantTaskRecords(taskId, {}, signal(), admission())).items[0]!.refs;
    const appState = (await api.listAssistantTaskItems(taskId, {}, signal(), admission())).items[0]!.appState;
    const rules = (await api.getAssistantTaskManual(taskId, signal(), admission())).rules;
    const proposedRules = (await api.listAssistantTaskProposals(taskId, {}, signal(), admission())).items[0]!.rules;
    const payload = (await api.listAssistantTaskEvents({ taskId }, signal(), admission())).items[0]!.payload;
    for (const value of [refs, appState, rules, proposedRules, payload]) expect(api.stringifyAssistantTaskJson(value)).toBe(applicationJson);
  });

  it('retains strict protocol numeric types independently of application numbers', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(rawResponse(JSON.stringify({ ...task(), trigger: null }).replace('"trigger":null', '"trigger":{"kind":"interval","minutes":9007199254740993}')))
      .mockResolvedValueOnce(rawResponse(JSON.stringify(task()).replace('"version":"9007199254740993"', '"version":9007199254740993')))
      .mockResolvedValueOnce(rawResponse(JSON.stringify({ ...task(), trigger: null }).replace('"trigger":null', '"trigger":{"kind":"interval","minutes":1e1}')));
    vi.stubGlobal('fetch', fetch);
    await expect(api.getAssistantTask(taskId, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(api.getAssistantTask(taskId, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    expect((await api.getAssistantTask(taskId, signal(), admission())).trigger).toEqual({ kind: 'interval', minutes: 10 });
  });

  it('sends exact edited rules and retains them in an unknown write snapshot', async () => {
    const decided = { ...proposal(), status: 'edited', body: 'New text', rules: null, decidedAt: BOT_TIME };
    const fetch = vi.fn().mockResolvedValueOnce(rawResponse(withApplicationJson(decided, 'rules'))).mockRejectedValueOnce(new Error('Lost response'));
    vi.stubGlobal('fetch', fetch);
    const input = { ifVersion: task().version, decision: 'edited' as const, body: decided.body, rules: api.parseAssistantTaskJson(applicationJson) };
    const result = await api.decideAssistantTaskProposal(taskId, entryId, input, signal(), admission());
    expect(api.stringifyAssistantTaskJson(result.rules)).toBe(applicationJson);
    expect(fetch.mock.calls[0]![1].body).toContain(`"rules":${applicationJson}`);
    const unknown = await api.decideAssistantTaskProposal(taskId, entryId, input, signal(), admission()).catch(error => error as unknown);
    expect(unknown).toBeInstanceOf(api.AssistantTaskWriteUnknown);
    expect(api.stringifyAssistantTaskJson((unknown as api.AssistantTaskWriteUnknown).input.rules)).toBe(applicationJson);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('assistant task response contracts', () => {
  it('preserves int64 versions, task status and independent claim state', () => {
    expect(api.parseAssistantTask(task(), BOT_USER, taskId)).toEqual(task());
    for (const state of ['active', 'paused']) for (const claimState of ['pending', 'active', 'expired']) {
      const value = { ...task(), ...claimResult().currentClaim, state, claimState, ...(claimState === 'pending' ? {} : { credentialOperationId: operationId, renewedAt: BOT_TIME }) };
      expect(api.parseAssistantTask(value, BOT_USER)).toEqual(value);
    }
    const deleted = { ...task(), state: 'deleted', name: '', purpose: '', scope: '', manualVersion: '0' };
    expect(api.parseAssistantTask(deleted, BOT_USER)).toEqual(deleted);
  });
  it.each([
    { version: 1 }, { version: '01' }, { version: '0' }, { version: '9223372036854775808' },
    { ownerUserId: holder }, { id: '00000000-0000-0000-0000-000000000000' }, { name: '\ud800' }, { name: '' },
    { claimState: 'active' }, { claimGeneration: '-1' }, { holderBotId: holder }, { state: 'done' }, { manualVersion: '0' },
    { trigger: { kind: 'interval', minutes: 0 } }, { trigger: { kind: 'interval', minutes: 1, extra: true } },
    { trigger: { kind: 'daily', time: '24:00', timeZone: 'UTC' } }, { trigger: { kind: 'daily', time: '12:00', timeZone: 'Local' } },
    { trigger: { kind: 'daily', time: '12:00', timeZone: 'Bad/Zone' } }, { unknown: true }, { updatedAt: '2026-02-30T12:00:00Z' },
  ])('refuses malformed or contradictory tasks %#', patch => expect(() => api.parseAssistantTask({ ...task(), ...patch }, BOT_USER)).toThrow());
  it('validates related resource ownership, precise enums and revisions', () => {
    for (const [parse, value] of [
      [api.parseAssistantTaskManual, manual()], [api.parseAssistantTaskAppendix, appendix()], [api.parseAssistantTaskProposal, proposal()],
      [api.parseAssistantTaskItem, item()], [api.parseAssistantTaskRecord, record()], [api.parseAssistantTaskEvent, event()],
    ] as const) {
      expect(parse(value, taskId)).toEqual(value);
      expect(() => parse({ ...value, taskId: holder }, taskId)).toThrow();
      expect(() => parse({ ...value, extra: true }, taskId)).toThrow();
    }
    expect(() => api.parseAssistantTaskManual({ ...manual(), source: 'revision' }, taskId)).toThrow();
    expect(() => api.parseAssistantTaskProposal({ ...proposal(), status: 'approved' }, taskId)).toThrow();
    expect(() => api.parseAssistantTaskRecord({ ...record(), author: 'system' }, taskId)).toThrow();
    expect(() => api.parseAssistantTaskItem({ ...item(), episode: 2 }, taskId)).toThrow();
    expect(() => api.parseAssistantTaskEvent({ ...event(), type: 'invented' }, taskId)).toThrow();
    expect(() => api.parseAssistantTaskManual({ ...manual(), rules: { limit: Number.MAX_SAFE_INTEGER + 1 } }, taskId)).toThrow();
    expect(api.parseAssistantTaskManual({ ...manual(), rules: { value: 'embedded\0text' } }, taskId).rules).toEqual({ value: 'embedded\0text' });
    expect(() => api.parseAssistantTaskAppendix({ ...appendix(), state: 'deleted' }, taskId)).toThrow();
  });
  it('validates receipt identity independently of later claim observation', () => {
    const result = { ...claimResult(), currentClaim: { ...unowned(), claimGeneration: '4' } };
    expect(api.parseAssistantTaskClaimResult(result, taskId, operationId)).toEqual(result);
    for (const patch of [{ operationId: holder }, { taskId: holder }, { requestFingerprint: 'bad' }, { kind: 'transfer', credentialOperationId: operationId }]) {
      expect(() => api.parseAssistantTaskClaimResult({ ...result, operation: { ...result.operation, ...patch } }, taskId, operationId)).toThrow();
    }
    expect(() => api.parseAssistantTaskClaimResult({ ...result, currentClaim: unowned() }, taskId, operationId)).toThrow();
    expect(() => api.parseAssistantTaskClaimResult({ ...result, operation: { ...result.operation, kind: 'claim' } }, taskId, operationId)).toThrow();
  });
});

describe('assistant task reads', () => {
  it('binds account identity and URL filters to authenticated pages', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(botResponse(page([task()]))).mockResolvedValueOnce(botResponse(task())); vi.stubGlobal('fetch', fetch);
    expect(await api.listAssistantTasks({ limit: 200, cursor: 'next/+ token', state: 'active' }, signal(), admission())).toEqual(page([task()]));
    expect(await api.getAssistantTask(taskId, signal(), admission())).toEqual(task());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/assistant-tasks?limit=200&cursor=next%2F%2B+token&state=active', `/api/v1/assistant-tasks/${taskId}`]);
    expect(fetch.mock.calls[0]![1].credentials).toBe('same-origin');
  });
  it('reads manual versions, proposals, appendices, items, records and account events through real parsers', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(botResponse(manual()))
      .mockResolvedValueOnce(botResponse(page([manual()])))
      .mockResolvedValueOnce(botResponse(page([appendix()])))
      .mockResolvedValueOnce(botResponse(page([proposal()])))
      .mockResolvedValueOnce(botResponse(page([item()])))
      .mockResolvedValueOnce(botResponse(page([record()])))
      .mockResolvedValueOnce(botResponse(page([event()])))
      .mockResolvedValueOnce(botResponse(claimResult()));
    vi.stubGlobal('fetch', fetch);
    expect(await api.getAssistantTaskManual(taskId, signal(), admission(), '1')).toEqual(manual());
    expect((await api.listAssistantTaskManuals(taskId, {}, signal(), admission())).items).toEqual([manual()]);
    expect((await api.listAssistantTaskAppendices(taskId, { state: 'active' }, signal(), admission())).items).toEqual([appendix()]);
    expect((await api.listAssistantTaskProposals(taskId, { state: 'pending' }, signal(), admission())).items).toEqual([proposal()]);
    expect((await api.listAssistantTaskItems(taskId, { state: 'open' }, signal(), admission())).items).toEqual([item()]);
    expect((await api.listAssistantTaskRecords(taskId, { itemId: botId(84) }, signal(), admission())).items).toEqual([record()]);
    expect((await api.listAssistantTaskEvents({ targetBotId: holder }, signal(), admission())).items).toEqual([event()]);
    expect(await api.getAssistantTaskClaimOperation(taskId, operationId, signal(), admission())).toEqual(claimResult());
    expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/assistant-tasks/${taskId}/manual/versions/1`);
    expect(fetch.mock.calls[6]![0]).toBe(`/api/v1/assistant-task-events?targetBotId=${holder}`);
    expect(fetch.mock.calls[7]![0]).toBe(`/api/v1/assistant-tasks/${taskId}/claim-operations/${operationId}`);
  });
  it('rejects duplicate entries, cyclic cursors, ignored filters and wrong manual versions', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(botResponse(page([task(), task()])))
      .mockResolvedValueOnce(botResponse({ ...page([task()]), nextCursor: 'same' }))
      .mockResolvedValueOnce(botResponse(page([task()])))
      .mockResolvedValueOnce(botResponse(page([event()])))
      .mockResolvedValueOnce(botResponse(manual())); vi.stubGlobal('fetch', fetch);
    await expect(api.listAssistantTasks({}, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(api.listAssistantTasks({ cursor: 'same' }, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(api.listAssistantTasks({ targetBotId: holder }, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(api.listAssistantTaskEvents({ taskId, targetBotId: entryId }, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(api.getAssistantTaskManual(taskId, signal(), admission(), '2')).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('refuses malformed read filters before dispatch', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const query of [{ limit: 201 }, { limit: 0 }, { cursor: '' }, { state: 'deleted' }, { itemId: entryId }]) expect(() => api.listAssistantTasks(query, signal(), admission())).toThrow();
    expect(() => api.listAssistantTaskRecords(taskId, { state: 'open' }, signal(), admission())).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects missing and changed response principals and dispatches no read while account admission is paused', async () => {
    const gate = admission(), fetch = vi.fn().mockResolvedValueOnce(botResponse(task(), null)).mockResolvedValueOnce(botResponse(task(), holder)).mockResolvedValueOnce(botResponse(task())); vi.stubGlobal('fetch', fetch);
    await expect(api.getAssistantTask(taskId, signal(), gate)).rejects.toMatchObject({ kind: 'protocol' });
    await expect(api.getAssistantTask(taskId, signal(), gate)).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(gate.onPrincipalMismatch).toHaveBeenCalledOnce();
    const release = pauseAuthRequests(), pending = api.getAssistantTask(taskId, signal(), gate);
    await Promise.resolve(); expect(fetch).toHaveBeenCalledTimes(2);
    release(); expect(await pending).toEqual(task());
  });
});

describe('assistant task user writes', () => {
  it('creates an ordinary task and pauses or resumes using an exact task version', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(botResponse(task())).mockResolvedValueOnce(botResponse({ ...task(), state: 'paused', version: '9007199254740994' })); vi.stubGlobal('fetch', fetch);
    const input = { id: taskId, name: task().name, purpose: task().purpose, scope: task().scope, kind: 'continuous' as const, takeover: 'manual' as const, manual: { body: manual().body, rules: {} } };
    expect(await api.createAssistantTask(input, signal(), admission())).toEqual(task());
    expect((await api.updateAssistantTask(taskId, { ifVersion: task().version, state: 'paused' }, signal(), admission())).state).toBe('paused');
    expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual(['POST', 'PATCH']);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ ifVersion: '9007199254740993', state: 'paused' });
  });
  it('uses the Watchdog preset contract and accepts an existing singleton with the selected holder', async () => {
    const watchdog = { ...task(), ...claimResult().currentClaim, id: entryId, application: 'watchdog' };
    const fetch = vi.fn().mockResolvedValue(botResponse(watchdog)); vi.stubGlobal('fetch', fetch);
    expect(await api.enableWatchdog({ id: taskId, targetBotId: holder }, signal(), admission())).toEqual(watchdog);
    expect(fetch.mock.calls[0]![0]).toBe('/api/v1/assistant-task-presets/watchdog');
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ id: taskId, targetBotId: holder });
  });
  it('keeps unavailable Watchdog endpoints distinct from unknown preset writes', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(botError(404, 'not_found')).mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(botResponse(task())); vi.stubGlobal('fetch', fetch);
    await expect(api.enableWatchdog({ id: taskId, targetBotId: holder }, signal(), admission())).rejects.toMatchObject({ kind: 'server', status: 404 });
    await expect(api.enableWatchdog({ id: taskId, targetBotId: holder }, signal(), admission())).rejects.toMatchObject({ name: 'AssistantTaskWriteUnknown', taskId, input: { id: taskId, targetBotId: holder } });
    await expect(api.enableWatchdog({ id: taskId, targetBotId: holder }, signal(), admission())).rejects.toBeInstanceOf(api.AssistantTaskWriteUnknown);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('recognizes an older server route refusal before its authenticated JSON adapter exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('404 page not found', { status: 404 })));
    await expect(api.enableWatchdog({ id: taskId, targetBotId: holder }, signal(), admission())).rejects.toMatchObject({ kind: 'server', status: 404, code: 'preset_unavailable' });
  });
  it('transfers and releases responsibility as a user without a Bot credential', async () => {
    const released = { operation: { ...claimResult().operation, kind: 'release', holderBotId: null, leaseUntil: null, resultingVersion: '9007199254740995', resultingGeneration: '2' }, currentClaim: { ...unowned(), claimGeneration: '2' } };
    const fetch = vi.fn().mockResolvedValueOnce(botResponse(claimResult())).mockResolvedValueOnce(botResponse(released)); vi.stubGlobal('fetch', fetch);
    expect(await api.transferAssistantTask(taskId, transferInput(), signal(), admission())).toEqual(claimResult());
    expect(await api.releaseAssistantTask(taskId, { operationId, ifVersion: '9007199254740994', expectedGeneration: '1' }, signal(), admission())).toEqual(released);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(transferInput());
    for (const [, options] of fetch.mock.calls) expect(new Headers(options.headers).has('X-Daynight-Bot-Id')).toBe(false);
  });
  it('edits and deletes appendices with the task version, and confirms deleted task tombstones', async () => {
    const edited = { ...appendix(), state: 'edited', text: 'Preserve the operation ID', version: '3' }, deleted = { ...appendix(), state: 'deleted', text: '', sourceRecords: [], version: '4' };
    const removed = { ...task(), state: 'deleted', name: '', purpose: '', scope: '', manualVersion: '0', version: '9007199254740994' };
    const fetch = vi.fn().mockResolvedValueOnce(botResponse(edited)).mockResolvedValueOnce(botResponse(deleted)).mockResolvedValueOnce(botResponse(removed)); vi.stubGlobal('fetch', fetch);
    expect(await api.updateAssistantTaskAppendix(taskId, entryId, { ifVersion: task().version, text: edited.text, sourceRecords: appendix().sourceRecords }, signal(), admission())).toEqual(edited);
    expect(await api.deleteAssistantTaskAppendix(taskId, entryId, task().version, signal(), admission())).toEqual(deleted);
    expect(await api.deleteAssistantTask(taskId, task().version, signal(), admission())).toEqual(removed);
    expect(fetch.mock.calls.map(([, options]) => JSON.parse(options.body).ifVersion)).toEqual(Array(3).fill(task().version));
  });
  it.each(['approved', 'edited', 'rejected'] as const)('submits a %s decision and verifies the returned proposal', async decision => {
    const body = decision === 'edited' ? 'Modified text' : undefined;
    const decided = { ...proposal(), status: decision, body: body ?? proposal().body, decisionNote: 'Evidence reviewed', decidedAt: BOT_TIME };
    const fetch = vi.fn().mockResolvedValue(botResponse(decided)); vi.stubGlobal('fetch', fetch);
    expect(await api.decideAssistantTaskProposal(taskId, entryId, { ifVersion: task().version, decision, note: 'Evidence reviewed', ...(body === undefined ? {} : { body, rules: {} }) }, signal(), admission())).toEqual(decided);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ ifVersion: task().version, decision });
  });
  it('returns a new manual version on rollback', async () => {
    const rolledBack = { ...manual(), version: '3', source: 'rollback' }, fetch = vi.fn().mockResolvedValue(botResponse(rolledBack)); vi.stubGlobal('fetch', fetch);
    expect(await api.rollbackAssistantTaskManual(taskId, { ifVersion: task().version, manualVersion: '1' }, signal(), admission())).toEqual(rolledBack);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ ifVersion: task().version, manualVersion: '1' });
  });
  it('preserves appendix evidence when it is omitted from an edit', async () => {
    const edited = { ...appendix(), state: 'edited', text: 'Corrected text' }, fetch = vi.fn().mockResolvedValue(botResponse(edited)); vi.stubGlobal('fetch', fetch);
    expect(await api.updateAssistantTaskAppendix(taskId, entryId, { ifVersion: task().version, text: edited.text }, signal(), admission())).toEqual(edited);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).not.toHaveProperty('sourceRecords');
  });
  it.each([
    () => Promise.reject(new Error('response lost')),
    () => Promise.resolve(botError(503, 'claim_outcome_unknown')),
    () => Promise.resolve(botError(500, 'internal_error')),
    () => Promise.resolve(botResponse(claimResult(), null)),
    () => Promise.resolve(botResponse(claimResult(), BOT_USER, 201)),
    () => Promise.resolve(botResponse({ ...claimResult(), operation: { ...claimResult().operation, holderBotId: entryId } })),
    () => Promise.resolve(botResponse({ ...claimResult(), operation: { ...claimResult().operation, resultingGeneration: '5' } })),
  ])('retains the original transfer request after unknown outcomes without replay %#', async response => {
    const fetch = vi.fn(response); vi.stubGlobal('fetch', fetch);
    await expect(api.transferAssistantTask(taskId, transferInput(), signal(), admission())).rejects.toMatchObject({ name: 'AssistantTaskWriteUnknown', taskId, operationId, input: transferInput() });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('keeps definite conflicts separate and never refreshes then replays a stale write', async () => {
    const fetch = vi.fn().mockResolvedValue(botError(409, 'version_conflict')); vi.stubGlobal('fetch', fetch);
    await expect(api.updateAssistantTask(taskId, { ifVersion: task().version, state: 'paused' }, signal(), admission())).rejects.toMatchObject({ kind: 'server', code: 'version_conflict' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('retains dispatched aborts and freezes caller inputs while blocking pre-aborted dispatch', async () => {
    const controller = new AbortController(), original = transferInput();
    const fetch = vi.fn(async () => { original.targetBotId = entryId; controller.abort(); throw new DOMException('Aborted', 'AbortError'); }); vi.stubGlobal('fetch', fetch);
    await expect(api.transferAssistantTask(taskId, original, controller.signal, admission())).rejects.toMatchObject({ name: 'AssistantTaskWriteUnknown', input: transferInput() });
    await expect(api.transferAssistantTask(taskId, original, controller.signal, admission())).rejects.not.toBeInstanceOf(api.AssistantTaskWriteUnknown);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('refuses malformed writes before dispatch', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(api.deleteAssistantTask(taskId, '01', signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(api.transferAssistantTask(taskId, { ...transferInput(), expectedGeneration: '-1' }, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(api.releaseAssistantTask(taskId, { operationId, ifVersion: '1', expectedGeneration: '0' }, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(api.decideAssistantTaskProposal(taskId, entryId, { ifVersion: '1', decision: 'rejected', body: 'replacement' }, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(api.updateAssistantTask(taskId, { ifVersion: '1' }, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(api.updateAssistantTaskAppendix(taskId, entryId, { ifVersion: '1', text: '' }, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
