import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { runCommand, type CommandResult } from './command.ts';
import { cleanupOwnedResources, createDockerAccess, resourceIdentity, writeCleanupReceipt, type ResourceIdentity, type RecoveryMetadata } from './recovery.ts';
export { cleanupApplication, type CleanupReceipt, type ResourceIdentity } from './recovery.ts';

type EnvironmentOptions = {
  repository: string;
  runDirectory: string;
  artifactsDirectory: string;
  signal?: AbortSignal;
};
export type Environment = {
  baseURL: string;
  authURL: string;
  proxyURL: string;
  resourceIdentity: ResourceIdentity;
  startServer: (credentials: { appId: string; appSecret: string }) => Promise<void>;
  close: () => Promise<void>;
};

const postgresImage = 'postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650';
const pause = async (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
};

const reservePorts = async (): Promise<number[]> => {
  const listeners: Server[] = [];
  const ports: number[] = [];
  try {
    for (let index = 0; index < 3; index++) {
      const listener = createServer();
      listeners.push(listener);
      await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
      const address = listener.address();
      if (address === null || typeof address === 'string') throw new Error('Port reservation did not receive a TCP address.');
      ports.push(address.port);
    }
  } finally {
    for (const listener of listeners) {
      if (!listener.listening) continue;
      await new Promise<void>((resolve, reject) => listener.close((error) => error === undefined ? resolve() : reject(error)));
    }
  }
  return ports;
};

