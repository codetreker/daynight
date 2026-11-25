import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import type { createCompatGateway } from '../src/subtask-compat-gateway.ts';
import { CommandFailure } from '../src/command.ts';
import { test, expect, topology, cliEnvironment, startOwnedCommand } from './fixtures.ts';
import { createNestedFixtureTeam, selectFixtureTeamScopes, verifyOldWorker } from './subtask-compat-worker.ts';

type CompatTopology = typeof topology & { oldCliEntry: string; oldCliConfigDirectory: string; serverVersion: 'baseline' | 'candidate'; baselineSchema: string };
const compat = topology as CompatTopology;
type Task = { id: string; title: string; type: string; status: string; version: number; parentId: string | null; parentTaskId?: string | null };
type Tool = { name: string; inputSchema: { properties: Record<string, unknown> } };
test.use({ trace: 'off', screenshot: 'off' });

async function login(page: Page, entry: string, directory: string, teamScopes: boolean): Promise<string> {
  let output = '';
  let publish: (v: { uri: string; code: string }) => void = () => {};
  const pending = new Promise<{ uri: string; code: string }>(resolve => { publish = resolve; });
  const command = await startOwnedCommand(process.execPath, [entry, 'login', '--no-browser'], {
    cwd: directory, env: { ...cliEnvironment, DN_CONFIG_DIR: directory }, timeoutMs: 120_000,
    onOutput: (_channel, chunk) => {
      output += chunk;
      const uri = output.match(/^Open (\S+)$/m)?.[1], code = output.match(/^Enter code: (\S+)$/m)?.[1];
      if (uri && code) publish({ uri, code });
    },
  });
  try {
    const device = await Promise.race([pending, command.finished.then(() => { throw new Error('CLI exited before device authorization.'); })]);
    await page.goto(`${device.uri}?user_code=${encodeURIComponent(device.code)}`);
    if (teamScopes) await selectFixtureTeamScopes(page);
    await page.getByRole('checkbox', { name: 'This code matches the one in my terminal', exact: true }).check();
    await page.getByRole('button', { name: 'Authorize CLI', exact: true }).click();
    expect((await command.finished).exitCode).toBe(0);
  } catch {
    await page.close().catch(() => {});
    throw new Error('Device authorization failed; sensitive diagnostics suppressed.');
  } finally { await command.stop(); }
  const module = await import(pathToFileURL(path.join(path.dirname(entry), 'config/server.js')).href) as { loadServerConfiguration(paths: { stateDirectory: string; configFile: string }): Promise<{ serverToken?: string }> };
  const token = (await module.loadServerConfiguration({ stateDirectory: directory, configFile: path.join(directory, 'config.yml') })).serverToken;
  if (!token) throw new Error('Device login did not save its credential.');
  return token;
}

async function oauthGrant(page: Page): Promise<string> {
  let stage = 'register';
  try {
    const callback = 'http://localhost:9012/callback';
    const registration = await fetch(`${topology.baseURL}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: `Compatibility ${randomUUID()}`, redirect_uris: ['http://localhost/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }), signal: AbortSignal.timeout(30_000) });
    if (registration.status !== 201) throw new Error('registration refused');
    const { client_id: clientId } = await registration.json() as { client_id: string };
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code', scope: 'daynight:mcp', resource: `${topology.baseURL}/mcp`, state: randomUUID(), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    stage = 'consent';
    await page.goto(`${topology.baseURL}/oauth/authorize?${query}`);
    if (compat.serverVersion === 'candidate') await selectFixtureTeamScopes(page);
    const decision = page.waitForResponse(response => /\/api\/v2\/oauth\/requests\/[^/]+\/decision$/.test(response.url()) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Allow access', exact: true }).click();
    const approved = await decision;
    if (approved.status() !== 200) throw new Error('consent refused');
    const redirect = new URL((await approved.json() as { redirectUri: string }).redirectUri);
    const code = redirect.searchParams.get('code');
    if (!code || redirect.searchParams.get('state') !== query.get('state')) throw new Error('invalid authorization response');
    stage = 'token';
    const response = await fetch(`${topology.baseURL}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: callback, resource: `${topology.baseURL}/mcp`, code_verifier: verifier }), signal: AbortSignal.timeout(30_000) });
    if (response.status !== 200) throw new Error('token exchange refused');
    const token = await response.json() as { access_token?: string; scope?: string };
    if (!token.access_token || token.scope !== 'daynight:mcp') throw new Error('invalid token response');
    await page.goto(`${topology.baseURL}/account`);
    return token.access_token;
  } catch { await page.close().catch(() => {}); throw new Error(`OAuth grant failed at ${stage}; sensitive diagnostics suppressed.`); }
}

