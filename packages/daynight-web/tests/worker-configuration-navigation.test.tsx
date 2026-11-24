import { act, fireEvent, screen, within } from '@testing-library/react';
import { StrictMode, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserNavigation } from '../src/app/navigation';
import { navigate } from '../src/app/router';
import { assertResponsePrincipal, pauseAuthRequests } from '../src/api/client';
import * as promptApi from '../src/api/worker-prompts';
import { WorkerDetailPage } from '../src/features/workers/WorkerDetailPage';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { renderWithLocale } from './helpers/renderWithLocale';
import { configurationError, configurationResource, configurationResponse, configurationValue } from './helpers/worker-configuration';
import { WORKER_USER, workerDetail, workerId, workerResponse } from './helpers/workers';
import { wireResponse } from './helpers/wireJson';

const target = workerId(1), path = `/workers/${target}`;
const scopes: TaskCacheScope[] = [];
const flush = () => act(async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); });
const advance = () => act(async () => { vi.advanceTimersByTime(5_000); for (let i = 0; i < 60; i++) await Promise.resolve(); });
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
afterEach(() => { for (const scope of scopes.splice(0)) scope.dispose(); vi.useRealTimers(); });
const Workspace = ({ enabled }: { readonly enabled: boolean }) => {
  const owner = browserNavigation(), location = useSyncExternalStore(owner.subscribe, owner.snapshot);
  return <><a href="/projects" onClick={event => { event.preventDefault(); navigate('/projects'); }}>Projects</a>
    {location.pathname === path ? <WorkerDetailPage userId={WORKER_USER} workerId={target} readEnabled={enabled} /> : <button onClick={() => navigate(path)}>Open Worker</button>}</>;
};
const mount = async (strict = false, withProject = false) => {
  const projects = withProject ? [{ id: workerId(3), name: 'Project 3', repoUrl: 'https://example.test/project.git', settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: workerId(90), version: 1n }, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }] : [];
  let resource = configurationResource('1', { ...configurationValue(), projects: withProject ? [{ projectId: workerId(3), nativeOverrides: { args: ['--original'] } }] : [] }), missing = false, readFailure = false, write: Promise<Response> | null = null;
  const writes: unknown[] = [];
  const fetch = vi.fn((url: string, init: RequestInit = {}) => {
    if (url.startsWith('/api/v1/projects?')) return Promise.resolve(wireResponse({ items: projects, nextCursor: null }, { headers: { 'Daynight-User-ID': WORKER_USER } }));
    if (url === `/api/v1/me/workers/${target}/prompt`) return Promise.resolve(missing ? configurationError(404, 'not_found') : workerResponse({ scope: 'worker', scopeId: target, revision: '0', text: '', updatedAt: null }));
    if (!url.endsWith('/configuration')) return Promise.resolve(workerResponse(workerDetail()));
    if (init.method === 'PUT') {
      writes.push(JSON.parse(String(init.body)));
      if (write !== null) return write;
      resource = configurationResource('2', JSON.parse(String(init.body)).value);
    }
    if (readFailure) return Promise.reject(new Error('read connection lost'));
    return Promise.resolve(missing ? configurationError(404, 'not_found') : configurationResponse(resource));
  });
  vi.stubGlobal('fetch', fetch);
  const scope = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: () => { void scope.invalidateScope(); } }); scopes.push(scope);
  browserNavigation().navigate(path);
  const view = (enabled = true) => { const content = <TaskCacheProvider scope={scope}><Workspace enabled={enabled} /></TaskCacheProvider>; return strict ? <StrictMode>{content}</StrictMode> : content; };
  const rendered = renderWithLocale(view(), { locale: 'en' });
  fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
  return { ...rendered, scope, writes, fetch, unavailable: () => { missing = true; }, available: () => { missing = false; }, failReads: () => { readFailure = true; }, blockWrite: (response: Promise<Response>) => { write = response; }, pause: () => rendered.rerender(view(false)), resume: () => rendered.rerender(view()) };
};
const edit = (value = '3') => {
  const input = screen.getByRole('textbox', { name: 'Concurrent task limit' }); input.focus(); fireEvent.change(input, { target: { value } }); return input;
};
const leave = () => { const link = screen.getByRole('link', { name: 'Projects' }); link.focus(); fireEvent.click(link); };
const unload = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };

