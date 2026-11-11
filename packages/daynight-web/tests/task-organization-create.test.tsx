import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTask } from '../src/api/client';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { TaskOrganization } from '../src/features/task-detail/TaskOrganization';
import { renderWithLocale } from './helpers/renderWithLocale';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), createTask: vi.fn() }));
vi.mock('../src/api/auth', () => ({ listProjectPeople: vi.fn().mockResolvedValue({ items: [], unresolvedUserIds: [] }) }));
vi.mock('../src/features/task-cache/TaskCacheProvider', () => {
  const scope = { userId: 'viewer', signal: new AbortController().signal, isInvalidated: false, principalMismatch: vi.fn(), ready: async () => {} };
  return { useTaskCacheScope: () => scope };
});
vi.mock('../src/features/projects/ProjectAccess', () => ({ ProjectAccessBoundary: ({ children }: { children: React.ReactNode }) => children, useProjectAccess: () => ({ ready: true, session: { waitForFreshAccess: async () => ({}) } }) }));
const snapshot = { summaries: new Map(), index: { nodes: new Map() } } as unknown as GraphSnapshot;
afterEach(() => { cleanup(); document.getElementById('root')?.remove(); vi.clearAllMocks(); });

describe('Task creation', () => {
  it('freezes the submitted draft while a delayed creation is pending', async () => {
    let resolve!: (value: never) => void;
    vi.mocked(createTask).mockReturnValue(new Promise(done => { resolve = done; }));
    const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
    renderWithLocale(<TaskOrganization projectId="project" snapshot={snapshot} onRefreshGraph={vi.fn()} />, { locale: 'en', container: root });
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Submitted title' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'Submitted description' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createTask).toHaveBeenCalledOnce());
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Description' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Goal' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Assignee' })).toBeDisabled();
    await act(async () => resolve({} as never));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
