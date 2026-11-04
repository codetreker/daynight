import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base, expect, type TestInfo } from '@playwright/test';
import { command } from '../../scripts/acceptance/process.mts';
import { recordBrowserOwnership } from '../../scripts/acceptance/browser.mts';
import type { ExecutionPlatform, TaskProperties, WritableTaskProperties } from '../../src/api/types';
import { attachmentDownloadUrl } from '../../src/api/client';
import { bearerContext, browserAuthentication, createApiToken, tokenContext, type AuthenticatedAPI } from './authentication';
import { createAcceptanceCli } from '../../scripts/acceptance/installed-cli.mts';

export { expect };
export type AttachmentWriteExpectation = {
  readonly origin: string;
  readonly method: 'PUT' | 'DELETE';
  readonly projectId: string;
  readonly taskId: string;
  readonly path: string;
  readonly count: number;
};
export type StatusWriteExpectation = {
  readonly status: Task['status'];
  readonly origin: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly count: number;
};
type AttachmentWritePolicy = {
  readonly allowed: Map<string, { readonly count: number; observed: number }>;
  readonly statuses: Map<string, { readonly count: number; observed: number }>;
  readonly unexpected: string[];
  readonly register: (entries: readonly AttachmentWriteExpectation[]) => void;
  readonly registerStatuses: (entries: readonly StatusWriteExpectation[]) => void;
  readonly registerBrowser: (entries: readonly BrowserWriteExpectation[]) => void;
};
export type BrowserWriteExpectation = { readonly method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; readonly url: string; readonly count: number };
export type StatusPreparation = {
  projectId: string;
  cli: Awaited<ReturnType<typeof createAcceptanceCli>>;
  setupReceiptPath: string;
  apiContext(): Promise<AuthenticatedAPI>;
};
type WorkerPreparation = {
  status(origin: string, info: TestInfo): Promise<StatusPreparation>;
  controls(origin: string, api: AuthenticatedAPI, info: TestInfo): Promise<Project>;
};
export const test = base.extend<{
  preparationFamily: 'isolated' | 'status' | 'task-controls';
  statusPreparation: StatusPreparation;
  controlProject: Project;
  api: AuthenticatedAPI;
  authentication: 'automatic' | 'visible';
  authenticatedContext: void;
  acceptanceEvidence: void;
  allowAttachmentWrites: AttachmentWritePolicy['register'];
  allowStatusWrites: AttachmentWritePolicy['registerStatuses'];
  attachmentWritePolicy: AttachmentWritePolicy;
  allowBrowserWrites: AttachmentWritePolicy['registerBrowser'];
}, { workerPreparation: WorkerPreparation }>({
  preparationFamily: ['isolated', { option: true }],
  workerPreparation: [async ({ playwright }, use, workerInfo) => {
    let origin: string | undefined;
    let status: Promise<StatusPreparation> | undefined;
    let controls: Promise<Project> | undefined;
    let cli: StatusPreparation['cli'] | undefined;
    const bindOrigin = (value: string, info: TestInfo): void => {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || (origin !== undefined && origin !== value)
        || info.workerIndex !== workerInfo.workerIndex) {
        throw new Error('Shared preparation requires one exact service origin per worker.');
      }
      origin = value;
    };
    const prepareStatus = async (value: string, info: TestInfo): Promise<StatusPreparation> => {
      const directory = join(evidenceDirectory(), 'shared-preparation', `status-worker-${workerInfo.workerIndex}`);
      const setupReceiptPath = join(directory, 'setup.json');
      const apiToken = await createApiToken(value);
      try {
        const client = await createAcceptanceCli(value, join(directory, 'cli'));
        cli = client;
        const argv = ['project', 'create', `Status ${randomUUID()}`, '--repo', `https://example.com/status/${randomUUID()}`];
        const result = await client.run(argv);
        expect(result.exitCode).toBe(0); expect(result.stderr).toBe('');
        const ids = [...result.stdout.matchAll(/^ID: ([0-9a-f-]{36})$/gm)]; expect(ids).toHaveLength(1);
        const projectId = ids[0]![1]!;
        const receiptPath = process.env.DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT;
        if (receiptPath === undefined) throw new Error('Shared status preparation requires its installed CLI receipt.');
        const installedCli = JSON.parse(await readFile(receiptPath, 'utf8')) as unknown;
        await writeFile(setupReceiptPath, `${JSON.stringify({ origin: value, workerIndex: workerInfo.workerIndex,
          parallelIndex: workerInfo.parallelIndex, projectId, installedCli, command: { argv, ...result } }, null, 2)}\n`);
        await info.attach('shared-status-preparation', { path: setupReceiptPath, contentType: 'application/json' });
        return { projectId, cli: client, setupReceiptPath, apiContext: async () => tokenContext(playwright.request, value, apiToken) };
      } catch (error) {
        if (cli !== undefined) {
          try { await cli.close(); }
          catch (cleanup) { throw new AggregateError([error, cleanup], 'Status preparation and owned CLI cleanup failed.', { cause: error }); }
        }
        throw error;
      }
    };
    try {
      await use({
        status: (value, info) => {
          bindOrigin(value, info);
          return status ??= prepareStatus(value, info);
        },
        controls: (value, api, info) => {
          bindOrigin(value, info);
          return controls ??= createProject(api, { name: 'Task controls acceptance' });
        },
      });
    } finally {
      const results = await Promise.allSettled([status, controls].filter((pending) => pending !== undefined));
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (cli !== undefined) {
        try { await cli.close(); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Worker preparation or owned CLI cleanup failed.');
    }
  }, { scope: 'worker' }],
  statusPreparation: async ({ baseURL, preparationFamily, workerPreparation }, use, info) => {
    if (baseURL === undefined || preparationFamily !== 'status') throw new Error('Status preparation requires its service origin and scenario family.');
    await use(await workerPreparation.status(baseURL, info));
  },
  controlProject: async ({ baseURL, preparationFamily, workerPreparation, api }, use, info) => {
    if (baseURL === undefined || preparationFamily !== 'task-controls') throw new Error('Task control preparation requires its service origin and scenario family.');
    await use(await workerPreparation.controls(baseURL, api, info));
  },
  authentication: ['automatic', { option: true }],
  authenticatedContext: async ({ context, baseURL, authentication }, use) => {
    if (baseURL === undefined) throw new Error('Browser authentication requires the exact product origin.');
    if (authentication === 'automatic') await browserAuthentication(context, baseURL);
    await use();
  },
  page: async ({ page, authenticatedContext }, use) => { void authenticatedContext; await use(page); },
  api: async ({ playwright, baseURL, preparationFamily, workerPreparation }, use, info) => {
    if (baseURL === undefined) throw new Error('API fixture authentication requires the exact product origin.');
    const context = preparationFamily === 'status'
      ? await (await workerPreparation.status(baseURL, info)).apiContext()
      : await bearerContext(playwright.request, baseURL);
    try { await use(context); } finally { await context.dispose(); }
  },
  attachmentWritePolicy: async ({}, use) => {
    const allowed: AttachmentWritePolicy['allowed'] = new Map();
    const statuses: AttachmentWritePolicy['statuses'] = new Map();
    const unexpected: string[] = [];
    const registerBrowser = (entries: readonly BrowserWriteExpectation[]) => {
      for (const entry of entries) {
        const url = new URL(entry.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.href !== entry.url || url.username !== '' || url.password !== '' || url.hash !== ''
          || !['POST', 'PATCH', 'PUT', 'DELETE'].includes(entry.method) || !Number.isInteger(entry.count) || entry.count < 1) throw new Error('Invalid exact browser write expectation.');
        const key = `${entry.method} ${url.href}`;
        if (allowed.has(key)) throw new Error('Duplicate exact browser write expectation.');
        allowed.set(key, { count: entry.count, observed: 0 });
      }
    };
    await use({ allowed, statuses, unexpected, registerBrowser, register: (entries) => {
      if (allowed.size !== 0) throw new Error('Attachment write expectations are registered once per scenario.');
      for (const entry of entries) {
        const origin = new URL(entry.origin);
        if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== entry.origin
          || !['PUT', 'DELETE'].includes(entry.method) || !Number.isInteger(entry.count) || entry.count < 1) {
          throw new Error('Invalid exact attachment write expectation.');
        }
        const key = `${entry.method} ${new URL(attachmentDownloadUrl(entry.projectId, entry.taskId, entry.path), origin).href}`;
        if (allowed.has(key)) throw new Error('Duplicate exact attachment write expectation.');
        allowed.set(key, { count: entry.count, observed: 0 });
      }
    }, registerStatuses: (entries) => {
      if (statuses.size !== 0) throw new Error('Status write expectations are registered once per scenario.');
      for (const entry of entries) {
        const origin = new URL(entry.origin);
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== entry.origin
          || !['todo', 'in_progress', 'done'].includes(entry.status) || !uuid.test(entry.projectId) || !uuid.test(entry.taskId) || !Number.isInteger(entry.count) || entry.count < 1) {
          throw new Error('Invalid exact status write expectation.');
        }
        const key = `PUT ${origin.origin}/api/v1/projects/${entry.projectId}/tasks/${entry.taskId}/status ${entry.status}`;
        if (statuses.has(key)) throw new Error('Duplicate exact status write expectation.');
        statuses.set(key, { count: entry.count, observed: 0 });
      }
    } });
  },
  allowAttachmentWrites: async ({ attachmentWritePolicy }, use) => { await use(attachmentWritePolicy.register); },
  allowStatusWrites: async ({ attachmentWritePolicy }, use) => { await use(attachmentWritePolicy.registerStatuses); },
  allowBrowserWrites: async ({ attachmentWritePolicy }, use) => { await use(attachmentWritePolicy.registerBrowser); },
  acceptanceEvidence: [async ({ browser, page, attachmentWritePolicy }, use) => {
    const directory = evidenceDirectory();
    await mkdir(directory, { recursive: true });
    const { identity, profile } = await recordBrowserOwnership(browser, directory);
    await writeFile(join(directory, 'browser.json'), `${JSON.stringify({
      name: browser.browserType().name(), version: browser.version(), platform: process.platform, arch: process.arch,
      node: process.version, ci: Boolean(process.env.CI), executableOverride: process.env.DAYNIGHT_BROWSER_EXECUTABLE !== undefined,
      identity, profile,
    }, null, 2)}\n`);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.name));
    page.on('request', (request) => {
      if (['GET', 'HEAD'].includes(request.method())) return;
      const key = `${request.method()} ${request.url()}`;
      const status = request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/status') ? (JSON.parse(request.postData()!) as { status: string }).status : null;
      const allowed = attachmentWritePolicy.allowed.get(key) ?? attachmentWritePolicy.statuses.get(`${key} ${status}`);
      if (allowed === undefined) attachmentWritePolicy.unexpected.push(key);
      else allowed.observed += 1;
    });
    await use();
    expect(pageErrors, 'Production page has no uncaught exceptions').toEqual([]);
    expect(attachmentWritePolicy.unexpected, 'Browser writes match only exact registered URLs and methods').toEqual([]);
    for (const [key, entry] of [...attachmentWritePolicy.allowed, ...attachmentWritePolicy.statuses]) {
      expect(entry.observed, `Exact browser write count: ${key}`).toBe(entry.count);
    }
  }, { auto: true }],
});
export type Project = { id: string; name: string; repoUrl: string; createdAt: string; updatedAt: string };
export type Task = {
  id: string; projectId: string; title: string; description: string; status: 'todo' | 'in_progress' | 'done';
  version: number; assignedTo: string | null; dependsOn: string[]; externalDependsOn: readonly string[]; blockedBy: string[]; ready: boolean; allowAgents: boolean; requiredPlatform: ExecutionPlatform | null; createdAt: string; updatedAt: string;
  properties: TaskProperties;
};