describe('Worker configuration navigation', () => {
  it('keeps the prompt textarea mounted while the independent configuration finishes loading', async () => {
    const config = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.startsWith('/api/v1/projects?')) return Promise.resolve(wireResponse({ items: [], nextCursor: null }, { headers: { 'Daynight-User-ID': WORKER_USER } }));
      if (url === `/api/v1/me/workers/${target}/prompt`) return Promise.resolve(workerResponse({ scope: 'worker', scopeId: target, revision: '0', text: '', updatedAt: null }));
      if (url.endsWith('/configuration')) return config.promise;
      return Promise.resolve(workerResponse(workerDetail()));
    }));
    const scope = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: () => { void scope.invalidateScope(); } }); scopes.push(scope);
    browserNavigation().navigate(path);
    renderWithLocale(<TaskCacheProvider scope={scope}><Workspace enabled /></TaskCacheProvider>, { locale: 'en' });
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' })); await flush();
    const prompt = screen.getByRole('textbox', { name: 'Prompt text' }) as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: 'preserved prompt' } }); prompt.focus(); prompt.setSelectionRange(2, 7);
    await act(async () => { config.resolve(configurationResponse(configurationResource())); }); await flush();
    expect(screen.getByRole('textbox', { name: 'Prompt text' })).toBe(prompt);
    expect(prompt).toHaveValue('preserved prompt'); expect(prompt).toHaveFocus();
    expect(prompt.selectionStart).toBe(2); expect(prompt.selectionEnd).toBe(7);
  });

  it('guards a prompt changed back to its original text while saving and after unknown reconciliation', async () => {
    const put = Promise.withResolvers<Response>(); let promptReads = 0;
    const savedPrompt = (revision: string, text: string) => workerResponse({ scope: 'worker', scopeId: target, revision, text, updatedAt: '2026-11-09T10:00:00Z' });
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
      if (url.startsWith('/api/v1/projects?')) return Promise.resolve(wireResponse({ items: [], nextCursor: null }, { headers: { 'Daynight-User-ID': WORKER_USER } }));
      if (url === `/api/v1/me/workers/${target}/prompt`) {
        if (init.method === 'PUT') return put.promise;
        return Promise.resolve(++promptReads === 1 ? savedPrompt('1', 'old') : savedPrompt('2', 'other'));
      }
      if (url.endsWith('/configuration')) return Promise.resolve(configurationResponse(configurationResource()));
      return Promise.resolve(workerResponse(workerDetail()));
    }));
    const scope = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: () => { void scope.invalidateScope(); } }); scopes.push(scope);
    browserNavigation().navigate(path);
    renderWithLocale(<TaskCacheProvider scope={scope}><Workspace enabled /></TaskCacheProvider>, { locale: 'en' });
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' })); await flush();
    const prompt = screen.getByRole('textbox', { name: 'Prompt text' });
    fireEvent.change(prompt, { target: { value: 'submitted' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); await flush();
    fireEvent.change(prompt, { target: { value: 'old' } });
    leave(); expect(screen.getByRole('alertdialog')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await act(async () => { put.reject(new Error('response lost')); }); await flush();
    expect(prompt).toHaveValue('old'); expect(screen.getByText('The saved version has changed. Your draft is retained.')).toBeVisible();
    leave(); expect(screen.getByRole('alertdialog')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(prompt).toHaveValue('old');
  });

  it('uses one confirmation for both Worker forms and restores the prompt editor on cancellation', async () => {
    await mount();
    const configuration = edit();
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' })); await flush();
    const prompt = screen.getByRole('textbox', { name: 'Prompt text' });
    prompt.focus(); fireEvent.change(prompt, { target: { value: 'Worker instructions' } });
    leave();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(prompt).toHaveFocus(); expect(prompt).toHaveValue('Worker instructions');
    expect(configuration).toHaveValue('3');
    leave(); fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(location.pathname).toBe('/projects'); expect(unload()).toBe(false);
  });

  it('tracks actual draft edits instead of prompt preview controls', async () => {
    await mount(false, true);
    await screen.findByRole('heading', { name: 'Project 3' }, { timeout: 5_000 });
    edit();
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' })); await flush();
    const prompt = screen.getByRole('textbox', { name: 'Prompt text' });
    prompt.focus(); fireEvent.change(prompt, { target: { value: 'instructions' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
    fireEvent.click(screen.getByRole('button', { name: /Remove project/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'resume' } });
    leave(); fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('tab', { name: 'Configuration' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: 'Concurrent task limit' })).toHaveFocus();
    expect(prompt).toHaveValue('instructions');
  });

  it('does not count an unchanged project selection as a later edit', async () => {
    await mount(); edit();
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' })); await flush();
    const prompt = screen.getByRole('textbox', { name: 'Prompt text' });
    prompt.focus(); fireEvent.change(prompt, { target: { value: 'instructions' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
    fireEvent.click(screen.getAllByRole('button', { name: /Choose projects/ })[0]!); await flush();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Done' }));
    leave(); fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('tab', { name: 'Prompts' })).toHaveAttribute('aria-selected', 'true');
    expect(prompt).toHaveFocus();
  });

  it('keeps tab relationships and keyboard focus local to the visible Worker', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(workerResponse(workerDetail()))));
    const scope = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
    const other = workerId(2); browserNavigation().navigate(`/workers/${other}`);
    const { container } = renderWithLocale(<TaskCacheProvider scope={scope}>
      <div hidden inert><WorkerDetailPage workerId={target} userId={WORKER_USER} active={false} readEnabled={false} /></div>
      <WorkerDetailPage workerId={other} userId={WORKER_USER} readEnabled />
    </TaskCacheProvider>, { locale: 'en' });
    const tabs = container.querySelectorAll<HTMLButtonElement>('[data-worker-tab="prompt"]');
    expect(tabs).toHaveLength(2); expect(tabs[0]!.id).not.toBe(tabs[1]!.id);
    expect(tabs[0]!.getAttribute('aria-controls')).not.toBe(tabs[1]!.getAttribute('aria-controls'));
    for (const tab of tabs) expect(document.getElementById(tab.getAttribute('aria-controls')!)?.getAttribute('aria-labelledby')).toBe(tab.id);
    const overview = screen.getByRole('tab', { name: 'Runtime monitoring' });
    overview.focus(); fireEvent.keyDown(overview, { key: 'ArrowLeft' });
    expect(tabs[1]).toHaveFocus(); expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('returns to the hidden prompt when it is the only dirty editor', async () => {
    await mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' })); await flush();
    const prompt = screen.getByRole('textbox', { name: 'Prompt text' }) as HTMLTextAreaElement;
    prompt.focus(); fireEvent.change(prompt, { target: { value: 'draft 🐱' } }); prompt.setSelectionRange(1, 4);
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    leave(); expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('tab', { name: 'Prompts' })).toHaveAttribute('aria-selected', 'true');
    expect(prompt).toHaveFocus(); expect(prompt).toHaveValue('draft 🐱');
    expect(prompt.selectionStart).toBe(1); expect(prompt.selectionEnd).toBe(4);
  });

  it('retains a confirmed configuration result until its hidden panel can publish it', async () => {
    const put = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
      if (url.startsWith('/api/v1/projects?')) return Promise.resolve(wireResponse({ items: [], nextCursor: null }, { headers: { 'Daynight-User-ID': WORKER_USER } }));
      if (url === `/api/v1/me/workers/${target}/prompt`) return Promise.resolve(workerResponse({ scope: 'worker', scopeId: target, revision: '0', text: '', updatedAt: null }));
      if (url.endsWith('/configuration')) return init.method === 'PUT' ? put.promise : Promise.resolve(configurationResponse(configurationResource()));
      return Promise.resolve(workerResponse(workerDetail()));
    }));
    const scope = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
    const retention = vi.fn(); browserNavigation().navigate(path);
    renderWithLocale(<TaskCacheProvider scope={scope}><WorkerDetailPage workerId={target} userId={WORKER_USER} readEnabled onRetentionChange={retention} /></TaskCacheProvider>, { locale: 'en' });
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush(); edit();
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' })); await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' })); await flush();
    put.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 }))); await flush();
    expect(retention).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    expect(retention).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('textbox', { name: 'Concurrent task limit' })).toHaveValue('3');
  });

  it('retains the page until both independent saves settle', async () => {
    const configPut = Promise.withResolvers<Response>(), promptPut = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
      if (url.startsWith('/api/v1/projects?')) return Promise.resolve(wireResponse({ items: [], nextCursor: null }, { headers: { 'Daynight-User-ID': WORKER_USER } }));
      if (url === `/api/v1/me/workers/${target}/prompt`) return init.method === 'PUT' ? promptPut.promise : Promise.resolve(workerResponse({ scope: 'worker', scopeId: target, revision: '0', text: '', updatedAt: null }));
      if (url.endsWith('/configuration')) return init.method === 'PUT' ? configPut.promise : Promise.resolve(configurationResponse(configurationResource()));
      return Promise.resolve(workerResponse(workerDetail()));
    }));
    const scope = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
    const retention = vi.fn(); browserNavigation().navigate(path);
    renderWithLocale(<TaskCacheProvider scope={scope}><WorkerDetailPage workerId={target} userId={WORKER_USER} readEnabled onRetentionChange={retention} /></TaskCacheProvider>, { locale: 'en' });
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush(); edit();
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' })); await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' })); await flush();
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt text' }), { target: { value: 'instructions' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); await flush();
    expect(retention).toHaveBeenLastCalledWith(true);
    configPut.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 })));
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    expect(retention).toHaveBeenLastCalledWith(true);
    promptPut.resolve(workerResponse({ scope: 'worker', scopeId: target, revision: '1', text: 'instructions', updatedAt: '2026-11-09T10:00:00Z' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' })); await flush();
    expect(retention).toHaveBeenLastCalledWith(false);
  });

  it('reads prompt independently when it is the first editing tab', async () => {
    const result = await mount();
    // Resetting the page ensures configuration has never been opened for this visit.
    result.unmount(); browserNavigation().navigate('/projects'); browserNavigation().navigate(path);
    result.fetch.mockClear();
    renderWithLocale(<TaskCacheProvider scope={result.scope}><Workspace enabled /></TaskCacheProvider>, { locale: 'en' });
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' })); await flush();
    expect(screen.getByRole('textbox', { name: 'Prompt text' })).toBeVisible();
    expect(result.fetch.mock.calls.some(([url]) => url.endsWith('/configuration') || url.startsWith('/api/v1/projects?'))).toBe(false);
  });

  it('protects invalid raw input, defaults to keep editing and restores the editor after cancel or Escape', async () => {
    await mount(); const input = edit('-'); leave();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Leave this Worker configuration and discard unsaved changes?');
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    expect(location.pathname).toBe(path); expect(unload()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(input).toHaveValue('-'); expect(input).toHaveFocus();
    leave(); fireEvent.keyDown(document, { key: 'Escape' });
    expect(input).toHaveValue('-'); expect(input).toHaveFocus(); expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('retains the hidden configuration and returns to its editor when leaving the overview is cancelled', async () => {
    await mount(); const input = edit();
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime monitoring' }));
    expect(screen.queryByRole('alertdialog')).toBeNull(); expect(unload()).toBe(true); expect(input).not.toBeVisible();
    leave(); expect(screen.getByRole('alertdialog')).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('tab', { name: 'Configuration' })).toHaveAttribute('aria-selected', 'true');
    expect(input).toBeVisible(); expect(input).toHaveFocus(); expect(input).toHaveValue('3');
  });

  it('admits equivalent routes for the same Worker but protects departure to a different Worker', async () => {
    await mount(); const input = edit();
    act(() => navigate(`${path}?view=configuration`));
    expect(screen.queryByRole('alertdialog')).toBeNull(); expect(input).toHaveValue('3');
    act(() => navigate(`/workers/${workerId(2)}`));
    expect(screen.getByRole('alertdialog')).toBeVisible(); expect(location.pathname).toBe(path);
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' })); expect(location.pathname).toBe(`/workers/${workerId(2)}`);
  });

  it('discards on confirmed departure and loads the saved configuration on returning', async () => {
    const result = await mount(); edit(); leave();
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(location.pathname).toBe('/projects'); expect(result.writes).toEqual([]); expect(unload()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Open Worker' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    expect(screen.getByRole('textbox', { name: 'Concurrent task limit' })).toHaveValue(String(configurationValue().maxConcurrent));
    expect(screen.getByText('No changes')).toBeVisible();
  });

  it.each(['clean', 'saved', 'discarded'] as const)('does not block a %s configuration', async (kind) => {
    await mount();
    if (kind !== 'clean') {
      edit(); fireEvent.click(within(screen.getByRole('form', { name: 'Configuration' })).getByRole('button', { name: kind === 'saved' ? 'Save configuration' : 'Discard changes' })); await flush();
    }
    expect(unload()).toBe(false); leave(); expect(location.pathname).toBe('/projects'); expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('keeps draft protection through a temporary identity pause', async () => {
    const result = await mount(); const input = edit(); result.pause();
    leave(); expect(screen.getByRole('alertdialog')).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' }); result.resume(); await flush();
    expect(input).toHaveValue('3'); expect(unload()).toBe(true);
  });

  it.each(['identity', 'unavailable'] as const)('clears a pending choice on proven %s loss without following its action', async (kind) => {
    const result = await mount(); edit(); leave(); expect(screen.getByRole('alertdialog')).toBeVisible();
    if (kind === 'identity') act(() => result.scope.principalMismatch());
    else { result.unavailable(); await advance(); }
    expect(screen.queryByRole('alertdialog')).toBeNull(); expect(unload()).toBe(false); expect(location.pathname).toBe(path);
    expect(screen.queryByRole('textbox', { name: 'Concurrent task limit' })).toBeNull();
  });

  it('keeps only one guard after Strict Mode replay and protects the draft after unavailable recovery', async () => {
    const result = await mount(true); edit(); leave();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    result.unavailable(); await advance(); expect(screen.queryByRole('alertdialog')).toBeNull();
    result.available(); await advance(); edit('4'); leave();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('textbox', { name: 'Concurrent task limit' })).toHaveValue('4'); expect(unload()).toBe(true);
  });

  it('closes the project picker before showing a leave choice and restores the configuration editor', async () => {
    await mount(); const input = edit();
    fireEvent.click(screen.getAllByRole('button', { name: 'Choose projects' })[0]!);
    expect(screen.getByRole('dialog')).toBeVisible();
    act(() => navigate('/projects')); expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(input).toHaveValue('3'); expect(input).toHaveFocus();
  });

  it.each(['collapsed', 'removed'] as const)('returns to a visible editor when the last edited project field was %s', async (kind) => {
    await mount(false, true);
    await screen.findByRole('heading', { name: 'Project 3' }, { timeout: 5_000 });
    const summary = screen.getByText(/Agent settings ·/); fireEvent.click(summary);
    const projectArgs = screen.getByRole('textbox', { name: 'Project 3 · Custom arguments' });
    projectArgs.focus(); fireEvent.change(projectArgs, { target: { value: '["--edited"]' } });
    if (kind === 'collapsed') {
      fireEvent.click(summary); expect(projectArgs).not.toBeVisible(); expect(projectArgs.isConnected).toBe(true);
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Remove project Project 3' })); expect(projectArgs.isConnected).toBe(false);
    }
    leave(); fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    const fallback = screen.getByRole('textbox', { name: 'Concurrent task limit' });
    expect(fallback).toBeVisible(); expect(fallback).toHaveFocus(); expect(unload()).toBe(true);
    if (kind === 'collapsed') { fireEvent.click(summary); expect(projectArgs).toHaveValue('["--edited"]'); }
  });

  it('keeps the mounted configuration through indexed history cancellation and admits confirmed history departure', async () => {
    const initial = browserNavigation().snapshot(), initialState = history.state;
    await mount(); const input = edit(), workerState = history.state;
    const arrival = (state: unknown, pathname: string) => act(() => {
      history.replaceState(state, '', pathname); window.dispatchEvent(new PopStateEvent('popstate', { state }));
    });
    const go = vi.spyOn(history, 'go').mockImplementation(() => {});
    arrival(initialState, initial.pathname);
    expect(browserNavigation().snapshot().pathname).toBe(path); expect(input).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' }); expect(go).toHaveBeenCalledWith(2);
    arrival(workerState, path); expect(input).toHaveValue('3'); expect(input).toHaveFocus();
    arrival(initialState, initial.pathname);
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(browserNavigation().snapshot().pathname).toBe(initial.pathname); expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('preserves an unknown save when navigation is cancelled and never submits it again on leaving', async () => {
    const result = await mount(), response = Promise.withResolvers<Response>(); result.blockWrite(response.promise);
    edit(); fireEvent.click(screen.getByRole('button', { name: 'Save configuration' })); await flush();
    result.failReads(); response.reject(new Error('connection lost')); await flush();
    expect(screen.getByText('The save result is not yet confirmed. Your draft has been kept.')).toBeVisible();
    expect(result.writes).toHaveLength(1);
    const configurationState = history.state;
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime monitoring' }));
    act(() => { history.replaceState(configurationState, '', path); window.dispatchEvent(new PopStateEvent('popstate', { state: configurationState })); });
    expect(screen.getByText('The save result is not yet confirmed. Your draft has been kept.')).toBeVisible();
    expect(result.writes).toHaveLength(1);
    leave(); fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('textbox', { name: 'Concurrent task limit' })).toHaveValue('3');
    expect(screen.getByText('The save result is not yet confirmed. Your draft has been kept.')).toBeVisible();
    leave(); fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(result.writes).toHaveLength(1); expect(location.pathname).toBe('/projects');
  });

  it('does not let a leave choice settle or replay a pending save', async () => {
    const result = await mount(), response = Promise.withResolvers<Response>(); result.blockWrite(response.promise);
    const input = edit(); fireEvent.click(screen.getByRole('button', { name: 'Save configuration' })); await flush();
    const configurationState = history.state;
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime monitoring' }));
    act(() => { history.replaceState(configurationState, '', path); window.dispatchEvent(new PopStateEvent('popstate', { state: configurationState })); });
    expect(screen.getByRole('textbox', { name: 'Concurrent task limit' })).toBe(input);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled(); expect(result.writes).toHaveLength(1);
    leave(); fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(input).toHaveValue('3'); expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled(); expect(result.writes).toHaveLength(1);
    leave(); fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(location.pathname).toBe('/projects'); expect(result.writes).toHaveLength(1);
    response.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 }))); await flush();
    expect(location.pathname).toBe('/projects'); expect(result.writes).toHaveLength(1);
  });
});


