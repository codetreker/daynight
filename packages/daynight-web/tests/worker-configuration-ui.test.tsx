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
import { configurationError, configurationResource, configurationResponse, configurationValue, controlModeResponse } from './helpers/worker-configuration';
import { wireResponse } from './helpers/wireJson';
import { WORKER_TIME, WORKER_USER, workerDetail, workerError, workerId, workerResponse } from './helpers/workers';

const flush = () => act(async () => { for (let n = 0; n < 60; n++) { await Promise.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); } });
const advance = async () => { await act(async () => { vi.advanceTimersByTime(5_000); for (let n = 0; n < 60; n++) await Promise.resolve(); }); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const project = (value: number): Project => ({ id: workerId(value), name: `Project ${value}`, repoUrl: `https://example.test/project-${value}.git`, settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: workerId(999), version: 1n }, createdAt: WORKER_TIME, updatedAt: WORKER_TIME });
const projectPage = (items: readonly Project[] = [], nextCursor: string | null = null, userId = WORKER_USER) => wireResponse({ items, nextCursor }, { headers: { 'Daynight-User-ID': userId } });
const item = (key: WorkerConfigurationKey, appliedValue: WorkerConfigurationOutcome['appliedValue'], targetRevision = '1'): WorkerConfigurationOutcome => ({ key, appliedValue, targetRevision, state: 'applied', error: null, lastFailure: null, nextAttemptAt: null });
const globals = (value: WorkerConfigurationValue, revision = '1') => [item({ kind: 'maxConcurrent' }, value.maxConcurrent, revision), item({ kind: 'pollIntervalMs' }, value.pollIntervalMs, revision), item({ kind: 'recoveryLimit' }, value.recoveryLimit, revision), item({ kind: 'preferPlatformSpecificTasks' }, value.preferPlatformSpecificTasks, revision), item({ kind: 'native' }, value.native, revision)];
const observed = (revision: string, value: WorkerConfigurationValue, items: readonly WorkerConfigurationOutcome[], observationRevision = '1'): WorkerConfigurationResource => ({ ...configurationResource(revision, value), observationRevision, observation: { baseRevision: String(BigInt(observationRevision) - 1n), desiredRevision: revision, items, reportedAt: WORKER_TIME } });
const install = (handler: (url: string, init: RequestInit) => Response | Promise<Response>, projects: readonly Project[] = []) => {
  const fetch = vi.fn((url: string, init: RequestInit = {}) => url.startsWith('/api/v1/projects?') ? projectPage(projects) : url === `/api/v1/me/workers/${workerId(1)}/prompt` ? workerResponse({ scope: 'worker', scopeId: workerId(1), revision: '0', text: '', updatedAt: null }) : handler(url, init));
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
  it('saves the platform preference independently and reports actual false until the Worker applies it', async () => {
    const value = configurationValue();
    let resource = observed('1', value, globals(value));
    const writes: unknown[] = [];
    install((_url, init) => {
      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { revision: string; value: WorkerConfigurationValue };
        writes.push(body);
        resource = { ...resource, desired: { revision: '2', updatedAt: WORKER_TIME, value: body.value } };
      }
      return configurationResponse(resource);
    });
    mount(); await flush();
    const preference = screen.getByRole('checkbox', { name: 'Prefer platform-specific tasks' });
    const feedback = document.getElementById('feedback-preferPlatformSpecificTasks')!;
    expect(preference).not.toBeChecked(); expect(feedback).toHaveTextContent('Actual: Off');
    fireEvent.click(preference);
    expect(preference).toBeChecked(); expect(feedback).toHaveTextContent('Unsaved');
    save(); await flush();
    expect(writes).toEqual([{ revision: '1', value: { ...value, preferPlatformSpecificTasks: true } }]);
    expect(feedback).toHaveTextContent('Awaiting application'); expect(feedback).toHaveTextContent('Actual: Off');
    const applied = resource.desired!.value;
    resource = observed('2', applied, globals(applied, '2'), '2'); await advance();
    expect(feedback).toHaveTextContent('Applied'); expect(feedback).toHaveTextContent('Actual: On');
    expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
  });
  it('discards the platform preference draft without saving it', async () => {
    const fetch = install(() => configurationResponse(configurationResource()));
    mount(); await flush();
    const preference = screen.getByRole('checkbox', { name: 'Prefer platform-specific tasks' });
    fireEvent.click(preference); expect(preference).toBeChecked();
    fireEvent.click(within(document.querySelector('.configuration-form') as HTMLElement).getByRole('button', { name: 'Discard changes' }));
    expect(preference).not.toBeChecked(); expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });
  it('keeps healthy choices editable and reports a failed refresh after withdrawal', () => {
    const apply = vi.fn(), target = workerId(3), healthy = project(4);
    renderWithLocale(<ConfigurationProjectsDialog projects={[healthy]} selected={[target]} loading={false} error={new Error('offline')} refresh={vi.fn()} onClose={vi.fn()} onApply={apply} />, { locale: 'en' });
    expect(screen.getByRole('alert')).toHaveTextContent('Available projects could not be loaded.');
    expect(screen.queryByText('Project 3')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Project 4/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' })); expect(apply).toHaveBeenCalledWith([target, healthy.id]);
  });
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
  it('uses saved field values for feedback without rewriting formatted input or inventing application', async () => {
    const value = { ...configurationValue(), projects: [{ projectId: workerId(3), nativeOverrides: { args: ['--project'] } }] };
    let resource = observed('1', value, [...globals(value), item({ kind: 'projectPreparation', projectId: workerId(3) }, true), item({ kind: 'projectNative', projectId: workerId(3) }, { ...value.native, args: ['--project'] })]);
    install((_url, init) => {
      if (init.method === 'PUT') resource = { ...resource, desired: { revision: '2', updatedAt: WORKER_TIME, value: (JSON.parse(String(init.body)) as { value: WorkerConfigurationValue }).value } };
      return configurationResponse(resource);
    }, [project(3)]);
    mount(); await flush();
    const row = screen.getByRole('heading', { name: 'Project 3' }).closest('article')!;
    fireEvent.click(within(row).getByText(/Agent settings/));
    change('Concurrent task limit', '004');
    change('Startup arguments', '[\n  "--foo"\n]');
    change('Project 3 · Custom arguments', '[ "--new" ]');
    const args = input('Startup arguments'); args.focus(); args.setSelectionRange(2, 6);
    save(); await flush();
    const nativeFeedback = document.querySelector<HTMLElement>('.native-summary .application-feedback')!;
    const projectFeedback = within(row).getByText('Project Agent').closest<HTMLElement>('.application-feedback')!;
    expect(within(document.getElementById('feedback-maxConcurrent')!).getByText('Awaiting application')).toBeInTheDocument();
    expect(within(nativeFeedback).getByText('Awaiting application')).toBeInTheDocument();
    expect(within(projectFeedback).getByText('Awaiting application')).toBeInTheDocument();
    expect(args).toHaveValue('[\n  "--foo"\n]'); expect(args).toHaveFocus(); expect(args.selectionStart).toBe(2); expect(args.selectionEnd).toBe(6);
    expect(input()).toHaveValue('004'); expect(input('Project 3 · Custom arguments')).toHaveValue('[ "--new" ]');
    expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
    const saved = resource.desired!.value;
    resource = observed('2', saved, [...globals(saved, '2'), item({ kind: 'projectPreparation', projectId: workerId(3) }, true, '2'), item({ kind: 'projectNative', projectId: workerId(3) }, { ...saved.native, args: ['--new'] }, '2')], '2');
    await advance();
    expect(within(document.getElementById('feedback-maxConcurrent')!).getByText('Applied')).toBeInTheDocument();
    expect(within(nativeFeedback).getByText('Applied')).toBeInTheDocument(); expect(within(projectFeedback).getByText('Applied')).toBeInTheDocument();
    change('Concurrent task limit', '-');
    expect(within(document.getElementById('feedback-maxConcurrent')!).getByText('Unsaved')).toBeInTheDocument();
    expect(within(nativeFeedback).getByText('Applied')).toBeInTheDocument(); expect(within(projectFeedback).getByText('Applied')).toBeInTheDocument();
  });
  it('retains edits made while a formatted submission is in flight', async () => {
    const response = deferred<Response>(); let submitted: WorkerConfigurationValue | null = null;
    install((_url, init) => {
      if (init.method === 'PUT') { submitted = (JSON.parse(String(init.body)) as { value: WorkerConfigurationValue }).value; return response.promise; }
      return configurationResponse(configurationResource());
    });
    mount(); await flush(); change('Startup arguments', '[ "--foo" ]'); save(); await flush();
    change('Startup arguments', '[ "--bar" ]'); const args = input('Startup arguments'); args.focus(); args.setSelectionRange(3, 5);
    response.resolve(configurationResponse(configurationResource('2', submitted!))); await flush();
    expect(args).toHaveValue('[ "--bar" ]'); expect(args).toHaveFocus(); expect(args.selectionStart).toBe(3); expect(args.selectionEnd).toBe(5);
    expect(within(document.querySelector<HTMLElement>('.native-summary')!).getByText('Unsaved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save configuration' })).toBeEnabled();
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
    const view = mount({ tasks: [task] }); await flush(); fireEvent.click(screen.getByRole('button', { name: 'Remove project Project 3' }));
    const opener = screen.getByRole('button', { name: 'Save configuration' }); opener.focus(); fireEvent.click(opener);
    let dialog = screen.getByRole('dialog', { name: 'Save configuration and stop execution?' });
    expect(within(dialog).getByRole('link', { name: 'Snapshot task' }).getAttribute('href')).toContain(`/projects/${task.projectId}/tasks/${task.taskId}`);
    expect(within(dialog).getByText(/Task status, claims, worktrees and history remain for manual handling/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox', { name: '语言 / Language' })).toBeNull();
    const requests = fetch.mock.calls.length;
    view.setLocale('zh-CN');
    expect(screen.getByRole('dialog', { name: '保存配置并停止执行？' })).toBe(dialog);
    expect(within(dialog).getByRole('link', { name: 'Snapshot task' }).getAttribute('href')).toContain(`/projects/${task.projectId}/tasks/${task.taskId}`);
    expect(fetch).toHaveBeenCalledTimes(requests);
    view.setLocale('en');
    fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull(); expect(opener).toHaveFocus(); expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
    fireEvent.click(opener); dialog = screen.getByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: 'Save configuration' })); await flush();
    expect(resource.desired!.value.projects).toEqual([]); expect(task.status).toBe('in_progress'); expect(task.claimId).toBe(workerDetail().worker.tasks[0]!.claimId);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1); expect(fetch.mock.calls.some(([url]) => url.includes('/tasks/'))).toBe(false);
  });
  it('does not reopen an old Project dialog after a Worker becomes unavailable and recovers', async () => {
    let missing = false;
    install(() => missing ? configurationError(404, 'not_found') : configurationResponse(configurationResource()), [project(3)]);
    mount(); await flush(); fireEvent.click(screen.getAllByRole('button', { name: /Choose projects/ })[0]!); await flush();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    missing = true; await advance(); expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.getByText('Worker configuration is unavailable')).toBeInTheDocument();
    missing = false; fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await flush();
    expect(screen.queryByRole('dialog')).toBeNull(); expect(input()).toHaveValue('2');
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
  it.each([['macos', 'macOS'], ['windows', 'Windows'], ['linux', 'Linux']] as const)('labels the %s Worker using its reported platform in both languages', async (platform, name) => {
    const detail = workerDetail(); detail.worker.platform = platform; detail.worker.telemetry.platform = platform;
    vi.stubGlobal('navigator', { ...navigator, platform: 'a different browser platform' });
    install(url => url.endsWith('/configuration') ? configurationResponse(configurationResource()) : workerResponse(detail));
    const view = renderWithLocale(<WorkerDetailPage workerId={workerId(1)} readEnabled />, { locale: 'en', taskCache: { viewerId: WORKER_USER } }); await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    expect(screen.getByRole('checkbox', { name: `Prefer ${name} tasks` })).toBeInTheDocument();
    view.setLocale('zh-CN');
    expect(screen.getByRole('checkbox', { name: `优先领取 ${name} 的任务` })).toBeInTheDocument();
  });
  it('updates the label when switching Workers and does not retain the old platform while loading', async () => {
    const second = deferred<Response>();
    const first = workerDetail(1); first.worker.platform = 'macos'; first.worker.telemetry.platform = 'macos';
    const next = workerDetail(2); next.worker.platform = 'windows'; next.worker.telemetry.platform = 'windows';
    install(url => url.endsWith('/configuration') ? configurationResponse(configurationResource()) : url.endsWith(workerId(2)) ? second.promise : workerResponse(first));
    const view = renderWithLocale(<WorkerDetailPage workerId={workerId(1)} readEnabled />, { locale: 'en', taskCache: { viewerId: WORKER_USER } }); await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    expect(screen.getByRole('checkbox', { name: 'Prefer macOS tasks' })).toBeInTheDocument();
    view.rerender(<WorkerDetailPage workerId={workerId(2)} readEnabled />);
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    expect(screen.getByRole('checkbox', { name: 'Prefer platform-specific tasks' })).toBeInTheDocument();
    second.resolve(workerResponse(next)); await flush();
    expect(screen.getByRole('checkbox', { name: 'Prefer Windows tasks' })).toBeInTheDocument();
  });
  it('keeps configuration available after telemetry404 and preserves its mounted draft across keyboard tabs', async () => {
    install(url => url.endsWith('/configuration') ? configurationResponse(configurationResource()) : workerError(404));
    renderWithLocale(<WorkerDetailPage workerId={workerId(1)} readEnabled />, { locale: 'en', taskCache: { viewerId: WORKER_USER } }); await flush();
    expect(screen.getByText('Worker unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    expect(screen.getByRole('checkbox', { name: 'Prefer platform-specific tasks' })).toBeInTheDocument();
    const args = input('Startup arguments'); change('Startup arguments', '[unfinished');
    const overview = screen.getByRole('tab', { name: 'Runtime monitoring' }); fireEvent.click(overview); expect(args).not.toBeVisible();
    fireEvent.keyDown(overview, { key: 'ArrowRight' }); await flush();
    expect(screen.getByRole('tab', { name: 'Configuration' })).toHaveFocus(); expect(input('Startup arguments')).toBe(args); expect(args).toHaveValue('[unfinished'); expect(args).toBeVisible();
  });
  it('keeps an open selection and its focus across background reads, and closes it on a real tab change', async () => {
    const projectsRead = deferred<Response>(), configRead = deferred<Response>();
    let projectReads = 0, configReads = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.startsWith('/api/v1/projects?')) return ++projectReads > 2 ? projectsRead.promise : projectPage([project(3), project(4)]);
      if (url.endsWith('/configuration')) return ++configReads > 1 ? configRead.promise : configurationResponse(configurationResource());
      return workerError(404);
    }));
    const view = renderWithLocale(<WorkerDetailPage workerId={workerId(1)} readEnabled />, { locale: 'en', taskCache: { viewerId: WORKER_USER } }); await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    change('Startup arguments', '[invalid'); const args = input('Startup arguments');
    fireEvent.click(screen.getAllByRole('button', { name: /Choose projects/ })[0]!); await flush();
    const dialog = screen.getByRole('dialog', { name: 'Choose projects' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Project 4/ }));
    const search = within(dialog).getByRole('searchbox') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'Project 4' } }); search.focus(); search.setSelectionRange(2, 6);
    view.rerender(<WorkerDetailPage workerId={workerId(1)} readEnabled={false} />);
    expect(screen.getByRole('dialog')).toBe(dialog); expect(search).toHaveFocus(); expect(search.selectionStart).toBe(2); expect(search.selectionEnd).toBe(6);
    expect(within(dialog).getByRole('checkbox', { name: /Project 4/ })).toBeChecked(); expect(args).toHaveValue('[invalid');
    view.rerender(<WorkerDetailPage workerId={workerId(1)} readEnabled />); await flush();
    expect(screen.getByRole('dialog')).toBe(dialog); expect(search).toHaveFocus(); expect(within(dialog).queryByRole('status')).toBeNull();
    projectsRead.resolve(projectPage([project(3), project(4)])); configRead.resolve(configurationResponse(configurationResource())); await flush();
    expect(search).toHaveValue('Project 4'); expect(within(dialog).getByRole('checkbox', { name: /Project 4/ })).toBeChecked();
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime monitoring' })); expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); expect(input('Startup arguments')).toBe(args); expect(args).toHaveValue('[invalid');
  });
  it('preserves existing Task links while displaying a separate configuration panel', async () => {
    const detail = workerDetail(); install(url => url.endsWith('/configuration') ? configurationResponse(configurationResource()) : workerResponse(detail));
    renderWithLocale(<WorkerDetailPage workerId={workerId(1)} readEnabled />, { locale: 'en', taskCache: { viewerId: WORKER_USER } }); await flush();
    const taskLink = screen.getByRole('link', { name: 'Snapshot task' }), href = taskLink.getAttribute('href');
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    expect(screen.getByText('Snapshot task')).toBe(taskLink); expect(taskLink.getAttribute('href')).toBe(href); expect(taskLink).not.toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime monitoring' })); expect(taskLink).toBeVisible();
  });
  it('keeps local editing while reads are paused and removes private draft on account change', async () => {
    const first = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: vi.fn() }), nextUser = workerId(88), second = createTaskCacheScope({ userId: nextUser, onIdentityMismatch: vi.fn() }); scopes.push(first, second);
    let actor = WORKER_USER;
    vi.stubGlobal('fetch', vi.fn((url: string) => url.startsWith('/api/v1/projects?') ? projectPage([], null, actor) : configurationResponse(configurationResource('1', { ...configurationValue(), maxConcurrent: actor === WORKER_USER ? 2 : 8 }), 200, actor)));
    const ui = (scope: TaskCacheScope, enabled: boolean) => <TaskCacheProvider scope={scope}><WorkerConfigurationPanel workerId={workerId(1)} readEnabled={enabled} online tasks={[]} /></TaskCacheProvider>;
    const view = renderWithLocale(ui(first, true), { locale: 'en' }); await flush(); change('Startup arguments', '[private draft');
    view.rerender(ui(first, false)); expect(input('Startup arguments')).toBeEnabled(); expect(input('Startup arguments')).toHaveValue('[private draft');
    change('Startup arguments', '[still private'); expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
    actor = nextUser; view.rerender(ui(second, true)); expect(screen.queryByDisplayValue('[still private')).toBeNull(); await flush();
    expect(input()).toHaveValue('8'); expect(input('Startup arguments')).toHaveValue('[]');
  });
});


