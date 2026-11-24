import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { observeWorkerCandidates } from './subtask-compat-worker-observer.ts';

test('Worker candidate observation fences pre-transition responses and unsafe claims', async () => {
  const root = path.resolve(import.meta.dirname, '../../../.tmp', `worker-observer-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  let upstream: ReturnType<typeof createServer> | undefined;
  let observer: Awaited<ReturnType<typeof observeWorkerCandidates>> | undefined;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=app.daynight.localhost', '-addext', 'subjectAltName=DNS:app.daynight.localhost', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem')], { stdio: 'ignore', timeout: 15_000 });
    const certificate = await readFile(path.join(root, 'cert.pem')), key = await readFile(path.join(root, 'key.pem'));
    const projectId = randomUUID(), blockedTaskId = randomUUID(), workerId = randomUUID();
    let held: ServerResponse | undefined, arrived!: () => void, claimCalls = 0;
    const arrival = new Promise<void>(resolve => { arrived = resolve; });
    upstream = createServer({ cert: certificate, key }, (req, res) => {
      if (req.method === 'POST') { claimCalls++; res.end(); return; }
      if (req.url?.includes('hold=true')) { held = res; arrived(); return; }
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-request-id', 'fixture-request');
      res.end(JSON.stringify({ items: req.url?.includes('bad=true') ? [{ id: blockedTaskId }] : [], nextCursor: null }));
    });
    await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('No upstream port.');
    observer = await observeWorkerCandidates({ server: `https://app.daynight.localhost:${address.port}`, certificate, key, projectId, blockedTaskId, workerId });
    const send = (method: string, url: string) => new Promise<number>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: Number(new URL(observer!.origin).port), servername: 'app.daynight.localhost', ca: certificate, method, path: url }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.end();
    });
    const base = `/api/v1/projects/${projectId}/tasks`;
    const query = 'automaticCandidate=true&ready=true&allowAgents=true&assignedTo=me&compatiblePlatform=linux';
    const first = send('GET', `${base}?${query}&hold=true`);
    await arrival;
    const generation = observer.arm();
    held!.end(JSON.stringify({ items: [], nextCursor: null }));
    assert.equal(await first, 200);
    assert.equal(observer.seen(generation), false);
    assert.equal(await send('GET', `${base}?${query}`), 200);
    assert.equal(observer.seen(generation), true);
    assert.equal(observer.requestId(generation), 'fixture-request');
    assert.equal(await send('POST', `${base}/${blockedTaskId}/worker-claim`), 503);
    assert.equal(claimCalls, 0);
    assert.throws(() => observer!.seen(generation), /attempted to claim/);
    await observer.close();
    observer = await observeWorkerCandidates({ server: `https://app.daynight.localhost:${address.port}`, certificate, key, projectId, blockedTaskId, workerId });
    const second = observer.arm();
    assert.equal(await send('GET', `${base}?${query}&bad=true`), 503);
    assert.throws(() => observer!.seen(second), /descendant appeared/);
    await observer.close();
    observer = await observeWorkerCandidates({ server: `https://app.daynight.localhost:${address.port}`, certificate, key, projectId, blockedTaskId, workerId });
    const third = observer.arm();
    assert.equal(await send('GET', `${base}?${query}&platformSpecific=true`), 503);
    assert.throws(() => observer!.seen(third), /expected conditions/);
  } finally {
    await observer?.close();
    if (upstream) await new Promise<void>((resolve, reject) => upstream!.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
