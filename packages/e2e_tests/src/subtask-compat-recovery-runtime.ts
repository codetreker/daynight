import { createHash } from 'node:crypto';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { createServer as createTLSServer } from 'node:tls';
import { createServer as createHTTPSServer } from 'node:https';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runCommand, startCommand, type ManagedCommand } from './command.ts';
import { startProvider, providerClientId, providerClientSecret } from './provider.ts';
import { writeServerConfig } from './server-config.ts';

type Configuration = { serverPort: number; authPort: number; proxyPort: number; receiverPort: number; databaseURL: string; uid: number; gid: number };
const root = '/run/private', artifacts = '/opt/e2e';
const config = JSON.parse(await readFile(path.join(root, 'runtime.json'), 'utf8')) as Configuration;
const servers: Server[] = [];
const sockets = new Set<Socket>();
let auth: ManagedCommand | undefined, occupied: Server | undefined, stopping = false;
let delivered: string[] = [];
let wake: () => void = () => {};
const stopped = new Promise<void>(resolve => { wake = resolve; });
let failure: unknown;
const stop = (): void => { stopping = true; wake(); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
const pause = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms));
const listen = async (server: Server, port: number, host: string): Promise<void> => await new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); });
});
const localPort = async (excluded: Set<number>): Promise<number> => {
  const server = createServer(); await listen(server, 0, '127.0.0.1');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local port.');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (excluded.has(address.port)) return await localPort(excluded);
  excluded.add(address.port); return address.port;
};
const close = async (server: Server): Promise<void> => await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const forward = async (port: number, target: number, tls: boolean): Promise<void> => {
  const onConnection = (incoming: Socket): void => {
    const upstream = connect({ host: '127.0.0.1', port: target });
    for (const socket of [incoming, upstream]) {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      socket.once('error', () => { incoming.destroy(); upstream.destroy(); });
    }
    incoming.pipe(upstream).pipe(incoming);
    incoming.once('close', () => upstream.destroy());
  };
  const server = tls ? createTLSServer({ cert: await readFile(path.join(artifacts, 'daynight-ca.pem')), key: await readFile(path.join(artifacts, 'daynight-key.pem')) }, onConnection) : createServer(onConnection);
  await listen(server, port, '0.0.0.0'); servers.push(server);
};

