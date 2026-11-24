import { createServer, request } from 'node:https';
import { connect } from 'node:tls';
import type { Socket } from 'node:net';

// Only the Worker uses this loopback gateway. The candidate response is checked
// before delivery so a regression cannot create an unregistered second claim.
export async function observeWorkerCandidates(input: { server: string; certificate: Buffer; key: Buffer; projectId: string; blockedTaskId: string; workerId: string }) {
  const upstream = new URL(input.server);
  if (upstream.protocol !== 'https:' || upstream.hostname !== 'app.daynight.localhost' || upstream.username || upstream.password || upstream.pathname !== '/') throw new Error('Unexpected candidate Server origin.');
  const sockets = new Set<Socket>();
  let generation = 0, observed = 0, failure: Error | undefined;
  const requestIds = new Map<number, string>();
  const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const server = createServer({ cert: input.certificate, key: input.key }, (incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', input.server);
    const collection = `/api/v1/projects/${input.projectId}/tasks`;
    const candidate = incoming.method === 'GET' && url.pathname === collection && url.searchParams.get('automaticCandidate') === 'true';
    const requestGeneration = generation;
    if (incoming.method === 'POST' && url.pathname === `${collection}/${input.blockedTaskId}/worker-claim`) {
      failure ??= new Error('Worker attempted to claim the blocked descendant.');
      outgoing.writeHead(503); outgoing.end(); incoming.resume(); return;
    }
    const forwarded = request({ hostname: '127.0.0.1', port: upstream.port || 443, servername: upstream.hostname, ca: input.certificate, path: `${url.pathname}${url.search}`, method: incoming.method, headers: { ...incoming.headers, host: upstream.host } }, response => {
      response.on('error', () => outgoing.destroy());
      if (!candidate || requestGeneration === 0) {
        outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= 1024 * 1024) chunks.push(chunk); });
      response.on('end', () => {
        try {
          if (url.searchParams.get('ready') !== 'true' || url.searchParams.get('allowAgents') !== 'true' || url.searchParams.get('assignedTo') !== 'me' || url.searchParams.get('compatiblePlatform') !== 'linux' || url.searchParams.has('cursor') || url.searchParams.get('platformSpecific') === 'true' || ['parentId', 'parentTaskId', 'tagIds', 'untagged', 'workerId'].some(key => url.searchParams.has(key)) || (url.searchParams.has('status') && url.searchParams.get('status') !== 'todo') || (url.searchParams.has('type') && url.searchParams.get('type') !== 'task') || (url.searchParams.has('candidateWorkerId') && url.searchParams.get('candidateWorkerId') !== input.workerId)) throw new Error('Worker candidate query does not cover the expected conditions.');
          if (response.statusCode !== 200 || size > 1024 * 1024) throw new Error('Worker candidate response failed or exceeded its limit.');
          const requestId = response.headers['x-request-id'];
          if (typeof requestId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(requestId)) throw new Error('Worker candidate response has no safe request ID.');
          const page = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { items?: unknown; nextCursor?: unknown };
          if (!Array.isArray(page.items) || page.nextCursor !== null || page.items.some(item => typeof item !== 'object' || item === null || typeof item.id !== 'string')) throw new Error('Worker candidate response is incomplete.');
          if (page.items.some(item => item.id === input.blockedTaskId)) throw new Error('Terminal Goal descendant appeared in the Worker candidate response.');
          outgoing.writeHead(200, response.headers);
          outgoing.end(Buffer.concat(chunks), () => { requestIds.set(requestGeneration, requestId); observed = Math.max(observed, requestGeneration); });
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error('Invalid candidate response.');
          if (!outgoing.headersSent) outgoing.writeHead(503);
          outgoing.end();
        }
      });
    });
    forwarded.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.on('aborted', () => forwarded.destroy());
    outgoing.on('close', () => { if (!outgoing.writableFinished) forwarded.destroy(); });
    incoming.pipe(forwarded);
  });
  server.on('connection', track);
  server.on('upgrade', (incoming, socket, head) => {
    const target = connect({ host: '127.0.0.1', port: Number(upstream.port || 443), servername: upstream.hostname, ca: input.certificate });
    track(target);
    target.once('error', () => socket.destroy()); socket.once('error', () => target.destroy());
    target.once('secureConnect', () => {
      const headers = [`${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}`];
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.push(`${incoming.rawHeaders[i]}: ${incoming.rawHeaders[i + 1]}`);
      target.write(`${headers.join('\r\n')}\r\n\r\n`); if (head.length) target.write(head); socket.pipe(target).pipe(socket);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Worker observer has no loopback address.');
  return {
    origin: `https://${upstream.hostname}:${address.port}`,
    arm: () => ++generation,
    seen: (expected: number) => { if (failure) throw failure; return observed >= expected; },
    requestId: (expected: number) => requestIds.get(expected),
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
