import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request } from 'node:https';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createCompatGateway } from '../src/subtask-compat-gateway.ts';

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../../..', '.tmp');

test('TLS gateway selects independent Web shells while preserving API, authentication and old assets', async () => {
  await mkdir(root, { recursive: true });
  const tmp = await mkdtemp(path.join(root, 'subtask-compat-gateway-'));
  const upstream = createServer((req, res) => {
    if (req.url === '/api/v1/test') {
      let body = '';
      req.on('data', chunk => { body += String(chunk); });
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json', 'x-host': req.headers.host ?? '', 'x-selection-seen': String(req.headers['x-daynight-e2e-web'] ?? 'absent') }); res.end(body); });
    } else if (req.url?.startsWith('/api/v1/projects/')) { req.resume(); req.on('end', () => { res.writeHead(200); res.end('ok'); }); }
    else if (req.url === '/auth/callback') { res.writeHead(302, { location: '/projects' }); res.end(); }
    else { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-product-header': 'retained' }); res.end('<head></head>upstream'); }
  });
  let gateway: Awaited<ReturnType<typeof createCompatGateway>> | undefined;
  const taskRequests: unknown[] = [];
  try {
    await Promise.all(['old', 'new'].map(async name => {
      await mkdir(path.join(tmp, name, 'assets'), { recursive: true });
      await writeFile(path.join(tmp, name, 'index.html'), `<head></head><body>${name}</body>`);
      await writeFile(path.join(tmp, name, 'assets', `${name}-12345678.js`), name);
    }));
    await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=app.daynight.localhost', '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem')], { timeout: 15_000 });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing upstream address.');
    gateway = await createCompatGateway({ baselineWeb: path.join(tmp, 'old'), candidateWeb: path.join(tmp, 'new'), upstreamPort: address.port, appHost: 'app.daynight.localhost', previewOrigin: 'https://preview.daynight.localhost:1234', certificate: await readFile(path.join(tmp, 'cert.pem')), key: await readFile(path.join(tmp, 'key.pem')), onTaskRequest: event => taskRequests.push(event) });
    await new Promise<void>(resolve => gateway!.server.listen(0, '127.0.0.1', resolve));
    const listener = gateway.server.address();
    if (!listener || typeof listener === 'string') throw new Error('Missing gateway address.');
    const get = async (target: string, method = 'GET', body?: string, host = 'app.daynight.localhost', selection?: 'baseline' | 'candidate') => await new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: listener.port, path: target, method, rejectUnauthorized: false, headers: { host, ...(selection ? { 'x-daynight-e2e-web': selection } : {}), ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, res => {
        let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      });
      req.on('error', reject); req.end(body);
    });
    gateway.selectWeb('baseline');
    const old = await get('/projects');
    assert.match(old.body, /<body>old<\/body>/);
    assert.match(old.body, /name="daynight-preview-origin" content="https:\/\/preview.daynight.localhost:1234"/);
    assert.equal(old.headers['x-product-header'], 'retained');
    gateway.selectWeb('candidate');
    assert.match((await get('/projects')).body, /<body>new<\/body>/);
    assert.match((await get('/projects', 'GET', undefined, 'app.daynight.localhost', 'baseline')).body, /<body>old<\/body>/);
    assert.match((await get('/projects', 'GET', undefined, 'app.daynight.localhost', 'candidate')).body, /<body>new<\/body>/);
    assert.equal((await get('/assets/old-12345678.js')).body, 'old');
    assert.equal((await get('/assets/new-12345678.js')).body, 'new');
    assert.equal((await get('/assets/missing.js')).status, 404);
    const api = await get('/api/v1/test', 'POST', '{"value":1}', 'app.daynight.localhost', 'baseline');
    assert.equal(api.body, '{"value":1}');
    assert.equal(api.headers['x-host'], 'app.daynight.localhost');
    assert.equal(api.headers['x-selection-seen'], 'absent');
    assert.equal((await get('/auth/callback')).status, 302);
    assert.equal((await get('/projects', 'GET', undefined, 'preview.daynight.localhost')).body, '<head></head>upstream');
    const project = '11111111-1111-4111-8111-111111111111', parent = '22222222-2222-4222-8222-222222222222';
    await get(`/api/v1/projects/${project}/tasks?parentTaskId=${parent}&include=session&token=secret`);
    await get(`/api/v1/projects/${project}/tasks/${parent}/status`, 'PUT', '{"cancelDescendants":true,"secret":"hidden"}');
    await get(`/api/v1/projects/${project}/tasks/${parent}/status`, 'PUT', '{"status":"cancelled"}');
    await get(`/api/v1/projects/${project}/tasks/${parent}/status`, 'PUT', '{"cancelDescendants":"hidden"}');
    assert.deepEqual(taskRequests, [
      { method: 'GET', path: `/api/v1/projects/${project}/tasks`, query: { parentTaskId: parent, include: 'session' } },
      { method: 'PUT', path: `/api/v1/projects/${project}/tasks/${parent}/status`, query: {}, cancelDescendants: true },
      { method: 'PUT', path: `/api/v1/projects/${project}/tasks/${parent}/status`, query: {}, cancelDescendants: null },
      { method: 'PUT', path: `/api/v1/projects/${project}/tasks/${parent}/status`, query: {}, cancelDescendants: 'invalid' },
    ]);
  } finally {
    await gateway?.close();
    if (upstream.listening) await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    await rm(tmp, { recursive: true, force: true });
  }
});