export const createProject = async (request: AuthenticatedAPI, input: { name?: string; repoUrl?: string } = {}): Promise<Project> => {
  const current = await request.get('/api/v1/me');
  expect(current.status(), 'Project fixture identity succeeds').toBe(200);
  const user = await current.json() as { id: string };
  const response = await request.post('/api/v1/projects', {
    data: { name: input.name ?? `Browser ${randomUUID()}`, repoUrl: input.repoUrl ?? 'https://github.com/example/browser-fixture', expectedUserId: user.id },
  });
  expect(response.status(), 'Project fixture creation succeeds').toBe(201);
  return await response.json() as Project;
};

export const createTask = async (request: AuthenticatedAPI, projectId: string, input: {
  title: string; description?: string; dependsOn?: string[]; properties?: WritableTaskProperties; requiredPlatform?: ExecutionPlatform | null; assignedTo?: string | null;
}): Promise<Task> => {
  const response = await request.post(`/api/v1/projects/${projectId}/tasks`, {
    data: { title: input.title, description: input.description ?? '', dependsOn: input.dependsOn ?? [], properties: input.properties, requiredPlatform: input.requiredPlatform, assignedTo: input.assignedTo },
  });
  expect(response.status(), 'Task fixture creation succeeds').toBe(201);
  const task = await response.json() as Task;
  expect(task.status, 'Task fixture creation registers a to-do task').toBe('todo');
  expect(task.version).toBe(1);
  expect(task.requiredPlatform).toBe(input.requiredPlatform === undefined ? null : input.requiredPlatform);
  expect(task).toHaveProperty('assignedTo', input.assignedTo === undefined ? null : input.assignedTo);
  return task;
};

