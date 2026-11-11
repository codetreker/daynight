import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reserveLoopbackPort, startAuthFixture, type AuthFixture } from '../../../daynight-server/scripts/auth-fixture.mts';

const repository = fileURLToPath(new URL('../../../..', import.meta.url));
const serverRoot = path.join(repository, 'packages/daynight-server');
const runId = randomUUID();
const directory = path.join(repository, '.tmp', `task-search-runtime-${runId}`);
const container = `daynight-search-${runId}`;
const output = path.join(repository, '.tmp', 'task-search-acceptance', runId);
const resultFile = path.join(output, 'result.json');
const cancellation = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => cancellation.abort(new Error(`Interrupted by ${signal}`)));
const command = (program: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; quiet?: boolean; signal?: AbortSignal } = {}) => new Promise<void>((resolve, reject) => {
  const child = spawn(program, args, { cwd: options.cwd ?? repository, env: options.env ?? process.env, stdio: options.quiet ? 'ignore' : 'inherit', timeout: options.timeout ?? 300_000, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  child.once('error', reject);
  child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${program} exited with ${code ?? signal}`)));
});
const delay = () => new Promise(resolve => setTimeout(resolve, 200));
let fixture: AuthFixture | undefined;
let server: ChildProcess | undefined;
let serverClosed: Promise<void> | undefined;
let databaseStarted = false;
let originalFailure: unknown;
let browserResult: Record<string, unknown> = {};
await mkdir(output, { recursive: true });
await writeFile(resultFile, JSON.stringify({ runId, result: 'running', sourceHash: process.env.DAYNIGHT_SEARCH_SOURCE_HASH }) + '\n');
console.log(`Acceptance run ${runId}: ${resultFile}`);
try {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await command('pnpm', ['web:build'], { signal: cancellation.signal });
  const binary = path.join(directory, 'daynight-server');
  await command('go', ['build', '-trimpath', '-o', binary, './cmd/daynight-server'], { cwd: serverRoot, signal: cancellation.signal });
  const binaryHash = createHash('sha256').update(await readFile(binary)).digest('hex');
  const fixtureBinary = path.join(serverRoot, '.tmp/uniauth-fixture');
  await command('node', ['scripts/prepare-uniauth-fixture.mts'], { cwd: serverRoot, timeout: 600_000, signal: cancellation.signal });
  const databasePort = await reserveLoopbackPort();
  databaseStarted = true;
  await command('docker', ['run', '--detach', '--rm', '--name', container, '--network', 'host', '-e', 'POSTGRES_USER=daynight', '-e', 'POSTGRES_PASSWORD=daynight-search-local', '-e', 'POSTGRES_DB=daynight', 'postgres:18.6-bookworm', 'postgres', '-c', `port=${databasePort}`, '-c', 'listen_addresses=127.0.0.1'], { signal: cancellation.signal, timeout: 60_000 });
  let databaseReady = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    cancellation.signal.throwIfAborted();
    try { await command('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-p', String(databasePort), '-U', 'daynight', '-d', 'daynight'], { quiet: true, timeout: 5_000 }); databaseReady = true; break; } catch { await delay(); }
  }
  if (!databaseReady) throw new Error('Isolated PostgreSQL did not become ready.');
  const port = await reserveLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  fixture = await startAuthFixture({ binary: fixtureBinary, directory: path.join(directory, 'auth'), callbackURL: `${origin}/auth/callback`, signal: cancellation.signal });
  const configDirectory = path.join(directory, 'config');
  await mkdir(configDirectory, { mode: 0o700 });
  // JSON is a YAML 1.2 flow document; serialize the whole mapping to preserve types and credentials.
  const configuration = {
    server: { listen_address: `127.0.0.1:${port}`, public_origin: origin, allow_http_test_origin: true },
    database: { url: `postgres://daynight:daynight-search-local@127.0.0.1:${databasePort}/daynight?sslmode=disable` },
    storage: { root: 'storage' },
    uniauth: { url: fixture.origin, app_id: fixture.appId, app_secret: fixture.appSecret, callback_url: `${origin}/auth/callback`, allow_loopback_http: true },
  };
  await writeFile(path.join(configDirectory, 'config.yml'), `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  const serverEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DAYNIGHT_')));
  server = spawn(binary, ['--root', directory], { cwd: serverRoot, stdio: ['ignore', 'inherit', 'inherit'], env: serverEnvironment });
  let serverExit: string | null = null;
  serverClosed = new Promise(resolve => { server!.once('error', error => { serverExit = String(error); }); server!.once('close', (code, signal) => { serverExit ??= String(code ?? signal); resolve(); }); });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    cancellation.signal.throwIfAborted();
    if (serverExit !== null) throw new Error(`Server exited before readiness: ${serverExit}`);
    try { if ((await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch { /* Wait for the loopback listener. */ }
    await delay();
  }
  if (!ready) throw new Error('Server did not become ready.');
  await command('node', ['packages/daynight-web/scripts/acceptance/task-search.mts'], { env: { ...process.env, DAYNIGHT_BASE_URL: origin, DAYNIGHT_SEARCH_BINARY_SHA: binaryHash, DAYNIGHT_SEARCH_RUN_ID: runId, DAYNIGHT_SEARCH_DB_CONTAINER: container, DAYNIGHT_SEARCH_DB_PORT: String(databasePort) }, timeout: 300_000, signal: cancellation.signal });
  browserResult = JSON.parse(await readFile(path.join(output, 'browser.json'), 'utf8')) as Record<string, unknown>;
  if (browserResult.result !== 'passed' || browserResult.runId !== runId) throw new Error('Browser acceptance receipt is invalid.');
} catch (error) { originalFailure = error; throw error; } finally {
  const failures: unknown[] = [];
  if (server !== undefined && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    const exited = await Promise.race([serverClosed!.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10_000))]);
    if (!exited) { server.kill('SIGKILL'); await serverClosed; failures.push(new Error('Server exceeded its shutdown deadline.')); }
  }
  if (fixture !== undefined) try { await fixture.close(); } catch (error) { failures.push(error); }
  if (databaseStarted) {
    try {
      const existing = execFileSync('docker', ['ps', '-a', '--filter', `name=^/${container}$`, '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 10_000 }).trim();
      if (existing === container) await command('docker', ['rm', '-f', container], { timeout: 30_000 });
      else if (existing !== '') throw new Error('Unexpected database container identity during cleanup.');
    } catch (error) { failures.push(error); }
  }
  try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (Object.keys(browserResult).length === 0) {
    try { browserResult = JSON.parse(await readFile(path.join(output, 'browser.json'), 'utf8')) as Record<string, unknown>; } catch { /* Earlier failures have no browser receipt. */ }
  }
  const result = originalFailure === undefined && failures.length === 0 ? 'passed' : 'failed';
  await writeFile(resultFile, JSON.stringify({ ...browserResult, runId, sourceHash: process.env.DAYNIGHT_SEARCH_SOURCE_HASH, result,
    ...(originalFailure === undefined ? {} : { error: String(originalFailure) }), cleanupErrors: failures.map(String) }, null, 2) + '\n');
  if (failures.length > 0) throw new AggregateError(originalFailure === undefined ? failures : [originalFailure, ...failures], 'Acceptance execution or cleanup failed.');
}
