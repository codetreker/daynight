import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openCodexProvider } from '../../../src/commands/controller/providers/codex.js';
import { CodexBotRecovery } from '../../../src/commands/controller/providers/codex-bot-recovery.js';
import { textNativeInput } from '../../../src/commands/controller/providers/native-input.js';
import type { NativeProvider, ProviderEntry, ProviderOptions, ProviderState } from '../../../src/commands/controller/providers/types.js';

let directory: string, home: string, recoveryDirectory: string, log: string;
let opened: NativeProvider[], states: ProviderState[];
let timeline: ProviderEntry[];
const identity = { serverOrigin: 'https://daynight.example', ownerUserId: randomUUID(), botId: randomUUID(), sessionId: randomUUID() };
beforeEach(async () => {
  const base = join(process.cwd(), '.tmp'); await mkdir(base, { recursive: true });
  directory = await realpath(await mkdtemp(join(base, 'codex-bot-provider-')));
  home = join(directory, 'configuration'); recoveryDirectory = join(directory, 'recovery'); log = join(directory, 'requests.jsonl');
  await mkdir(home); opened = []; states = []; timeline = [];
});
afterEach(async () => { try { for (const provider of opened) await provider.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
const requests = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const manifest = async () => JSON.parse(await readFile(join(recoveryDirectory, 'manifest.json'), 'utf8'));
const open = async (resumeNativeSessionId: string | null = null, environment: NodeJS.ProcessEnv = {}, callbacks: Pick<ProviderOptions, 'onControlConfirmed' | 'onFatalError'> = {}) => {
  const options: ProviderOptions = {
    cwd: directory, model: null, args: [], resumeNativeSessionId,
    executable: fileURLToPath(new URL('./fixtures/codex-bot-native.mjs', import.meta.url)),
    env: { ...process.env, CODEX_HOME: home, CODEX_BOT_REQUEST_LOG: log, CODEX_BOT_CONFIG_SENTINEL: 'current-account-config', ...environment },
    codexBotRecovery: { directory: recoveryDirectory, identity },
    onTimeline: entry => timeline.push(entry), onState: state => states.push(state), onSpawn: () => {},
    ...callbacks,
  };
  const provider = await openCodexProvider(options); opened.push(provider); return provider;
};
const close = async (provider: NativeProvider) => { await provider.close(); opened = opened.filter(value => value !== provider); };

test('Bot recovery preserves configuration environment and resumes the original ID from its owned copy', async () => {
  const first = await open(), nativeId = first.nativeSessionId;
  const sent = await first.send(textNativeInput('Complete one turn'), randomUUID(), null);
  await first.waitForTurn(sent.turnId!, Date.now() + 5000);
  const point = await manifest();
  expect(point).toMatchObject({ dirty: false, point: { nativeSessionId: nativeId, protectedThroughTurn: sent.turnId } });
  await close(first);
  // The shared history is absent: success must depend on the Bot-owned point.
  await rm(join(home, 'sessions'), { recursive: true });
  timeline = [];
  const resumed = await open(nativeId);
  expect(resumed.nativeSessionId).toBe(nativeId);
  const messages = await requests(), starts = messages.filter(message => message.method === 'thread/start'), resumes = messages.filter(message => message.method === 'thread/resume');
  expect(starts).toHaveLength(1); expect(resumes).toHaveLength(1);
  expect(starts[0].params.historyMode).toBe('legacy');
  expect(messages.filter(message => message.method === 'thread/name/set')).toHaveLength(1);
  expect(resumes[0].params).toMatchObject({ threadId: nativeId, excludeTurns: true });
  expect(resumes[0].params.path).toBe(join(recoveryDirectory, (await manifest()).activeFile));
  expect(messages.every(message => message.observedHome === home && message.observedConfig === 'current-account-config')).toBe(true);
  expect(messages.filter(message => message.method === 'turn/start')).toHaveLength(1);
  expect(messages.filter(message => ['thread/turns/list', 'thread/items/list'].includes(message.method))).toEqual([]);
  expect(timeline.filter(entry => entry.kind === 'assistant_message')).toHaveLength(1);
  expect(JSON.stringify(timeline)).toContain('Preserved native assistant reply');
});

test('a confirmed idle settings change remains recoverable with the changed value', async () => {
  const first = await open(), nativeId = first.nativeSessionId;
  await first.setSetting!('model', 'other-model', randomUUID(), states.at(-1)!.controls!.revision);
  expect((await manifest()).dirty).toBe(false);
  await close(first);
  await open(nativeId);
  expect(states.at(-1)!.controls!.settings.find(setting => setting.id === 'model')!.value).toBe('other-model');
});

test('a failed idle setting checkpoint is fatal independently of native confirmation and closes dispatch', async () => {
  const confirmed: string[] = [], fatals: Error[] = [], events: string[] = [];
  const provider = await open(null, {}, {
    onControlConfirmed: id => { confirmed.push(id); events.push('confirmed'); },
    onFatalError: error => { fatals.push(error); events.push('fatal'); },
  });
  const previous = await manifest(), operationId = randomUUID();
  const storageFailure = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  const protection = vi.spyOn(CodexBotRecovery.prototype, 'protect').mockRejectedValueOnce(storageFailure);
  try {
    await expect(provider.setSetting!('model', 'other-model', operationId, states.at(-1)!.controls!.revision)).rejects.toThrow('Codex Bot recovery could not protect the confirmed setting');
    expect(confirmed).toEqual([operationId]); expect(events).toEqual(['confirmed', 'fatal']);
    expect(fatals).toHaveLength(1); expect(fatals[0]!.cause).toBe(storageFailure);
    expect(states.at(-1)).toMatchObject({ activity: 'unknown', capabilities: { send: false, steer: false, cancel: false, respond: false } });
    expect(states.at(-1)!.controls!.settings.find(setting => setting.id === 'model')!.value).toBe('other-model');
    expect(await manifest()).toMatchObject({ dirty: true, point: previous.point });
    const revision = states.at(-1)!.controls!.revision;
    const before = await requests();
    await expect(provider.send(textNativeInput('must not dispatch'), randomUUID(), null)).rejects.toThrow();
    await expect(provider.setSetting!('model', 'fixture-model', randomUUID(), revision)).rejects.toThrow();
    await expect(provider.executeCommand!('compact', '', randomUUID(), revision, null)).rejects.toThrow();
    await provider.refreshControls!().catch(() => {});
    expect(await requests()).toEqual(before);
    expect(protection).toHaveBeenCalledTimes(1); expect(fatals).toHaveLength(1);
  } finally { protection.mockRestore(); }
});

test('compact completion protects its own turn before a later process resumes', async () => {
  const first = await open(), nativeId = first.nativeSessionId;
  await first.executeCommand!('compact', '', randomUUID(), states.at(-1)!.controls!.revision, null);
  const compactTurn = states.findLast(state => state.currentTurnId !== null)!.currentTurnId!;
  await first.waitForTurn(compactTurn, Date.now() + 5000);
  const point = await manifest();
  expect(point).toMatchObject({ dirty: false, point: { protectedThroughTurn: compactTurn } });
  expect(await readFile(join(recoveryDirectory, point.point.file), 'utf8')).toContain('"type":"compacted"');
  await close(first); await open(nativeId);
  expect((await manifest()).point.protectedThroughTurn).toBe(compactTurn);
  expect((await requests()).filter(message => message.method === 'thread/compact/start')).toHaveLength(1);
});

test('a confirmed interrupted turn is protected and resumes without replaying its input', async () => {
  const first = await open(null, { CODEX_BOT_TURN_MODE: 'hold-turn' }), nativeId = first.nativeSessionId;
  const sent = await first.send(textNativeInput('Wait for cancellation'), randomUUID(), null);
  expect(states.at(-1)!.currentTurnId).toBe(sent.turnId);
  expect((await manifest()).dirty).toBe(true);
  await first.cancel(sent.turnId!);
  expect((await manifest())).toMatchObject({ dirty: false, point: { protectedThroughTurn: sent.turnId } });
  await close(first);
  const resumed = await open(nativeId);
  expect(resumed.nativeSessionId).toBe(nativeId);
  expect((await manifest())).toMatchObject({ dirty: false, point: { protectedThroughTurn: sent.turnId } });
  const messages = await requests();
  expect(messages.filter(message => message.method === 'turn/start')).toHaveLength(1);
  expect(messages.filter(message => message.method === 'turn/interrupt')).toHaveLength(1);
  expect(messages.filter(message => message.method === 'thread/resume')).toHaveLength(1);
});

test('a missing snapshot refuses resume without starting a replacement thread', async () => {
  const first = await open(), nativeId = first.nativeSessionId;
  await close(first); await rm(join(recoveryDirectory, (await manifest()).point.file));
  await expect(open(nativeId)).rejects.toThrow('recovery_material_missing');
  expect((await requests()).filter(message => ['thread/start', 'thread/resume'].includes(message.method))).toHaveLength(1);
});

test.each([['0.170.0', '0.170.0'], ['0.169.0', '0.170.0'], ['0.170.0', '0.169.0'], ['unknown', '99.0.0']])('compatible history starts with %s and resumes with %s', async (created, resumedVersion) => {
  const first = await open(null, { CODEX_BOT_VERSION: created }), nativeId = first.nativeSessionId;
  const sent = await first.send(textNativeInput('Preserve this turn'), randomUUID(), null);
  await first.waitForTurn(sent.turnId!, Date.now() + 5000);
  await close(first);
  await rm(join(home, 'sessions'), { recursive: true });
  const resumed = await open(nativeId, { CODEX_BOT_VERSION: resumedVersion });
  expect(resumed.nativeSessionId).toBe(nativeId);
  const point = await manifest();
  expect(point).toMatchObject({ dirty: false, point: { providerVersion: resumedVersion, protectedThroughTurn: sent.turnId } });
  expect(await readFile(join(recoveryDirectory, point.point.file), 'utf8')).toContain(`"cli_version":"${created}"`);
  const messages = await requests();
  expect(messages.filter(message => message.method === 'turn/start')).toHaveLength(1);
  expect(messages.filter(message => message.method === 'thread/start')).toHaveLength(1);
  expect(messages.filter(message => message.method === 'thread/resume')).toHaveLength(1);
});

test.each(['empty', 'wrong-watermark', 'active', 'duplicate'])('incompatible restored history (%s) cannot report ready or replay input', async result => {
  const first = await open(), nativeId = first.nativeSessionId;
  const sent = await first.send(textNativeInput('Preserved turn'), randomUUID(), null);
  await first.waitForTurn(sent.turnId!, Date.now() + 5000);
  await close(first);
  const previous = await manifest(); states = []; timeline = [];
  await expect(open(nativeId, { CODEX_BOT_VERSION: '0.170.0', CODEX_BOT_HISTORY_RESULT: result })).rejects.toThrow('recovery_material_invalid');
  expect((await manifest()).dirty).toBe(true);
  expect((await manifest()).point).toEqual(previous.point);
  expect(timeline).toEqual([]);
  expect(states.some(state => state.activity === 'idle')).toBe(false);
  expect((await requests()).filter(message => message.method === 'turn/start')).toHaveLength(1);
});

test('a resume receipt cannot replace the original native ID', async () => {
  const first = await open(), nativeId = first.nativeSessionId; await close(first);
  await expect(open(nativeId, { CODEX_BOT_WRONG_ID: '1' })).rejects.toThrow('identity or working directory mismatch');
  expect((await manifest()).dirty).toBe(true);
  expect((await requests()).filter(message => message.method === 'thread/start')).toHaveLength(1);
});

test.each(['start', 'resume'])('a paginated %s receipt cannot be protected as a standalone rollout', async mode => {
  let nativeId: string | null = null;
  if (mode === 'resume') { const first = await open(); nativeId = first.nativeSessionId; await close(first); }
  await expect(open(nativeId, { CODEX_BOT_HISTORY_MODE: 'paginated' })).rejects.toThrow('requires legacy rollout history');
  expect((await manifest()).dirty).toBe(true);
  expect((await requests()).filter(message => message.method === 'turn/start')).toEqual([]);
});

test('resume cannot redirect native writes outside its protected active copy', async () => {
  const first = await open(), nativeId = first.nativeSessionId; await close(first);
  await expect(open(nativeId, { CODEX_BOT_WRONG_PATH: '1' })).rejects.toThrow('outside the protected active rollout');
  expect((await manifest()).dirty).toBe(true);
  expect((await requests()).filter(message => message.method === 'thread/start')).toHaveLength(1);
});
