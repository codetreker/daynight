import { createGraphSyncFixture } from "./helpers/taskSync";
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthConfig, listMembers, logout, me } from '../src/api/auth';
import type { CurrentUser } from '../src/api/auth-types';
import { ApiError, setTaskStatus, getTask, getTaskSync } from '../src/api/client';
import type { TaskDetail, TaskGraph } from '../src/api/types';
import { AuthenticatedApp } from '../src/app/AuthenticatedApp';
import { renderWithLocale } from './helpers/renderWithLocale';

vi.mock('../src/api/auth', async (original) => ({ ...await original<typeof import('../src/api/auth')>(),
  getAuthConfig: vi.fn(), listMembers: vi.fn(), logout: vi.fn(), me: vi.fn(),
}));
vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(),
  getTask: vi.fn(), getTaskSync: vi.fn(), setTaskStatus: vi.fn(), listAttachments: vi.fn(async () => ({ items: [], nextCursor: null })),
}));
const graphRequest = vi.fn<(projectId: string, signal: AbortSignal) => Promise<TaskGraph>>();

const confirmStatus = (button: HTMLElement) => {
  fireEvent.click(button);
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'In progress' }));
  const confirmation = screen.getByRole('alertdialog', { name: 'Set task status' });
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirm status' }));
};
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const project = id(100); const otherProject = id(200); const task = id(1); const otherTask = id(2);
const stamp = '2026-10-22T00:00:00Z';
const alice: CurrentUser = { id: id(501), name: 'Alice', email: 'alice@example.com', emailVerified: true, avatarUrl: null };
const bob: CurrentUser = { ...alice, id: id(502), name: 'Bob', email: 'bob@example.com' };
let currentUser: CurrentUser;
let topLevelFocused = true;
const returnFromAnotherWindow = () => {
  topLevelFocused = false; fireEvent(window, new Event('blur'));
  topLevelFocused = true; fireEvent(window, new Event('focus'));
};
const initial = (projectId = project): TaskDetail => ({ requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, id: projectId === project ? task : otherTask, projectId,
  version: 9007199254740993n, title: `${currentUser.name} task ${projectId === project ? 'P' : 'Q'}`, description: `${currentUser.name} reviewed content`,
  properties: { worker: null, pullRequests: [] }, status: 'todo', dependsOn: [], blockedBy: [], ready: true, createdAt: stamp, updatedAt: stamp });
const graph = (projectId: string): TaskGraph => {
  const detail = initial(projectId);
  return { observedAt: "2026-10-20T12:00:00Z", project: { settings: { version: 1n, executionWarningMinutes: 60 }, id: projectId, name: `${currentUser.name} project ${projectId === project ? 'P' : 'Q'}`, repoUrl: 'https://example.com/repo', createdAt: stamp, updatedAt: stamp },
    tasks: [{ requiredPlatform: detail.requiredPlatform, allowAgents: detail.allowAgents, externalDependsOn: detail.externalDependsOn, startedAt: null, completedAt: null, id: detail.id, titlePreview: detail.title, titleTruncated: false, status: detail.status, dependsOn: [], blockedBy: [], ready: true, createdAt: stamp, updatedAt: stamp }],
    summary: { total: 1, todo: 1, inProgress: 0, done: 0, ready: 1, blocked: 0 } };
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
};
let root: HTMLDivElement;
const syncFixture = createGraphSyncFixture();
beforeEach(() => {
  syncFixture.reset();
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (projectId, query, _userId, signal) => syncFixture.toSync(await graphRequest(projectId, signal), query));
});

beforeEach(() => {
  currentUser = alice; topLevelFocused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => topLevelFocused);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  window.history.replaceState(null, '', `/projects/${project}`);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  vi.mocked(me).mockReset().mockImplementation(async () => currentUser);
  vi.mocked(getAuthConfig).mockReset().mockResolvedValue({ providers: ['github'] });
  vi.mocked(logout).mockReset().mockResolvedValue(undefined);
  vi.mocked(listMembers).mockReset().mockImplementation(async (projectId) => [{ projectId, userId: currentUser.id, role: 'member', version: 1n,
    name: currentUser.name, email: currentUser.email, avatarUrl: null, createdAt: stamp, updatedAt: stamp }]);
  graphRequest.mockReset().mockImplementation(async (projectId) => graph(projectId));
  vi.mocked(getTask).mockReset().mockImplementation(async (projectId) => initial(projectId));
  vi.mocked(setTaskStatus).mockReset();
});
afterEach(() => { cleanup(); root.remove(); });
const mount = () => renderWithLocale(<AuthenticatedApp />, { locale: 'en', container: root });
const open = async (title: string) => {
  fireEvent.click(screen.getByRole('tab', { name: 'Standalone tasks' }));
  fireEvent.click(screen.getByRole('button', { name: new RegExp(title) }));
  const dialog = screen.getByRole('dialog');
  await within(dialog).findByRole('heading', { name: title }); return dialog;
};
const close = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: 'Close task details' }));
const navigate = async (projectId: string, heading: string) => {
  act(() => { window.history.pushState(null, '', `/projects/${projectId}`); window.dispatchEvent(new PopStateEvent('popstate')); });
  await screen.findByRole('heading', { name: heading });
};

