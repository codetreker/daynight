import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { getProjectAccess } from '../src/api/auth';
import { ApiError, getTaskSync } from '../src/api/client';
import { getProject } from '../src/api/project-settings';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import { renderWithLocale } from './helpers/renderWithLocale';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { directAccessFixture, taskSyncFromGraph, taskSyncReadFixture } from './helpers/taskSync';

vi.mock('../src/api/client', async original => ({ ...await original<typeof import('../src/api/client')>(), getTaskSync: vi.fn() }));
vi.mock('../src/api/auth', async original => ({ ...await original<typeof import('../src/api/auth')>(), getProjectAccess: vi.fn() }));
vi.mock('../src/api/project-settings', async original => ({ ...await original<typeof import('../src/api/project-settings')>(), getProject: vi.fn() }));

const projectId = '00000000-0000-4000-8000-000000000031';
const graph = graphFixture([detailFixture(projectId, '00000000-0000-4000-8000-000000000041', { title: 'Retained task' })]);

beforeEach(() => {
  window.history.replaceState(null, '', `/projects/${projectId}`);
  vi.mocked(getProjectAccess).mockReset().mockImplementation(async (_id, _signal, admission) => directAccessFixture(projectId, admission.userId));
  vi.mocked(getProject).mockReset().mockResolvedValue(graph.project);
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (_id, query) => taskSyncReadFixture(taskSyncFromGraph(graph, { query, versionForTask: () => 1n })));
});

it('ends an explicit graph refresh superseded by a newer project read while preserving its snapshot during the next sync', async () => {
  const old = Promise.withResolvers<Awaited<ReturnType<typeof getTaskSync>>>();
  const next = Promise.withResolvers<Awaited<ReturnType<typeof getTaskSync>>>();
  renderWithLocale(<ProjectPage projectId={projectId} />, { locale: 'en', taskCache: true });
  await screen.findByRole('region', { name: 'Project task statistics' });
  const statistics = screen.getByRole('region', { name: 'Project task statistics' });
  expect(statistics).toHaveTextContent('1');
  const refresh = screen.getByRole('button', { name: /^Refresh$/ });
  vi.mocked(getTaskSync).mockReset().mockReturnValueOnce(old.promise).mockReturnValue(next.promise);
  fireEvent.click(refresh);
  await waitFor(() => expect(getTaskSync).toHaveBeenCalledOnce());
  expect(refresh).toBeDisabled();

  vi.mocked(getProject).mockReset().mockResolvedValue({ ...graph.project, name: 'New project read' });
  fireEvent(window, new Event('focus'));
  await screen.findByRole('heading', { name: 'New project read' });
  await act(async () => { old.reject(new ApiError('server', 404, 'not_found')); });
  await waitFor(() => expect(refresh).toBeEnabled());
  expect(screen.getByRole('region', { name: 'Project task statistics' })).toBe(statistics);
  expect(statistics).toHaveTextContent('1');
  expect(screen.queryByRole('alert')).toBeNull();

  await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() => expect(getTaskSync).toHaveBeenCalledTimes(2));
  expect(refresh).toBeEnabled();
  expect(screen.getByRole('region', { name: 'Project task statistics' })).toBe(statistics);
  expect(statistics).toHaveTextContent('1');
});
