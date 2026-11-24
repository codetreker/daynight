import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
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
let context: BrowserContext | undefined;
let phase = 'launch';
let safeFailureDetail: string | undefined;
const setPhase = async (value: string): Promise<void> => { phase = value; await writeAtomic(path.join(privateDirectory, 'browser-phase.json'), JSON.stringify({ phase })); };
let scope: string | undefined, bound = false;
try {
  await mkdir(cliDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(cliDirectory, 'config.yml'), `serverUrl: ${input.baseURL}\n`, { mode: 0o600 });
  const profile = path.join(privateDirectory, 'chromium-profile');
  const launch = async (): Promise<BrowserContext> => {
    scope = await beginBrowserScope(input.repository, input.browserOwnerDirectory); bound = false;
    const started = await chromium.launchPersistentContext(profile, { ignoreHTTPSErrors: true, locale: 'en-US', proxy: { server: input.proxyURL, bypass: '127.0.0.1,localhost,*.localhost' } });
    // Playwright does not expose a persistent context's process handle. Match its
    // direct child by the exact private profile argument and bind the original
    // process-group leader before treating the launch as owned.
    const children = new Set<string>();
    for (const thread of await readdir(`/proc/${process.pid}/task`)) {
      try {
        for (const child of (await readFile(`/proc/${process.pid}/task/${thread}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)) children.add(child);
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
    const matches: number[] = [];
    for (const child of children) {
      try {
        const command = (await readFile(`/proc/${child}/cmdline`, 'utf8')).replaceAll('\0', ' ');
        if (command.includes(` --user-data-dir=${profile} --remote-debugging-pipe`) && !command.includes(' --type=')) matches.push(Number(child));
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
    if (matches.length !== 1) { await started.close(); throw new Error('Persistent browser process identity is ambiguous.'); }
    try { await bindBrowserScope(input.repository, input.browserOwnerDirectory, scope, matches[0]!); bound = true; return started; }
    catch (error) { await started.close(); throw error; }
  };
  const stop = async (): Promise<void> => {
    if (!context || !scope || !bound) throw new Error('Persistent browser ownership is unavailable.');
    await context.close(); context = undefined;
    await finishBrowserScope(input.repository, input.browserOwnerDirectory, scope); scope = undefined; bound = false;
  };
  context = await launch();
  let page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(30_000);
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
    if (!context) throw new Error('Persistent browser is not running.');
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
  // Populate the old database before deletion so restoration must not revive it.
  await page.goto(`${input.baseURL}/projects/${project}/tasks/${hiddenChild}`);
  await expect(page.getByRole('heading', { name: 'Hidden recovery child', exact: true })).toBeVisible();
  const oldDatabase = await page.evaluate(async () => (await indexedDB.databases()).find(item => item.name === 'daynight-task-cache')?.version);
  if (oldDatabase !== 13) throw new Error('Baseline profile did not open task cache schema 13.');
  await cli(['task', 'delete', hiddenGoal, '--project', project, '--force']);
  await cli(['task', 'thread', 'post', child, '--body=Recovery baseline history', '--project', project]);
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
  await page.goto(`${input.baseURL}/projects/${project}/tasks/${child}`);
  await expect(page.getByRole('heading', { name: 'Recovery child', exact: true })).toBeVisible();
  await page.goto('about:blank');
  await send({ type: 'fixture-ready', project, goal, child, hiddenGoal, hiddenChild, oldDatabase });
  let candidateTab: Page | undefined;
  let candidateWrite: string | undefined;
  let candidateControl: CDPSession | undefined;
  let originalCacheDigest: string | undefined;
  const childURL = `${input.baseURL}/projects/${project}/tasks/${child}`;
  const syncPath = `/api/v1/projects/${project}/task-sync`;
  const databases = async (target: Page): Promise<{ name?: string; version?: number }[]> => await target.evaluate(() => indexedDB.databases());
  const originalDigest = async (target: Page): Promise<string> => await target.evaluate(async () => {
    const request = indexedDB.open('daynight-task-cache');
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const names = Array.from(db.objectStoreNames).sort();
      const transaction = db.transaction(names, 'readonly');
      const entries = await Promise.all(names.map(async name => await new Promise<unknown[]>((resolve, reject) => {
        const read = transaction.objectStore(name).getAll(); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
      })));
      const bytes = new TextEncoder().encode(JSON.stringify([names, entries], (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value));
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
    } finally { db.close(); }
  });
  const snapshot = async (target: Page): Promise<{ epoch: string; user: string }> => {
    const responsePromise = target.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === syncPath && response.status() === 200 && !url.searchParams.has('epoch') && !url.searchParams.has('since');
    }, { timeout: 30_000 });
    await target.goto(childURL);
    const response = await responsePromise;
    const body = await response.json() as { mode?: unknown; epoch?: unknown; tasks?: unknown };
    const principal = response.headers()['daynight-user-id'];
    if (body.mode !== 'snapshot' || typeof body.epoch !== 'string' || !Array.isArray(body.tasks) || typeof principal !== 'string' || principal !== me.id) throw new Error('Restored browser snapshot or principal mismatch.');
    const ids = body.tasks.map(item => (item as { id?: unknown }).id);
    if (!ids.includes(child) || ids.includes(hiddenChild) || candidateWrite !== undefined && ids.includes(candidateWrite)) throw new Error('Restored snapshot contains wrong task history.');
    await expect(target.getByRole('heading', { name: 'Recovery child', exact: true })).toBeVisible();
    return { epoch: body.epoch, user: principal };
  };
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
      candidateWrite = task;
      await cli(['task', 'thread', 'post', child, '--body=Recovery post-upgrade history', '--project', project]);
      candidateTab = await context.newPage();
      await candidateTab.goto(`${childURL}?tab=discussion`);
      await expect(candidateTab.getByText('Recovery post-upgrade history', { exact: true })).toBeVisible();
      const upgraded = (await databases(candidateTab)).find(item => item.name === 'daynight-task-cache');
      if (upgraded?.version !== 14) throw new Error('Candidate profile did not upgrade task cache schema to 14.');
      await writeFile(payload, 'post124', { mode: 0o600 });
      await cli(['task', 'attachment', 'put', child, payload, '--path', 'recovery-proof.txt', '--project', project]);
      if ((await cli(['task', 'attachment', 'read', child, 'recovery-proof.txt', '--project', project])) !== 'post124') throw new Error('Post-upgrade attachment readback mismatch.');
      await page.bringToFront();
      candidateControl = await context.newCDPSession(candidateTab);
      await candidateControl.send('Page.setWebLifecycleState', { state: 'frozen' });
      await page.goto(`${input.baseURL}/readyz`);
      originalCacheDigest = await originalDigest(page);
      await send({ type: 'written', task, originalCacheDigest }); continue;
    }
    if (operation === 'verify-restored') {
      await setPhase('restored-browser');
      if (!candidateTab || !candidateWrite || !candidateControl || !originalCacheDigest) throw new Error('Candidate browser history was not established.');
      const restored = await snapshot(page);
      const inventory = await databases(page);
      if (inventory.find(item => item.name === 'daynight-task-cache')?.version !== 14 || inventory.find(item => item.name === 'daynight-task-cache-recovery-12ebdd08')?.version !== 13) throw new Error('Recovery cache namespaces or versions differ.');
      if (await originalDigest(page) !== originalCacheDigest) throw new Error('Fallback changed the candidate cache contents.');
      await candidateControl.send('Page.setWebLifecycleState', { state: 'active' });
      await candidateTab.bringToFront();
      await page.goto(`${childURL}/attachments/recovery-proof.txt`);
      await expect(page.getByText('paired122', { exact: true })).toBeVisible();
      await page.goto(`${childURL}?tab=discussion`);
      await expect(page.getByText('Recovery baseline history', { exact: true })).toBeVisible();
      await expect(page.getByText('Recovery post-upgrade history', { exact: true })).toHaveCount(0);
      // The still-running candidate tab must retire its own pre-restore history.
      await expect(candidateTab.getByText('Recovery post-upgrade history', { exact: true })).toHaveCount(0, { timeout: 60_000 });
      await expect(candidateTab.getByText('Recovery baseline history', { exact: true })).toBeVisible();
      await page.goto(`${input.baseURL}/projects/${project}/tasks/${hiddenChild}`);
      await expect(page.getByRole('heading', { name: 'Hidden recovery child', exact: true })).toHaveCount(0);
      const deleted = await context.request.get(`${input.baseURL}/api/v1/projects/${project}/tasks/${hiddenChild}`);
      if (deleted.status() !== 410) throw new Error('Deleted Task was not refused after restore.');
      await send({ type: 'restored-verified', ...restored, project, child, hiddenChild, databases: inventory, originalCacheDigest, sameContext: true, candidateTabRetired: true, attachment: 'paired122', history: 'baseline-only', deletedStatus: deleted.status() });
      continue;
    }
    if (operation === 'verify-failures') {
      await setPhase('restored-failures');
      for (const failure of ['denied', 'offline', 'storage'] as const) {
        await setPhase(`restored-${failure}-prepare`);
        const probe = await context.newPage(); probe.setDefaultTimeout(30_000);
        let refused = 0;
        const refusedKinds = new Set<string>();
        if (failure !== 'storage') {
          await probe.bringToFront();
          await expect.poll(async () => await probe.evaluate(() => document.visibilityState)).toBe('visible');
          await probe.goto(`${childURL}?tab=discussion`);
          await expect(probe.getByText('Recovery baseline history', { exact: true })).toBeVisible();
        }
        if (failure === 'storage') {
          await probe.addInitScript(() => {
            const original = indexedDB.open.bind(indexedDB);
            indexedDB.open = ((name: string, version?: number) => {
              if (name.startsWith('daynight-task-cache-recovery-')) { (window as Window & { recoveryStorageFailed?: boolean }).recoveryStorageFailed = true; throw new DOMException('Injected storage failure', 'UnknownError'); }
              return original(name, version);
            }) as typeof indexedDB.open;
          });
        } else {
          await probe.route(new RegExp(`/api/v1/projects/${project}(?:/|[?]|$)`), route => {
            refused++;
            const pathname = new URL(route.request().url()).pathname;
            refusedKinds.add(pathname.endsWith('/task-sync') ? 'sync' : pathname.endsWith(`/tasks/${child}`) ? 'detail' : pathname.includes('/thread') ? 'thread' : 'other');
            return failure === 'denied'
              ? route.fulfill({ status: 403, contentType: 'application/json', headers: { 'Daynight-User-ID': String(me.id) }, body: JSON.stringify({ code: 'forbidden' }) })
              : route.abort('failed');
          });
        }
        await setPhase(`restored-${failure}-await-error`);
        if (failure === 'storage') await probe.goto(childURL);
        else {
          await setPhase(`restored-${failure}-await-sync`);
          await expect.poll(() => refusedKinds.has('sync'), { timeout: 60_000 }).toBe(true);
          await setPhase(`restored-${failure}-await-error`);
        }
        await expect(probe.getByRole('alert').first()).toBeVisible({ timeout: 60_000 });
        await setPhase(`restored-${failure}-verify-hidden`);
        if (failure === 'storage') {
          if (!await probe.evaluate(() => (window as Window & { recoveryStorageFailed?: boolean }).recoveryStorageFailed === true)) throw new Error('Storage failure was not exercised.');
        } else if (refused === 0) throw new Error('Project access failure was not exercised.');
        const hidden = async (label: 'heading' | 'history', locator: ReturnType<Page['getByText']>): Promise<void> => {
          await setPhase(`restored-${failure}-${label}`);
          try { await expect(locator).toHaveCount(0); }
          catch (error) {
            const count = await locator.count();
            let visible = 0;
            for (let index = 0; index < count; index++) if (await locator.nth(index).isVisible()) visible++;
            safeFailureDetail = `${label}-total-${count}-visible-${visible}-requests-${[...refusedKinds].sort().join('-') || 'none'}`;
            throw error;
          }
        };
        await hidden('heading', probe.getByRole('heading', { name: 'Recovery child', exact: true }));
        await hidden('history', probe.getByText('Recovery baseline history', { exact: true }));
        await probe.close();
      }
      await setPhase('restored-blocked-prepare');
      await page.close();
      const lockPage = await context.newPage();
      await lockPage.goto(`${input.baseURL}/projects`);
      await lockPage.evaluate(async () => {
        const request = indexedDB.open('daynight-task-cache-recovery-12ebdd08', 13);
        const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        Object.assign(window, { recoveryLock: db });
      });
      const upgrade = await context.newPage();
      await upgrade.goto(`${input.baseURL}/projects`);
      await upgrade.evaluate(() => {
        const request = indexedDB.open('daynight-task-cache-recovery-12ebdd08', 14);
        request.onblocked = () => { Object.assign(window, { recoveryBlocked: true }); };
        request.onupgradeneeded = () => { request.transaction!.abort(); };
        request.onerror = () => { Object.assign(window, { recoveryAborted: request.error?.name === 'AbortError' }); };
      });
      await setPhase('restored-blocked-barrier');
      await expect.poll(async () => await upgrade.evaluate(() => (window as Window & { recoveryBlocked?: boolean }).recoveryBlocked === true)).toBe(true);
      const blocked = await context.newPage();
      await blocked.addInitScript(() => {
        const original = indexedDB.open.bind(indexedDB);
        indexedDB.open = ((name: string, version?: number) => {
          const request = original(name, version);
          if (name === 'daynight-task-cache-recovery-12ebdd08') {
            Object.assign(window, { recoveryOpen: 'pending' });
            request.addEventListener('success', () => Object.assign(window, { recoveryOpen: 'success' }));
            request.addEventListener('error', () => Object.assign(window, { recoveryOpen: 'error' }));
          }
          return request;
        }) as typeof indexedDB.open;
      });
      await setPhase('restored-blocked-open');
      await blocked.goto(childURL);
      await expect.poll(async () => await blocked.evaluate(() => (window as Window & { recoveryOpen?: string }).recoveryOpen)).toBe('pending');
      await expect(blocked.getByRole('heading', { name: 'Recovery child', exact: true })).toHaveCount(0);
      await expect(blocked.getByText('Recovery baseline history', { exact: true })).toHaveCount(0);
      await setPhase('restored-blocked-release');
      await lockPage.evaluate(() => (window as Window & { recoveryLock?: IDBDatabase }).recoveryLock!.close());
      await expect.poll(async () => await upgrade.evaluate(() => (window as Window & { recoveryAborted?: boolean }).recoveryAborted === true)).toBe(true);
      await expect(blocked.getByRole('heading', { name: 'Recovery child', exact: true })).toBeVisible();
      await blocked.close(); await lockPage.close(); await upgrade.close();
      page = await context.newPage();
      await send({ type: 'failures-verified', denied: true, offline: true, storage: true, storageInjected: true, blocked: true });
      continue;
    }
    if (operation === 'verify-restart') {
      await setPhase('restored-page-restart');
      await stop();
      context = await launch();
      const restarted = context.pages()[0] ?? await context.newPage();
      restarted.setDefaultTimeout(30_000);
      page = restarted;
      let restartedIdentity = await context.request.get(`${input.baseURL}/api/v1/me`);
      if (restartedIdentity.status() === 401) {
        await restarted.goto(`${input.baseURL}/login`);
        await restarted.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
        await restarted.getByRole('button', { name: 'Authorize local identity', exact: true }).click();
        restartedIdentity = await context.request.get(`${input.baseURL}/api/v1/me`);
      }
      if (restartedIdentity.status() !== 200 || (await restartedIdentity.json() as { id?: unknown }).id !== me.id) throw new Error('Browser restart identity mismatch.');
      await setPhase('restored-restart-snapshot');
      const restored = await snapshot(restarted);
      await restarted.goto(`${childURL}?tab=discussion`);
      await expect(restarted.getByText('Recovery baseline history', { exact: true })).toBeVisible();
      await expect(restarted.getByText('Recovery post-upgrade history', { exact: true })).toHaveCount(0);
      await send({ type: 'restart-verified', ...restored, kind: 'persistent-browser-process', sameProfile: true });
      continue;
    }
    if (operation === 'verify-real-storage') {
      await setPhase('restored-real-storage-error');
      await expect(page.getByText('Recovery baseline history', { exact: true })).toBeVisible();
      const upgrade = await context.newPage();
      await upgrade.goto(`${input.baseURL}/projects`);
      await setPhase('restored-real-storage-upgrade');
      await upgrade.evaluate(async () => {
        const request = indexedDB.open('daynight-task-cache-recovery-12ebdd08', 14);
        const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        db.close();
      });
      await setPhase('restored-real-storage-version');
      const errorName = await upgrade.evaluate(async () => await new Promise<string>(resolve => {
        const request = indexedDB.open('daynight-task-cache-recovery-12ebdd08', 13);
        request.onsuccess = () => { request.result.close(); resolve('success'); };
        request.onerror = () => resolve(request.error?.name ?? 'unknown');
      }));
      if (errorName !== 'VersionError') throw new Error('Actual IndexedDB version failure was not observed.');
      await setPhase('restored-real-storage-withdraw');
      await expect(page.getByText('Recovery baseline history', { exact: true })).toHaveCount(0, { timeout: 60_000 });
      const failurePage = await context.newPage(); await failurePage.goto(childURL);
      await expect(failurePage.getByRole('alert').first()).toBeVisible();
      await expect(failurePage.getByRole('heading', { name: 'Recovery child', exact: true })).toHaveCount(0);
      await failurePage.close(); await upgrade.close();
      await send({ type: 'real-storage-verified', errorName, namespace: 'daynight-task-cache-recovery-12ebdd08' });
      continue;
    }
    if (operation !== 'verify' && operation !== 'verify-cli') throw new Error('Unknown browser operation.');
    await setPhase(operation === 'verify' ? 'cross-client-readback' : 'restored-cli-readback');
    if (operation === 'verify') {
      await page.goto(`${input.baseURL}/projects/${project}/tasks/${child}`);
      await expect(page.getByRole('heading', { name: 'Recovery child', exact: true })).toBeVisible();
    }
    const current = JSON.parse(await cli(['task', 'show', child, '--project', project, '--json'])) as { id?: string; parentId?: string };
    if (current.id !== child || current.parentId !== goal) throw new Error('Cross-client Task readback mismatch.');
    if ((await cli(['task', 'attachment', 'read', child, 'recovery-proof.txt', '--project', project])) !== 'paired122') throw new Error('Cross-client attachment mismatch.');
    if (operation === 'verify') await page.goto('about:blank');
    await send({ type: operation === 'verify' ? 'verified' : 'cli-verified', project, goal, child });
  }
  await stop();
} catch (error) {
  const category = error instanceof Error && ['Error', 'TimeoutError', 'AssertionError'].includes(error.name) ? error.name : 'unknown';
  const message = error instanceof Error ? error.message : '';
  const apiStatus = message.match(/^Fixture API creation failed \((\d{3})\)\.$/)?.[1];
  const cliFailure = message.match(/^CLI (project|task|login) (create|show|delete|attachment|--no-browser) failed \(exit=(\d+|null)\)\.$/);
  const detail = safeFailureDetail ?? (apiStatus ? `api-status-${apiStatus}` : cliFailure ? `cli-${cliFailure[1]}-${cliFailure[2]!.replaceAll('-', '')}-exit-${cliFailure[3]}`
    : message.includes('toBeVisible') ? 'assert-visible' : message.includes('toHaveCount') ? 'assert-count'
      : message.includes('toBe(') ? 'assert-value' : message.includes('Storage failure was not exercised') ? 'storage-not-exercised'
        : message.includes('Project access failure was not exercised') ? 'access-not-exercised'
          : message.includes('Actual IndexedDB version failure was not observed') ? 'version-error-not-observed' : undefined);
  await send({ type: 'failed', phase, category, ...(detail ? { detail } : {}) }); process.exitCode = 1;
}
finally {
  if (running) running.kill('SIGKILL');
  if (context) { try { await context.close(); } finally { if (scope && bound) await finishBrowserScope(input.repository, input.browserOwnerDirectory, scope); } }
}
