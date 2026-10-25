import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { ApiError, attachmentPageUrl } from '../src/api/client';
import type { Attachment, AttachmentPage as Page } from '../src/api/types';
import { useLayoutEffect, useState } from 'react';
import { navigateTaskDetail, type TaskDetailNavigation } from '../src/app/router';
import { TaskDetailSurface } from '../src/features/task-detail/TaskDetailSurface';
import { TaskDetailSessionBoundary } from '../src/features/task-detail/TaskDetailSession';
import { detailFixture, resourceResponse, snapshotFixture } from './helpers/taskDetail';
import type { AttachmentUrls } from '../src/features/task-detail/attachments/TaskAttachments';
import type { AttachmentApi } from '../src/features/task-detail/attachments/useAttachments';
import { createLocaleRender } from './helpers/renderWithLocale';

import { createTaskSessionWorld } from './helpers/taskSessions';
import { TEST_VIEWER_ID } from './helpers/taskSync';

let world: ReturnType<typeof createTaskSessionWorld>;
const localeRender = createLocaleRender('zh-CN');
const render: typeof localeRender = (ui, options) => localeRender(ui, { ...options, taskCache: { scope: world.scope } });
const projectId = '00000000-0000-4000-8000-000000000100';
const taskId = '00000000-0000-4000-8000-000000000001';
const timestamp = '2026-10-21T00:00:00Z';
const file = (path: string, contentType = 'text/plain'): Attachment => ({ path, contentType, sizeBytes: 12, createdAt: timestamp, updatedAt: timestamp });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const fixture = (items: readonly Attachment[]): AttachmentApi => {
  const files = new Map(items.map((item) => [item.path, item]));
  return {
  list: vi.fn(async () => ({ items: [...files.values()], nextCursor: null })),
  readText: vi.fn(async (_project, _task, path) => `Contents of ${path}`),
  checkPreview: vi.fn(async () => {}),
  put: vi.fn(async (_project, _task, path) => { const item = file(path); files.set(path, item); return item; }),
  remove: vi.fn(async (_project, _task, path) => { files.delete(path); }),
  };
};
const preview = () => within(screen.getByRole('group', { name: '附件预览' }));
const readyPreview = async () => within(await screen.findByRole('group', { name: '附件预览' }));
const Reader = ({ api, path, id, urls }: { readonly api: AttachmentApi; readonly path: string; readonly id: string; readonly urls?: AttachmentUrls }) => {
  const [fullscreen, setFullscreen] = useState(false);
  const [selection, setSelection] = useState<TaskDetailNavigation>({ tab: 'attachments', path });
  useLayoutEffect(() => { setSelection({ tab: 'attachments', path }); }, [path]);
  return <TaskDetailSessionBoundary><TaskDetailSurface presentation="page" fullscreen={{ active: fullscreen, onChange: setFullscreen }} projectId={projectId} taskId={id} snapshot={snapshotFixture([detailFixture(projectId, id)])} navigation={selection}
    attachmentApi={api} {...(urls === undefined ? {} : { attachmentUrls: urls })} onNavigate={(next) => { setSelection(next); navigateTaskDetail(projectId, id, next); }} onSelectTask={vi.fn()} onRefreshGraph={vi.fn()} /></TaskDetailSessionBoundary>;
};
const page = (api: AttachmentApi, path = 'docs/readme.md', id = taskId) => <Reader key={id} api={api} path={path} id={id} />;
beforeEach(async () => {
  world = createTaskSessionWorld();
  await world.sync([detailFixture(projectId, taskId), detailFixture(projectId, '00000000-0000-4000-8000-000000000002')]);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => resourceResponse(detailFixture(projectId, url.split('/').at(-1)!), TEST_VIEWER_ID)));
});
afterEach(() => world.dispose());

