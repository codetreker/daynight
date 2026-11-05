import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { EventEmitter } from 'node:events';
import { parseControllerGrantResponse, parseRegistrationResponse, parseRelayMessage, type ControllerMessage, type ControllerState, type RelayMessage } from '../../../daynight/src/session/controller-protocol';
import { SESSION_PROTOCOL, type ControllerFence, type SessionCommand } from '../../../daynight/src/session/protocol';
import { readWorkerClaim } from '../../src/api/task-properties';
import type { AuthenticatedAPI } from './authentication';
import { expect, type Task } from './fixtures';

type Socket = EventEmitter & { send(value: string): void; close(): void; terminate(): void; readonly readyState: number };
// The Controller's declared ws dependency supplies the same transport as production.
const WebSocket = createRequire(new URL('../../../daynight/package.json', import.meta.url))('ws') as new (url: URL, options: { headers: Record<string, string>; handshakeTimeout: number }) => Socket;

/** Controlled Session state over the real relay; no native Provider is started. */
export const openFooterController = async (api: AuthenticatedAPI, origin: string, task: Task, activity: ControllerState['activity']) => {
  const taskPath = `/api/v1/projects/${task.projectId}/tasks/${task.id}`;
  const enabledResponse = await api.patch(taskPath, { data: { version: task.version, allowAgents: true } });
  expect(enabledResponse.status()).toBe(200);
  const enabled = await enabledResponse.json() as Task;
  const claimId = randomUUID(), workerId = randomUUID(), worktreeId = randomUUID();
  const claimResponse = await api.post(`${taskPath}/worker-claim`, { headers: { 'Daynight-Worker-Protocol': '2' }, data: {
    version: enabled.version, claimId, workerId, worktreeId, machine: { id: randomUUID(), name: 'session-footer-fixture' },
    platform: 'linux', agent: 'codex', agentControlMode: 'web',
  } });
  expect(claimResponse.status()).toBe(200);
  const claimed = await claimResponse.json() as Task;
  const releaseClaim = async () => {
    // Task details omit runtime properties; the dedicated resource owns current claim observation.
    const response = await api.get(`${taskPath}/properties`);
    expect(response.status()).toBe(200);
    const current = await response.json() as { projectId: string; taskId: string; version: number; properties: Task['properties'] };
    expect(current.projectId).toBe(task.projectId); expect(current.taskId).toBe(task.id);
    const claim = readWorkerClaim(current.properties);
    expect(claim?.claimId, 'Cleanup retains the original fixture claim').toBe(claimId);
    if (claim?.state === 'active') {
      const released = await api.post(`${taskPath}/worker-claim/release`, { headers: { 'Daynight-Worker-Protocol': '2' }, data: { version: current.version, claimId, stoppedConfirmed: true } });
      expect(released.status()).toBe(200);
    }
    const confirmedResponse = await api.get(`${taskPath}/properties`);
    expect(confirmedResponse.status()).toBe(200);
    const confirmed = await confirmedResponse.json() as { version: number; properties: Task['properties'] };
    const releasedClaim = readWorkerClaim(confirmed.properties);
    expect(releasedClaim?.claimId).toBe(claimId);
    expect(releasedClaim?.state, 'Fixture claim release is confirmed').toBe('released');
    return { claimId, state: releasedClaim!.state, version: confirmed.version };
  };
  let closeTransport: (() => Promise<void>) | undefined;
  try {
    const controllerId = randomUUID(), controllerInstanceId = randomUUID();
    const registration = await api.post(`${taskPath}/sessions`, { data: {
      protocol: SESSION_PROTOCOL, registrationId: randomUUID(), claimId, workerId, worktreeId, provider: 'codex', controllerId, controllerInstanceId,
    } });
    expect(registration.status()).toBe(200);
    const { session } = parseRegistrationResponse(await registration.json());
    const grantResponse = await api.post(`${taskPath}/sessions/${session.sessionId}/controller-grant`, { data: {
      protocol: SESSION_PROTOCOL, claimId, controllerId, controllerInstanceId, executionGeneration: session.executionGeneration,
      kind: 'bootstrap', previousGeneration: null, stopProof: null,
    } });
    expect(grantResponse.status()).toBe(200);
    const grant = parseControllerGrantResponse(await grantResponse.json());
    const url = new URL('/api/v1/controller-channel', origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${grant.token}` }, handshakeTimeout: 10_000 });
    let fence: ControllerFence | null = null;
    let failure: Error | null = null;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let waiter: { type: RelayMessage['type']; resolve: (message: RelayMessage) => void; reject: (error: Error) => void } | null = null;
    const queued: RelayMessage[] = [];
    const commands: SessionCommand[] = [];
    const prefix = () => { if (fence === null) throw new Error('Controller is not connected.'); return { protocol: SESSION_PROTOCOL, ...fence }; };
    const send = (message: ControllerMessage) => socket.send(JSON.stringify(message));
    const fail = () => { failure = new Error('Footer fixture Controller transport failed.'); waiter?.reject(failure); };
    socket.on('error', fail);
    socket.on('message', (data: { toString(): string }) => {
      try {
        const message = parseRelayMessage(JSON.parse(data.toString()));
        if (message.type === 'error') { fail(); return; }
        if (message.type === 'content_request') {
          if (message.kind !== 'timeline') throw new Error('Unexpected resource request.');
          send({ ...prefix(), type: 'content_response', requestId: message.requestId, sourceThrough: '0', error: null,
            result: { kind: 'timeline', historyEpoch: message.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false } });
        } else if (message.type === 'operation_offer') {
          commands.push(message.command);
          send({ ...prefix(), type: 'operation_begin', operationId: message.command.operationId });
        } else if (message.type !== 'heartbeat_ack') {
          if (waiter?.type === message.type) { const current = waiter; waiter = null; current.resolve(message); }
          else queued.push(message);
        }
      } catch { fail(); }
    });
    const wait = async <T extends RelayMessage['type']>(type: T): Promise<Extract<RelayMessage, { type: T }>> => {
      if (failure !== null) throw failure;
      const index = queued.findIndex(message => message.type === type);
      if (index >= 0) return queued.splice(index, 1)[0] as Extract<RelayMessage, { type: T }>;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<RelayMessage>((resolve, reject) => {
          waiter = { type, resolve, reject };
          timer = setTimeout(() => reject(new Error(`Footer fixture did not receive ${type}.`)), 10_000);
        }) as Extract<RelayMessage, { type: T }>;
      } finally { clearTimeout(timer); waiter = null; }
    };
    const closeSocket = async () => {
      clearInterval(heartbeat);
      if (socket.readyState === 3) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { socket.terminate(); }, 2_000);
        socket.once('close', () => { clearTimeout(timer); resolve(); });
        socket.close();
      });
    };
    closeTransport = closeSocket;
    let revision = 0;
    const update = async (next: ControllerState['activity'], model = 'GPT-6-Astra', startedAt = new Date(Date.now() - 15_000).toISOString(), synchronized = true) => {
      send({ ...prefix(), type: 'sync_state', state: {
        nativeSessionId: `footer-${task.id}`, initialInputState: 'confirmed', synchronized,
        activity: next, currentTurnId: ['working', 'waiting_input'].includes(next) ? 'footer-turn' : null,
        turnStartedAt: ['working', 'waiting_input'].includes(next) ? startedAt : null,
        controls: { revision: String(++revision), settings: [
          { id: 'model', category: 'model', label: 'Model selection', description: null, value: 'footer-model', mutable: true, scope: 'session', options: [{ value: 'footer-model', label: model }] },
          { id: 'permission', category: 'permission', label: 'Permissions', description: null, value: 'ask', mutable: true, scope: 'session', options: [{ value: 'ask', label: 'Ask' }] },
        ], commands: [{ id: 'compact', name: 'compact', description: 'Compact context', argumentHint: null, available: true }], settingsError: null, commandsError: null },
        capabilities: { send: true, steer: true, cancel: true, respond: true },
      }, pendingInteractions: [] });
      await wait('sync_ack');
    };
    socket.once('open', () => send({ type: 'hello', protocol: SESSION_PROTOCOL, schemaVersion: 1, projectionVersion: 1,
      sessionId: session.sessionId, claimId, executionGeneration: session.executionGeneration,
      controllerId, controllerInstanceId, provider: 'codex', sourceEpoch: randomUUID(), lastAckedSourceSeq: '0' }));
    const welcome = await wait('welcome');
    fence = { sessionId: session.sessionId, claimId, executionGeneration: session.executionGeneration, connectionEpoch: welcome.connectionEpoch };
    await update(activity);
    heartbeat = setInterval(() => { if (socket.readyState === 1) send({ ...prefix(), type: 'heartbeat' }); }, 5_000);
    return {
      task: claimed, sessionId: session.sessionId, update, disconnect: closeSocket,
      waitForSubmission: async () => {
        const authorized = await wait('operation_authorized');
        const command = commands.find(value => value.operationId === authorized.operationId);
        if (!command) throw new Error('Footer operation has no original command.');
        return command;
      },
      rejectSubmission: async (command: SessionCommand) => {
        send({ ...prefix(), type: 'operation_receipt', operation: { protocol: SESSION_PROTOCOL, sessionId: session.sessionId, claimId, executionGeneration: session.executionGeneration,
          operationId: command.operationId, kind: command.kind, state: 'rejected', providerResult: null, error: { code: 'fixture_rejected', message: 'Controlled layout rejection; no Provider action was executed.' } } });
        await wait('receipt_ack');
      },
      close: async () => {
        await closeSocket();
        return await releaseClaim();
      },
    };
  } catch (error) {
    try { await closeTransport?.(); await releaseClaim(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Footer Controller setup and cleanup failed.'); }
    throw error;
  }
};