type TaskVersion = Pick<Task, 'id' | 'version'>;
export const setTaskStatus = async (request: AuthenticatedAPI, projectId: string, task: TaskVersion & { status: Task['status'] }, status: Task['status']): Promise<Task> => {
  const response = await request.put(`/api/v1/projects/${projectId}/tasks/${task.id}/status`, { data: { version: task.version, status } });
  expect(response.status(), `Task fixture sets ${status}`).toBe(200);
  const result = await response.json() as Task;
  expect(result.status).toBe(status);
  expect(result.version, 'Status assignment increments only an actual change').toBe(task.version + Number(task.status !== status));
  return result;
};
export const startTask = async (request: AuthenticatedAPI, projectId: string, task: Task): Promise<Task> => setTaskStatus(request, projectId, task, 'in_progress');
export const finishTask = async (request: AuthenticatedAPI, projectId: string, task: Task): Promise<Task> => setTaskStatus(request, projectId, task, 'done');
export const executeTask = async (request: AuthenticatedAPI, projectId: string, task: Task): Promise<Task> =>
  finishTask(request, projectId, await startTask(request, projectId, task));

export const updateTask = async (request: AuthenticatedAPI, projectId: string, taskId: string, input: {
  version: number; title?: string; description?: string; dependsOn?: string[]; properties?: WritableTaskProperties; requiredPlatform?: ExecutionPlatform | null; assignedTo?: string | null;
}): Promise<Task> => {
  const response = await request.patch(`/api/v1/projects/${projectId}/tasks/${taskId}`, { data: input });
  expect(response.status(), 'Task fixture update succeeds').toBe(200);
  return await response.json() as Task;
};

