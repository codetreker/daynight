import { appendFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer, connect, type Socket } from 'node:net';
import path from 'node:path';
import { runCommand, startCommand, type ManagedCommand } from './command.ts';
import { createLifecycle } from './lifecycle.ts';
import { providerClientId, providerClientSecret, startProvider } from './provider.ts';
import { writeServerConfig } from './server-config.ts';

type RuntimeConfiguration = { serverPort: number; authPort: number; proxyPort: number; databaseURL: string };
type ServerConfiguration = { appId: string; appSecret: string };
const runDirectory = '/run';
const artifacts = '/opt/e2e';
const signalController = new AbortController();
const lifecycle = createLifecycle();
let shutdown = false;
let failure: unknown;
let wake: () => void = () => {};
const ended = new Promise<void>((resolve) => { wake = resolve; });

const stop = (): void => {
  shutdown = true;
  signalController.abort(new Error('Runtime is stopping.'));
  wake();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

const wait = async (milliseconds: number): Promise<void> => {
  signalController.signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signalController.signal.reason); };
    const timer = setTimeout(() => { signalController.signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signalController.signal.addEventListener('abort', abort, { once: true });
  });
};

const forward = async (publicPort: number, targetPort: number): Promise<void> => {
  const sockets = new Set<Socket>();
  const listener = createServer((incoming) => {
    const target = connect({ host: '127.0.0.1', port: targetPort });
    for (const socket of [incoming, target]) {
      sockets.add(socket);
      socket.once('close', () => { sockets.delete(socket); });
      socket.once('error', () => { incoming.destroy(); target.destroy(); });
    }
    incoming.pipe(target).pipe(incoming);
    incoming.once('close', () => { target.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(publicPort, '0.0.0.0', () => { listener.off('error', reject); resolve(); });
  });
  lifecycle.defer(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => listener.close((error) => error === undefined ? resolve() : reject(error)));
  });
};

const reservePort = async (excluded: ReadonlySet<number>): Promise<number> => {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (address === null || typeof address === 'string') throw new Error('Internal listener did not receive a TCP port.');
  await new Promise<void>((resolve, reject) => listener.close((error) => error === undefined ? resolve() : reject(error)));
  if (excluded.has(address.port)) return reservePort(excluded);
  return address.port;
};

const launch = (name: string, binary: string, environment: NodeJS.ProcessEnv, args: string[] = []): ManagedCommand => {
  const command = startCommand(binary, args, {
    cwd: artifacts,
    env: environment,
    timeoutMs: 30 * 60_000,
    onOutput: (channel, chunk) => {
      appendFileSync(path.join(runDirectory, 'logs', `${name}.${channel}.log`), chunk);
      process[channel].write(`[${name}] ${chunk}`);
    },
  });
  lifecycle.defer(command.stop);
  void command.finished.then((result) => {
    if (shutdown) return;
    failure = new Error(`${name} exited before environment shutdown (exit=${result.exitCode}).`);
    signalController.abort(failure);
    wake();
  }, (error) => {
    if (shutdown) return;
    failure = error;
    signalController.abort(error);
    wake();
  });
  return command;
};

const awaitServerConfiguration = async (): Promise<ServerConfiguration> => {
  const filename = path.join(runDirectory, 'private', 'server.json');
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    signalController.signal.throwIfAborted();
    try {
      const configuration = JSON.parse(await readFile(filename, 'utf8')) as ServerConfiguration;
      if (typeof configuration.appId !== 'string' || configuration.appId === '' || typeof configuration.appSecret !== 'string' || configuration.appSecret === '') throw new Error('Server App credentials are missing.');
      return configuration;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await wait(100);
  }
  throw new Error('Timed out waiting for registered UniAuth App credentials.');
};

const removeDefaultRoutes = async (): Promise<void> => {
  for (const family of [[], ['-6']]) {
    const commandOptions = { cwd: artifacts, env: { PATH: process.env.PATH }, timeoutMs: 10_000 };
    while (true) {
      const routes = await runCommand('ip', [...family, 'route', 'show', 'default'], commandOptions);
      if (routes.stdout.trim() === '') break;
      await runCommand('ip', [...family, 'route', 'del', 'default'], commandOptions);
    }
  }
};

