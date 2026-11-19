import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAuthRequests } from '../src/api/client';
import { ProjectAccessBoundary } from '../src/features/projects/ProjectAccess';
import { publishRepositoryChange } from '../src/features/projects/repository-changes';
import { useProjectSettings } from '../src/features/management/useProjectSettings';
import { createLocaleRender } from './helpers/renderWithLocale';
import { directAccessFixture } from './helpers/taskSync';
import { wireResponse } from './helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000001', userId = '00000000-0000-4000-8000-000000000002';
const version = 9_007_199_254_740_993n;
const project = (minutes = 60, settingsVersion = version) => ({
  id: projectId, name: 'Project', repoUrl: 'https://github.com/o/repository', ownership: directAccessFixture(projectId, userId, 'admin').ownership,
  settings: { executionWarningMinutes: minutes, version: settingsVersion }, createdAt: '2026-11-19T10:00:00Z', updatedAt: '2026-11-19T10:00:00Z',
});
const response = (value: unknown, status = 200) => wireResponse(value, { status, headers: { 'Daynight-User-ID': userId } });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const render = createLocaleRender('en', { taskCache: { viewerId: userId } });
const Probe = ({ onRoute = true }: { onRoute?: boolean }) => {
  const settings = useProjectSettings(projectId, userId, onRoute, true);
  return <>
    <input aria-label="Threshold draft" value={settings.draft} onChange={event => settings.change(event.target.value)} />
    <button onClick={settings.retry}>Retry read</button><button onClick={() => { void settings.save(); }}>Save threshold</button>
    <output>{settings.loading ? 'Reading' : settings.error !== null ? 'Read failed' : 'Read complete'}</output>
    <output>{settings.draftConflict ? 'Draft conflict' : 'No draft conflict'}</output>
  </>;
};
const tree = (onRoute = true) => <ProjectAccessBoundary projectId={projectId} initialRead><Probe onRoute={onRoute} /></ProjectAccessBoundary>;
const triggerRepositoryRead = () => act(() => publishRepositoryChange({ projectId, userId }));
beforeEach(() => { invalidateAuthRequests(); vi.spyOn(document, 'hasFocus').mockReturnValue(true); });

describe('repository refresh of independent execution settings', () => {
  it('retains the draft and its exact original version after a failed read and successful retry', async () => {
    let failed = false;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/access')) return response(directAccessFixture(projectId, userId, 'admin'));
      if (init.method === 'PATCH') return response(project(75, version + 1n));
      if (failed) throw new TypeError('Network unavailable');
      return response(project());
    }); vi.stubGlobal('fetch', fetch);
    render(tree()); await waitFor(() => expect(screen.getByLabelText('Threshold draft')).toHaveValue('60'));
    fireEvent.change(screen.getByLabelText('Threshold draft'), { target: { value: '75' } });
    failed = true; triggerRepositoryRead(); await screen.findByText('Read failed');
    expect(screen.getByLabelText('Threshold draft')).toHaveValue('75');
    failed = false; fireEvent.click(screen.getByRole('button', { name: 'Retry read' })); await screen.findByText('Read complete');
    expect(screen.getByLabelText('Threshold draft')).toHaveValue('75');
    fireEvent.click(screen.getByRole('button', { name: 'Save threshold' }));
    await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1));
    expect(fetch.mock.calls.find(([, init]) => init.method === 'PATCH')![1].body).toBe(`{"version":${version},"executionWarningMinutes":75}`);
  });

  it('retains the draft while detecting a settings version conflict during retry', async () => {
    let state: 'initial' | 'failed' | 'changed' = 'initial';
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/access')) return response(directAccessFixture(projectId, userId, 'admin'));
      if (state === 'failed') throw new TypeError('Network unavailable');
      return response(state === 'changed' ? project(90, version + 1n) : project());
    }); vi.stubGlobal('fetch', fetch);
    render(tree()); await waitFor(() => expect(screen.getByLabelText('Threshold draft')).toHaveValue('60'));
    fireEvent.change(screen.getByLabelText('Threshold draft'), { target: { value: '75' } });
    state = 'failed'; triggerRepositoryRead(); await screen.findByText('Read failed');
    state = 'changed'; fireEvent.click(screen.getByRole('button', { name: 'Retry read' })); await screen.findByText('Draft conflict');
    expect(screen.getByLabelText('Threshold draft')).toHaveValue('75');
    const calls = fetch.mock.calls.length; fireEvent.click(screen.getByRole('button', { name: 'Save threshold' })); await act(async () => { await Promise.resolve(); }); expect(fetch.mock.calls).toHaveLength(calls);
  });

  it('keeps an edit back to the old value bound to its original version while recovery is unresolved', async () => {
    let failed = false, newer = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/access')) return response(directAccessFixture(projectId, userId, 'admin'));
      if (failed) throw new TypeError('Network unavailable');
      return response(newer ? project(90, version + 1n) : project());
    }));
    render(tree()); await waitFor(() => expect(screen.getByLabelText('Threshold draft')).toHaveValue('60'));
    fireEvent.change(screen.getByLabelText('Threshold draft'), { target: { value: '75' } });
    failed = true; triggerRepositoryRead(); await screen.findByText('Read failed');
    fireEvent.change(screen.getByLabelText('Threshold draft'), { target: { value: '60' } });
    failed = false; newer = true; fireEvent.click(screen.getByRole('button', { name: 'Retry read' })); await screen.findByText('Draft conflict');
    expect(screen.getByLabelText('Threshold draft')).toHaveValue('60');
  });

  it('keeps retention across a cancelled read and discards private drafts on a subsequent denial', async () => {
    const pending = deferred<Response>(); let state: 'initial' | 'pending' | 'denied' | 'restored' = 'initial';
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/access')) return response(directAccessFixture(projectId, userId, 'admin'));
      if (state === 'pending') return pending.promise;
      if (state === 'denied') return response({ error: { code: 'forbidden', message: 'Denied', requestId: 'repository-refresh-denied' } }, 403);
      return response(state === 'restored' ? project(90, version + 1n) : project());
    }); vi.stubGlobal('fetch', fetch);
    const view = render(tree()); await waitFor(() => expect(screen.getByLabelText('Threshold draft')).toHaveValue('60'));
    fireEvent.change(screen.getByLabelText('Threshold draft'), { target: { value: '75' } });
    state = 'pending'; triggerRepositoryRead(); await screen.findByText('Reading'); view.rerender(tree(false));
    state = 'initial'; view.rerender(tree(true)); await screen.findByText('Read complete'); expect(screen.getByLabelText('Threshold draft')).toHaveValue('75');
    await act(async () => pending.resolve(response(project(95, version + 2n)))); expect(screen.getByLabelText('Threshold draft')).toHaveValue('75');
    state = 'denied'; triggerRepositoryRead(); await waitFor(() => expect(screen.getByLabelText('Threshold draft')).toHaveValue(''));
    state = 'restored'; fireEvent.click(screen.getByRole('button', { name: 'Retry read' })); await waitFor(() => expect(screen.getByLabelText('Threshold draft')).toHaveValue('90'));
  });
});
