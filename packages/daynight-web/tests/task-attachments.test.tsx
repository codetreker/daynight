import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createLocaleRender } from './helpers/renderWithLocale';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { Attachment, AttachmentPage } from '../src/api/types';
import { TaskAttachments } from '../src/features/task-detail/attachments/TaskAttachments';
import type { AttachmentApi } from '../src/features/task-detail/attachments/useAttachments';

const render = createLocaleRender('zh-CN');

const timestamp = '2026-10-21T00:00:00Z';
const file = (path: string, contentType = 'text/plain'): Attachment => ({ path, contentType, sizeBytes: 12, createdAt: timestamp, updatedAt: timestamp });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const fixture = (initial: readonly Attachment[] = []) => {
  const files = new Map(initial.map((item) => [item.path, item]));
  let revision = 0;
  const api: AttachmentApi = {
    list: vi.fn(async () => ({ items: [...files.values()], nextCursor: null })),
    readText: vi.fn(async (_project, _task, path) => `Contents of ${path}`),
    checkPreview: vi.fn(async () => {}),
    put: vi.fn(async (_project, _task, path, source) => {
      const item = { ...file(path, source.type), sizeBytes: source.size, updatedAt: new Date(Date.now() + ++revision).toISOString() };
      files.set(path, item);
      return item;
    }),
    remove: vi.fn(async (_project, _task, path) => { files.delete(path); }),
  };
  return api;
};
const open = (api: AttachmentApi, taskId = '00000000-0000-4000-8000-000000000001') => render(<TaskAttachments projectId="00000000-0000-4000-8000-000000000100" taskId={taskId} api={api} />);
const fileButton = (name: RegExp): HTMLElement => {
  const selection = screen.getAllByRole('button', { name }).find((button) => button.hasAttribute('aria-pressed'));
  if (selection === undefined) throw new Error(`No file selection button matches ${name}`);
  return selection;
};
const findFileButton = (name: RegExp) => waitFor(() => fileButton(name));
const showDeleteConfirmation = (path: string) => {
  fireEvent.click(screen.getByRole('button', { name: `更多操作：${path}` }));
  fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
  return screen.getByRole('dialog', { name: '删除附件？' });
};