try {
  for (const family of [[], ['-6']]) {
    while (true) {
      const opts = { cwd: artifacts, env: { PATH: process.env.PATH }, timeoutMs: 10_000, onOutput: () => {} };
      if (!(await runCommand('ip', [...family, 'route', 'show', 'default'], opts)).stdout.trim()) break;
      await runCommand('ip', [...family, 'route', 'del', 'default'], opts);
    }
  }
  process.setgid!(config.gid); process.setuid!(config.uid);
  await mkdir(path.join(root, 'storage'), { recursive: true, mode: 0o700 });
  const provider = await startProvider({ port: config.proxyPort, certificatePath: path.join(artifacts, 'provider-ca.pem'), keyPath: path.join(artifacts, 'provider-key.pem') });
  const excluded = new Set([config.authPort, config.serverPort, config.proxyPort, config.receiverPort]);
  const authInternal = await localPort(excluded), serverInternal = await localPort(excluded);
  await forward(config.authPort, authInternal, false);
  await forward(config.serverPort, serverInternal, true);
  const authURL = `http://127.0.0.1:${config.authPort}`;
  const baseURL = `https://app.daynight.localhost:${config.serverPort}`;
  const proxyURL = `http://127.0.0.1:${config.proxyPort}`;
  auth = startCommand(path.join(artifacts, 'uniauth'), [], { cwd: artifacts, env: {
    PATH: process.env.PATH, HTTPS_PROXY: proxyURL, HTTP_PROXY: proxyURL, NO_PROXY: '127.0.0.1,localhost,postgres,redis', SSL_CERT_FILE: path.join(artifacts, 'provider-ca.pem'),
    UNIAUTH_PUBLIC_URL: authURL, UNIAUTH_LISTEN_ADDR: `127.0.0.1:${authInternal}`, UNIAUTH_ALLOW_LOOPBACK_HTTP: 'true',
    UNIAUTH_DATABASE_PATH: path.join(root, 'uniauth.db'), UNIAUTH_INITIAL_ADMIN_EMAIL: 'admin@example.test',
    UNIAUTH_GITHUB_CLIENT_ID: providerClientId, UNIAUTH_GITHUB_CLIENT_SECRET: providerClientSecret,
  }, timeoutMs: 1_800_000, onOutput: () => {} });
  void auth.finished.then(result => { if (!stopping) { failure = new Error(`UniAuth exited (${result.exitCode}).`); wake(); } }, error => { if (!stopping) { failure = error; wake(); } });
  const receiver = createHTTPSServer({ cert: await readFile(path.join(artifacts, 'receiver-ca.pem')), key: await readFile(path.join(artifacts, 'receiver-key.pem')) }, (request, response) => {
    const chunks: Buffer[] = []; let size = 0;
    request.on('data', chunk => { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 1024 * 1024) request.destroy(); else chunks.push(bytes); });
    request.on('end', () => { delivered.push(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')); response.writeHead(204); response.end(); });
  });
  await listen(receiver, config.receiverPort, '127.0.0.1'); servers.push(receiver);
  const controlPath = path.join(root, 'control.sock'); await rm(controlPath, { force: true });
  const control = createServer(socket => {
    let input = '';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      input += chunk.toString(); if (input.length > 1024) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      void (async () => {
        switch (input.trim()) {
          case 'occupy': if (occupied) throw new Error('already occupied'); occupied = createServer(); await listen(occupied, serverInternal, '127.0.0.1'); return { ok: true };
          case 'release': if (!occupied) throw new Error('not occupied'); await close(occupied); occupied = undefined; return { ok: true };
          case 'count': return { count: delivered.length, hashes: delivered };
          case 'reset': delivered = []; return { ok: true };
          default: throw new Error('unknown control');
        }
      })().then(value => socket.end(`${JSON.stringify(value)}\n`), () => socket.end('{"error":"control failed"}\n'));
    });
  });
  await new Promise<void>((resolve, reject) => { control.once('error', reject); control.listen(controlPath, () => { control.off('error', reject); resolve(); }); }); servers.push(control);
  await writeFile(path.join(root, 'runtime-ready.json.tmp'), JSON.stringify({ authURL, baseURL, proxyURL, serverInternal, receiverPort: config.receiverPort }), { mode: 0o600 });
  await rename(path.join(root, 'runtime-ready.json.tmp'), path.join(root, 'runtime-ready.json'));
  const end = performance.now() + 120_000;
  let credentials: { appId: string; appSecret: string } | undefined;
  while (!stopping && performance.now() < end) {
    try { credentials = JSON.parse(await readFile(path.join(root, 'server.json'), 'utf8')) as typeof credentials; break; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    await pause(100);
  }
  if (!credentials?.appId || !credentials.appSecret) throw new Error('UniAuth App credentials were not registered.');
  await mkdir(path.join(root, 'daynight'), { mode: 0o700 });
  await writeServerConfig(path.join(root, 'daynight'), { listenAddress: `127.0.0.1:${serverInternal}`, publicOrigin: baseURL,
    previewOrigin: `https://preview.daynight.localhost:${config.serverPort}`, databaseURL: config.databaseURL,
    storageRoot: path.join(root, 'storage'), authURL, appId: credentials.appId, appSecret: credentials.appSecret, callbackURL: `${baseURL}/auth/callback` });
  await writeFile(path.join(root, 'server-configured'), 'ready', { mode: 0o600 });
  await stopped;
  await provider.close();
} catch (error) { if (!stopping) failure = error; }
finally {
  stopping = true;
  for (const socket of sockets) socket.destroy();
  if (occupied) await close(occupied).catch(() => {});
  for (const server of servers.reverse()) await close(server).catch(() => {});
  if (auth) try { await auth.stop(); } catch (error) { failure ??= error; }
}
if (failure) { console.error('Recovery authentication runtime failed.'); process.exitCode = 1; }