describe('authenticated status ownership', () => {
  it('retains a pending status through same-user revalidation, split-panel selection and P/Q/P navigation', async () => {
    const revalidation = deferred<CurrentUser>(); const mutation = deferred<TaskDetail>();
    const original = initial();
    vi.mocked(me).mockResolvedValueOnce(alice).mockReturnValueOnce(revalidation.promise);
    vi.mocked(setTaskStatus).mockReturnValueOnce(mutation.promise);
    mount(); await screen.findByRole('heading', { name: 'Alice project P' });
    let dialog = await open('Alice task P');
    confirmStatus(within(dialog).getByRole('button', { name: 'To do' }));
    const attachmentTab = within(dialog).getByRole('tab', { name: 'Attachments' });
    fireEvent.click(attachmentTab);
    returnFromAnotherWindow();
    await waitFor(() => expect(me).toHaveBeenCalledTimes(2));
    expect(dialog.isConnected).toBe(true);
    await act(async () => { revalidation.resolve(alice); });
    await waitFor(() => expect(document.body).not.toHaveClass('auth-session-checking'));
    expect(within(dialog).getByRole('tab', { name: 'Attachments' })).toBe(attachmentTab);
    expect(attachmentTab).toHaveAttribute('aria-selected', 'true');
    close(dialog);
    await navigate(otherProject, 'Alice project Q');
    dialog = await open('Alice task Q'); close(dialog);
    await navigate(project, 'Alice project P');
    dialog = await open('Alice task P');
    expect(within(dialog).getByRole('button', { name: 'To do' })).toBeDisabled();
    expect(setTaskStatus).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getTask).mock.calls.filter(([projectId]) => projectId === project)).toHaveLength(1);
    await act(async () => { mutation.resolve({ ...original, status: 'in_progress', ready: false, startedAt: '2026-10-22T00:01:00Z', version: original.version + 1n, updatedAt: '2026-10-22T00:01:00Z' }); });
    await within(dialog).findByRole('button', { name: 'In progress' });
    expect(within(dialog).getByRole('button', { name: 'In progress' })).toBeVisible();
  });

  it('replaces pending and cached status state on identity change and ignores the previous identity late result', async () => {
    const mutation = deferred<TaskDetail>(); const original = initial();
    vi.mocked(setTaskStatus).mockReturnValueOnce(mutation.promise);
    mount(); await screen.findByRole('heading', { name: 'Alice project P' });
    let dialog = await open('Alice task P');
    confirmStatus(within(dialog).getByRole('button', { name: 'To do' })); close(dialog);
    currentUser = bob; returnFromAnotherWindow();
    await screen.findByRole('heading', { name: 'Bob project P' });
    dialog = await open('Bob task P');
    expect(within(dialog).getByRole('button', { name: 'To do' })).toBeEnabled();
    expect(within(dialog).queryByText('Alice reviewed content')).toBeNull();
    const graphCalls = graphRequest.mock.calls.length;
    await act(async () => { mutation.resolve({ ...original, status: 'in_progress', ready: false, startedAt: '2026-10-22T00:01:00Z', version: original.version + 1n }); });
    expect(within(dialog).getByRole('heading', { name: 'Bob task P' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'To do' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'To do' })).toBeEnabled();
    expect(graphRequest).toHaveBeenCalledTimes(graphCalls);
    expect(setTaskStatus).toHaveBeenCalledTimes(1);
  });

  it('disposes pending task ownership on logout without allowing late failure to read or repopulate private content', async () => {
    const mutation = deferred<TaskDetail>(); vi.mocked(setTaskStatus).mockReturnValueOnce(mutation.promise);
    mount(); await screen.findByRole('heading', { name: 'Alice project P' });
    const dialog = await open('Alice task P');
    confirmStatus(within(dialog).getByRole('button', { name: 'To do' })); close(dialog);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in to your workspace' });
    const reads = vi.mocked(getTask).mock.calls.length;
    await act(async () => { mutation.reject(new ApiError('network')); });
    expect(screen.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
    expect(screen.queryByText('Alice reviewed content')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getTask).toHaveBeenCalledTimes(reads);
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