export const startEnvironment = async (options: EnvironmentOptions): Promise<Environment> => {
  if (process.platform !== 'linux') throw new Error('Product E2E environments require Linux.');
  const runId = randomUUID();
  const resources = resourceIdentity(runId);
  const [serverPort, authPort, proxyPort] = await reservePorts();
  if (serverPort === undefined || authPort === undefined || proxyPort === undefined) throw new Error('Three runtime ports are required.');
  const baseURL = `http://127.0.0.1:${serverPort}`;
  const authURL = `http://127.0.0.1:${authPort}`;
  const proxyURL = `http://127.0.0.1:${proxyPort}`;
  const docker = async (args: readonly string[], signal: AbortSignal | undefined, timeoutMs = 60_000): Promise<CommandResult> =>
    runCommand('docker', args, { cwd: options.repository, env: process.env, signal, timeoutMs });
  const access = createDockerAccess(options.repository, runId);
  const running = async (container: string): Promise<void> => {
    const object = await access.inspect('container', container);
    if (object === undefined) throw new Error(`Runtime container ${container} disappeared.`);
    const state = access.state(object);
    if (!state.running) throw new Error(`Runtime container ${container} exited before readiness (exit=${state.exitCode}).`);
  };
  const ready = async (origin: string): Promise<void> => {
    const deadline = performance.now() + 90_000;
    while (performance.now() < deadline) {
      options.signal?.throwIfAborted();
      await running(resources.applicationContainer);
      try {
        const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1_000) });
        if (response.status === 200) return;
      } catch (error) {
        if (!(error instanceof TypeError || error instanceof DOMException && error.name === 'TimeoutError')) throw error;
      }
      await pause(100, options.signal);
    }
    throw new Error(`Service did not become ready: ${origin}`);
  };
  const owner = await stat(options.runDirectory);
  const metadata: RecoveryMetadata = { schemaVersion: 1, runId, directoryId: path.basename(options.runDirectory), ownerUid: owner.uid, ownerGid: owner.gid };
  await writeCleanupReceipt(options.runDirectory, { ...metadata, resourceIdentity: resources, state: 'pending', verified: false, resourcesAbsent: false, remaining: [], verificationErrors: [], cleanupErrors: [] });
  let applicationStarted = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closing = (async () => {
      const cleanup = await cleanupOwnedResources({ ...options, resources, metadata, mode: 'normal', applicationStarted });
      const { failures, ...verification } = cleanup;
      try { await writeCleanupReceipt(options.runDirectory, { ...metadata, resourceIdentity: resources, state: verification.verified ? 'complete' : 'failed', ...verification }); }
      catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Environment cleanup or verification failed.', { cause: failures[0] });
    })();
    return closing;
  };
  try {
    await mkdir(path.join(options.runDirectory, 'private'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(options.runDirectory, 'logs'), { recursive: true });
    await docker(['network', 'create', '--internal', '--label', `daynight.e2e.run=${runId}`, resources.network], options.signal);
    await docker(['network', 'create', '--label', `daynight.e2e.run=${runId}`, resources.ingressNetwork], options.signal);
    await docker(['volume', 'create', '--label', `daynight.e2e.run=${runId}`, resources.postgresVolume], options.signal);
    await docker(['build', '--label', `daynight.e2e.run=${runId}`, '--file', path.join(options.repository, 'packages/e2e_tests/Dockerfile.runtime'), '--tag', resources.runtimeImage, options.artifactsDirectory], options.signal, 10 * 60_000);
    const password = randomBytes(24).toString('hex');
    const databaseURL = `postgres://daynight:${password}@postgres:5432/daynight?sslmode=disable`;
    await writeFile(path.join(options.runDirectory, 'private', 'runtime.json'), `${JSON.stringify({ serverPort, authPort, proxyPort, databaseURL })}\n`, { mode: 0o600 });
    const postgresEnvironment = path.join(options.runDirectory, 'private', 'postgres.env');
    await writeFile(postgresEnvironment, `POSTGRES_USER=daynight\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=daynight\n`, { mode: 0o600 });
    await docker(['run', '--detach', '--name', resources.postgresContainer, '--label', `daynight.e2e.run=${runId}`, '--network', resources.network, '--network-alias', 'postgres', '--env-file', postgresEnvironment, '--mount', `type=volume,src=${resources.postgresVolume},dst=/var/lib/postgresql`, postgresImage], options.signal);
    const deadline = performance.now() + 60_000;
    let postgresReady = false;
    while (performance.now() < deadline) {
      options.signal?.throwIfAborted();
      await running(resources.postgresContainer);
      const result = await access.result(['exec', resources.postgresContainer, 'pg_isready', '-h', '127.0.0.1', '-U', 'daynight', '-d', 'daynight']);
      if (result.exitCode === 0) { postgresReady = true; break; }
      await pause(100, options.signal);
    }
    if (!postgresReady) throw new Error('Isolated PostgreSQL did not become ready.');
    await docker(['create', '--pull', 'never', '--name', resources.applicationContainer, '--label', `daynight.e2e.run=${runId}`, '--network', resources.ingressNetwork, '--cap-add', 'NET_ADMIN',
      '--publish', `127.0.0.1:${serverPort}:${serverPort}`, '--publish', `127.0.0.1:${authPort}:${authPort}`, '--publish', `127.0.0.1:${proxyPort}:${proxyPort}`,
      '--mount', `type=bind,src=${path.resolve(options.runDirectory)},dst=/run`, resources.runtimeImage], options.signal);
    await docker(['network', 'connect', resources.network, resources.applicationContainer], options.signal);
    await docker(['start', resources.applicationContainer], options.signal);
    applicationStarted = true;
    await ready(authURL);
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Environment setup and cleanup failed.', { cause: error }); }
    throw error;
  }
  let started = false;
  return {
    baseURL,
    authURL,
    proxyURL,
    resourceIdentity: resources,
    startServer: async (credentials) => {
      if (started) throw new Error('Product Server was already started.');
      if (credentials.appId === '' || credentials.appSecret === '') throw new Error('Registered UniAuth App credentials are required.');
      started = true;
      const filename = path.join(options.runDirectory, 'private', 'server.json');
      await writeFile(`${filename}.tmp`, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
      await rename(`${filename}.tmp`, filename);
      await ready(baseURL);
    },
    close,
  };
};