test(`mixed versions: Web CLI and MCP against ${compat.serverVersion} Server`, async ({ page, context }) => {
  test.setTimeout(300_000);
  // Open the older cache schema first, then keep that tab open while the new
  // bundle upgrades the same origin's IndexedDB database.
  await page.setExtraHTTPHeaders({ 'x-daynight-e2e-web': 'baseline' });
  await page.goto(`${topology.baseURL}/login`);
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
  await page.getByRole('button', { name: 'Authorize local identity', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
  const candidateToken = await login(page, topology.cliEntry, topology.cliConfigDirectory, compat.serverVersion === 'candidate');
  const oldToken = await login(page, compat.oldCliEntry, compat.oldCliConfigDirectory, compat.serverVersion === 'candidate');
  const token = await oauthGrant(page);
  const command = async (version: 'old' | 'new', args: string[], success = true) => {
    const entry = version === 'old' ? compat.oldCliEntry : topology.cliEntry;
    const directory = version === 'old' ? compat.oldCliConfigDirectory : topology.cliConfigDirectory;
    const result = await (await startOwnedCommand(process.execPath, [entry, ...args], { cwd: directory, env: { ...cliEnvironment, DN_CONFIG_DIR: directory }, timeoutMs: 30_000, onOutput: () => {} })).finished;
    if (success && result.exitCode !== 0) throw new CommandFailure(`${version} CLI ${args[0]} ${args[1]}`, result);
    if (!success) expect(result.exitCode).not.toBe(0);
    return result;
  };
  const team = compat.serverVersion === 'candidate' ? await createNestedFixtureTeam({ server: topology.baseURL, token: candidateToken, command: args => command('new', args), name: `Compatibility ${randomUUID()}` }) : undefined;
  const createProject = await command('old', ['project', 'create', `Compatibility ${randomUUID()}`, '--repo', `https://example.test/compat/${randomUUID()}.git`, '--team', team?.id ?? 'personal', '--confirm']);
  const projectId = createProject.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
  if (!projectId) throw new Error('Project creation returned no ID.');
  const create = async (version: 'old' | 'new', args: string[]): Promise<string> => {
    const result = await command(version, ['task', 'create', '--project', projectId, ...args]);
    const id = result.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
    if (!id) throw new Error('Task creation returned no ID.');
    return id;
  };
  const show = async (version: 'old' | 'new', id: string): Promise<Task> => JSON.parse((await command(version, ['task', 'show', id, '--project', projectId, '--json'])).stdout) as Task;
  const goal = await create('old', ['--type', 'goal', '--title', 'Compatibility goal']);
  const standalone = await create('old', ['--title', 'Compatibility standalone', '--status', 'todo']);
  const goalChild = await create('old', ['--title', 'Compatibility goal child', '--parent', goal, '--status', 'todo']);
  expect(await show('new', goalChild)).toMatchObject({ id: goalChild, parentId: goal, status: 'todo' });
  await command('old', ['task', 'set-status', standalone, 'in_progress', '--project', projectId]);
  expect(await show('new', standalone)).toMatchObject({ id: standalone, status: 'in_progress' });
  const search = JSON.parse((await command('old', ['task', 'search', `id:${standalone}`, '--project', projectId, '--json'])).stdout) as Task[];
  expect(search.map(item => item.id)).toContain(standalone);
  await page.goto(`${topology.baseURL}/projects/${projectId}/tasks/${goal}`);
  await expect(page.getByRole('heading', { name: 'Compatibility goal', exact: true })).toBeVisible();
  await page.goto(`${topology.baseURL}/projects/${projectId}/tasks/${standalone}`);
  await expect(page.getByRole('heading', { name: 'Compatibility standalone', exact: true })).toBeVisible();

  const schemas = JSON.parse(await readFile(compat.baselineSchema, 'utf8')) as Record<string, Tool[]>;
  const oldTools = Object.values(schemas).flat();
  const mcp = async (name: string, args: Record<string, unknown>, old = true) => {
    if (old) {
      const definition = oldTools.find(tool => tool.name === name);
      if (!definition || Object.keys(args).some(key => !Object.hasOwn(definition.inputSchema.properties, key))) throw new Error(`Request exceeds baseline MCP schema: ${name}`);
    }
    const response = await fetch(`${topology.baseURL}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    expect(response.status).toBe(200);
    return await response.json() as { result?: { isError?: boolean; structuredContent?: { data?: Record<string, unknown>; error?: { code?: string } } }; error?: unknown };
  };
  const oldRead = await mcp('task_show', { projectId, taskId: goalChild, view: 'full' });
  expect(oldRead.result?.isError).not.toBe(true);
  expect(oldRead.result?.structuredContent?.data).toMatchObject({ id: goalChild, parentId: goal });
  expect(oldRead.result?.structuredContent?.data).not.toHaveProperty('parentTaskId');
  const receipt = await mcp('task_create', { projectId, title: 'Legacy MCP receipt', status: 'todo', returnView: 'receipt' });
  expect(receipt.result?.isError).not.toBe(true);
  const createdReceipt = receipt.result?.structuredContent?.data;
  expect(createdReceipt).toEqual({ projectId, taskId: expect.any(String), version: '1' });
  expect(await show('old', String(createdReceipt!.taskId))).toMatchObject({ title: 'Legacy MCP receipt', status: 'todo', version: 1 });

  if (compat.serverVersion === 'candidate') {
    const parent = await create('new', ['--title', 'Mixed parent', '--status', 'todo']);
    await team!.setAllowed(true);
    const child = await create('new', ['--title', 'Mixed child', '--parent-task', parent, '--status', 'todo']);
    await team!.setAllowed(false);
    const childTask = await show('new', child);
    expect(childTask).toMatchObject({ id: child, parentTaskId: parent });
    const legacy = await show('old', child);
    expect(legacy).toMatchObject({ id: child, parentId: null });
    expect(legacy).not.toHaveProperty('parentTaskId');
    const projected = await mcp('task_show', { projectId, taskId: child, view: 'full' });
    expect(projected.result?.structuredContent?.data).toMatchObject({ id: child, parentId: null });
    expect(projected.result?.structuredContent?.data).not.toHaveProperty('parentTaskId');
    for (const action of [['set-status', parent, 'done'], ['set-status', parent, 'cancelled'], ['delete', parent]]) {
      const refused = await command('old', ['task', ...action, '--project', projectId], false);
      expect(refused.stderr + refused.stdout).toMatch(/subtask|child|unfinished/i);
      expect(await show('new', parent)).toMatchObject({ id: parent, status: 'todo', version: 1 });
    }
    await page.goto(`${topology.baseURL}/projects/${projectId}/tasks/${child}`);
    await expect(page.getByRole('heading', { name: 'Mixed child', exact: true })).toBeVisible();
    await expect.poll(async () => page.evaluate(async ({ taskId, projectId, version }) => await new Promise<boolean>((resolve, reject) => {
      const request = indexedDB.open('daynight-task-cache');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('summaries', 'readonly').objectStore('summaries').getAll();
        read.onerror = () => { db.close(); reject(read.error); };
        read.onsuccess = () => { const row = read.result.find((entry: { taskId: string; projectId: string }) => entry.taskId === taskId && entry.projectId === projectId); db.close(); resolve(!!row && row.summary.id === taskId && String(row.summary.version) === version && !Object.hasOwn(row.summary, 'parentTaskId')); };
      };
    }), { taskId: child, projectId, version: String(childTask.version) }), { timeout: 30_000 }).toBe(true);
    const newPage = await context.newPage();
    await newPage.setExtraHTTPHeaders({ 'x-daynight-e2e-web': 'candidate' });
    const direct = newPage.waitForResponse(response => response.request().method() === 'GET' && response.url().includes(`/api/v1/projects/${projectId}/tasks?`) && new URL(response.url()).searchParams.get('parentTaskId') === parent);
    await newPage.goto(`${topology.baseURL}/projects/${projectId}/tasks/${parent}`);
    const listed = await direct;
    expect(listed.status()).toBe(200);
    const identityResponse = await newPage.request.get(`${topology.baseURL}/api/v1/me`);
    expect(identityResponse.status()).toBe(200);
    const identity = await identityResponse.json() as { id: string };
    expect(listed.headers()['daynight-user-id']).toBe(identity.id);
    const children = await listed.json() as { items: Task[] };
    expect(children.items).toMatchObject([{ id: child, parentTaskId: parent }]);
    await newPage.getByRole('tab', { name: 'Subtasks', exact: true }).click();
    await expect(newPage.getByRole('region', { name: 'Subtasks' })).toContainText('Mixed child');
    await newPage.close();
    await verifyOldWorker({ entry: compat.oldCliEntry, token: oldToken, server: topology.baseURL, command: args => command('old', args) });
  } else {
    await page.close();
    const requestLog = path.join(process.env.DAYNIGHT_E2E_RUN_DIRECTORY!, 'logs', 'subtask-compat-requests.jsonl');
    type TaskRequest = Parameters<NonNullable<Parameters<typeof createCompatGateway>[0]['onTaskRequest']>>[0];
    const taskRequests = async (): Promise<TaskRequest[]> => (await readFile(requestLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as TaskRequest);
    const collectionPath = `/api/v1/projects/${projectId}/tasks`;
    const projectRequestsSince = async (offset: number): Promise<TaskRequest[]> => (await taskRequests()).slice(offset).filter(item => item.path === collectionPath || item.path.startsWith(`${collectionPath}/`));
    // Read every status and both resource types directly from the old Server,
    // without the new client's relationship or Session projection.
    const snapshot = async (): Promise<Task[]> => {
      const tasks: Task[] = [];
      for (const type of ['task', 'goal']) {
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
          const query = new URLSearchParams({ type, limit: '100', ...(cursor === null ? {} : { cursor }) });
          const response = await fetch(`${topology.baseURL}${collectionPath}?${query}`, { headers: { Authorization: `Bearer ${oldToken}` }, signal: AbortSignal.timeout(30_000) });
          expect(response.status).toBe(200);
          const page = await response.json() as { items: Task[]; nextCursor: string | null };
          expect(Array.isArray(page.items)).toBe(true);
          tasks.push(...page.items);
          cursor = page.nextCursor;
          if (cursor !== null) {
            if (typeof cursor !== 'string' || cursor === '' || seen.has(cursor)) throw new Error('Invalid or repeated task snapshot cursor.');
            seen.add(cursor);
          }
        } while (cursor !== null);
      }
      return tasks.toSorted((a, b) => a.id.localeCompare(b.id));
    };
    const initial = await snapshot();
    expect(initial.map(task => task.id)).toEqual(expect.arrayContaining([goal, standalone, goalChild, String(createdReceipt!.taskId)]));
    const before = await show('new', standalone);
    const beforeCreation = (await taskRequests()).length;
    const creation = await command('new', ['task', 'create', '--project', projectId, '--title', 'Unsupported child', '--parent-task', standalone, '--status', 'todo'], false);
    const creationRequests = await projectRequestsSince(beforeCreation);
    expect(creation.stderr + creation.stdout).toMatch(/unsupported|invalid|unknown|bad request|400/i);
    expect(await snapshot()).toEqual(initial);
    expect.soft(creationRequests.map(({ method, path }) => ({ method, path }))).toEqual([{ method: 'POST', path: collectionPath }]);
    const beforeListing = (await taskRequests()).length;
    const listing = await command('new', ['task', 'list', '--project', projectId, '--parent-task', standalone, '--all', '--json'], false);
    const listingRequests = await projectRequestsSince(beforeListing);
    expect(listing.stderr + listing.stdout).toMatch(/unsupported|invalid|unknown|bad request|400/i);
    expect(await snapshot()).toEqual(initial);
    expect.soft(listingRequests.length).toBeGreaterThanOrEqual(1);
    expect.soft(listingRequests.length).toBeLessThanOrEqual(2);
    for (const request of listingRequests) {
      expect.soft(request).toMatchObject({ method: 'GET', path: collectionPath, query: { parentTaskId: standalone } });
      expect.soft([undefined, 'session']).toContain(request.query.include);
    }
    if (listingRequests.length === 2) {
      expect.soft(listingRequests[0]?.query.include).toBe('session');
      expect.soft(listingRequests[1]?.query.include).toBeUndefined();
    }
    const countStatus = async () => (await readFile(requestLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { method: string; path: string }).filter(item => item.method === 'PUT' && item.path === `/api/v1/projects/${projectId}/tasks/${standalone}/status`).length;
    const beforeCancellation = await countStatus();
    const cancellationOffset = (await taskRequests()).length;
    const cancellation = await command('new', ['task', 'set-status', standalone, 'cancelled', '--project', projectId, '--confirm'], false);
    const cancellationRequests = await projectRequestsSince(cancellationOffset);
    expect(cancellation.stderr + cancellation.stdout).toMatch(/unsupported|invalid|unknown|bad request|400/i);
    expect(await countStatus()).toBe(beforeCancellation + 1);
    expect(await show('new', standalone)).toMatchObject({ id: standalone, status: before.status, version: before.version });
    expect(await snapshot()).toEqual(initial);
    expect.soft(cancellationRequests.map(({ method, path }) => ({ method, path }))).toEqual([{ method: 'GET', path: `${collectionPath}/${standalone}` }, { method: 'PUT', path: `${collectionPath}/${standalone}/status` }]);
    expect.soft(cancellationRequests.filter(request => request.method === 'PUT').map(request => request.cancelDescendants)).toEqual([true]);
    // Each new MCP request is sent once, with no redirect or retry using the
    // older argument shape. Read back the old Server after every refusal.
    for (const scenario of [
      { name: 'task_create', field: 'parentTaskId', args: { projectId, title: 'Unsupported MCP child', status: 'todo', parentTaskId: standalone } },
      { name: 'task_list', field: 'parentTaskId', args: { projectId, parentTaskId: standalone, all: true } },
      { name: 'task_set_status', field: 'cancelDescendants', args: { projectId, taskId: standalone, status: 'cancelled', ifVersion: String(before.version), cancelDescendants: true } },
    ]) {
      const definition = oldTools.find(tool => tool.name === scenario.name);
      expect(definition).toBeDefined();
      expect(Object.hasOwn(definition!.inputSchema.properties, scenario.field)).toBe(false);
      const refusal = await mcp(scenario.name, scenario.args, false);
      expect(refusal.result?.isError).toBe(true);
      expect(refusal.result?.structuredContent?.error?.code).toBe('invalid_input');
      expect(await snapshot()).toEqual(initial);
    }
    const newPage = await context.newPage();
    await newPage.setExtraHTTPHeaders({ 'x-daynight-e2e-web': 'candidate' });
    await newPage.goto(`${topology.baseURL}/projects/${projectId}/tasks/${standalone}`);
    await newPage.getByRole('tab', { name: 'Subtasks', exact: true }).click();
    await expect(newPage.getByText('This server does not support ordinary Task relationships.')).toBeVisible();
    await newPage.close();
  }
  console.log(`mixed version project=${projectId} goal=${goal} standalone=${standalone} goalChild=${goalChild} server=${compat.serverVersion}`);
});
