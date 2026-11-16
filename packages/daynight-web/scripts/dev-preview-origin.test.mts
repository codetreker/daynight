import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { win32 } from 'node:path';
import { createServer as createHTTPServer, get as httpGet } from 'node:http';
import test from 'node:test';
import { createServer, resolveConfig } from 'vite';
import { normalizeDevConfigPath } from '../vite.config.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const initial = process.env.DAYNIGHT_PREVIEW_ORIGIN;

test('ordinary Vite development shell publishes the configured Task preview origin', async () => {
  process.env.DAYNIGHT_PREVIEW_ORIGIN = 'http://preview.daynight.localhost:8787';
  const server = await createServer({ root, configFile, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (address === null || typeof address === 'string') throw new Error('Vite did not bind TCP.');
    for (const route of ['/projects/00000000-0000-4000-8000-000000000001/tasks/00000000-0000-4000-8000-000000000002', '/projects']) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}${route}`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /<meta name="daynight-preview-origin" content="http:\/\/preview\.daynight\.localhost:8787">/);
      assert.equal((html.match(/name="daynight-preview-origin"/g) ?? []).length, 1);
    }
    const proxy = server.config.server.proxy!['/api'];
    if (proxy === undefined || typeof proxy === 'string') throw new Error('Missing API proxy.');
    assert.equal(proxy.target, 'http://127.0.0.1:8787');
    assert.equal(proxy.changeOrigin, false);
  } finally {
    await server.close();
    if (initial === undefined) delete process.env.DAYNIGHT_PREVIEW_ORIGIN;
    else process.env.DAYNIGHT_PREVIEW_ORIGIN = initial;
  }
});

test('development API proxy preserves the browser Host', async () => {
  process.env.DAYNIGHT_PREVIEW_ORIGIN = 'http://preview.daynight.localhost:8787';
  const upstream = createHTTPServer((request, response) => response.end(request.headers.host));
  await new Promise<void>((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  const target = upstream.address();
  if (target === null || typeof target === 'string') throw new Error('Upstream did not bind TCP.');
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    server = await createServer({ root, configFile, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: `http://127.0.0.1:${target.port}`, changeOrigin: false } } } });
    await server.listen();
    const address = server.httpServer!.address();
    if (address === null || typeof address === 'string') throw new Error('Vite did not bind TCP.');
    const host = await new Promise<string>((resolve, reject) => {
      const request = httpGet({ hostname: '127.0.0.1', port: address.port, path: '/api/v1/me', headers: { Host: 'app.daynight.localhost:5173' }, signal: AbortSignal.timeout(5_000) }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.once('end', () => resolve(body)); response.once('error', reject);
      });
      request.once('error', reject);
    });
    assert.equal(host, 'app.daynight.localhost:5173');
  } finally {
    await server?.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    if (initial === undefined) delete process.env.DAYNIGHT_PREVIEW_ORIGIN;
    else process.env.DAYNIGHT_PREVIEW_ORIGIN = initial;
  }
});

test('ordinary Vite development rejects missing, noncanonical and non-routable preview origins', async () => {
  try {
    for (const value of [undefined, '', 'http://127.0.0.1:8789', 'http://[::1]:8789', 'http://external.example', 'https://preview.example/path', 'https://user@preview.example', 'https://PREVIEW.example']) {
      if (value === undefined) delete process.env.DAYNIGHT_PREVIEW_ORIGIN;
      else process.env.DAYNIGHT_PREVIEW_ORIGIN = value;
      await assert.rejects(createServer({ root, configFile, logLevel: 'silent' }), /Set DAYNIGHT_PREVIEW_ORIGIN.*exact preview origin/);
    }
  } finally {
    if (initial === undefined) delete process.env.DAYNIGHT_PREVIEW_ORIGIN;
    else process.env.DAYNIGHT_PREVIEW_ORIGIN = initial;
  }
});

test('normalizes the ordinary Vite config path on Windows', () => {
  const root = 'C:\\work\\daynight-web';
  const viteConfig = 'C:/work/daynight-web/vite.config.ts';
  assert.equal(normalizeDevConfigPath(win32.resolve(root, 'vite.config.ts')), viteConfig);
});

test('production build configuration does not require development metadata', async () => {
  try {
    delete process.env.DAYNIGHT_PREVIEW_ORIGIN;
    const config = await resolveConfig({ root, configFile, logLevel: 'silent' }, 'build');
    assert.equal(config.plugins.some(plugin => plugin.name === 'daynight-development-preview-origin'), false);
  } finally {
    if (initial === undefined) delete process.env.DAYNIGHT_PREVIEW_ORIGIN;
    else process.env.DAYNIGHT_PREVIEW_ORIGIN = initial;
  }
});