describe('Worker control mode form', () => {
  it('saves a mode change, retains the actual old mode and includes mode in overall application', async () => {
    const value = { ...configurationValue(), agentControlMode: 'herdr' as const };
    let resource = observed('1', value, [...globals(value), item({ kind: 'agentControlMode' }, 'herdr')]);
    const writes: unknown[] = [];
    install((_url, init) => {
      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { revision: string; value: WorkerConfigurationValue };
        writes.push(body);
        resource = { ...resource, desired: { revision: '2', updatedAt: WORKER_TIME, value: body.value } };
      }
      return controlModeResponse(resource);
    });
    mount(); await flush();
    const mode = screen.getByRole('combobox', { name: 'Control mode' });
    expect(within(mode).getAllByRole('option').map(option => option.textContent)).toEqual(['herdr', 'web']);
    const feedback = document.getElementById('feedback-agentControlMode')!;
    expect(mode).toHaveValue('herdr'); expect(feedback).toHaveTextContent('Actual: herdr');
    fireEvent.change(mode, { target: { value: 'web' } }); expect(feedback).toHaveTextContent('Unsaved');
    save(); await flush();
    expect(writes).toEqual([{ revision: '1', value: { ...value, agentControlMode: 'web' } }]);
    expect(feedback).toHaveTextContent('Awaiting application'); expect(feedback).toHaveTextContent('Actual: herdr');
    const target = resource.desired!.value;
    resource = observed('2', target, globals(target, '2'), '2'); await advance();
    expect(document.querySelector('.configuration-summary')).toHaveTextContent('Awaiting application');
    expect(feedback).toHaveTextContent('Actual: Not confirmed');
    const error = { code: 'invalid_configuration' as const, category: 'agent' as const, phase: 'validate' as const, occurredAt: WORKER_TIME };
    resource = observed('2', target, [...globals(target, '2'), { ...item({ kind: 'agentControlMode' }, 'herdr', '2'), state: 'error', error }], '3'); await advance();
    expect(feedback).toHaveTextContent('Failed'); expect(feedback).toHaveTextContent('Actual: herdr'); expect(feedback).toHaveTextContent('Validation · Invalid configuration');
    expect(document.querySelector('.configuration-summary')).toHaveTextContent('Partially applied');
    resource = observed('2', target, [...globals(target, '2'), item({ kind: 'agentControlMode' }, 'web', '2')], '4'); await advance();
    expect(feedback).toHaveTextContent('Applied'); expect(feedback).toHaveTextContent('Actual: web');
    expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
  });
  it('leaves unadopted mode unselected and protects an explicit choice from late adoption', async () => {
    let resource = configurationResource('1', { ...configurationValue(), agentControlMode: null });
    const fetch = install(() => controlModeResponse(resource));
    mount(); await flush();
    const mode = screen.getByRole('combobox', { name: 'Control mode' }) as HTMLSelectElement;
    expect(mode.selectedIndex).toBe(-1); expect(mode.options).toHaveLength(2);
    expect(document.getElementById('feedback-agentControlMode')).toHaveTextContent('Actual: Not confirmed');
    fireEvent.change(mode, { target: { value: 'herdr' } }); mode.focus();
    resource = configurationResource('2', { ...configurationValue(), agentControlMode: 'web' }); await advance();
    expect(screen.getByRole('combobox', { name: 'Control mode' })).toBe(mode);
    expect(mode).toHaveValue('herdr'); expect(mode).toHaveFocus();
    expect(screen.getByText('The cloud configuration changed in another page.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Load latest configuration' }));
    expect(mode).toHaveValue('web');
    fireEvent.change(mode, { target: { value: 'herdr' } });
    fireEvent.click(within(document.querySelector('.configuration-form') as HTMLElement).getByRole('button', { name: 'Discard changes' }));
    expect(mode).toHaveValue('web');
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });
  it('disables only mode on an old service while saving other fields', async () => {
    let resource = configurationResource();
    const writes: Record<string, unknown>[] = [];
    install((_url, init) => {
      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body)); writes.push(body.value);
        resource = configurationResource('2', body.value);
      }
      return configurationResponse(resource);
    });
    mount(); await flush();
    expect(screen.getByRole('combobox', { name: 'Control mode' })).toBeDisabled();
    expect(screen.getByText('Upgrade the service to configure control mode.')).toBeInTheDocument();
    change('Automatic recovery limit', '8'); save(); await flush();
    expect(writes).toHaveLength(1); expect(writes[0]).not.toHaveProperty('agentControlMode');
    expect(writes[0]!.recoveryLimit).toBe(8); expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
  });
});

