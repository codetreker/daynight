import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { EventEmitter } from 'node:events';
import { parseControllerGrantResponse, parseRegistrationResponse, parseRelayMessage, type ControllerMessage, type ControllerState, type RelayMessage } from '../../../daynight/src/session/controller-protocol';
import { SESSION_PROTOCOL, type ControllerFence } from '../../../daynight/src/session/protocol';
import { readWorkerClaim } from '../../src/api/task-properties';
import type { AuthenticatedAPI } from './authentication';
import { expect, type Task } from './fixtures';

type Socket = EventEmitter & { send(value: string): void; close(): void; terminate(): void; readonly readyState: number };
// The Controller's declared ws dependency supplies the same transport as production.
const WebSocket = createRequire(new URL('../../../daynight/package.json', import.meta.url))('ws') as new (url: URL, options: { headers: Record<string, string>; handshakeTimeout: number }) => Socket;

export const openStatusController = async (api: AuthenticatedAPI, origin: string, task: Task, activity: ControllerState['activity']) => {
  const taskPath = `/api/v1/projects/${task.projectId}/tasks/${task.id}`;
  const enabledResponse = await api.patch(taskPath, { data: { version: task.version, allowAgents: true } });
  expect(enabledResponse.status()).toBe(200);
  const enabled = await enabledResponse.json() as Task;
  const claimId = randomUUID(), workerId = randomUUID(), worktreeId = randomUUID();
  const claimResponse = await api.post(`${taskPath}/worker-claim`, { headers: { 'Daynight-Worker-Protocol': '2' }, data: {
    version: enabled.version, claimId, workerId, worktreeId, machine: { id: randomUUID(), name: 'session-status-fixture' },
    platform: 'linux', agent: 'codex', agentControlMode: 'web',
  } });
  expect(claimResponse.status()).toBe(200);
  const claimed = await claimResponse.json() as Task;
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
  const prefix = () => { if (fence === null) throw new Error('Controller is not connected.'); return { protocol: SESSION_PROTOCOL, ...fence }; };
  const send = (message: ControllerMessage) => socket.send(JSON.stringify(message));
  const fail = () => { failure = new Error('Status fixture Controller transport failed.'); waiter?.reject(failure); };
  socket.on('error', fail);
  socket.on('message', (data: { toString(): string }) => {
    try {
      const message = parseRelayMessage(JSON.parse(data.toString()));
      if (message.type === 'error') { fail(); return; }
      if (message.type === 'content_request') {
        if (message.kind !== 'timeline') throw new Error('Unexpected resource request.');
        send({ ...prefix(), type: 'content_response', requestId: message.requestId, sourceThrough: '0', error: null,
          result: { kind: 'timeline', historyEpoch: message.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false } });
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
        timer = setTimeout(() => reject(new Error(`Status fixture did not receive ${type}.`)), 10_000);
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
  const update = async (next: ControllerState['activity']) => {
    send({ ...prefix(), type: 'sync_state', state: {
      nativeSessionId: `status-${task.id}`, initialInputState: 'confirmed', synchronized: true,
      activity: next, currentTurnId: next === 'working' ? 'status-turn' : null,
      capabilities: { send: true, steer: true, cancel: true, respond: true },
    }, pendingInteractions: [] });
    await wait('sync_ack');
  };
  socket.once('open', () => send({ type: 'hello', protocol: SESSION_PROTOCOL, schemaVersion: 1, projectionVersion: 1,
    sessionId: session.sessionId, claimId, executionGeneration: session.executionGeneration,
    controllerId, controllerInstanceId, provider: 'codex', sourceEpoch: randomUUID(), lastAckedSourceSeq: '0' }));
  try {
    const welcome = await wait('welcome');
    fence = { sessionId: session.sessionId, claimId, executionGeneration: session.executionGeneration, connectionEpoch: welcome.connectionEpoch };
    await update(activity);
    heartbeat = setInterval(() => { if (socket.readyState === 1) send({ ...prefix(), type: 'heartbeat' }); }, 5_000);
  } catch (error) { await closeSocket(); throw error; }
  return {
    task: claimed, sessionId: session.sessionId, update, disconnect: closeSocket,
    close: async () => {
      await closeSocket();
      const response = await api.get(taskPath);
      expect(response.status()).toBe(200);
      const current = await response.json() as Task;
      const claim = readWorkerClaim(current.properties);
      if (claim?.claimId === claimId && claim.state === 'active') {
        const released = await api.post(`${taskPath}/worker-claim/release`, { headers: { 'Daynight-Worker-Protocol': '2' }, data: { version: current.version, claimId, stoppedConfirmed: true } });
        expect(released.status()).toBe(200);
      }
    },
  };
};
