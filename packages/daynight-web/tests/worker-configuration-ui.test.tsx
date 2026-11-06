import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../src/api/types';
import type { WorkerConfigurationKey, WorkerConfigurationOutcome, WorkerConfigurationResource, WorkerConfigurationValue } from '../src/api/worker-configuration';
import { WorkerConfigurationPanel } from '../src/features/workers/configuration/WorkerConfigurationPanel';
import { ConfigurationProjectsDialog } from '../src/features/workers/configuration/ConfigurationDialogs';
import { WorkerDetailPage } from '../src/features/workers/WorkerDetailPage';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { TaskCacheError } from '../src/features/task-cache/database';
import { renderWithLocale } from './helpers/renderWithLocale';
import { configurationError, configurationResource, configurationResponse, configurationValue } from './helpers/worker-configuration';
import { wireResponse } from './helpers/wireJson';
import { WORKER_TIME, WORKER_USER, workerDetail, workerError, workerId, workerResponse } from './helpers/workers';

const flush = () => act(async () => { for (let n = 0; n < 60; n++) { await Promise.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); } });
const advance = async () => { await act(async () => { vi.advanceTimersByTime(5_000); for (let n = 0; n < 60; n++) await Promise.resolve(); }); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const project = (value: number): Project => ({ id: workerId(value), name: `Project ${value}`, repoUrl: `https://example.test/project-${value}.git`, settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: workerId(999), version: 1n }, createdAt: WORKER_TIME, updatedAt: WORKER_TIME });
const projectPage = (items: readonly Project[] = [], nextCursor: string | null = null, userId = WORKER_USER) => wireResponse({ items, nextCursor }, { headers: { 'Daynight-User-ID': userId } });
const item = (key: WorkerConfigurationKey, appliedValue: WorkerConfigurationOutcome['appliedValue'], targetRevision = '1'): WorkerConfigurationOutcome => ({ key, appliedValue, targetRevision, state: 'applied', error: null, lastFailure: null, nextAttemptAt: null });
const globals = (value: WorkerConfigurationValue, revision = '1') => [item({ kind: 'maxConcurrent' }, value.maxConcurrent, revision), item({ kind: 'pollIntervalMs' }, value.pollIntervalMs, revision), item({ kind: 'recoveryLimit' }, value.recoveryLimit, revision), item({ kind: 'native' }, value.native, revision)];
const observed = (revision: string, value: WorkerConfigurationValue, items: readonly WorkerConfigurationOutcome[], observationRevision = '1'): WorkerConfigurationResource => ({ ...configurationResource(revision, value), observationRevision, observation: { baseRevision: String(BigInt(observationRevision) - 1n), desiredRevision: revision, items, reportedAt: WORKER_TIME } });
const install = (handler: (url: string, init: RequestInit) => Response | Promise<Response>, projects: readonly Project[] = []) => {
  const fetch = vi.fn((url: string, init: RequestInit = {}) => url.startsWith('/api/v1/projects?') ? projectPage(projects) : handler(url, init));
  vi.stubGlobal('fetch', fetch); return fetch;
};
const mount = (props: Partial<Parameters<typeof WorkerConfigurationPanel>[0]> = {}) => renderWithLocale(<WorkerConfigurationPanel workerId={workerId(1)} readEnabled online tasks={[]} {...props} />, { locale: 'en', taskCache: { viewerId: WORKER_USER } });
const input = (name = 'Concurrent task limit') => screen.getByRole('textbox', { name }) as HTMLInputElement;
const change = (name: string, value: string) => fireEvent.change(input(name), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
const scopes: TaskCacheScope[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
afterEach(() => { for (const scope of scopes.splice(0)) scope.dispose(); vi.useRealTimers(); });

describe('Worker configuration form', () => {
  it.each([['en', 'The local project cache could not be checked or cleared.'], ['zh-CN', '无法检查或清理本地项目缓存。']] as const)('shows cache failures in %s while allowing unavailable selections to be removed', (locale, message) => {
    const apply = vi.fn(), id = workerId(3);
    renderWithLocale(<ConfigurationProjectsDialog projects={[]} selected={[id]} loading={false} error={new TaskCacheError('storage')} refresh={vi.fn()} onClose={vi.fn()} onApply={apply} />, { locale });
    expect(screen.getByText(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(id) }));
    fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Done' : '完成' })); expect(apply).toHaveBeenCalledWith([]);
  });
  it('keeps a newly selected Project removable if its metadata is withdrawn in the open dialog', () => {
    const apply = vi.fn(), selected: string[] = [], refresh = vi.fn(), close = vi.fn();
    const dialog = (projects: readonly Project[]) => <ConfigurationProjectsDialog projects={projects} selected={selected} loading={false} error={null} refresh={refresh} onClose={close} onApply={apply} />;
    const view = renderWithLocale(dialog([project(3), project(4)]), { locale: 'en' });
    fireEvent.click(screen.getByRole('checkbox', { name: /Project 3/ }));
    view.rerender(dialog([project(4)]));
    const unavailable = screen.getByRole('checkbox', { name: new RegExp(workerId(3)) });
    expect(unavailable).toBeChecked(); fireEvent.click(unavailable); expect(screen.queryByRole('checkbox', { name: new RegExp(workerId(3)) })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' })); expect(apply).toHaveBeenCalledWith([]);
  });
  it('saves a target without presenting the old actual value as applied', async () => {
    let resource = observed('1', configurationValue(), globals(configurationValue()));
    const writes: unknown[] = [];
    const fetch = install((_url, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { revision: string; value: WorkerConfigurationValue }; writes.push(body);
        resource = { ...resource, desired: { revision: '2', updatedAt: WORKER_TIME, value: body.value } };
      }
      return configurationResponse(resource);
    });
    mount({ online: false }); await flush();
    expect(screen.getByText('This Worker is offline. Saved changes wait for its next report.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
    change('Concurrent task limit', '4'); save(); await flush();
    expect(writes).toEqual([{ revision: '1', value: { ...configurationValue(), maxConcurrent: 4 } }]);
    expect(screen.getByText('Saved to the cloud. Application is confirmed by a Worker report.')).toBeInTheDocument();
    const feedback = document.getElementById('feedback-maxConcurrent')!;
    expect(within(feedback).getByText('Awaiting application')).toBeInTheDocument(); expect(within(feedback).getByText('Actual: 2')).toBeInTheDocument();
    expect(within(feedback).queryByText('Applied')).toBeNull();
    expect(fetch.mock.calls.some(([url]) => url.includes('/tasks'))).toBe(false);
  });
  it('preserves inherited fields, explicit clears and different Agent defaults in saved Projects', async () => {
    const value = { ...configurationValue(), native: { agent: 'codex' as const, model: 'global-model', args: ['--global'] }, projects: [3, 4, 5].map(id => ({ projectId: workerId(id), nativeOverrides: {} })) };
    let resource = configurationResource('1', value), submitted: WorkerConfigurationValue | null = null;
    install((_url, init) => {
      if (init?.method === 'PUT') { submitted = (JSON.parse(String(init.body)) as { value: WorkerConfigurationValue }).value; resource = configurationResource('2', submitted); }
      return configurationResponse(resource);
    }, [project(3), project(4), project(5)]);
    mount(); await flush();
    for (const id of [3, 4, 5]) fireEvent.click(within(screen.getByRole('heading', { name: `Project ${id}` }).closest('article')!).getByText(/Agent settings/));
    fireEvent.change(screen.getByRole('combobox', { name: 'Project 4 · Model' }), { target: { value: 'default' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Project 4 · Startup arguments' }), { target: { value: 'clear' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Project 5 · Agent' }), { target: { value: 'claude' } });
    expect(screen.getByRole('textbox', { name: 'Project 5 · Custom model' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Project 5 · Custom arguments' })).toHaveValue('[]');
    expect(screen.getByText('With a different Agent, inherited model and arguments use that Agent’s defaults.')).toBeInTheDocument();
    save(); await flush();
    expect(submitted).toEqual({ ...value, projects: [{ projectId: workerId(3), nativeOverrides: {} }, { projectId: workerId(4), nativeOverrides: { model: null, args: [] } }, { projectId: workerId(5), nativeOverrides: { agent: 'claude' } }] });
  });
  it('keeps invalid numeric/JSON text, the focused node and its selection during observation refresh', async () => {
    let resource = configurationResource(); install(() => configurationResponse(resource)); mount(); await flush();
    change('Concurrent task limit', '-'); expect(input()).toHaveAttribute('aria-invalid', 'true'); expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
    change('Startup arguments', '[invalid JSON'); const args = input('Startup arguments'); args.focus(); args.setSelectionRange(2, 8);
    resource = observed('1', configurationValue(), globals(configurationValue())); await advance();
    expect(input('Startup arguments')).toBe(args); expect(args).toHaveValue('[invalid JSON'); expect(args).toHaveFocus(); expect(args.selectionStart).toBe(2); expect(args.selectionEnd).toBe(8);
    expect(input()).toHaveValue('-'); expect(screen.getByText('Enter a JSON array of nonempty strings without control characters.')).toBeInTheDocument();
  });
  it('shows preparation errors, removed Project stop results and recovered last failures together', async () => {
    const value = { ...configurationValue(), projects: [{ projectId: workerId(3), nativeOverrides: {} }] };
    const preparation = { code: 'permission_denied' as const, category: 'repository' as const, phase: 'prepare' as const, occurredAt: WORKER_TIME };
    const stopping = { code: 'command_failed' as const, category: 'runtime' as const, phase: 'stop' as const, occurredAt: WORKER_TIME };
    let resource = observed('2', value, [...globals(value, '2'),
      { ...item({ kind: 'projectPreparation', projectId: workerId(3) }, null, '2'), state: 'error', error: preparation, lastFailure: preparation, nextAttemptAt: WORKER_TIME },
      item({ kind: 'projectNative', projectId: workerId(3) }, value.native, '2'),
      { ...item({ kind: 'projectRemoval', projectId: workerId(9) }, null, '1'), state: 'error', error: stopping, lastFailure: stopping, nextAttemptAt: WORKER_TIME },
    ], '2');
    install(() => configurationResponse(resource), [project(3), project(9)]); mount(); await flush();
    expect(screen.getByText('Partially applied')).toBeInTheDocument();
    const removed = screen.getByRole('heading', { name: 'Project 9' }).closest('article')!;
    expect(within(removed).getByText('Stop project execution')).toBeInTheDocument(); expect(within(removed).getByText(/Stopping · Command failed/)).toBeInTheDocument();
    expect(screen.getByText(/Preparation · Permission denied/)).toBeInTheDocument();
    resource = observed('2', value, [...globals(value, '2'),
      { ...item({ kind: 'projectPreparation', projectId: workerId(3) }, true, '2'), lastFailure: preparation },
      item({ kind: 'projectNative', projectId: workerId(3) }, value.native, '2'),
      { ...item({ kind: 'projectRemoval', projectId: workerId(9) }, true, '1'), lastFailure: stopping },
    ], '3'); await advance();
    expect(screen.getByText(/Last failure: Preparation · Permission denied/)).toBeInTheDocument(); expect(screen.getByText(/Last failure: Stopping · Command failed/)).toBeInTheDocument();
    const summary = screen.getByRole('heading', { name: 'Configuration status' }).closest('section')!;
    expect(within(summary).getByText('Applied')).toBeInTheDocument();
  });
  it('keeps new Project targets pending and shows an unfinished removal after that Project is reselected', async () => {
    const value = { ...configurationValue(), projects: [{ projectId: workerId(3), nativeOverrides: {} }] };
    const oldProof = [item({ kind: 'projectPreparation', projectId: workerId(3) }, true), item({ kind: 'projectNative', projectId: workerId(3) }, value.native)];
    let resource: WorkerConfigurationResource = { ...observed('1', value, [...globals(value), ...oldProof]), desired: configurationResource('2', value).desired };
    install(() => configurationResponse(resource), [project(3)]); mount(); await flush();
    const selected = screen.getByRole('heading', { name: 'Project 3' }).closest('article')!;
    expect(within(selected).getAllByText('Awaiting application')).toHaveLength(2); expect(within(selected).queryByText('Applied')).toBeNull();
    const failure = { code: 'command_failed' as const, category: 'runtime' as const, phase: 'stop' as const, occurredAt: WORKER_TIME };
    resource = observed('3', value, [...globals(value, '3'), ...oldProof,
      { ...item({ kind: 'projectRemoval', projectId: workerId(3) }, null, '2'), state: 'error', error: failure, lastFailure: failure, nextAttemptAt: WORKER_TIME },
    ], '2'); await advance();
    const projectRows = screen.getAllByRole('heading', { name: 'Project 3' }).map(heading => heading.closest('article')!);
    expect(within(projectRows[0]!).getAllByText('Awaiting application')).toHaveLength(2);
    expect(within(projectRows[1]!).getByText(/Stopping · Command failed/)).toBeInTheDocument(); expect(screen.getByText('Partially applied')).toBeInTheDocument();
    fireEvent.click(within(projectRows[0]!).getByText(/Agent settings/));
    fireEvent.change(screen.getByRole('combobox', { name: 'Project 3 · Agent' }), { target: { value: 'claude' } });
    expect(within(projectRows[1]!).getByText(/Stopping · Command failed/)).toBeInTheDocument();
  });
  it('retains a known save failure through a successful poll until the draft is edited', async () => {
    install((_url, init) => init.method === 'PUT' ? configurationError(400, 'invalid_input') : configurationResponse(configurationResource()));
    mount(); await flush(); change('Concurrent task limit', '3'); save(); await flush();
    expect(screen.getByText('Configuration could not be saved.')).toBeInTheDocument(); expect(screen.getByText('configuration-request')).toBeInTheDocument();
    await advance(); expect(screen.getByText('Configuration could not be saved.')).toBeInTheDocument(); expect(input()).toHaveValue('3');
    change('Concurrent task limit', '4'); expect(screen.queryByText('Configuration could not be saved.')).toBeNull(); expect(input()).toHaveValue('4');
  });
  it('clears a previous Agent model and arguments when choosing another global Agent', async () => {
    const value = { ...configurationValue(), native: { agent: 'codex' as const, model: 'codex-model', args: ['--codex-option'] } };
    let resource = configurationResource('1', value), submitted: WorkerConfigurationValue | null = null;
    install((_url, init) => {
      if (init.method === 'PUT') { submitted = (JSON.parse(String(init.body)) as { value: WorkerConfigurationValue }).value; resource = configurationResource('2', submitted); }
      return configurationResponse(resource);
    }); mount(); await flush();
    expect(input('Model')).toHaveValue('codex-model');
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'claude' } });
    expect(input('Model')).toHaveValue(''); expect(input('Startup arguments')).toHaveValue('[]');
    save(); await flush(); expect(submitted).toEqual({ ...value, native: { agent: 'claude', model: null, args: [] } });
  });
  it('retains the input on conflict and loads the new target only after an explicit action', async () => {
    let reads = 0;
    const fetch = install((_url, init) => init?.method === 'PUT' ? configurationError(409, 'version_conflict') : configurationResponse(++reads === 1 ? configurationResource() : configurationResource('2', { ...configurationValue(), maxConcurrent: 9 })));
    mount(); await flush(); change('Concurrent task limit', '3'); save(); await flush();
    expect(screen.getByText('The cloud configuration changed in another page.')).toBeInTheDocument(); expect(input()).toHaveValue('3');
    expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Load latest configuration' })); expect(input()).toHaveValue('9');
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });
  it('checks an unknown save without replaying PUT and retains the draft while checking is unavailable', async () => {
    let reads = 0;
    const fetch = install((_url, init) => {
      if (init?.method === 'PUT') return configurationError(500, 'internal_error');
      ++reads;
      if (reads === 2) throw new Error('offline');
      return configurationResponse(reads === 1 ? configurationResource() : configurationResource('2', { ...configurationValue(), maxConcurrent: 3 }));
    });
    mount(); await flush(); change('Concurrent task limit', '3'); save(); await flush();
    expect(screen.getByText('The save result is not yet confirmed. Your draft has been kept.')).toBeInTheDocument(); expect(input()).toHaveValue('3'); expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check save result' })); await flush();
    expect(screen.getByText('The cloud confirms the submitted configuration.')).toBeInTheDocument(); expect(input()).toHaveValue('3');
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });
  it('confirms Project removal, supports Escape and keeps task links and responsibility untouched', async () => {
    const task = { ...workerDetail().worker.tasks[0]!, projectId: workerId(3), projectName: 'Project 3' };
    let resource = configurationResource('1', { ...configurationValue(), projects: [{ projectId: workerId(3), nativeOverrides: {} }] });
    const fetch = install((_url, init) => {
      if (init?.method === 'PUT') resource = configurationResource('2', (JSON.parse(String(init.body)) as { value: WorkerConfigurationValue }).value);
      return configurationResponse(resource);
    }, [project(3)]);
    mount({ tasks: [task] }); await flush(); fireEvent.click(screen.getByRole('button', { name: 'Remove project Project 3' }));
    const opener = screen.getByRole('button', { name: 'Save configuration' }); opener.focus(); fireEvent.click(opener);
    let dialog = screen.getByRole('dialog', { name: 'Save configuration and stop execution?' });
    expect(within(dialog).getByRole('link', { name: 'Snapshot task' }).getAttribute('href')).toContain(`/projects/${task.projectId}/tasks/${task.taskId}`);
    expect(within(dialog).getByText(/Task status, claims, worktrees and history remain for manual handling/)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull(); expect(opener).toHaveFocus(); expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
    fireEvent.click(opener); dialog = screen.getByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: 'Save configuration' })); await flush();
    expect(resource.desired!.value.projects).toEqual([]); expect(task.status).toBe('in_progress'); expect(task.claimId).toBe(workerDetail().worker.tasks[0]!.claimId);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1); expect(fetch.mock.calls.some(([url]) => url.includes('/tasks/'))).toBe(false);
  });
  it('paginates Project choices and retains selected inaccessible IDs when choosing another Project', async () => {
    const inaccessible = workerId(30), second = deferred<Response>(); let projectReads = 0;
    const value = { ...configurationValue(), projects: [{ projectId: inaccessible, nativeOverrides: { model: null, args: [] } }] };
    const fetch = vi.fn((url: string) => {
      if (url.startsWith('/api/v1/projects?')) {
        ++projectReads;
        if (url.includes('cursor=')) return second.promise.then(response => response.clone());
        return projectPage([project(3)], 'second');
      }
      return configurationResponse(configurationResource('1', value));
    }); vi.stubGlobal('fetch', fetch); mount(); await flush();
    expect(screen.getByRole('heading', { name: inaccessible })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Choose projects/ })); await flush();
    let dialog = screen.getByRole('dialog', { name: 'Choose projects' }); expect(within(dialog).getByRole('button', { name: 'Done' })).toBeDisabled();
    second.resolve(projectPage([project(4)])); await flush();
    dialog = screen.getByRole('dialog'); const retained = within(dialog).getByRole('checkbox', { name: new RegExp(inaccessible) }); expect(retained).toBeChecked();
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'Project 4' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Project 4/ })); fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('heading', { name: inaccessible })).toBeInTheDocument(); expect(screen.getByRole('heading', { name: 'Project 4' })).toBeInTheDocument(); expect(projectReads).toBeGreaterThanOrEqual(3);
    expect(fetch.mock.calls.some(([url]) => url === '/api/v1/projects?limit=100&cursor=second')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Choose projects/ })); await flush();
    dialog = screen.getByRole('dialog'); const unavailable = within(dialog).getByRole('checkbox', { name: new RegExp(inaccessible) });
    expect(unavailable).toBeChecked(); fireEvent.click(unavailable); expect(unavailable).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeEnabled(); fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('heading', { name: inaccessible })).toBeNull(); expect(screen.getByRole('heading', { name: 'Project 4' })).toBeInTheDocument();
  });
});

