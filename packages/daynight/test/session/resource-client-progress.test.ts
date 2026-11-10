import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createSessionResourceClient } from '../../src/session/resource-client.js';

it('reports actual response-body progress before the complete resource arrives', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const bytes = Buffer.from('saved original'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const scope = { serverOrigin: 'https://daynight.cc', actorUserId: id, authorizationGeneration: '1', fence: { sessionId: id, claimId: id, executionGeneration: '1' } };
  const envelope = new TextEncoder().encode(JSON.stringify({ resourceId: id, byteLength: String(bytes.length), sha256, offset: '0', data: bytes.toString('base64'), eof: true }));
  let release!: () => void, observed!: () => void;
  const chunkObserved = new Promise<void>(resolve => { observed = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const api = createSessionResourceClient({ scope, baseUrl: `https://daynight.cc/api/v1/test-sessions/${id}`, isCurrent: () => true,
    transport: async () => new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(envelope.slice(0, 20)); await held;
      controller.enqueue(envelope.slice(20)); controller.close();
    } }), { headers: { 'Daynight-User-ID': id } }),
  });
  let progress = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = api.readResource({ resourceId: id, status: 'available', name: 'original', mediaType: 'text/plain', byteLength: String(bytes.length), sha256, error: null }, new AbortController().signal, () => { progress++; observed(); });
  try {
    const outcome = await Promise.race([chunkObserved.then(() => 'progress'), new Promise<string>(resolve => { timer = setTimeout(() => resolve('missing'), 500); })]);
    expect(outcome).toBe('progress');
    expect(progress).toBe(1);
    release();
    expect(Buffer.from(await read)).toEqual(bytes);
    expect(progress).toBe(2);
  } finally { clearTimeout(timer); release(); await read.catch(() => {}); await api.close(); }
});