const main = async (): Promise<void> => {
  const configuration = JSON.parse(await readFile(path.join(runDirectory, 'private', 'runtime.json'), 'utf8')) as RuntimeConfiguration;
  for (const port of [configuration.serverPort, configuration.authPort, configuration.proxyPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Runtime public ports are invalid.');
  }
  if (typeof configuration.databaseURL !== 'string' || configuration.databaseURL === '') throw new Error('Runtime database connection is missing.');
  await removeDefaultRoutes();
  await mkdir(path.join(runDirectory, 'logs'), { recursive: true });
  await mkdir(path.join(runDirectory, 'private', 'storage'), { recursive: true, mode: 0o700 });
  const daynightRoot = path.join(runDirectory, 'private', 'daynight');
  await mkdir(daynightRoot, { recursive: true, mode: 0o700 });
  const provider = await startProvider({
    port: configuration.proxyPort,
    certificatePath: path.join(artifacts, 'provider-ca.pem'),
    keyPath: path.join(artifacts, 'provider-key.pem'),
  });
  lifecycle.defer(provider.close);
  const publicPorts = new Set([configuration.serverPort, configuration.authPort, configuration.proxyPort]);
  const authInternalPort = await reservePort(publicPorts);
  await forward(configuration.authPort, authInternalPort);
  const authURL = `http://127.0.0.1:${configuration.authPort}`;
  const baseURL = `http://127.0.0.1:${configuration.serverPort}`;
  const proxyURL = `http://127.0.0.1:${configuration.proxyPort}`;
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HTTPS_PROXY: proxyURL,
    HTTP_PROXY: proxyURL,
    NO_PROXY: '127.0.0.1,localhost,postgres',
    SSL_CERT_FILE: path.join(artifacts, 'provider-ca.pem'),
  };
  launch('uniauth', path.join(artifacts, 'uniauth'), {
    ...environment,
    UNIAUTH_PUBLIC_URL: authURL,
    UNIAUTH_LISTEN_ADDR: `127.0.0.1:${authInternalPort}`,
    UNIAUTH_ALLOW_LOOPBACK_HTTP: 'true',
    UNIAUTH_DATABASE_PATH: path.join(runDirectory, 'private', 'uniauth.db'),
    UNIAUTH_INITIAL_ADMIN_EMAIL: 'admin@example.test',
    UNIAUTH_GITHUB_CLIENT_ID: providerClientId,
    UNIAUTH_GITHUB_CLIENT_SECRET: providerClientSecret,
  });
  const credentials = await awaitServerConfiguration();
  const serverInternalPort = await reservePort(publicPorts);
  await forward(configuration.serverPort, serverInternalPort);
  await writeServerConfig(daynightRoot, {
    listenAddress: `127.0.0.1:${serverInternalPort}`, publicOrigin: baseURL,
    databaseURL: configuration.databaseURL, storageRoot: path.join(runDirectory, 'private', 'storage'),
    authURL, appId: credentials.appId, appSecret: credentials.appSecret, callbackURL: `${baseURL}/auth/callback`,
  });
  const imageTemporaryDirectory = path.join(runDirectory, 'private', 'image-validation');
  await mkdir(imageTemporaryDirectory, { recursive: true, mode: 0o700 });
  launch('daynight', path.join(artifacts, 'daynight-server'), {
    ...environment,
    DAYNIGHT_IMAGE_NODE_PATH: process.execPath,
    DAYNIGHT_IMAGE_HELPER_PATH: path.join(artifacts, 'image-validator', 'image-validation-helper.js'),
    DAYNIGHT_IMAGE_MANIFEST_PATH: path.join(artifacts, 'image-validator', 'image-validation-manifest.json'),
    DAYNIGHT_IMAGE_TEMP_DIRECTORY: imageTemporaryDirectory,
  }, ['--root', daynightRoot]);
  await ended;
  if (failure !== undefined) throw failure;
};

try { await main(); }
catch (error) { if (!shutdown) failure = error; }
finally {
  shutdown = true;
  try { await lifecycle.close(); }
  catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Runtime and cleanup failed.', { cause: failure }); }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
if (failure !== undefined) {
  console.error(failure);
  process.exitCode = 1;
}
