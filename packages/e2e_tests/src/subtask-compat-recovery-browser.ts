import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect, type BrowserContext, type Response } from '@playwright/test';
import { beginBrowserScope, bindBrowserScope, finishBrowserScope } from './fixture-owner.ts';
import { deviceInstructionReader } from './subtask-compat-recovery-device.ts';
import { probeHigherTaskCache, recoveryFailureDetail, verifyRecoveryReadback, type CacheProbe } from './subtask-compat-recovery-readback.ts';
import { recoverySnapshot, type RecoverySnapshot } from './subtask-compat-recovery-snapshot.ts';

type Input = { repository: string; browserOwnerDirectory: string; authURL: string; baseURL: string; proxyURL: string; receiverPort: number; directory: string; cliEntry: string; resolver: string; certificate: string };
const input = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as Input;
const privateDirectory = path.join(input.directory, 'private');
const cliDirectory = path.join(privateDirectory, 'cli');
const cliEnvironment = { ...process.env, DN_CONFIG_DIR: cliDirectory, NODE_EXTRA_CA_CERTS: input.certificate,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(input.resolver)}` };
let eventSequence = 0, commandSequence = 0;
const writeAtomic = async (filename: string, value: string): Promise<void> => {
  const temporary = `${filename}.tmp`; await writeFile(temporary, value, { mode: 0o600 }); await rename(temporary, filename);
};
const send = async (message: Record<string, unknown>): Promise<void> => await writeAtomic(path.join(privateDirectory, `browser-event-${eventSequence++}.json`), JSON.stringify(message));
const next = async (): Promise<string> => {
  const filename = path.join(privateDirectory, `browser-command-${commandSequence++}.txt`), deadline = performance.now() + 180_000;
  while (performance.now() < deadline) {
    try { return await readFile(filename, 'utf8'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Recovery browser command timed out.');
};
let running: ChildProcess | undefined;
const cli = async (args: string[], onOutput?: (channel: 'stdout' | 'stderr', chunk: string) => void): Promise<string> => {
  const child = spawn(process.execPath, [input.cliEntry, ...args], { cwd: cliDirectory, env: cliEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
  running = child; let output = '', stderr = '';
  child.stdout!.on('data', chunk => { const text = chunk.toString(); output = (output + text).slice(-262144); onOutput?.('stdout', text); });
  child.stderr!.on('data', chunk => { const text = chunk.toString(); stderr = (stderr + text).slice(-262144); onOutput?.('stderr', text); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (code !== 0) throw new Error(`CLI ${args[0]} ${args[1] ?? ''} failed (exit=${code}).`);
    return output;
  } finally { clearTimeout(timer); running = undefined; }
};
let browser: Awaited<ReturnType<typeof chromium.connect>> | undefined;
let server: Awaited<ReturnType<typeof chromium.launchServer>> | undefined;
let restoredContext: BrowserContext | undefined;
let phase = 'launch';
let navigationStatus: number | undefined;
let taskResponseStatus: number | undefined;
let cacheProbe: CacheProbe | null = null;
let navigationRoute: () => 'expected' | 'login' | 'other' | 'unknown' = () => 'unknown';
const setPhase = async (value: string): Promise<void> => { phase = value; await writeAtomic(path.join(privateDirectory, 'browser-phase.json'), JSON.stringify({ phase })); };
let scope: string | undefined, bound = false;
try {
  await mkdir(cliDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(cliDirectory, 'config.yml'), `serverUrl: ${input.baseURL}\n`, { mode: 0o600 });
  scope = await beginBrowserScope(input.repository, input.browserOwnerDirectory);
  server = await chromium.launchServer({ proxy: { server: input.proxyURL, bypass: '127.0.0.1,localhost,*.localhost' } });
  const browserPID = server.process().pid; if (browserPID === undefined) throw new Error('Browser process identity is missing.');
  await bindBrowserScope(input.repository, input.browserOwnerDirectory, scope, browserPID); bound = true;
  browser = await chromium.connect(server.wsEndpoint());
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' });
  let page = await context.newPage(); page.setDefaultTimeout(30_000);
  await setPhase('register-uniauth');
  await page.goto(`${input.authURL}/console/`);
  await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).click();
  await page.getByRole('button', { name: 'Authorize local identity', exact: true }).click();
  await expect(page).toHaveURL(`${input.authURL}/console/`);
  const session = await context.request.get(`${input.authURL}/console/api/session`);
  if (session.status() !== 200) throw new Error(`UniAuth Console session failed (${session.status()}).`);
  const user = await session.json() as { csrf_token?: unknown };
  if (typeof user.csrf_token !== 'string') throw new Error('UniAuth Console CSRF is missing.');
  const registered = await context.request.post(`${input.authURL}/console/api/apps`, { headers: { Origin: input.authURL, 'X-CSRF-Token': user.csrf_token }, data: {
    name: 'Recovery fixture', enabled: true, redirect_uris: [`${input.baseURL}/auth/callback`], providers: ['github'], initial_secret: { name: 'Recovery backend' },
  } });
  if (registered.status() !== 201) throw new Error(`UniAuth App registration failed (${registered.status()}).`);
  const app = await registered.json() as { app?: { id?: unknown }; secret?: unknown };
  if (typeof app.app?.id !== 'string' || typeof app.secret !== 'string') throw new Error('UniAuth App registration omitted credentials.');
  await writeAtomic(path.join(privateDirectory, 'server.json'), JSON.stringify({ appId: app.app.id, appSecret: app.secret }));
  await send({ type: 'auth-ready' });
  if (await next() !== 'baseline-ready') throw new Error('Baseline start was not confirmed.');
  await setPhase('web-login');
  await page.goto(`${input.baseURL}/login`);
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
  await page.getByRole('button', { name: 'Authorize local identity', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
  const meResponse = await context.request.get(`${input.baseURL}/api/v1/me`);
  if (meResponse.status() !== 200) throw new Error('Browser identity could not be read.');
  const me = await meResponse.json() as { id?: unknown };
  if (typeof me.id !== 'string') throw new Error('Browser identity is invalid.');
  await setPhase('device-login');
  let publish: (value: { uri: string; code: string }) => void = () => {};
  const device = new Promise<{ uri: string; code: string }>(resolve => { publish = resolve; });
  const login = cli(['login', '--no-browser'], deviceInstructionReader(publish));
  const authorization = await Promise.race([device, login.then(() => { throw new Error('CLI exited before device authorization.'); })]);
  await page.goto(`${authorization.uri}?user_code=${encodeURIComponent(authorization.code)}`);
  await page.getByRole('checkbox', { name: 'This code matches the one in my terminal', exact: true }).check();
  await page.getByRole('button', { name: 'Authorize CLI', exact: true }).click(); await login;
  const module = await import(pathToFileURL(path.join(path.dirname(input.cliEntry), 'config/server.js')).href) as { loadServerConfiguration(paths: { stateDirectory: string; configFile: string }): Promise<{ serverToken?: string }> };
  const token = (await module.loadServerConfiguration({ stateDirectory: cliDirectory, configFile: path.join(cliDirectory, 'config.yml') })).serverToken;
  if (!token) throw new Error('CLI device login did not save its token.');
  await setPhase('create-project');
  const projectOutput = await cli(['project', 'create', `Recovery ${randomUUID()}`, '--repo', `https://example.test/recovery/${randomUUID()}.git`, '--team', 'personal', '--confirm']);
  const project = projectOutput.match(/^ID: ([0-9a-f-]{36})$/m)?.[1]; if (!project) throw new Error('Project ID missing.');
  const request = async (url: string, data: unknown): Promise<Record<string, unknown>> => {
    const result = await context.request.post(`${input.baseURL}${url}`, { headers: { Authorization: `Bearer ${token}` }, data });
    if (result.status() !== 201) throw new Error(`Fixture API creation failed (${result.status()}).`);
    return await result.json() as Record<string, unknown>;
  };
  const create = async (args: string[]): Promise<string> => {
    const result = await cli(['task', 'create', '--project', project, ...args]);
    const id = result.match(/^ID: ([0-9a-f-]{36})$/m)?.[1]; if (!id) throw new Error('Task ID missing.'); return id;
  };
  await setPhase('create-goal');
  const goal = await create(['--type', 'goal', '--title', 'Recovery goal']);
  const child = await create(['--parent', goal, '--title', 'Recovery child', '--status', 'todo']);
  const hiddenGoal = await create(['--type', 'goal', '--title', 'Deleted recovery goal']);
  const hiddenChild = await create(['--parent', hiddenGoal, '--title', 'Hidden recovery child', '--status', 'todo']);
  await cli(['task', 'delete', hiddenGoal, '--project', project, '--force']);
  await setPhase('create-webhook');
  const endpointResult = await request('/api/v1/me/webhooks', { operationId: randomUUID(), issuedAt: new Date().toISOString(), expectedUserId: me.id,
    name: 'Recovery receiver', enabled: true, destination: { kind: 'http', adapterVersion: '1', configuration: { url: `https://receiver.example:${input.receiverPort}/webhook` } },
    subscriptions: [{ id: null, projectId: project, eventTypes: ['task.created'] }] });
  const endpoint = (endpointResult.endpoint as { id?: unknown } | undefined)?.id;
  if (typeof endpoint !== 'string') throw new Error('Webhook endpoint ID missing.');
  await setPhase('baseline-attachment');
  const payload = path.join(privateDirectory, 'recovery-proof.txt'); await writeFile(payload, 'paired122', { mode: 0o600 });
  await cli(['task', 'attachment', 'put', child, payload, '--path', 'recovery-proof.txt', '--project', project]);
  if ((await cli(['task', 'attachment', 'read', child, 'recovery-proof.txt', '--project', project])) !== 'paired122') throw new Error('Baseline attachment readback mismatch.');
  const shown = JSON.parse(await cli(['task', 'show', child, '--project', project, '--json'])) as { id?: string; parentId?: string };
  if (shown.id !== child || shown.parentId !== goal) throw new Error('Baseline child readback mismatch.');
  await writeFile(path.join(privateDirectory, 'fixture.json'), JSON.stringify({ user: me.id, project, goal, child, hiddenGoal, hiddenChild, endpoint, token }), { mode: 0o600 });
  await page.goto('about:blank');
  await send({ type: 'fixture-ready', project, goal, child, hiddenGoal, hiddenChild });
  let baselineSnapshot: RecoverySnapshot | undefined, pendingTask: string | undefined;
  while (true) {
    const operation = await next();
    if (operation === 'finish') break;
    if (operation === 'pending') {
      await setPhase('pending-event');
      const task = await create(['--title', 'Recovery pending event', '--status', 'todo']);
      const response = await context.request.get(`${input.baseURL}/api/v1/projects/${project}/task-sync`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.status() !== 200) throw new Error('Baseline task sync failed.');
      baselineSnapshot = recoverySnapshot(await response.json(), project, goal, child, task); pendingTask = task;
      await send({ type: 'pending', task, snapshot: baselineSnapshot }); continue;
    }
    if (operation === 'repair-write') {
      await setPhase('repair-read-write');
      await writeFile(payload, 'repair124', { mode: 0o600 });
      await cli(['task', 'attachment', 'put', child, payload, '--path', 'recovery-proof.txt', '--project', project]);
      if ((await cli(['task', 'attachment', 'read', child, 'recovery-proof.txt', '--project', project])) !== 'repair124') throw new Error('Repair attachment readback mismatch.');
      await writeFile(payload, 'paired122', { mode: 0o600 });
      await cli(['task', 'attachment', 'put', child, payload, '--path', 'recovery-proof.txt', '--project', project]);
      if ((await cli(['task', 'attachment', 'read', child, 'recovery-proof.txt', '--project', project])) !== 'paired122') throw new Error('Repair attachment reset mismatch.');
      await send({ type: 'repair-written' }); continue;
    }
    if (operation === 'write') {
      await setPhase('post-upgrade-write');
      const task = await create(['--title', 'Post-upgrade write', '--status', 'todo']);
      await writeFile(payload, 'post124', { mode: 0o600 });
      await cli(['task', 'attachment', 'put', child, payload, '--path', 'recovery-proof.txt', '--project', project]);
      if ((await cli(['task', 'attachment', 'read', child, 'recovery-proof.txt', '--project', project])) !== 'post124') throw new Error('Post-upgrade attachment readback mismatch.');
      await send({ type: 'written', task }); continue;
    }
    if (operation !== 'verify' && operation !== 'verify-restored') throw new Error('Unknown browser operation.');
    if (operation === 'verify-restored') {
      if (!baselineSnapshot || !pendingTask) throw new Error('Baseline sync evidence is unavailable.');
      await setPhase('restore-original-profile');
      const originalResponse = await page.goto(`${input.baseURL}/projects/${project}/tasks/${child}`);
      if (originalResponse?.status() !== 200 || new URL(page.url()).pathname !== `/projects/${project}/tasks/${child}`) throw new Error('Original profile navigation failed.');
      let unavailable = false;
      try { await expect(page.getByRole('heading', { name: 'Recovery child', exact: true })).toBeVisible({ timeout: 3_000 }); }
      catch { if (page.isClosed()) throw new Error('Original profile closed unexpectedly.'); unavailable = true; }
      if (unavailable) {
        const originalCache = await page.evaluate(probeHigherTaskCache);
        if (!originalCache || originalCache.version <= 13 || originalCache.result !== 'version-error') throw new Error('Original profile downgrade observation did not match.');
        await send({ type: 'original-profile', status: 'unavailable', cacheVersion: originalCache.version, schema13Open: originalCache.result, headingUnavailableAfterMs: 3000 });
      } else {
        await verifyRecoveryReadback({
          phase: setPhase, child, goal,
          navigate: async () => { await page.goto(`${input.baseURL}/projects/${project}/tasks/${child}`); },
          heading: async () => { await expect(page.getByRole('heading', { name: 'Recovery child', exact: true })).toBeVisible(); },
          readTask: async () => JSON.parse(await cli(['task', 'show', child, '--project', project, '--json'])) as { id?: string; parentId?: string },
          readAttachment: async () => await cli(['task', 'attachment', 'read', child, 'recovery-proof.txt', '--project', project]),
          leave: async () => { await page.goto('about:blank'); },
        });
        await send({ type: 'original-profile', status: 'available', readback: true });
      }
      await setPhase('restore-isolated-login');
      restoredContext = await browser!.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' });
      page = await restoredContext.newPage(); page.setDefaultTimeout(30_000);
      await page.goto(`${input.baseURL}/login`);
      await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
      await page.getByRole('button', { name: 'Authorize local identity', exact: true }).click();
      await expect(page.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
      const identity = await restoredContext.request.get(`${input.baseURL}/api/v1/me`);
      if (identity.status() !== 200 || (await identity.json() as { id?: unknown }).id !== me.id) throw new Error('Restored browser identity differs from baseline.');
      await setPhase('restore-original-epoch-sync');
      const query = new URLSearchParams({ epoch: baselineSnapshot.epoch, since: baselineSnapshot.observedAt });
      const response = await restoredContext.request.get(`${input.baseURL}/api/v1/projects/${project}/task-sync?${query}`);
      if (response.status() !== 200) throw new Error('Restored task sync failed.');
      const restored = recoverySnapshot(await response.json(), project, goal, child, pendingTask);
      if (restored.epoch === baselineSnapshot.epoch || JSON.stringify(restored.tasks) !== JSON.stringify(baselineSnapshot.tasks)) throw new Error('Restored task sync did not replace the original epoch and snapshot.');
      await send({ type: 'restore-snapshot', oldEpoch: baselineSnapshot.epoch, oldObservedAt: baselineSnapshot.observedAt, newEpoch: restored.epoch, tasks: restored.tasks, mode: 'snapshot', profile: 'isolated', sameUser: true });
    }
    navigationStatus = undefined; taskResponseStatus = undefined; cacheProbe = null;
    navigationRoute = () => {
      try {
        const url = new URL(page.url());
        if (url.origin !== new URL(input.baseURL).origin) return 'other';
        if (url.pathname === `/projects/${project}/tasks/${child}`) return 'expected';
        if (url.pathname === '/login') return 'login';
        return 'other';
      } catch { return 'unknown'; }
    };
    const observeTaskResponse = (response: Response): void => {
      try {
        const url = new URL(response.url());
        if (url.origin === new URL(input.baseURL).origin && url.pathname === `/api/v1/projects/${project}/tasks/${child}` && response.request().method() === 'GET') taskResponseStatus = response.status();
      } catch { /* Invalid addresses are not included in diagnostics. */ }
    };
    page.on('response', observeTaskResponse);
    try {
      await verifyRecoveryReadback({
        phase: setPhase, child, goal,
        navigate: async () => { const response = await page.goto(`${input.baseURL}/projects/${project}/tasks/${child}`); navigationStatus = response?.status(); },
        heading: async () => { await expect(page.getByRole('heading', { name: 'Recovery child', exact: true })).toBeVisible(); },
        readTask: async () => JSON.parse(await cli(['task', 'show', child, '--project', project, '--json'])) as { id?: string; parentId?: string },
        readAttachment: async () => await cli(['task', 'attachment', 'read', child, 'recovery-proof.txt', '--project', project]),
        leave: async () => { await page.goto('about:blank'); },
      });
    } catch (error) {
      if (phase === 'verify-web-heading' && navigationRoute() === 'expected') {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          cacheProbe = await Promise.race([page.evaluate(probeHigherTaskCache), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 3_000); })]);
        } catch { /* An unavailable probe cannot change the original failure. */ }
        finally { if (timer !== undefined) clearTimeout(timer); }
      }
      throw error;
    } finally { page.off('response', observeTaskResponse); }
    await send({ type: operation === 'verify-restored' ? 'verified-restored' : 'verified', project, goal, child });
  }
  if (restoredContext) await restoredContext.close();
  await context.close();
} catch (error) {
  const category = error instanceof Error && ['Error', 'TimeoutError', 'AssertionError'].includes(error.name) ? error.name : 'unknown';
  const detail = recoveryFailureDetail(error, phase, { status: navigationStatus, taskStatus: taskResponseStatus, route: navigationRoute(), cache: cacheProbe });
  await send({ type: 'failed', phase, category, ...(detail ? { detail } : {}) }); process.exitCode = 1;
}
finally {
  if (running) running.kill('SIGKILL');
  if (browser) await browser.close();
  if (server) { try { await server.close(); } finally { if (scope && bound) await finishBrowserScope(input.repository, input.browserOwnerDirectory, scope); } }
}