describe('task attachments', () => {
  it('keeps embedded file selection local without writing address or browser history', async () => {
    window.history.replaceState(null, '', '/projects/embedded');
    const initialLength = window.history.length;
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    const api = fixture([file('one.txt'), file('two.txt')]);
    open(api);
    fireEvent.click(await findFileButton(/^one\.txt/));
    await screen.findByText('Contents of one.txt');
    fireEvent.click(fileButton(/^two\.txt/));
    await screen.findByText('Contents of two.txt');
    expect(window.location.pathname).toBe('/projects/embedded');
    expect(window.history.length).toBe(initialLength);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('starts with upload controls collapsed and retains the mounted draft when toggled', async () => {
    const api = fixture();
    open(api);
    await screen.findByText('暂无附件，上传文件后即可在这里浏览。');
    const user = userEvent.setup();
    const summary = screen.getByText('上传文件', { selector: 'summary' });
    const disclosure = summary.parentElement!;
    const input = screen.getByLabelText('选择一个文件') as HTMLInputElement;
    expect(disclosure).not.toHaveAttribute('open');
    expect(input).not.toBeVisible();
    expect(screen.getByLabelText('目标相对路径')).not.toBeVisible();
    await user.click(summary);
    expect(disclosure).toHaveAttribute('open');
    expect(input).toBeVisible();
    const source = new File(['draft'], 'draft.txt', { type: 'text/plain' });
    await user.upload(input, source);
    const path = screen.getByRole('textbox', { name: '目标相对路径' });
    await user.clear(path);
    await user.type(path, 'drafts/unsent.txt');
    await user.click(summary);
    expect(input).not.toBeVisible();
    await user.click(summary);
    expect(screen.getByLabelText('选择一个文件')).toBe(input);
    expect(screen.getByRole('textbox', { name: '目标相对路径' })).toBe(path);
    expect(input.files?.[0]).toBe(source);
    expect(path).toHaveValue('drafts/unsent.txt');
    expect(api.put).not.toHaveBeenCalled();
  });

  it('loads a native directory tree, keeps names as text, and selects files for preview and download', async () => {
    const first = deferred<AttachmentPage>();
    const api = { ...fixture(), list: vi.fn().mockReturnValue(first.promise) };
    open(api);
    expect(screen.getByRole('status')).toHaveTextContent('正在加载附件');
    expect(screen.getByRole('button', { name: '刷新附件' })).toBeDisabled();
    await act(async () => first.resolve({ items: [file('docs/readme.md', 'text/markdown'), file('<img onerror=bad>.txt')], nextCursor: null }));
    expect(screen.getByRole('heading', { name: '附件 · 2' })).toBeVisible();
    expect(screen.getByText('docs').tagName).toBe('SUMMARY');
    expect(fileButton(/<img onerror=bad>.txt/)).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
    fireEvent.click(fileButton(/readme.md/));
    await screen.findByText('Contents of docs/readme.md');
    expect(fileButton(/readme.md/)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('link', { name: '下载' })).toHaveAttribute('href', '/api/v1/projects/00000000-0000-4000-8000-000000000100/tasks/00000000-0000-4000-8000-000000000001/attachments/files/docs/readme.md');
    expect(screen.getByRole('link', { name: '下载' })).toHaveAttribute('download');
  });

  it('keeps a real new-tab link bound to the current selection while its content is pending', async () => {
    const pending = deferred<string>();
    const api = fixture([file('docs/设计 #?%.md', 'text/markdown'), file('next.txt')]);
    const readText = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue('Next content');
    open({ ...api, readText });
    fireEvent.click(await findFileButton(/设计/));
    const link = screen.getByRole('link', { name: '在新标签页打开' });
    expect(link).toHaveAttribute('href', '/projects/00000000-0000-4000-8000-000000000100/tasks/00000000-0000-4000-8000-000000000001/attachments/docs/%E8%AE%BE%E8%AE%A1%20%23%3F%25.md');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link.previousElementSibling).toBe(screen.getByRole('link', { name: '下载' }));
    expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('正在加载预览');
    fireEvent.click(fileButton(/next.txt/));
    expect(link).toHaveAttribute('href', expect.stringContaining('/attachments/next.txt'));
    await screen.findByText('Next content');
    await act(async () => pending.resolve('Stale document'));
    expect(screen.queryByText('Stale document')).toBeNull();
  });

  it('uploads one file, validates the target path, directly overwrites, and deletes with attachment-only reloads', async () => {
    const api = fixture([file('docs/readme.md')]);
    open(api);
    await findFileButton(/readme.md/);
    const user = userEvent.setup();
    await user.click(screen.getByText('上传文件', { selector: 'summary' }));
    const source = new File(['new contents'], 'readme.md', { type: 'text/markdown' });
    const input = screen.getByLabelText('选择一个文件') as HTMLInputElement;
    expect(input).not.toHaveAttribute('multiple');
    expect(input).not.toHaveAttribute('webkitdirectory');
    await user.upload(input, source);
    const path = screen.getByRole('textbox', { name: '目标相对路径' });
    expect(path).toHaveValue('readme.md');
    await user.clear(path);
    await user.type(path, '../outside.md');
    await user.click(screen.getByRole('button', { name: '上传文件' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请输入有效的相对文件路径');
    expect(api.put).not.toHaveBeenCalled();
    await user.clear(path);
    await user.type(path, 'docs/readme.md');
    await user.click(screen.getByRole('button', { name: '上传文件' }));
    await screen.findByRole('heading', { name: 'docs/readme.md' });
    expect(api.put).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000001', 'docs/readme.md', source, expect.any(AbortSignal));
    expect(path).toHaveValue('');
    expect(input.files).toHaveLength(0);
    expect(screen.getByRole('heading', { name: '附件 · 1' })).toBeVisible();
    expect(api.list).toHaveBeenCalledTimes(2);
    showDeleteConfirmation('docs/readme.md');
    await user.click(screen.getByRole('button', { name: '删除附件' }));
    await screen.findByText('暂无附件，上传文件后即可在这里浏览。');
    expect(api.remove).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000001', 'docs/readme.md', expect.any(AbortSignal));
    expect(api.list).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('region', { name: '附件预览' })).toBeNull();
  });

  it('retains upload form and current preview after failed writes and exposes request IDs without private details', async () => {
    const api = fixture([file('old.txt')]);
    const put = vi.fn().mockRejectedValueOnce(new ApiError('server', 500, 'internal_error', 'upload-123')).mockImplementation(api.put);
    const remove = vi.fn().mockRejectedValue(new Error('private delete failure'));
    open({ ...api, put, remove });
    await findFileButton(/old.txt/);
    fireEvent.click(fileButton(/old.txt/));
    await screen.findByText('Contents of old.txt');
    const user = userEvent.setup();
    await user.click(screen.getByText('上传文件', { selector: 'summary' }));
    const input = screen.getByLabelText('选择一个文件') as HTMLInputElement;
    const source = new File(['next'], 'next.txt', { type: 'text/plain' });
    await user.upload(input, source);
    await user.click(screen.getByRole('button', { name: '上传文件' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('upload-123');
    expect(screen.getByRole('textbox', { name: '目标相对路径' })).toHaveValue('next.txt');
    expect(input.files?.[0]).toBe(source);
    expect(screen.getByText('Contents of old.txt')).toBeVisible();
    showDeleteConfirmation('old.txt');
    await user.click(screen.getByRole('button', { name: '删除附件' }));
    expect(await screen.findByRole('alert')).not.toHaveTextContent('private delete failure');
    expect(screen.getByText('Contents of old.txt')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '取消' }));
    await user.click(screen.getByRole('button', { name: '上传文件' }));
    await screen.findByRole('heading', { name: 'next.txt' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('distinguishes incomplete lists from empty lists and retries from the beginning', async () => {
    const api = fixture();
    const list = vi.fn().mockRejectedValueOnce(new Error('private list error')).mockResolvedValueOnce({ items: [file('partial.txt')], nextCursor: 'next' }).mockRejectedValueOnce(new Error('next page failed')).mockResolvedValue({ items: [], nextCursor: null });
    open({ ...api, list });
    expect(await screen.findByRole('alert')).toHaveTextContent('附件列表加载失败');
    expect(screen.queryByText('暂无附件，上传文件后即可在这里浏览。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试附件' }));
    await findFileButton(/partial.txt/);
    expect(screen.getByRole('alert')).toHaveTextContent('附件列表尚未完整加载');
    expect(screen.getByRole('heading', { name: '附件' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重试附件' }));
    await screen.findByText('暂无附件，上传文件后即可在这里浏览。');
    expect(list.mock.calls[3]?.[2]).toEqual({ limit: 100 });
  });

  it('retries text previews and uses injected native preview and download URLs', async () => {
    const api = fixture([file('text.txt'), file('image.svg', 'image/svg+xml')]);
    const readText = vi.fn().mockRejectedValueOnce(new Error('private preview')).mockResolvedValue('Recovered');
    render(<TaskAttachments projectId="00000000-0000-4000-8000-000000000100" taskId="task" api={{ ...api, readText }} urls={{ page: (path) => `/reader/${path}`, previewRoot: '/fixtures/', preview: (path) => `/fixtures/${path}`, download: (path) => `/downloads/${path}` }} />);
    fireEvent.click(await findFileButton(/text.txt/));
    expect(await screen.findByRole('alert')).not.toHaveTextContent('private preview');
    fireEvent.click(screen.getByRole('button', { name: '重试预览' }));
    await screen.findByText('Recovered');
    fireEvent.click(fileButton(/image.svg/));
    expect(await screen.findByRole('img')).toHaveAttribute('src', '/fixtures/image.svg');
    expect(screen.getByRole('link', { name: '下载' })).toHaveAttribute('href', '/downloads/image.svg');
  });

  it('retries HTML availability failures before mounting its native frame and reloads successful overwrites', async () => {
    const api = fixture([file('site/index.html', 'text/html')]);
    const checkPreview = vi.fn().mockRejectedValueOnce(new Error('private native preview')).mockResolvedValue(undefined);
    open({ ...api, checkPreview });
    fireEvent.click(await findFileButton(/index.html/));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取文件预览');
    expect(screen.queryByTitle('HTML 预览：site/index.html')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试预览' }));
    const oldFrame = await screen.findByTitle('HTML 预览：site/index.html');
    fireEvent.load(oldFrame);
    expect(checkPreview).toHaveBeenCalledTimes(2);
    const user = userEvent.setup();
    await user.click(screen.getByText('上传文件', { selector: 'summary' }));
    await user.upload(screen.getByLabelText('选择一个文件'), new File(['<p>new</p>'], 'index.html', { type: 'text/html' }));
    const path = screen.getByRole('textbox', { name: '目标相对路径' });
    await user.clear(path);
    await user.type(path, 'site/index.html');
    await user.click(screen.getByRole('button', { name: '上传文件' }));
    await waitFor(() => expect(screen.getByTitle('HTML 预览：site/index.html')).not.toBe(oldFrame));
    expect(screen.getByTitle('HTML 预览：site/index.html')).toHaveAttribute('src', '/api/v1/projects/00000000-0000-4000-8000-000000000100/tasks/00000000-0000-4000-8000-000000000001/preview/site/index.html');
    expect(checkPreview).toHaveBeenCalledTimes(3);
  });

  it('requires a full-path menu and confirmation, defaults to Cancel, and sends no mutation on dismissal', async () => {
    const api = fixture([file('docs/设计 #?.md')]);
    open(api);
    await findFileButton(/设计/);
    const trigger = screen.getByRole('button', { name: '更多操作：docs/设计 #?.md' });
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const item = screen.getByRole('menuitem', { name: '删除' });
    expect(item).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(api.remove).not.toHaveBeenCalled();
    for (const key of ['ArrowUp', 'Home', 'End']) {
      fireEvent.keyDown(item, { key });
      expect(item).toHaveFocus();
    }
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    const dialog = showDeleteConfirmation('docs/设计 #?.md');
    expect(within(dialog).getByText('docs/设计 #?.md')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus();
    expect(api.remove).not.toHaveBeenCalled();
    await userEvent.setup().keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
    const escaped = showDeleteConfirmation('docs/设计 #?.md');
    fireEvent(escaped, new Event('cancel', { bubbles: false, cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const backdrop = showDeleteConfirmation('docs/设计 #?.md');
    fireEvent.click(backdrop, { clientX: -1, clientY: -1 });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.remove).not.toHaveBeenCalled();
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('wraps confirmation Tab boundaries and keeps pending focus within its enabled controls', async () => {
    const api = fixture([file('target.txt')]);
    const pending = deferred<void>();
    const remove = vi.fn<AttachmentApi['remove']>().mockReturnValue(pending.promise);
    open({ ...api, remove });
    await findFileButton(/target.txt/);
    const dialog = showDeleteConfirmation('target.txt');
    const language = within(dialog).getByRole('combobox', { name: '语言 / Language' });
    const body = within(dialog).getByRole('group', { name: '删除附件？' });
    const cancel = within(dialog).getByRole('button', { name: '取消' });
    const confirm = within(dialog).getByRole('button', { name: '删除附件' });
    const onOuterKey = vi.fn();
    document.addEventListener('keydown', onOuterKey);
    const user = userEvent.setup();
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(language).toHaveFocus();
    await user.tab();
    expect(body).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(body).toHaveFocus();
    await user.tab({ shift: true });
    expect(language).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    expect(onOuterKey).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(dialog).toHaveFocus();
    await user.tab();
    expect(language).toHaveFocus();
    await user.tab();
    expect(body).toHaveFocus();
    await user.tab();
    expect(language).toHaveFocus();
    await user.tab({ shift: true });
    expect(body).toHaveFocus();
    expect(remove).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', onOuterKey);
    await act(async () => pending.resolve());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('reacts to native outside dismissal and keeps menu keyboard events inside their layer', async () => {
    const api = fixture([file('first.txt'), file('last.txt')]);
    open(api);
    await findFileButton(/first.txt/);
    const first = screen.getByRole('button', { name: '更多操作：first.txt' });
    fireEvent.click(first);
    const menu = screen.getByRole('menu');
    fireEvent(menu, Object.assign(new Event('toggle'), { newState: 'closed' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(first).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(first);
    const onOuterKey = vi.fn();
    document.addEventListener('keydown', onOuterKey);
    fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(first).toHaveFocus();
    expect(onOuterKey).not.toHaveBeenCalled();
    document.removeEventListener('keydown', onOuterKey);
    expect(api.remove).not.toHaveBeenCalled();
  });

  it('confirms the exact unselected path while preserving preview DOM and reading position', async () => {
    const api = fixture([file('docs/readme.md'), file('other/readme.md')]);
    open(api);
    const selections = await screen.findAllByRole('button', { name: /readme.md/ });
    fireEvent.click(selections.find((button) => button.hasAttribute('aria-pressed'))!);
    const content = await screen.findByText('Contents of docs/readme.md');
    const preview = content.closest('.attachment-preview-body')!;
    preview.scrollTop = 240;
    const dialog = showDeleteConfirmation('other/readme.md');
    expect(within(dialog).getByText('other/readme.md')).toBeVisible();
    expect(screen.getByText('Contents of docs/readme.md')).toBe(content);
    fireEvent.click(within(dialog).getByRole('button', { name: '删除附件' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '更多操作：other/readme.md' })).toBeNull());
    expect(api.remove).toHaveBeenCalledExactlyOnceWith('00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000001', 'other/readme.md', expect.any(AbortSignal));
    expect(screen.getByText('Contents of docs/readme.md')).toBe(content);
    expect(content.closest('.attachment-preview-body')).toBe(preview);
    expect(preview.scrollTop).toBe(240);
    expect(api.readText).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the surviving preview pane while a successful deletion reload is pending', async () => {
    const api = fixture([file('target.txt')]);
    const pending = deferred<AttachmentPage>();
    const list = vi.fn<AttachmentApi['list']>().mockImplementationOnce(api.list).mockReturnValueOnce(pending.promise);
    open({ ...api, list });
    await findFileButton(/target.txt/);
    const dialog = showDeleteConfirmation('target.txt');
    fireEvent.click(within(dialog).getByRole('button', { name: '删除附件' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: '更多操作：target.txt' })).toBeNull();
    expect(screen.getByRole('button', { name: '刷新附件' })).toBeDisabled();
    expect(screen.getByRole('group', { name: '附件预览' })).toHaveFocus();
    await act(async () => pending.resolve({ items: [], nextCursor: null }));
    expect(screen.getByRole('group', { name: '附件预览' })).toHaveFocus();
  });

  it('blocks repeated confirmation and conflicting writes while the captured deletion is pending', async () => {
    const api = fixture([file('selected.txt'), file('target.txt')]);
    const pending = deferred<void>();
    const remove = vi.fn<AttachmentApi['remove']>().mockReturnValue(pending.promise);
    open({ ...api, remove });
    fireEvent.click(await findFileButton(/selected.txt/));
    await screen.findByText('Contents of selected.txt');
    const dialog = showDeleteConfirmation('target.txt');
    const confirm = within(dialog).getByRole('button', { name: '删除附件' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.keyDown(confirm, { key: 'Enter' });
    expect(within(dialog).getByRole('button', { name: '正在删除…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '刷新附件' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '更多操作：selected.txt' })).toBeDisabled();
    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    fireEvent.click(dialog, { clientX: -1, clientY: -1 });
    expect(dialog).toHaveAttribute('open');
    expect(remove).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Contents of selected.txt')).toBeVisible();
  });

  it('shows a deletion request ID with last-known content and retries only after another confirmation', async () => {
    const api = fixture([file('selected.txt')]);
    const remove = vi.fn<AttachmentApi['remove']>().mockRejectedValueOnce(new ApiError('server', 500, 'internal_error', 'delete-456')).mockImplementation(api.remove);
    open({ ...api, remove });
    fireEvent.click(await findFileButton(/selected.txt/));
    const content = await screen.findByText('Contents of selected.txt');
    const dialog = showDeleteConfirmation('selected.txt');
    fireEvent.click(within(dialog).getByRole('button', { name: '删除附件' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('delete-456');
    expect(screen.getByText('Contents of selected.txt')).toBe(content);
    expect(screen.getByRole('button', { name: '更多操作：selected.txt' })).toBeVisible();
    expect(remove).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: '删除附件' }));
    await screen.findByText('暂无附件，上传文件后即可在这里浏览。');
    expect(remove).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Contents of selected.txt')).toBeNull();
  });

  it('releases an unsubmitted confirmation when task identity changes', async () => {
    const api = fixture([file('old.txt')]);
    const view = open(api);
    await findFileButton(/old.txt/);
    const dialog = showDeleteConfirmation('old.txt');
    view.rerender(<TaskAttachments projectId="00000000-0000-4000-8000-000000000100" taskId="00000000-0000-4000-8000-000000000002" api={api} />);
    expect(dialog).not.toHaveAttribute('open');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.remove).not.toHaveBeenCalled();
    await findFileButton(/old.txt/);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('clears previous task preview and form synchronously and aborts old work', async () => {
    const next = deferred<AttachmentPage>();
    const api = fixture([file('old.txt')]);
    const list = vi.fn().mockImplementationOnce(api.list).mockReturnValue(next.promise);
    const injected = { ...api, list };
    const view = open(injected);
    fireEvent.click(await findFileButton(/old.txt/));
    await screen.findByText('Contents of old.txt');
    const user = userEvent.setup();
    await user.click(screen.getByText('上传文件', { selector: 'summary' }));
    await user.upload(screen.getByLabelText('选择一个文件'), new File(['old'], 'old-upload.txt'));
    view.rerender(<TaskAttachments projectId="00000000-0000-4000-8000-000000000100" taskId="00000000-0000-4000-8000-000000000002" api={injected} />);
    expect(screen.queryByText('Contents of old.txt')).toBeNull();
    expect(screen.getByText('上传文件', { selector: 'summary' }).parentElement).not.toHaveAttribute('open');
    expect(screen.getByLabelText('目标相对路径')).toHaveValue('');
    expect(screen.getByLabelText('选择一个文件')).not.toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('正在加载附件');
    expect(vi.mocked(api.readText).mock.calls[0]?.[3].aborted).toBe(true);
    await act(async () => next.resolve({ items: [], nextCursor: null }));
    expect(screen.getByText('暂无附件，上传文件后即可在这里浏览。')).toBeVisible();
    expect(within(screen.getByRole('region', { name: '附件 · 0' })).queryByRole('region', { name: '附件预览' })).toBeNull();
  });
});
