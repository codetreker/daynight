import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { EventEmitter } from 'node:events';
import { parseControllerGrantResponse, parseControllerMessage, parseRelayMessage, type ControllerMessage, type RelayMessage } from '../../../daynight/src/session/controller-protocol';
import { SESSION_PROTOCOL, parseSessionSnapshot, type ControllerFence, type SessionCommand, type TimelineEntry } from '../../../daynight/src/session/protocol';
import type { Bot, BotDefinition, DeletedBot } from '../../src/api/bots';
import type { AuthenticatedAPI } from './authentication';
import { expect } from './fixtures';

type Socket = EventEmitter & { send(value: string): void; close(): void; terminate(): void; readonly readyState: number };
const WebSocket = createRequire(new URL('../../../daynight/package.json', import.meta.url))('ws') as new (url: URL, options: { headers: Record<string, string>; handshakeTimeout: number }) => Socket;

/** Report only this scenario's simulated hosts to its isolated acceptance service. */
export async function reportBotWorker(api: AuthenticatedAPI, workerId: string, supported: boolean): Promise<void> {
  const now = new Date().toISOString();
  const probe = (value: unknown) => ({ state: 'ok', checkedAt: now, value });
  const response = await api.post(`/api/v1/me/workers/${workerId}/report`, { data: {
    machine: { id: workerId, name: supported ? 'Assistant acceptance host' : 'Legacy acceptance host' }, platform: 'linux', workingDirectory: '/assistant-acceptance', sampledAt: now,
    os: probe({ type: 'Linux', release: 'acceptance', version: 'acceptance', arch: 'x64' }),
    cpu: probe({ model: 'Acceptance fixture', logicalProcessors: 4, usagePercent: 0 }),
    memory: probe({ usedBytes: 4, totalBytes: 8 }), disk: probe({ availableBytes: 8, totalBytes: 16 }),
    versions: { daynight: '1.0.0', herdr: probe('0.9.5'), codex: probe('1.0.0'), copilot: { state: 'not_installed', checkedAt: now } },
    taskInventory: { observedAt: now, claims: [] },
    ...(supported ? { assistantHost: { protocolVersion: 1, observedAt: now, defaultCwd: '/assistant-acceptance', defaultProvider: 'codex',
      providers: ['codex', 'claude', 'copilot'].map(provider => ({ provider, available: provider === 'codex', reason: provider === 'codex' ? null : 'not_found', model: null, args: [] })) } } : {}),
  } });
  expect(response.status(), 'Isolated Worker report accepted').toBe(200);
}

