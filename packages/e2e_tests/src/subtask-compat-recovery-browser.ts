import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { beginBrowserScope, bindBrowserScope, finishBrowserScope } from './fixture-owner.ts';
import { deviceInstructionReader } from './subtask-compat-recovery-device.ts';

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
let phase = 'launch';
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
  const page = await context.newPage(); page.setDefaultTimeout(30_000);
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
  while (true) {
    const operation = await next();
    if (operation === 'finish') break;
    if (operation === 'pending') {
      await setPhase('pending-event');
      const task = await create(['--title', 'Recovery pending event', '--status', 'todo']);
      await send({ type: 'pending', task }); continue;
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
    if (operation !== 'verify') throw new Error('Unknown browser operation.');
    await setPhase('cross-client-readback');
    await page.goto(`${input.baseURL}/projects/${project}/tasks/${child}`);
    await expect(page.getByRole('heading', { name: 'Recovery child', exact: true })).toBeVisible();
    const current = JSON.parse(await cli(['task', 'show', child, '--project', project, '--json'])) as { id?: string; parentId?: string };
    if (current.id !== child || current.parentId !== goal) throw new Error('Cross-client Task readback mismatch.');
    if ((await cli(['task', 'attachment', 'read', child, 'recovery-proof.txt', '--project', project])) !== 'paired122') throw new Error('Cross-client attachment mismatch.');
    await page.goto('about:blank');
    await send({ type: 'verified', project, goal, child });
  }
  await context.close();
} catch (error) {
  const category = error instanceof Error && ['Error', 'TimeoutError', 'AssertionError'].includes(error.name) ? error.name : 'unknown';
  const message = error instanceof Error ? error.message : '';
  const apiStatus = message.match(/^Fixture API creation failed \((\d{3})\)\.$/)?.[1];
  const cliFailure = message.match(/^CLI (project|task|login) (create|show|delete|attachment|--no-browser) failed \(exit=(\d+|null)\)\.$/);
  const detail = apiStatus ? `api-status-${apiStatus}` : cliFailure ? `cli-${cliFailure[1]}-${cliFailure[2]!.replaceAll('-', '')}-exit-${cliFailure[3]}` : undefined;
  await send({ type: 'failed', phase, category, ...(detail ? { detail } : {}) }); process.exitCode = 1;
}
finally {
  if (running) running.kill('SIGKILL');
  if (browser) await browser.close();
  if (server) { try { await server.close(); } finally { if (scope && bound) await finishBrowserScope(input.repository, input.browserOwnerDirectory, scope); } }
}
