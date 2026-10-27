import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listMembers } from '../src/api/auth';
import type { ProjectMember } from '../src/api/auth-types';
import { ProjectMembersProvider, useProjectMembers } from '../src/features/projects/ProjectMembers';
import { renderWithLocale } from './helpers/renderWithLocale';
import { TEST_VIEWER_ID } from './helpers/taskSync';

vi.mock('../src/api/auth', async (original) => ({ ...await original<typeof import('../src/api/auth')>(), listMembers: vi.fn() }));
const projectId = '00000000-0000-4000-8000-000000000100';
const otherProjectId = '00000000-0000-4000-8000-000000000101';
const stamp = '2026-10-27T00:00:00Z';
const member: ProjectMember = { projectId, userId: TEST_VIEWER_ID, name: 'Jianjun', email: null, avatarUrl: null, role: 'admin', version: 1n, createdAt: stamp, updatedAt: stamp };
const Probe = ({ label, project = projectId, enabled = true }: { readonly label: string; readonly project?: string; readonly enabled?: boolean }) => {
  const membership = useProjectMembers(project, enabled);
  return <section aria-label={label}><p>{membership.status}</p>{membership.members.map((item) => <span key={item.userId}>{item.name}</span>)}{membership.error !== null && <span>Member lookup failed</span>}<button onClick={membership.retry}>Retry {label}</button></section>;
};
beforeEach(() => vi.mocked(listMembers).mockReset());
afterEach(() => vi.restoreAllMocks());

describe('shared project-member lookup', () => {
  it('shares one principal-bound membership read between the project and task detail consumers', async () => {
    vi.mocked(listMembers).mockResolvedValue([member]);
    renderWithLocale(<ProjectMembersProvider projectId={projectId}><Probe label="project" /><Probe label="task" /></ProjectMembersProvider>, { locale: 'en', taskCache: true });
    expect(await screen.findAllByText('Jianjun')).toHaveLength(2);
    expect(listMembers).toHaveBeenCalledExactlyOnceWith(projectId, expect.any(AbortSignal), expect.objectContaining({ userId: TEST_VIEWER_ID, onPrincipalMismatch: expect.any(Function) }));
  });

  it('exposes a failed lookup and retries only after an explicit read request', async () => {
    vi.mocked(listMembers).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([member]);
    renderWithLocale(<Probe label="task" />, { locale: 'en', taskCache: true });
    expect(await screen.findByText('Member lookup failed')).toBeVisible();
    expect(listMembers).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry task' }));
    expect(await screen.findByText('Jianjun')).toBeVisible();
    expect(listMembers).toHaveBeenCalledTimes(2);
  });

  it('starts a standalone lookup only when a current claim needs member details', async () => {
    vi.mocked(listMembers).mockResolvedValue([member]);
    const view = renderWithLocale(<Probe label="task" enabled={false} />, { locale: 'en', taskCache: true });
    expect(listMembers).not.toHaveBeenCalled();
    view.rerender(<Probe label="task" />);
    expect(await screen.findByText('Jianjun')).toBeVisible();
    expect(listMembers).toHaveBeenCalledTimes(1);
  });

  it('keeps a different project lookup separate from an inherited membership snapshot', async () => {
    vi.mocked(listMembers).mockImplementation(async (project) => project === projectId ? [member] : [{ ...member, projectId: otherProjectId, name: 'Other project' }]);
    renderWithLocale(<ProjectMembersProvider projectId={projectId}><Probe label="task" project={otherProjectId} /></ProjectMembersProvider>, { locale: 'en', taskCache: true });
    expect(await screen.findByText('Other project')).toBeVisible();
    await waitFor(() => expect(listMembers).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Jianjun')).toBeNull();
  });
});