describe('Worker detail configuration integration', () => {
  it('keeps configuration available after telemetry404 and preserves its mounted draft across keyboard tabs', async () => {
    install(url => url.endsWith('/configuration') ? configurationResponse(configurationResource()) : workerError(404));
    renderWithLocale(<WorkerDetailPage workerId={workerId(1)} readEnabled />, { locale: 'en', taskCache: { viewerId: WORKER_USER } }); await flush();
    expect(screen.getByText('Worker unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    const args = input('Startup arguments'); change('Startup arguments', '[unfinished');
    const overview = screen.getByRole('tab', { name: 'Runtime overview' }); fireEvent.click(overview); expect(args).not.toBeVisible();
    fireEvent.keyDown(overview, { key: 'ArrowRight' }); await flush();
    expect(screen.getByRole('tab', { name: 'Configuration' })).toHaveFocus(); expect(input('Startup arguments')).toBe(args); expect(args).toHaveValue('[unfinished'); expect(args).toBeVisible();
  });
  it('preserves existing Task links while displaying a separate configuration panel', async () => {
    const detail = workerDetail(); install(url => url.endsWith('/configuration') ? configurationResponse(configurationResource()) : workerResponse(detail));
    renderWithLocale(<WorkerDetailPage workerId={workerId(1)} readEnabled />, { locale: 'en', taskCache: { viewerId: WORKER_USER } }); await flush();
    const taskLink = screen.getByRole('link', { name: 'Snapshot task' }), href = taskLink.getAttribute('href');
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    expect(screen.getByText('Snapshot task')).toBe(taskLink); expect(taskLink.getAttribute('href')).toBe(href); expect(taskLink).not.toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime overview' })); expect(taskLink).toBeVisible();
  });
  it('disables paused reads without losing raw input and removes private draft on account change', async () => {
    const first = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: vi.fn() }), nextUser = workerId(88), second = createTaskCacheScope({ userId: nextUser, onIdentityMismatch: vi.fn() }); scopes.push(first, second);
    let actor = WORKER_USER;
    vi.stubGlobal('fetch', vi.fn((url: string) => url.startsWith('/api/v1/projects?') ? projectPage([], null, actor) : configurationResponse(configurationResource('1', { ...configurationValue(), maxConcurrent: actor === WORKER_USER ? 2 : 8 }), 200, actor)));
    const ui = (scope: TaskCacheScope, enabled: boolean) => <TaskCacheProvider scope={scope}><WorkerConfigurationPanel workerId={workerId(1)} readEnabled={enabled} online tasks={[]} /></TaskCacheProvider>;
    const view = renderWithLocale(ui(first, true), { locale: 'en' }); await flush(); change('Startup arguments', '[private draft');
    view.rerender(ui(first, false)); expect(input('Startup arguments')).toBeDisabled(); expect(input('Startup arguments')).toHaveValue('[private draft');
    actor = nextUser; view.rerender(ui(second, true)); expect(screen.queryByDisplayValue('[private draft')).toBeNull(); await flush();
    expect(input()).toHaveValue('8'); expect(input('Startup arguments')).toHaveValue('[]');
  });
});