export const evidenceDirectory = (): string => {
  const directory = process.env.DAYNIGHT_ACCEPTANCE_DIRECTORY;
  if (directory === undefined || !directory.startsWith('/')) throw new Error('Acceptance requires an absolute owned evidence directory.');
  return directory;
};

type DatabaseTarget = {
  postgresContainer: string; projectLabel: { key: string; value: string }; database: string;
};
const ownedDatabase = async (): Promise<DatabaseTarget> => {
  const target = JSON.parse(await readFile(join(evidenceDirectory(), 'target.json'), 'utf8')) as DatabaseTarget;
  if (!/^[a-zA-Z0-9_.-]+$/.test(target.postgresContainer) || target.database !== 'daynight'
    || !['com.docker.compose.project', 'io.daynight.acceptance.run'].includes(target.projectLabel.key)
    || !/^(daynight-dev-ci-|daynight-web-)[a-zA-Z0-9-]+$/.test(target.projectLabel.value)) {
    throw new Error('Refusing database control for an unowned target.');
  }
  const label = await command('docker', ['inspect', '--format', `{{index .Config.Labels "${target.projectLabel.key}"}}`, target.postgresContainer], {
    cwd: process.cwd(), timeoutMs: 10_000, quiet: true,
  });
  if (label !== target.projectLabel.value) throw new Error('Database ownership label differs from this acceptance target.');
  return target;
};

export const seedUserProfile = async (userId: string, profile: { readonly name: string | null; readonly avatarUrl: string | null }): Promise<void> => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuid.test(userId) || Object.values(profile).some((value) => value !== null && value.includes('\0'))) throw new Error('Invalid owned user profile fixture.');
  const literal = (value: string | null): string => value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
  const target = await ownedDatabase();
  const result = await command('docker', ['exec', '--interactive', target.postgresContainer, 'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1',
    '--username', 'daynight', '--dbname', target.database, '--tuples-only', '--no-align', '--file', '-'], {
    cwd: process.cwd(), timeoutMs: 15_000, quiet: true,
    input: `UPDATE users SET name = ${literal(profile.name)}, avatar_url = ${literal(profile.avatarUrl)}, updated_at = statement_timestamp() WHERE id = '${userId}' RETURNING id;`,
  });
  expect(result.split('\n').filter((line) => uuid.test(line)), 'Owned profile fixture updates exactly the selected cached user').toEqual([userId]);
};