/** A controlled writer over the production relay; this does not start a native Provider. */
export async function openBotController(api: AuthenticatedAPI, origin: string, initial: BotDefinition) {
  const base = `/api/v1/me/workers/${initial.workerId}/bots/${initial.id}`;
  const controllerId = randomUUID(), controllerInstanceId = randomUUID(), testExecutionId = randomUUID(), sourceEpoch = randomUUID();
  const instructions = 'Use the Daynight CLI and keep role instructions separate from user input.';
  const response = await api.post(`${base}/register`, { data: {
    botVersion: initial.version, configuration: initial.resolvedConfiguration,
    roleConfiguration: { instructions, revision: 'acceptance-v1', digest: createHash('sha256').update(instructions).digest('hex') },
    registration: { protocol: SESSION_PROTOCOL, schemaVersion: 1, projectionVersion: 1, registrationId: randomUUID(), testExecutionId, controllerId, controllerInstanceId, provider: 'codex', initialInput: 'none' },
  } });
  expect(response.status(), 'Bot registration accepted').toBe(200);
  const registered = await response.json() as { bot: BotDefinition; session: unknown };
  const session = parseSessionSnapshot(registered.session);
  const grantResponse = await api.post(`${base}/grant`, { data: { botVersion: registered.bot.version, nativeSessionId: null,
    grant: { protocol: SESSION_PROTOCOL, testExecutionId, controllerId, controllerInstanceId, executionGeneration: session.executionGeneration, kind: 'bootstrap', previousGeneration: null, stopProof: null } } });
  expect(grantResponse.status()).toBe(200);
  const grant = parseControllerGrantResponse(await grantResponse.json());
  const url = new URL('/api/v1/controller-channel', origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${grant.token}` }, handshakeTimeout: 10_000 });
  let fence: ControllerFence | null = null, failure: Error | null = null, closing = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let waiter: { type: RelayMessage['type']; resolve(message: RelayMessage): void; reject(error: Error): void } | null = null;
  const queued: RelayMessage[] = [], commands: SessionCommand[] = [];
  const entries: TimelineEntry[] = Array.from({ length: 30 }, (_, index) => ({ kind: 'assistant_message', entryId: randomUUID(), entrySeq: String(index + 1), revision: '1', content: [{ type: 'text', text: `${initial.name} history ${index + 1}\n\nThis controlled conversation exercises the production relay and shared Session rendering.` }] }));
  const prefix = () => { if (fence === null) throw new Error('Bot writer is not connected.'); return { protocol: SESSION_PROTOCOL, ...fence }; };
  const send = (message: ControllerMessage) => socket.send(JSON.stringify(parseControllerMessage(message)));
  const fail = (message = 'Controlled Bot writer transport failed.') => { if (!closing) { failure = new Error(message); waiter?.reject(failure); } };
  socket.on('error', () => fail());
  socket.on('close', (code: number) => fail(`Controlled Bot writer closed unexpectedly (${code}).`));
  socket.on('message', (data: { toString(): string }) => {
    try {
      const message = parseRelayMessage(JSON.parse(data.toString()));
      if (message.type === 'error') { fail(`Controlled Bot relay rejected a frame (${message.code}).`); return; }
      if (message.type === 'content_request') {
        if (message.kind !== 'timeline') throw new Error('Unexpected Bot resource request.');
        send({ ...prefix(), type: 'content_response', requestId: message.requestId, sourceThrough: '30', error: null,
          result: { kind: 'timeline', historyEpoch: message.historyEpoch, items: entries, resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false } });
      } else if (message.type === 'operation_offer') {
        commands.push(message.command);
        send({ ...prefix(), type: 'operation_begin', operationId: message.command.operationId });
      } else if (message.type === 'operation_authorized') {
        const command = commands.find(command => command.operationId === message.operationId);
        if (command === undefined) throw new Error('Authorization lacks the original Bot operation.');
        send({ ...prefix(), type: 'operation_receipt', operation: { protocol: SESSION_PROTOCOL, sessionId: session.sessionId, testExecutionId, executionGeneration: session.executionGeneration,
          operationId: command.operationId, kind: command.kind, state: 'confirmed', providerResult: 'handled', error: null } });
      } else if (message.type !== 'heartbeat_ack' && message.type !== 'receipt_ack') {
        if (waiter?.type === message.type) { const current = waiter; waiter = null; current.resolve(message); }
        else queued.push(message);
      }
    } catch { fail('Controlled Bot writer received an invalid protocol message.'); }
  });
  async function wait<T extends RelayMessage['type']>(type: T): Promise<Extract<RelayMessage, { type: T }>> {
    if (failure !== null) throw failure;
    const index = queued.findIndex(message => message.type === type);
    if (index >= 0) return queued.splice(index, 1)[0] as Extract<RelayMessage, { type: T }>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await new Promise<RelayMessage>((resolve, reject) => { waiter = { type, resolve, reject }; timer = setTimeout(() => reject(new Error(`Bot writer did not receive ${type}.`)), 10_000); }) as Extract<RelayMessage, { type: T }>; }
    finally { clearTimeout(timer); waiter = null; }
  }
  async function disconnect() {
    closing = true; clearInterval(heartbeat);
    if (socket.readyState === 3) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('Controlled Bot writer did not close.')); }, 5_000);
      socket.once('close', () => { clearTimeout(timer); resolve(); }); socket.close();
    });
  }
  socket.once('open', () => send({ protocol: SESSION_PROTOCOL, type: 'hello', schemaVersion: 1, projectionVersion: 1, sessionId: session.sessionId, testExecutionId,
    executionGeneration: session.executionGeneration, controllerId, controllerInstanceId, provider: 'codex', sourceEpoch, lastAckedSourceSeq: '0' }));
  try {
    const welcome = await wait('welcome');
    fence = { sessionId: session.sessionId, testExecutionId, executionGeneration: session.executionGeneration, connectionEpoch: welcome.connectionEpoch };
    send({ ...prefix(), type: 'sync_state', state: { nativeSessionId: `controlled-${initial.id}`, initialInputState: 'not_required', synchronized: true, activity: 'idle', currentTurnId: null,
      capabilities: { send: true, steer: true, cancel: true, respond: true } }, pendingInteractions: [] });
    await wait('sync_ack');
    send({ ...prefix(), type: 'events', sourceEpoch, batchId: randomUUID(), events: entries.map((entry, index) => ({ sourceSeq: String(index + 1), kind: 'timeline_upsert', payload: entry })) });
    await wait('events_ack');
    const reported = await api.post(`${base}/report`, { data: { botVersion: registered.bot.version, fence, controllerId, controllerInstanceId, nativeSessionId: `controlled-${initial.id}`, result: { state: 'ready', code: null } } });
    expect(reported.status(), 'Live Bot synchronization confirmed').toBe(200);
    heartbeat = setInterval(() => { if (socket.readyState === 1) send({ ...prefix(), type: 'heartbeat' }); }, 5_000);
  } catch (error) { await disconnect(); throw error; }
  let removed: DeletedBot | null = null;
  return {
    botId: initial.id, workerId: initial.workerId, sessionId: session.sessionId, commands, disconnect,
    async remove(): Promise<DeletedBot> {
      if (removed !== null) return removed;
      await disconnect();
      const read = await api.get(`/api/v1/me/bots/${initial.id}`); expect(read.status()).toBe(200);
      let bot = await read.json() as Bot;
      if (bot.deletion === null) {
        const response = await api.delete(`/api/v1/me/bots/${initial.id}`, { data: { ifVersion: bot.version, deletionId: randomUUID() } });
        expect(response.status()).toBe(200); bot = await response.json() as DeletedBot;
      }
      if (bot.deletion === null) throw new Error('Bot deletion was not recorded.');
      const completion = await api.post(`${base}/deletion-complete`, { data: { deletionId: bot.deletion.deletionId,
        stop: { protocol: SESSION_PROTOCOL, sessionId: session.sessionId, testExecutionId, executionGeneration: session.executionGeneration, controllerId, controllerInstanceId,
          stopProof: { recordId: randomUUID(), previousControllerInstanceId: controllerInstanceId, stoppedAt: new Date().toISOString() } }, result: { state: 'completed', code: null } } });
      expect(completion.status(), 'Controlled writer cleanup confirmed').toBe(200);
      const deleted = await completion.json() as DeletedBot;
      expect(deleted.deletion.workerCleanup.state).toBe('completed'); expect(deleted.deletion.serverCleanup.state).toBe('completed');
      removed = deleted; return deleted;
    },
  };
}
