import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import type { Attachment } from '../../src/api/types';
import { TaskDetailDialog } from '../../src/features/task-detail/TaskDetailDialog';
import { TaskPullRequests } from '../../src/features/task-detail/TaskPullRequests';
import { AttachmentPreview } from '../../src/features/task-detail/attachments/AttachmentPreview';
import { TaskAttachments } from '../../src/features/task-detail/attachments/TaskAttachments';
import type { AttachmentApi } from '../../src/features/task-detail/attachments/useAttachments';
import { LanguageSelector } from '../../src/i18n/LanguageSelector';
import { renderWithLocale } from '../helpers/renderWithLocale';
import { createTaskSessionWorld } from '../helpers/taskSessions';
import { detailFixture } from '../helpers/taskDetail';
import { viewerHeaders } from '../helpers/taskSync';

const timestamp = '2026-10-21T00:00:00Z';
const projectId = '00000000-0000-4000-8000-000000000100';
const taskId = '00000000-0000-4000-8000-000000000001';
const attachment = (path = 'site/index.html', contentType = 'text/html'): Attachment => ({
  path, contentType, sizeBytes: 1234, createdAt: timestamp, updatedAt: timestamp,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const fixture = (initial = [attachment()]) => {
  let items = initial;
  const api: AttachmentApi = {
    list: vi.fn(async () => ({ items, nextCursor: null })),
    readText: vi.fn(async () => 'Raw 用户内容'),
    checkPreview: vi.fn(async () => {}),
    put: vi.fn(async (_project, _task, path, source) => attachment(path, source.type)),
    remove: vi.fn(async () => {}),
  };
  return { api, setItems: (next: Attachment[]) => { items = next; } };
};
const openAttachments = (api: AttachmentApi) => renderWithLocale(<>
  <LanguageSelector />
  <TaskAttachments projectId={projectId} taskId={taskId} api={api} />
</>, { locale: 'zh-CN' });
const switchTo = (locale: 'en' | 'zh-CN') => fireEvent.change((document.querySelector('dialog[open]') === null ? screen : within(document.querySelector('dialog[open]')!)).getByRole('combobox', { name: '语言 / Language' }), { target: { value: locale } });

describe('inspection language changes', () => {
  it('keeps the PR collection, page, selector focus and raw fields while translating pagination', async () => {
    const pullRequests = Array.from({ length: 205 }, (_, index) => ({ title: `原始 title ${index}`, url: `https://example.com/pull/${index}` }));
    pullRequests[200] = { title: '  原始\nTitle  ', url: '  raw arbitrary URL  ' };
    const original = structuredClone(pullRequests);
    renderWithLocale(<><LanguageSelector /><TaskPullRequests pullRequests={pullRequests} /></>, { locale: 'zh-CN' });
    const selector = screen.getByRole('combobox', { name: '关联 PR 页码' });
    await userEvent.setup().selectOptions(selector, '2');
    const row = within(screen.getByRole('region', { name: '关联 PR' })).getAllByRole('listitem')[0]!;
    expect(selector).toHaveFocus();
    switchTo('en');
    expect(screen.getByRole('combobox', { name: 'Linked PR page' })).toBe(selector);
    expect(selector).toHaveFocus();
    expect(selector).toHaveValue('2');
    expect(screen.getByRole('status')).toHaveTextContent('Items 201–205 of 205');
    expect(within(screen.getByRole('region', { name: 'Linked PRs' })).getAllByRole('listitem')[0]).toBe(row);
    expect(row.querySelector('.task-detail-pr-title')?.textContent).toBe(pullRequests[200]!.title);
    expect(row.querySelector('.task-detail-pr-value')?.textContent).toBe(pullRequests[200]!.url);
    expect(pullRequests).toEqual(original);
  });

  it('keeps one pending overwrite, the File and frame across language changes and translates its failure at settlement', async () => {
    const data = fixture();
    const first = deferred<Attachment>();
    const second = deferred<Attachment>();
    const put = vi.fn<AttachmentApi['put']>().mockReturnValueOnce(first.promise).mockImplementationOnce(async () => {
      const updated = await second.promise;
      data.setItems([updated]);
      return updated;
    });
    openAttachments({ ...data.api, put });
    fireEvent.click(await screen.findByRole('button', { name: /index.html/, pressed: false }));
    const frame = await screen.findByTitle('HTML 预览：site/index.html');
    fireEvent.load(frame);
    const src = frame.getAttribute('src');
    const user = userEvent.setup();
    const disclosure = screen.getByText('上传文件', { selector: 'summary' });
    expect(disclosure.parentElement).not.toHaveAttribute('open');
    switchTo('en');
    expect(screen.getByText('Upload file', { selector: 'summary' })).toBe(disclosure);
    expect(disclosure.parentElement).not.toHaveAttribute('open');
    await user.click(disclosure);
    switchTo('zh-CN');
    const input = screen.getByLabelText('选择一个文件') as HTMLInputElement;
    const source = new File(['<p>更新</p>'], 'index.html', { type: 'text/html' });
    await user.upload(input, source);
    const path = screen.getByRole('textbox', { name: '目标相对路径' });
    fireEvent.change(path, { target: { value: 'site/index.html' } });
    await user.click(screen.getByRole('button', { name: '上传文件' }));
    const signal = put.mock.calls[0]![4];
    switchTo('en');
    expect(disclosure).toHaveTextContent('Upload file');
    expect(disclosure.parentElement).toHaveAttribute('open');
    expect(screen.getByLabelText('Choose one file')).toBe(input);
    expect(input.files?.[0]).toBe(source);
    expect(path).toHaveValue('site/index.html');
    expect(path).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Uploading…' })).toBeDisabled();
    expect(screen.getByTitle('HTML preview: site/index.html')).toBe(frame);
    expect(frame).toHaveAttribute('src', src);
    expect(data.api.list).toHaveBeenCalledTimes(1);
    expect(data.api.checkPreview).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledExactlyOnceWith(projectId, taskId, 'site/index.html', source, signal);
    expect(signal.aborted).toBe(false);
    await act(async () => first.reject(new ApiError('server', 500, 'internal_error', 'overwrite-request-raw')));
    expect(screen.getByRole('alert')).toHaveTextContent('The attachment operation failed.');
    expect(screen.getByRole('alert')).toHaveTextContent('overwrite-request-raw');
    switchTo('zh-CN');
    expect(screen.getByRole('alert')).toHaveTextContent('附件操作失败，请检查后重试。');
    expect(screen.getByTitle('HTML 预览：site/index.html')).toBe(frame);
    expect(input.files?.[0]).toBe(source);
    expect(path).toHaveValue('site/index.html');
    await user.click(screen.getByRole('button', { name: '上传文件' }));
    switchTo('en');
    await act(async () => second.resolve({ ...attachment(), updatedAt: '2026-10-22T00:00:00Z' }));
    await waitFor(() => expect(screen.getByTitle('HTML preview: site/index.html')).not.toBe(frame));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input.files).toHaveLength(0);
    expect(path).toHaveValue('');
    expect(put).toHaveBeenCalledTimes(2);
    expect(data.api.list).toHaveBeenCalledTimes(2);
  });

  it('keeps one pending delete and its preview, retranslates rejection, then completes a retry in the current language', async () => {
    const data = fixture();
    const first = deferred<void>();
    const second = deferred<void>();
    const remove = vi.fn<AttachmentApi['remove']>().mockReturnValueOnce(first.promise).mockImplementationOnce(async () => {
      await second.promise;
      data.setItems([]);
    });
    openAttachments({ ...data.api, remove });
    fireEvent.click(await screen.findByRole('button', { name: /index.html/, pressed: false }));
    const frame = await screen.findByTitle('HTML 预览：site/index.html');
    await userEvent.setup().click(screen.getByRole('button', { name: '更多操作：site/index.html' }));
    await userEvent.setup().click(screen.getByRole('menuitem', { name: '删除' }));
    await userEvent.setup().click(screen.getByRole('button', { name: '删除附件' }));
    const signal = remove.mock.calls[0]![3];
    switchTo('en');
    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
    expect(screen.getByTitle('HTML preview: site/index.html')).toBe(frame);
    expect(remove).toHaveBeenCalledExactlyOnceWith(projectId, taskId, 'site/index.html', signal);
    expect(signal.aborted).toBe(false);
    await act(async () => first.reject(new ApiError('server', 500, 'internal_error', 'delete-request-raw')));
    expect(screen.getByRole('alert')).toHaveTextContent('The attachment operation failed.');
    switchTo('zh-CN');
    expect(screen.getByRole('alert')).toHaveTextContent('附件操作失败，请检查后重试。');
    expect(screen.getByRole('alert')).toHaveTextContent('delete-request-raw');
    expect(screen.getByTitle('HTML 预览：site/index.html')).toBe(frame);
    await userEvent.setup().click(screen.getByRole('button', { name: '删除附件' }));
    switchTo('en');
    await act(async () => second.resolve());
    await screen.findByText('No attachments. Upload a file to browse it here.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(data.api.list).toHaveBeenCalledTimes(2);
    expect(data.api.checkPreview).toHaveBeenCalledTimes(1);
  });

  it('retranslates preview errors while retaining their request IDs and raw content boundaries', () => {
    const item = attachment('原始-file.txt', 'text/plain');
    renderWithLocale(<><LanguageSelector /><AttachmentPreview attachment={item}
      preview={{ path: item.path, status: 'error', text: null, error: new ApiError('server', 500, 'internal_error', 'preview-request-raw') }}
      url="/original-preview" previewRoot="/" onRetry={vi.fn()} /></>, { locale: 'zh-CN' });
    expect(screen.getByRole('alert')).toHaveTextContent('无法读取文件预览');
    switchTo('en');
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to read the file preview.');
    expect(screen.getByRole('alert')).toHaveTextContent('preview-request-raw');
    expect(screen.getByRole('button', { name: 'Retry preview' })).toBeVisible();
  });

  it('retranslates an open detail error without refetching or resetting dialog focus and modal ownership', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    const world = createTaskSessionWorld();
    await world.sync([detailFixture(projectId, taskId)]);
    const graph = world.scope.getAuthorizedProject(projectId)!.graph;
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
      code: 'not_found', message: 'private raw server error', requestId: 'detail-request-raw',
    } }), { status: 404, headers: viewerHeaders(world.scope.userId, { 'Content-Type': 'application/json' }) }));
    vi.stubGlobal('fetch', fetch);
    const view = renderWithLocale(<TaskDetailDialog projectId={projectId} taskId={taskId}
      snapshot={{ observedAt: graph.observedAt, graph, index: world.scope.getAuthorizedProject(projectId)!.index, receivedMonotonic: performance.now(), receivedAt: Date.now(), revision: 1 }}
      onSelectTask={vi.fn()} onClose={vi.fn()} onRestoreFocus={vi.fn()} onRefreshGraph={vi.fn()} />, { locale: 'zh-CN', taskCache: { scope: world.scope } });
    try {
      expect(await screen.findByRole('alert')).toHaveTextContent('这个任务已无法读取，请刷新任务图。');
      const close = screen.getByRole('button', { name: '关闭任务详情' });
      expect(close).toHaveFocus();
      const dialog = screen.getByRole('dialog');
      view.setLocale('en');
      expect(screen.getByRole('dialog')).toBe(dialog);
      expect(screen.getByRole('button', { name: 'Close task details' })).toBe(close);
      expect(close).toHaveFocus();
      expect(screen.getByRole('alert')).toHaveTextContent('This task can no longer be read. Refresh the task graph.');
      expect(screen.getByRole('alert')).toHaveTextContent('detail-request-raw');
      expect(screen.getByRole('alert')).not.toHaveTextContent('private raw server error');
      expect(root).toHaveAttribute('inert');
      expect(document.body.style.overflow).toBe('hidden');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      world.dispose();
      expect(root).not.toHaveAttribute('inert');
      root.remove();
    }
  });
});