export const seedTaskVersion = async (projectId: string, taskId: string, version: bigint): Promise<void> => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuid.test(projectId) || !uuid.test(taskId) || version <= 0n || version >= 9223372036854775807n) {
    throw new Error('Invalid exact task version fixture.');
  }
  const target = await ownedDatabase();
  const result = await command('docker', ['exec', target.postgresContainer, 'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1',
    '--username', 'daynight', '--dbname', target.database, '--tuples-only', '--no-align', '--command',
    `BEGIN;
      DO $fixture$ BEGIN
        PERFORM id FROM projects WHERE id = '${projectId}' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Owned version project is missing'; END IF;
      END $fixture$;
      UPDATE tasks SET version = ${version}, updated_at = statement_timestamp()
        WHERE project_id = '${projectId}' AND id = '${taskId}' AND version < ${version} RETURNING version;
      COMMIT;`], {
    cwd: process.cwd(), timeoutMs: 15_000, quiet: true,
  });
  expect(result.split('\n').filter((line) => /^[0-9]+$/.test(line)), 'Owned task version fixture updates exactly the selected row').toEqual([String(version)]);
};

// Classification reads are exercised independently of public write support by
// seeding the exact owned PostgreSQL task under its existing project lock.
export const seedExternalDependencies = async (request: AuthenticatedAPI, projectId: string, task: TaskVersion, externalIds: readonly string[]): Promise<Task> => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuid.test(projectId) || !uuid.test(task.id) || !Number.isSafeInteger(task.version) || task.version < 1
    || externalIds.some((id) => !uuid.test(id)) || new Set(externalIds).size !== externalIds.length) throw new Error('Invalid owned dependency classification fixture.');
  const beforeResponse = await request.get(`/api/v1/projects/${projectId}/tasks/${task.id}`);
  expect(beforeResponse.status(), 'Classification fixture reads the exact current task').toBe(200);
  const before = await beforeResponse.json() as Task;
  expect(before.version, 'Classification fixture uses the observed task version').toBe(task.version);
  const target = await ownedDatabase();
  const externalArray = `ARRAY[${externalIds.map((id) => `'${id}'`).join(',')}]::uuid[]`;
  const result = await command('docker', ['exec', target.postgresContainer, 'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1',
    '--username', 'daynight', '--dbname', target.database, '--tuples-only', '--no-align', '--command', `BEGIN;
      DO $fixture$
      DECLARE saved_version bigint; classification_changed boolean;
      BEGIN
        PERFORM id FROM projects WHERE id = '${projectId}' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Owned classification project is missing'; END IF;
        SELECT version INTO saved_version FROM tasks WHERE project_id = '${projectId}' AND id = '${task.id}';
        IF saved_version IS DISTINCT FROM ${task.version} THEN RAISE EXCEPTION 'Owned classification task version changed'; END IF;
        IF EXISTS(SELECT unnest(${externalArray}) EXCEPT SELECT depends_on_task_id FROM task_dependencies
          WHERE project_id = '${projectId}' AND task_id = '${task.id}') THEN RAISE EXCEPTION 'Owned external subset is not a dependency'; END IF;
        SELECT coalesce(bool_or(external IS DISTINCT FROM (depends_on_task_id = ANY(${externalArray}))), false) INTO classification_changed
          FROM task_dependencies WHERE project_id = '${projectId}' AND task_id = '${task.id}';
        IF classification_changed THEN
          UPDATE task_dependencies SET external = depends_on_task_id = ANY(${externalArray})
            WHERE project_id = '${projectId}' AND task_id = '${task.id}';
          UPDATE tasks SET version = version + 1, updated_at = statement_timestamp()
            WHERE project_id = '${projectId}' AND id = '${task.id}';
        END IF;
      END $fixture$;
      SELECT json_build_object('version', version::text) FROM tasks WHERE project_id = '${projectId}' AND id = '${task.id}';
      COMMIT;`], { cwd: process.cwd(), timeoutMs: 15_000, quiet: true });
  const versionRow = result.split('\n').find((line) => line.startsWith('{'));
  if (versionRow === undefined) throw new Error('Owned classification fixture returned no task version.');
  const saved = JSON.parse(versionRow) as { version: string };
  const response = await request.get(`/api/v1/projects/${projectId}/tasks/${task.id}`);
  expect(response.status(), 'Classification fixture reads back the real persisted resource').toBe(200);
  const after = await response.json() as Task;
  const expected = [...externalIds].sort();
  const changed = JSON.stringify(before.externalDependsOn) !== JSON.stringify(expected);
  expect(String(after.version), 'Database and API return the same exact committed version').toBe(saved.version);
  expect(after.version, 'Classification change increments the task version exactly once').toBe(before.version + Number(changed));
  expect(after, 'Classification preserves every other task field and dependency').toEqual({
    ...before, externalDependsOn: expected, version: after.version, updatedAt: after.updatedAt,
  });
  if (changed) expect(after.updatedAt).not.toBe(before.updatedAt);
  else expect(after.updatedAt).toBe(before.updatedAt);
  return after;
};