describe('control mode capability downgrade', () => {
  it.each(['saved', 'unknown'] as const)('keeps unsent mode edits while other settings are %s through the legacy contract', async result => {
    let supported = true;
    let resource = configurationResource('1', { ...configurationValue(), agentControlMode: 'herdr' as const });
    const writes: WorkerConfigurationValue[] = [];
    install((_url, init) => {
      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { value: WorkerConfigurationValue };
        writes.push(body.value);
        resource = configurationResource(String(BigInt(resource.desired!.revision) + 1n), { ...resource.desired!.value, ...body.value });
        if (result === 'unknown' && !supported) return Promise.reject(new TypeError('response lost'));
      }
      if (supported) return controlModeResponse(resource);
      const { agentControlMode: _mode, ...legacy } = resource.desired!.value;
      return configurationResponse(configurationResource(resource.desired!.revision, legacy));
    });
    mount(); await flush();
    const mode = screen.getByRole('combobox', { name: 'Control mode' });
    fireEvent.change(mode, { target: { value: 'web' } }); supported = false; await advance();
    expect(mode).toBeDisabled(); expect(mode).toHaveValue('web');
    const saveButton = screen.getByRole('button', { name: 'Save configuration' });
    expect(saveButton).toBeDisabled();
    change('Automatic recovery limit', '8'); expect(saveButton).toBeEnabled(); save(); await flush();
    expect(writes).toHaveLength(1); expect(writes[0]).not.toHaveProperty('agentControlMode'); expect(writes[0]!.recoveryLimit).toBe(8);
    expect(mode).toHaveValue('web'); expect(document.querySelector('.draft-summary')).toHaveTextContent('Unsaved changes');
    expect(saveButton).toBeDisabled();
    supported = true; await advance(); expect(mode).toBeEnabled(); expect(mode).toHaveValue('web'); expect(saveButton).toBeEnabled();
    save(); await flush(); expect(writes).toHaveLength(2); expect(writes[1]!.agentControlMode).toBe('web');
    expect(saveButton).toBeDisabled(); expect(document.querySelector('.draft-summary')).toHaveTextContent('No changes');
  });
});
