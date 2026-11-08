import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { runCommand, startCommand, type CommandResult } from './command.ts';
import { createLifecycle, runCleanupSteps } from './lifecycle.ts';

type EnvironmentOptions = {
  repository: string;
  runDirectory: string;
  artifactsDirectory: string;
  signal?: AbortSignal;
};
export type ResourceIdentity = {
  network: string;
  ingressNetwork: string;
  postgresContainer: string;
  applicationContainer: string;
  ownershipContainer: string;
  postgresVolume: string;
  runtimeImage: string;
};
export type CleanupReceipt = {
  resourceIdentity: ResourceIdentity;
  state: 'pending' | 'complete' | 'failed';
  verified: boolean;
  resourcesAbsent: boolean;
  remaining: string[];
  verificationErrors: string[];
  cleanupErrors: string[];
};
export type Environment = {
  baseURL: string;
  authURL: string;
  proxyURL: string;
  resourceIdentity: ResourceIdentity;
  startServer: (credentials: { appId: string; appSecret: string }) => Promise<void>;
  close: () => Promise<void>;
};

export const cleanupApplication = async (operations: {
  captureDiagnostics: () => Promise<void>;
  checkRunning: () => Promise<void>;
  stop: () => Promise<void>;
  checkStopped: () => Promise<void>;
  remove: () => Promise<void>;
}): Promise<void> => runCleanupSteps([
  operations.captureDiagnostics, operations.checkRunning, operations.stop,
  operations.checkStopped, operations.captureDiagnostics, operations.remove,
]);

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
  const name = `daynight-e2e-${runId}`;
  const resources: ResourceIdentity = {
    network: `${name}-network`,
    ingressNetwork: `${name}-ingress`,
    postgresContainer: `${name}-postgres`,
    applicationContainer: `${name}-application`,
    ownershipContainer: `${name}-ownership`,
    postgresVolume: `${name}-postgres-data`,
    runtimeImage: `daynight-e2e-runtime:${runId}`,
  };
  const [serverPort, authPort, proxyPort] = await reservePorts();
  if (serverPort === undefined || authPort === undefined || proxyPort === undefined) throw new Error('Three runtime ports are required.');
  const baseURL = `http://127.0.0.1:${serverPort}`;
  const authURL = `http://127.0.0.1:${authPort}`;
  const proxyURL = `http://127.0.0.1:${proxyPort}`;
  const docker = async (args: readonly string[], signal: AbortSignal | undefined, timeoutMs = 60_000): Promise<CommandResult> =>
    runCommand('docker', args, { cwd: options.repository, env: process.env, signal, timeoutMs });
  const dockerResult = async (args: readonly string[]): Promise<CommandResult> =>
    startCommand('docker', args, { cwd: options.repository, env: process.env, timeoutMs: 30_000, onOutput: () => {} }).finished;
  const exists = async (kind: 'container' | 'network' | 'volume' | 'image', resource: string): Promise<boolean> => {
    const result = await dockerResult([kind, 'inspect', resource]);
    if (result.exitCode === 0) return true;
    const missing = [
      `No such ${kind}: ${resource}`, `No such object: ${resource}`,
      ...(kind === 'network' ? [`network ${resource} not found`] : []),
      ...(kind === 'volume' ? [`get ${resource}: no such volume`] : []),
    ];
    if (result.exitCode === 1 && missing.some((message) => result.stderr.toLowerCase().includes(message.toLowerCase()))) return false;
    throw new Error(`Could not inspect ${kind} ${resource}: ${result.stderr}`);
  };
  const remove = async (kind: 'container' | 'network' | 'volume' | 'image', resource: string): Promise<void> => {
    if (await exists(kind, resource)) {
      const args = kind === 'container' ? ['container', 'rm', '--force', resource]
        : kind === 'image' ? ['image', 'rm', '--force', resource] : [kind, 'rm', resource];
      await docker(args, undefined);
    }
    if (await exists(kind, resource)) throw new Error(`Cleanup left ${kind} ${resource} present.`);
  };
  const running = async (container: string): Promise<void> => {
    const result = await dockerResult(['container', 'inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', container]);
    if (result.exitCode !== 0) throw new Error(`Runtime container ${container} disappeared: ${result.stderr}`);
    if (!result.stdout.startsWith('true ')) throw new Error(`Runtime container ${container} exited before readiness: ${result.stdout.trim()}`);
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
  const lifecycle = createLifecycle();
  const resultsDirectory = path.join(options.runDirectory, 'results');
  await mkdir(resultsDirectory, { recursive: true });
  const receiptPath = path.join(resultsDirectory, 'environment-cleanup.json');
  const writeReceipt = async (receipt: CleanupReceipt): Promise<void> => {
    await writeFile(`${receiptPath}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`);
    await rename(`${receiptPath}.tmp`, receiptPath);
  };
  await writeReceipt({ resourceIdentity: resources, state: 'pending', verified: false, resourcesAbsent: false, remaining: [], verificationErrors: [], cleanupErrors: [] });
  const resourceEntries: readonly ['container' | 'network' | 'volume' | 'image', string][] = [
    ['container', resources.applicationContainer], ['container', resources.ownershipContainer], ['container', resources.postgresContainer],
    ['volume', resources.postgresVolume], ['network', resources.network], ['network', resources.ingressNetwork], ['image', resources.runtimeImage],
  ];
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closing = (async () => {
      const failures: unknown[] = [];
      const cleanupErrors: string[] = [];
      const verificationErrors: string[] = [];
      const remaining: string[] = [];
      try { await lifecycle.close(); }
      catch (error) { failures.push(error); cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
      for (const [kind, resource] of resourceEntries) {
        try { if (await exists(kind, resource)) remaining.push(resource); }
        catch (error) { failures.push(error); verificationErrors.push(`${kind} ${resource}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (remaining.length > 0) failures.push(new Error(`Environment cleanup left resources present: ${remaining.join(', ')}`));
      const resourcesAbsent = remaining.length === 0 && verificationErrors.length === 0;
      const verified = resourcesAbsent && cleanupErrors.length === 0;
      try { await writeReceipt({ resourceIdentity: resources, state: verified ? 'complete' : 'failed', verified, resourcesAbsent, remaining, verificationErrors, cleanupErrors }); }
      catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Environment cleanup or verification failed.', { cause: failures[0] });
    })();
    return closing;
  };
  try {
    await mkdir(path.join(options.runDirectory, 'private'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(options.runDirectory, 'logs'), { recursive: true });
    lifecycle.defer(async () => remove('network', resources.network));
    await docker(['network', 'create', '--internal', '--label', `daynight.e2e.run=${runId}`, resources.network], options.signal);
    lifecycle.defer(async () => remove('network', resources.ingressNetwork));
    await docker(['network', 'create', '--label', `daynight.e2e.run=${runId}`, resources.ingressNetwork], options.signal);
    lifecycle.defer(async () => remove('volume', resources.postgresVolume));
    await docker(['volume', 'create', '--label', `daynight.e2e.run=${runId}`, resources.postgresVolume], options.signal);
    lifecycle.defer(async () => remove('image', resources.runtimeImage));
    await docker(['build', '--file', path.join(options.repository, 'packages/e2e_tests/Dockerfile.runtime'), '--tag', resources.runtimeImage, options.artifactsDirectory], options.signal, 10 * 60_000);
    const password = randomBytes(24).toString('hex');
    const databaseURL = `postgres://daynight:${password}@postgres:5432/daynight?sslmode=disable`;
    const owner = await stat(options.runDirectory);
    await writeFile(path.join(options.runDirectory, 'private', 'runtime.json'), `${JSON.stringify({ serverPort, authPort, proxyPort, databaseURL })}\n`, { mode: 0o600 });
    const postgresEnvironment = path.join(options.runDirectory, 'private', 'postgres.env');
    await writeFile(postgresEnvironment, `POSTGRES_USER=daynight\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=daynight\n`, { mode: 0o600 });
    lifecycle.defer(async () => remove('container', resources.postgresContainer));
    await docker(['run', '--detach', '--name', resources.postgresContainer, '--label', `daynight.e2e.run=${runId}`, '--network', resources.network, '--network-alias', 'postgres', '--env-file', postgresEnvironment, '--mount', `type=volume,src=${resources.postgresVolume},dst=/var/lib/postgresql`, postgresImage], options.signal);
    const deadline = performance.now() + 60_000;
    let postgresReady = false;
    while (performance.now() < deadline) {
      options.signal?.throwIfAborted();
      await running(resources.postgresContainer);
      const result = await dockerResult(['exec', resources.postgresContainer, 'pg_isready', '-h', '127.0.0.1', '-U', 'daynight', '-d', 'daynight']);
      if (result.exitCode === 0) { postgresReady = true; break; }
      await pause(100, options.signal);
    }
    if (!postgresReady) throw new Error('Isolated PostgreSQL did not become ready.');
    const applicationExists = async (): Promise<boolean> => exists('container', resources.applicationContainer);
    const applicationState = async (): Promise<{ running: boolean; exitCode: number }> => {
      const result = await dockerResult(['container', 'inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', resources.applicationContainer]);
      const match = /^(true|false) ([0-9]+)$/.exec(result.stdout.trim());
      if (result.exitCode !== 0 || match === null) throw new Error(`Could not inspect application terminal state: ${result.stderr || result.stdout}`);
      return { running: match[1] === 'true', exitCode: Number(match[2]) };
    };
    const captureDiagnostics = async (): Promise<void> => {
      if (!await applicationExists()) return;
      const logs = await dockerResult(['logs', resources.applicationContainer]);
      await writeFile(path.join(options.runDirectory, 'logs', 'runtime.stdout.log'), logs.stdout);
      await writeFile(path.join(options.runDirectory, 'logs', 'runtime.stderr.log'), logs.stderr);
      if (logs.exitCode !== 0) throw new Error(`Could not collect application diagnostics: ${logs.stderr}`);
    };
    lifecycle.defer(async () => runCleanupSteps([
      async () => {
        await docker(['create', '--name', resources.ownershipContainer, '--label', `daynight.e2e.run=${runId}`, '--network', 'none',
          '--mount', `type=bind,src=${path.resolve(options.runDirectory)},dst=/run`, '--entrypoint', 'chown', resources.runtimeImage,
          '--recursive', '--no-dereference', '--', `${owner.uid}:${owner.gid}`, '/run/private', '/run/logs'], undefined, 30_000);
        await docker(['start', '--attach', resources.ownershipContainer], undefined, 30_000);
        const result = await dockerResult(['container', 'inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', resources.ownershipContainer]);
        if (result.exitCode !== 0 || result.stdout.trim() !== 'false 0') throw new Error(`Private data ownership repair failed: ${result.stderr || result.stdout}`);
      },
      async () => remove('container', resources.ownershipContainer),
    ]));
    let applicationStarted = false;
    lifecycle.defer(async () => cleanupApplication({
      captureDiagnostics,
      checkRunning: async () => {
        if (!applicationStarted || !await applicationExists()) return;
        const state = await applicationState();
        if (!state.running) throw new Error(`Application exited before requested shutdown (exit=${state.exitCode}).`);
      },
      stop: async () => {
        if (!await applicationExists()) return;
        if (!(await applicationState()).running) return;
        const stopped = await dockerResult(['stop', '--time', '10', resources.applicationContainer]);
        if (stopped.exitCode !== 0) throw new Error(`Application container did not stop cleanly: ${stopped.stderr}`);
      },
      checkStopped: async () => {
        if (!await applicationExists()) return;
        const state = await applicationState();
        if (state.running || state.exitCode !== 0) throw new Error(`Application shutdown failed (running=${state.running}, exit=${state.exitCode}).`);
      },
      remove: async () => remove('container', resources.applicationContainer),
    }));
    await docker(['create', '--name', resources.applicationContainer, '--label', `daynight.e2e.run=${runId}`, '--network', resources.ingressNetwork, '--cap-add', 'NET_ADMIN',
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