export const seedRunningTaskStart = async (projectId: string, taskId: string, ageMs: number | null): Promise<void> => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuid.test(projectId) || !uuid.test(taskId)
    || (ageMs !== null && (!Number.isSafeInteger(ageMs) || ageMs < 0))) throw new Error('Invalid owned running-task timing fixture.');
  const target = await ownedDatabase();
  const start = ageMs === null ? 'NULL' : `statement_timestamp() - ${ageMs} * interval '1ms'`;
  const result = await command('docker', ['exec', target.postgresContainer, 'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1',
    '--username', 'daynight', '--dbname', target.database, '--tuples-only', '--no-align', '--command',
    `BEGIN;
      DO $fixture$ BEGIN
        PERFORM id FROM projects WHERE id = '${projectId}' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Owned timing project is missing'; END IF;
      END $fixture$;
      UPDATE tasks SET started_at = ${start}, version = version + 1, updated_at = statement_timestamp()
        WHERE project_id = '${projectId}' AND id = '${taskId}' AND status = 'in_progress' AND completed_at IS NULL RETURNING id;
      COMMIT;`], {
    cwd: process.cwd(), timeoutMs: 15_000, quiet: true,
  });
  expect(result.split('\n').filter((line) => uuid.test(line)), 'Owned timing fixture updates exactly the selected running task').toEqual([taskId]);
};

export const seedProjectSettingsVersion = async (projectId: string, version: bigint): Promise<void> => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(projectId)
    || version <= 0n || version >= 9223372036854775807n) throw new Error('Invalid exact project settings version fixture.');
  const target = await ownedDatabase();
  const result = await command('docker', ['exec', target.postgresContainer, 'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1',
    '--username', 'daynight', '--dbname', target.database, '--tuples-only', '--no-align', '--command',
    `UPDATE projects SET settings_version = ${version} WHERE id = '${projectId}' RETURNING settings_version`], {
    cwd: process.cwd(), timeoutMs: 15_000, quiet: true,
  });
  expect(result.split('\n')[0], 'Owned settings version fixture updates exactly the selected project').toBe(String(version));
};

const withTableFailure = async <T>(table: 'task_dependencies' | 'projects', callback: () => Promise<T>): Promise<T> => {
  const target = await ownedDatabase();
  const sql = async (value: string): Promise<void> => {
    try {
      await command('docker', ['exec', target.postgresContainer, 'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1',
        '--username', 'daynight', '--dbname', target.database, '--command', value], { cwd: process.cwd(), timeoutMs: 15_000, quiet: true });
    } catch (error) { throw new Error('Owned database failure control did not complete.', { cause: error }); }
  };
  const held = `acceptance_held_${table}`;
  await sql(`ALTER TABLE ${table} RENAME TO ${held}`);
  let original: unknown;
  try { return await callback(); }
  catch (error) { original = error; throw error; }
  finally {
    try { await sql(`ALTER TABLE ${held} RENAME TO ${table}`); }
    catch (error) {
      if (original !== undefined) throw new AggregateError([original, error], 'Browser scenario and database restoration failed.');
      throw error;
    }
  }
};

export const withDependencyFailure = async <T>(callback: () => Promise<T>): Promise<T> => withTableFailure('task_dependencies', callback);
export const withProjectsFailure = async <T>(callback: () => Promise<T>): Promise<T> => withTableFailure('projects', callback);
