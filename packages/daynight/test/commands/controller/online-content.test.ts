import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { openControllerLifecycleStore } from '../../../src/commands/controller/lifecycle-store.js';
import { createControllerRelay } from '../../../src/commands/controller/relay.js';
import type { ControllerLaunchTicket } from '../../../src/commands/controller/launch-ticket.js';
import { RELAY_LIMITS, parseControllerMessage } from '../../../src/session/controller-protocol.js';
import snapshotFixture from '../../session/fixtures/snapshot.json' with { type: 'json' };

it('hydrates over real WebSockets after offline compaction and fences a page before newer events', async () => {
  const base = path.resolve(import.meta.dirname, '../../../../../.tmp/controller-tests');
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, 'online-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test relay address');
  const ticket: ControllerLaunchTicket = {
    schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(),
    sessionId: randomUUID(), executionGeneration: '1', serverOrigin: `http://127.0.0.1:${address.port}`,
    projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(),
    provider: 'codex', cwd: home, nativeHome: path.join(home, '.codex'), configuration: { agent: 'codex', agentControlMode: 'web', model: null, args: [], recoveryLimit: 2 },
    initialOperationId: randomUUID(), initialPrompt: 'Initial input', resumeNativeSessionId: null, credentialFile: path.join(home, 'grant.json'),
    ipcEndpoint: path.join(home, 'c.sock'), ipcSecret: 'a'.repeat(64), createdAt: new Date().toISOString(),
  };
  await writeFile(ticket.credentialFile, JSON.stringify({ token: 'local-test-token', expiresAt: new Date(Date.now() + 60_000).toISOString(), sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId }), { mode: 0o600 });
  const journal = openControllerLifecycleStore(path.join(home, 'journal.sqlite'), ticket, { contentOwnedLocally: true, maxOutboxBytes: 1024 });
  let relay: ReturnType<typeof createControllerRelay> | undefined;
  const errors: string[] = [];
  try {
    journal.patchSnapshot({ nativeSessionId: 'native-test', initialInputState: 'confirmed', activity: 'idle', capabilities: { send: true, steer: false, cancel: false, respond: false } });
    for (let i = 0; i < 10; i++) journal.projectTimeline({ entryId: randomUUID(), revision: '1', kind: 'reasoning', text: `Before reconnect ${i} ${'x'.repeat(100)}` });
    const floor = journal.getSourceFloor();
    expect(BigInt(floor)).toBeGreaterThan(0n);
    const fence = { protocol: 'daynight.session.v1', sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: '1', connectionEpoch: '1' };
    const historyEpoch = randomUUID();
    let through = floor, serverSequence = 0n;
    const received: ReturnType<typeof parseControllerMessage>[] = [];
    const connection = once(server, 'connection');
    relay = createControllerRelay(ticket, journal, { onConnection() {}, onCommand: async () => { throw new Error('Unexpected native input'); }, onError: error => errors.push(error) });
    const [socket] = await connection;
    socket.on('message', (raw: Buffer) => {
      const m = parseControllerMessage(JSON.parse(raw.toString())); received.push(m);
      if (m.type === 'hello') {
        expect(m.sourceFloor).toBe(floor);
        const session = { ...snapshotFixture, ...fence, historyEpoch, lastEventSeq: '0', lastTimelineSeq: '0', identity: { ...snapshotFixture.identity, projectId: ticket.projectId, taskId: ticket.taskId, workerId: ticket.workerId, worktreeId: ticket.worktreeId, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, nativeSessionId: 'native-test' } };
        socket.send(JSON.stringify({ type: 'welcome', protocol: fence.protocol, connectionEpoch: '1', session, lastAckedSourceSeq: floor, limits: RELAY_LIMITS, requiresLiveSync: true }));
      } else if (m.type === 'reconcile') socket.send(JSON.stringify({ ...fence, type: 'reconcile_result', operations: [] }));
      else if (m.type === 'events') {
        expect(BigInt(m.events[0]!.sourceSeq)).toBe(BigInt(through) + 1n);
        through = m.events.at(-1)!.sourceSeq; serverSequence += BigInt(m.events.length);
        socket.send(JSON.stringify({ ...fence, type: 'events_ack', sourceEpoch: m.sourceEpoch, batchId: m.batchId, lastAckedSourceSeq: through, lastEventSeq: String(serverSequence) }));
      } else if (m.type === 'sync_state') {
        expect(m.state.synchronized).toBe(true);
        socket.send(JSON.stringify({ ...fence, type: 'sync_ack' }));
      } else if (m.type === 'content_response') expect(m.sourceThrough).toBe(through);
    });
    await vi.waitFor(() => expect(relay!.connected()).toBe(true));
    // Capture the page synchronously in readTimeline, then append another native
    // event. The transport must send that event only after the page response.
    const originalRead = journal.readTimeline;
    const lateId = randomUUID();
    journal.readTimeline = query => {
      const page = originalRead(query);
      queueMicrotask(() => journal.projectTimeline({ entryId: lateId, revision: '1', kind: 'reasoning', text: 'After page snapshot' }));
      return page;
    };
    socket.send(JSON.stringify({ ...fence, type: 'content_request', requestId: randomUUID(), kind: 'timeline', historyEpoch, direction: 'tail', cursor: null, limit: 100 }));
    await vi.waitFor(() => expect(received.some(m => m.type === 'content_response')).toBe(true));
    const responseIndex = received.findIndex(m => m.type === 'content_response');
    const response = received[responseIndex]!;
    expect(response.type === 'content_response' && response.result?.kind === 'timeline' && response.result.items.length).toBe(10);
    await vi.waitFor(() => expect(received.slice(responseIndex + 1).some(m => m.type === 'events' && m.events.some(e => e.kind === 'timeline_upsert' && e.payload.entryId === lateId))).toBe(true));
    expect(errors).toEqual([]);
  } finally {
    relay?.close(); journal.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