it('retains a confirmed prompt and later draft while leaving and returning to the Worker', async () => {
  const put = Promise.withResolvers<Response>(); let resume = () => {}; const retain = vi.fn();
  const scope = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: () => { resume = pauseAuthRequests(); } }); scopes.push(scope);
  const save = promptApi.saveWorkerPrompt; const mismatch = workerResponse({}, workerId(99));
  const spy = vi.spyOn(promptApi, 'saveWorkerPrompt').mockImplementation((target, submission, signal, admission) => save(target, submission, signal, {
    ...admission, onReceipt: receipt => { admission.onReceipt?.(receipt); try { assertResponsePrincipal(mismatch, WORKER_USER, scope.principalMismatch); } catch { /* The other principal is rejected. */ } },
  }));
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    if (url.startsWith('/api/v1/projects?')) return Promise.resolve(wireResponse({ items: [], nextCursor: null }, { headers: { 'Daynight-User-ID': WORKER_USER } }));
    if (url === `/api/v1/me/workers/${target}/prompt`) return init.method === 'PUT' ? put.promise : Promise.resolve(workerResponse({ scope: 'worker', scopeId: target, revision: '1', text: 'old', updatedAt: '2026-11-09T10:00:00Z' }));
    if (url.endsWith('/configuration')) return Promise.resolve(configurationResponse(configurationResource()));
    return Promise.resolve(workerResponse(workerDetail()));
  }));
  const view = (active: boolean) => <TaskCacheProvider scope={scope}><WorkerDetailPage userId={WORKER_USER} workerId={target} active={active} readEnabled={active} onRetentionChange={retain} /></TaskCacheProvider>;
  browserNavigation().navigate(path);
  const rendered = renderWithLocale(view(true), { locale: 'en' });
  try {
    await flush(); fireEvent.click(screen.getByRole('tab', { name: 'Prompts' })); await flush();
    const prompt = screen.getByRole('textbox', { name: 'Prompt text' }); fireEvent.change(prompt, { target: { value: 'submitted' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); await flush();
    fireEvent.change(prompt, { target: { value: 'continued' } });
    await act(async () => { put.resolve(workerResponse({ scope: 'worker', scopeId: target, revision: '2', text: 'submitted', updatedAt: '2026-11-09T10:00:00Z' })); }); await flush();
    expect(screen.getByText('Save confirmed. Refresh the page to continue.')).toBeVisible(); expect(retain).toHaveBeenLastCalledWith(true);
    rendered.rerender(view(false)); await flush(); expect(retain).toHaveBeenLastCalledWith(true);
    rendered.rerender(view(true)); await flush();
    expect(screen.getByRole('textbox', { name: 'Prompt text' })).toHaveValue('continued');
    expect(screen.getByText('Save confirmed. Refresh the page to continue.')).toBeVisible(); expect(retain).toHaveBeenLastCalledWith(true);
  } finally { spy.mockRestore(); resume(); }
});
