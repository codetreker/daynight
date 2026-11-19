import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAuthRequests } from '../src/api/client';
import type { RepositoryPreview } from '../src/api/project-repository';
import { ProjectAccessBoundary } from '../src/features/projects/ProjectAccess';
import { ProjectRepository } from '../src/features/management/project-repository/ProjectRepository';
import { useProjectManagementGuard } from '../src/features/management/ProjectManagementGuard';
import { subscribeRepositoryChanges } from '../src/features/projects/repository-changes';
import { createLocaleRender } from './helpers/renderWithLocale';
import { directAccessFixture } from './helpers/taskSync';
import { wireResponse } from './helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000001', userId = '00000000-0000-4000-8000-000000000002';
const original = 'https://github.com/o/original', target = 'https://github.com/o/new';
const fixture = (classification: RepositoryPreview['classification'] = 'same_repository'): RepositoryPreview => ({ projectId, projectName: 'Alpha', currentRepoUrl: original, repoUrl: target, classification, repositoryVersion: '9007199254740993', ownershipVersion: '1', targetGitHubRepositoryId: null, unverifiedReason: classification === 'unverified' ? 'no_github_access' : null, bindingsInvalidated: classification === 'different_repository' || classification === 'unverified' });
const response = (body: unknown, status = 200) => wireResponse(body, { status, headers: { 'Daynight-User-ID': userId } });
const failure = (status: number, code: string) => response({ error: { code, message: 'Failure', requestId: 'repository-test' } }, status);
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const retention = vi.fn(), summary = vi.fn();
const Editor = ({ active = true }: { active?: boolean }) => {
  const guard = useProjectManagementGuard();
  return <ProjectAccessBoundary projectId={projectId} initialRead><ProjectRepository projectId={projectId} repoUrl={original} active={active} onRoute unavailable={false} guard={guard} onRetentionChange={retention} onStateChange={summary} /></ProjectAccessBoundary>;
};
const render = createLocaleRender('zh-CN', { taskCache: { viewerId: userId } });
const install = (handler: (url: string, init: RequestInit) => Response | Promise<Response>, role: 'admin' | 'member' = 'admin') => {
  const fetch = vi.fn((url: string, init: RequestInit) => url.endsWith('/access') ? Promise.resolve(response(directAccessFixture(projectId, userId, role))) : Promise.resolve(handler(url, init)));
  vi.stubGlobal('fetch', fetch); return fetch;
};
const editAndPreview = async () => {
  const input = screen.getByLabelText('新仓库地址'); await waitFor(() => expect(input).not.toBeDisabled());
  fireEvent.change(input, { target: { value: target } }); fireEvent.click(screen.getByRole('button', { name: '预览更改' }));
  return screen.findByRole('dialog');
};
beforeEach(() => { invalidateAuthRequests(); vi.spyOn(document, 'hasFocus').mockReturnValue(true); retention.mockClear(); summary.mockClear(); });

describe('repository settings editor', () => {
  it('keeps cancelled draft, binds same-repository preview facts, dispatches once and publishes refresh', async () => {
    const pending = deferred<Response>(); const changed = vi.fn(), unsubscribe = subscribeRepositoryChanges(changed);
    const fetch = install((url, init) => init.method === 'PATCH' ? pending.promise : response(fixture()));
    render(<Editor />);
    let dialog = await editAndPreview(); await within(dialog).findByText(/这是同一个仓库/);
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' })); expect(screen.getByLabelText('新仓库地址')).toHaveValue(target);
    fireEvent.click(screen.getByRole('button', { name: '预览更改' })); dialog = await screen.findByRole('dialog');
    const save = await within(dialog).findByRole('button', { name: '保存地址' }); fireEvent.click(save); fireEvent.click(save);
    await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1)); expect(retention).toHaveBeenLastCalledWith(true);
    await act(async () => pending.resolve(response({ projectId, repoUrl: target, repositoryVersion: '9007199254740994', changed: true, bindingsInvalidated: false })));
    await screen.findByText('仓库地址已保存。'); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(changed).toHaveBeenCalledWith({ userId, projectId }); expect(screen.getByRole('button', { name: '预览更改' })).not.toBeDisabled(); unsubscribe();
  });
  it('requires an explicit unknown switch choice and describes both binding effects', async () => {
    const fetch = install((_url, init) => init.method === 'PATCH' ? response({ projectId, repoUrl: target, repositoryVersion: '9007199254740994', changed: true, bindingsInvalidated: true }) : response(fixture('unverified')));
    render(<Editor />); const dialog = await editAndPreview(), save = await within(dialog).findByRole('button', { name: '确认更换仓库' });
    expect(save).toBeDisabled(); expect(within(dialog).getByText(/同步前仍可能有新领取/)).toBeInTheDocument(); expect(within(dialog).getByText(/旧 PR 保留/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '按更换仓库处理' })); fireEvent.click(save);
    await screen.findByText(/仓库地址已保存。项目的 GitHub App/); expect(JSON.parse(fetch.mock.calls.find(([, init]) => init.method === 'PATCH')![1].body as string).treatUnverifiedAsSwitch).toBe(true);
  });
  it('invalidates conflict confirmation and requires another preview before a new save', async () => {
    const fetch = install((_url, init) => init.method === 'PATCH' ? failure(409, 'version_conflict') : response(fixture()));
    render(<Editor />); const dialog = await editAndPreview(); fireEvent.click(await within(dialog).findByRole('button', { name: '保存地址' }));
    await within(dialog).findByRole('button', { name: '重新预览' }); expect(within(dialog).queryByRole('button', { name: '保存地址' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '重新预览' })); await within(dialog).findByRole('button', { name: '保存地址' }); expect(fetch.mock.calls.filter(([url]) => url.endsWith('/preview'))).toHaveLength(2);
  });
  it('reads unknown outcomes without replay, even after closing the confirmation', async () => {
    const fetch = install((url, init) => {
      if (init.method === 'PATCH') throw new TypeError('Connection lost');
      if (url.endsWith('/preview')) return response(fixture());
      return response({ id: projectId, name: 'Alpha', repoUrl: target, ownership: { teamId: directAccessFixture(projectId, userId).ownership.teamId, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: '2026-11-19T10:00:00Z', updatedAt: '2026-11-19T10:00:00Z' });
    });
    render(<Editor />); const dialog = await editAndPreview(); fireEvent.click(await within(dialog).findByRole('button', { name: '保存地址' }));
    const check = await within(dialog).findByRole('button', { name: '核对当前地址' }); fireEvent.click(check); await within(dialog).findByText(/读到的当前地址/);
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' })); expect(screen.getByLabelText('新仓库地址')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '核对当前地址' })); expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1);
  });
  it('keeps non-administrators read-only and validates the UTF-8 byte limit before preview', async () => {
    const fetch = install(() => { throw new Error('Unexpected product operation'); }, 'member'); const mounted = render(<Editor />);
    await screen.findByText('只有项目管理员可以修改仓库地址。'); expect(screen.getByLabelText('新仓库地址')).toBeDisabled(); expect(fetch.mock.calls.every(([url]) => url.endsWith('/access'))).toBe(true); mounted.unmount();
    install(() => { throw new Error('Unexpected preview'); }); render(<Editor />);
    const input = screen.getByLabelText('新仓库地址'); await waitFor(() => expect(input).not.toBeDisabled()); fireEvent.change(input, { target: { value: '中'.repeat(1400) } }); fireEvent.click(screen.getByRole('button', { name: '预览更改' }));
    await screen.findByText('仓库地址不能超过 4096 字节。'); expect(screen.queryByRole('dialog')).toBeNull();
  });
});