describe('full-detail attachment surface', () => {
  it('uses the complete shared file panel and synchronizes explicit selections without duplicate history entries', async () => {
    const special = '资料/设计 %2F #?.txt';
    window.history.replaceState(null, '', attachmentPageUrl(projectId, taskId, 'docs/readme.md'));
    const api = fixture([file('docs/readme.md'), file(special)]);
    render(page(api));
    await screen.findByText('Contents of docs/readme.md');
    expect(screen.getByText('上传文件', { selector: 'summary' })).toBeVisible();
    expect(screen.getByRole('button', { name: '更多操作：docs/readme.md' })).toBeVisible();
    const initialLength = window.history.length;
    const otherDirectory = screen.getByText('资料', { selector: 'summary' }).parentElement!;
    expect(otherDirectory).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('资料', { selector: 'summary' }));
    const target = screen.getByRole('button', { name: /^设计 %2F #\?\.txt/ });
    fireEvent.click(target);
    await screen.findByText(`Contents of ${special}`);
    expect(window.location.pathname).toBe(attachmentPageUrl(projectId, taskId, special));
    expect(window.history.length).toBe(initialLength + 1);
    expect(target).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(target);
    expect(window.history.length).toBe(initialLength + 1);
    expect(api.list).toHaveBeenCalledOnce();
  });

  it('selects a successfully uploaded file in the shared panel and gives it an address', async () => {
    window.history.replaceState(null, '', attachmentPageUrl(projectId, taskId, 'docs/readme.md'));
    const api = fixture([file('docs/readme.md')]);
    render(page(api));
    await screen.findByText('Contents of docs/readme.md');
    const user = userEvent.setup();
    await user.click(screen.getByText('上传文件', { selector: 'summary' }));
    await user.upload(screen.getByLabelText('选择一个文件'), new File(['new contents'], 'new.txt', { type: 'text/plain' }));
    fireEvent.change(screen.getByLabelText('目标相对路径'), { target: { value: 'notes/new.txt' } });
    await user.click(screen.getByRole('button', { name: '上传文件' }));
    await screen.findByText('Contents of notes/new.txt');
    expect(window.location.pathname).toBe(attachmentPageUrl(projectId, taskId, 'notes/new.txt'));
    expect(screen.getByRole('link', { name: '下载' })).toHaveAttribute('href', expect.stringContaining('/notes/new.txt'));
    expect(screen.getByLabelText('目标相对路径')).toHaveValue('');
    expect(screen.getByText('notes', { selector: 'summary' }).parentElement).not.toHaveAttribute('open');
    expect(screen.getByText('new.txt')).not.toBeVisible();
  });

  it('reveals only a changed route target while retaining manually closed directories through refresh', async () => {
    const api = fixture([file('docs/deep/readme.md'), file('docs/examples/sample.txt'), file('other/next.txt'), file('root.txt')]);
    const view = render(page(api, 'docs/deep/readme.md'));
    await screen.findByText('Contents of docs/deep/readme.md');
    const directory = (name: string) => screen.getByText(name, { selector: 'summary' }).parentElement!;
    expect(directory('docs')).toHaveAttribute('open');
    expect(directory('deep')).toHaveAttribute('open');
    expect(directory('examples')).not.toHaveAttribute('open');
    expect(directory('other')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('docs', { selector: 'summary' }));
    fireEvent.click(screen.getByRole('button', { name: '刷新附件' }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(directory('docs')).not.toHaveAttribute('open');
    view.rerender(page(api, 'other/next.txt'));
    await screen.findByText('Contents of other/next.txt');
    expect(directory('other')).toHaveAttribute('open');
    expect(directory('docs')).not.toHaveAttribute('open');
    view.rerender(page(api, 'root.txt'));
    await screen.findByText('Contents of root.txt');
    expect(directory('docs')).not.toHaveAttribute('open');
    expect(directory('examples')).not.toHaveAttribute('open');
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('synchronizes a completed upload after another file was selected while the write was pending', async () => {
    window.history.replaceState(null, '', attachmentPageUrl(projectId, taskId, 'docs/readme.md'));
    const pending = deferred<Attachment>();
    const api = fixture([file('docs/readme.md'), file('next.txt')]);
    vi.mocked(api.put).mockReturnValueOnce(pending.promise);
    render(page(api));
    await screen.findByText('Contents of docs/readme.md');
    const user = userEvent.setup();
    await user.click(screen.getByText('上传文件', { selector: 'summary' }));
    await user.upload(screen.getByLabelText('选择一个文件'), new File(['replacement'], 'readme.md', { type: 'text/markdown' }));
    fireEvent.change(screen.getByLabelText('目标相对路径'), { target: { value: 'docs/readme.md' } });
    await user.click(screen.getByRole('button', { name: '上传文件' }));
    fireEvent.click(screen.getByRole('button', { name: /^next\.txt/ }));
    await screen.findByText('Contents of next.txt');
    expect(window.location.pathname).toBe(attachmentPageUrl(projectId, taskId, 'next.txt'));
    await act(async () => pending.resolve(file('docs/readme.md')));
    await screen.findByText('Contents of docs/readme.md');
    expect(window.location.pathname).toBe(attachmentPageUrl(projectId, taskId, 'docs/readme.md'));
  });

  it('retains the selected file address after deletion and shows the confirmed missing state', async () => {
    const address = attachmentPageUrl(projectId, taskId, 'docs/readme.md');
    window.history.replaceState(null, '', address);
    const api = fixture([file('docs/readme.md'), file('next.txt')]);
    render(page(api));
    await screen.findByText('Contents of docs/readme.md');
    const historyLength = window.history.length;
    fireEvent.click(screen.getByRole('button', { name: '更多操作：docs/readme.md' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    const dialog = screen.getByRole('dialog', { name: '删除附件？' });
    fireEvent.click(within(dialog).getByRole('button', { name: '删除附件' }));
    expect(await (await readyPreview()).findByRole('alert')).toHaveTextContent('找不到此附件');
    expect(window.location.pathname).toBe(address);
    expect(window.history.length).toBe(historyLength);
    expect(screen.queryByText('Contents of docs/readme.md')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^next\.txt/ }));
    await screen.findByText('Contents of next.txt');
    expect(window.location.pathname).toBe(attachmentPageUrl(projectId, taskId, 'next.txt'));
  });

  it('loads all inventory pages before rendering authoritative metadata and shared Markdown', async () => {
    const next = deferred<Page>();
    const item = file('docs/readme.md', 'text/markdown');
    const api = fixture([item]);
    vi.mocked(api.list).mockResolvedValueOnce({ items: [item], nextCursor: 'next' }).mockReturnValueOnce(next.promise);
    vi.mocked(api.readText).mockResolvedValue('# Full document\n\n| File | State |\n| --- | --- |\n| UI | Ready |\n\n![Figure](../images/a%20b.svg)\n\n<script>unsafe()</script>');
    render(page(api));
    expect(screen.getByRole('main')).toHaveFocus();
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect((await readyPreview()).getByRole('status')).toHaveTextContent('正在加载附件');
    expect(api.readText).not.toHaveBeenCalled();
    expect(screen.queryByText('找不到此附件，文件可能已被删除。')).toBeNull();
    await act(async () => next.resolve({ items: [], nextCursor: null }));
    await screen.findByRole('heading', { name: 'Full document' });
    expect(screen.getByRole('table')).toHaveTextContent('UIReady');
    expect(screen.getByRole('img', { name: 'Figure' })).toHaveAttribute('src', `/api/v1/projects/${projectId}/tasks/${taskId}/preview/images/a%20b.svg`);
    expect(screen.getByText('<script>unsafe()</script>')).toBeVisible();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByRole('heading', { name: item.path })).toHaveAttribute('title', item.path);
    expect(screen.getByRole('link', { name: '返回任务所在项目' })).toHaveAttribute('href', `/projects/${projectId}`);
    expect(screen.getByRole('link', { name: '下载' })).toHaveAttribute('download');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('distinguishes missing files from a partial inventory failure and retries the complete inventory', async () => {
    const api = fixture([]);
    const failure = new ApiError('server', 500, 'server_error', 'inventory-7');
    vi.mocked(api.list).mockResolvedValueOnce({ items: [file('other.txt')], nextCursor: 'next' }).mockRejectedValueOnce(failure);
    render(page(api));
    expect(await (await readyPreview()).findByRole('alert')).toHaveTextContent('附件列表尚未完整加载');
    expect(preview().getByRole('alert')).toHaveTextContent('inventory-7');
    expect(screen.queryByText('找不到此附件，文件可能已被删除。')).toBeNull();
    fireEvent.click(preview().getByRole('button', { name: '重试附件' }));
    expect(await (await readyPreview()).findByRole('alert')).toHaveTextContent('找不到此附件');
    expect(vi.mocked(api.list).mock.calls[2]?.[2]).toEqual({ limit: 100 });
    vi.mocked(api.list).mockResolvedValueOnce({ items: [file('docs/readme.md')], nextCursor: null });
    fireEvent.click(preview().getByRole('button', { name: '重试附件' }));
    await screen.findByText('Contents of docs/readme.md');
  });

  it('shows an initial service failure separately from preview errors and retries each owner', async () => {
    const api = fixture([file('docs/readme.md')]);
    vi.mocked(api.list).mockRejectedValueOnce(new Error('private inventory error'));
    vi.mocked(api.readText).mockRejectedValueOnce(new ApiError('server', 500, 'server_error', 'preview-7'));
    render(page(api));
    expect(await (await readyPreview()).findByRole('alert')).toHaveTextContent('附件列表加载失败');
    expect(preview().getByRole('alert')).not.toHaveTextContent('private');
    fireEvent.click(preview().getByRole('button', { name: '重试附件' }));
    await screen.findByRole('button', { name: '重试预览' });
    expect(preview().getByRole('alert')).toHaveTextContent('无法读取文件预览');
    expect(preview().getByRole('alert')).toHaveTextContent('preview-7');
    fireEvent.click(screen.getByRole('button', { name: '重试预览' }));
    await screen.findByText('Contents of docs/readme.md');
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.readText).toHaveBeenCalledTimes(2);
  });

  it('aborts pending text and clears the previous document on file and task navigation', async () => {
    const old = deferred<string>();
    const api = fixture([file('docs/readme.md'), file('next.txt')]);
    vi.mocked(api.readText).mockReturnValueOnce(old.promise);
    const view = render(page(api));
    await waitFor(() => expect(api.readText).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.readText).mock.calls[0]![3];
    view.rerender(page(api, 'next.txt'));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole('heading', { name: 'docs/readme.md' })).toBeNull();
    await screen.findByText('Contents of next.txt');
    await act(async () => old.resolve('Late old document'));
    expect(screen.queryByText('Late old document')).toBeNull();
    const pending = deferred<Page>();
    vi.mocked(api.list).mockReturnValueOnce(pending.promise);
    view.rerender(page(api, 'next.txt', '00000000-0000-4000-8000-000000000002'));
    expect(screen.queryByText('Contents of next.txt')).toBeNull();
    expect(await (await readyPreview()).findByRole('status')).toHaveTextContent('正在加载附件');
    const request = vi.mocked(api.list).mock.calls.at(-1)![3];
    view.unmount();
    expect(request.aborted).toBe(true);
    await act(async () => pending.reject(new Error('Late list failure')));
  });

  it.each([
    ['data.json', 'application/json', 'text'], ['image.svg', 'image/svg+xml', 'image'],
    ['site/index.html', 'text/html', 'HTML'], ['report.pdf', 'application/pdf', 'PDF'], ['archive.bin', 'application/octet-stream', 'unsupported'],
  ])('uses the shared renderer and injected URLs for %s', async (path, contentType, kind) => {
    const api = fixture([file(path, contentType)]);
    const urls = { previewRoot: '/fixtures/', preview: (name: string) => `/fixtures/${name}`, download: (name: string) => `/downloads/${name}`, page: (name: string) => `/reader/${name}` };
    render(<Reader id={taskId} path={path} api={api} urls={urls} />);
    if (kind === 'text') await screen.findByText(`Contents of ${path}`);
    else if (kind === 'image') expect(await screen.findByRole('img')).toHaveAttribute('src', `/fixtures/${path}`);
    else if (kind === 'unsupported') await screen.findByText('此文件暂不支持预览，请下载后打开。');
    else {
      const frame = await screen.findByTitle(`${kind} 预览：${path}`) as HTMLIFrameElement;
      expect(frame).toHaveAttribute('src', `/fixtures/${path}`);
      fireEvent.load(frame);
      expect(fireEvent.keyDown(frame.contentDocument!, { key: 'Escape' })).toBe(true);
      expect(fireEvent.keyDown(frame.contentDocument!, { key: 'Tab' })).toBe(true);
    }
    expect(screen.getByRole('link', { name: '下载' })).toHaveAttribute('href', `/downloads/${path}`);
  });
});
