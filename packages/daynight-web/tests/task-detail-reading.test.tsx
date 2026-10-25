import { createRef, useState } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { TaskDetailNavigation } from '../src/app/router';
import type { Attachment, AttachmentPage } from '../src/api/types';
import { TaskDetailReading } from '../src/features/task-detail/TaskDetailReading';
import type { AttachmentKeyboardOwner } from '../src/features/task-detail/attachments/AttachmentPreview';
import type { AttachmentApi } from '../src/features/task-detail/attachments/useAttachments';
import { LanguageSelector } from '../src/i18n/LanguageSelector';
import { createLocaleRender, renderWithLocale } from './helpers/renderWithLocale';

const render = createLocaleRender('zh-CN');
const projectId = '00000000-0000-4000-8000-000000000100';
const taskId = '00000000-0000-4000-8000-000000000001';
const root = `/api/v1/projects/${projectId}/tasks/${taskId}/preview/`;
const time = '2026-10-21T00:00:00Z';
const file = (path: string, contentType = 'text/markdown'): Attachment => ({ path, contentType, sizeBytes: 10, createdAt: time, updatedAt: time });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const fixture = (items: readonly Attachment[] = [file('plan.md')]): AttachmentApi => ({
  list: vi.fn(async () => ({ items, nextCursor: null })),
  readText: vi.fn(async (_project, _task, path) => `# Preview ${path}`),
  checkPreview: vi.fn(async () => {}), put: vi.fn(), remove: vi.fn(),
});
const reading = (api: AttachmentApi, description = '[方案](plan.md)', id = taskId) => <TaskDetailReading key={id} projectId={projectId} taskId={id} api={api} description={description} overview={(content) => <section aria-label="描述">{content}</section>} />;
const showOverview = () => fireEvent.click(screen.getByRole('tab', { name: '概览' }));
const pane = () => screen.getByRole('group', { name: '附件预览' });

describe('task description reading', () => {
  it('reveals only linked ancestors and reapplies the same link after manual collapse', async () => {
    const path = 'docs/design/方案 %?#.md';
    const api = fixture([file(path), file('docs2/other.md'), file('images/icon.svg'), file('root.md')]);
    render(reading(api, '[方案](docs/design/方案%20%25%3F%23.md) [根文件](root.md)'));
    fireEvent.click(screen.getByRole('tab', { name: '附件' }));
    const docs = (await screen.findByText('docs', { selector: 'summary' })).parentElement!;
    const design = screen.getByText('design', { selector: 'summary' }).parentElement!;
    const docs2 = screen.getByText('docs2', { selector: 'summary' }).parentElement!;
    const images = screen.getByText('images', { selector: 'summary' }).parentElement!;
    expect(docs).not.toHaveAttribute('open');
    expect(design).not.toHaveAttribute('open');
    expect(screen.getByText('方案 %?#.md')).not.toBeVisible();
    showOverview();
    fireEvent.click(screen.getByRole('link', { name: '方案' }));
    await screen.findByRole('heading', { name: `Preview ${path}` });
    expect(docs).toHaveAttribute('open');
    expect(design).toHaveAttribute('open');
    expect(docs2).not.toHaveAttribute('open');
    expect(images).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('docs', { selector: 'summary' }));
    fireEvent.click(screen.getByRole('button', { name: '刷新附件' }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(docs).not.toHaveAttribute('open');
    showOverview();
    fireEvent.click(screen.getByRole('tab', { name: '附件' }));
    expect(docs).not.toHaveAttribute('open');
    showOverview();
    fireEvent.click(screen.getByRole('link', { name: '方案' }));
    expect(docs).toHaveAttribute('open');
    expect(screen.getByText('方案 %?#.md')).toBeVisible();
    fireEvent.click(screen.getByText('docs', { selector: 'summary' }));
    showOverview();
    fireEvent.click(screen.getByRole('link', { name: '根文件' }));
    await screen.findByRole('heading', { name: 'Preview root.md' });
    expect(docs).not.toHaveAttribute('open');
    expect(docs2).not.toHaveAttribute('open');
    expect(images).not.toHaveAttribute('open');
  });

  it('records route ancestors before delayed pages arrive and reveals later external paths', async () => {
    const page = deferred<AttachmentPage>();
    const api = { ...fixture(), list: vi.fn().mockResolvedValueOnce({ items: [file('root.md')], nextCursor: 'next' }).mockReturnValueOnce(page.promise).mockResolvedValue({ items: [file('root.md'), file('docs/design/spec.md'), file('other/next.md')], nextCursor: null }) };
    const content = (path: string | null) => <TaskDetailReading projectId={projectId} taskId={taskId} api={api} description="Description" selection={{ tab: 'attachments', path }} overview={(description) => description} />;
    const view = render(content('docs/design/spec.md'));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    await act(async () => page.resolve({ items: [file('docs/design/spec.md'), file('other/next.md')], nextCursor: null }));
    await screen.findByRole('heading', { name: 'Preview docs/design/spec.md' });
    const docs = screen.getByText('docs', { selector: 'summary' }).parentElement!;
    const design = screen.getByText('design', { selector: 'summary' }).parentElement!;
    const other = screen.getByText('other', { selector: 'summary' }).parentElement!;
    expect(docs).toHaveAttribute('open');
    expect(design).toHaveAttribute('open');
    expect(other).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('docs', { selector: 'summary' }));
    view.rerender(content('other/next.md'));
    await screen.findByRole('heading', { name: 'Preview other/next.md' });
    expect(other).toHaveAttribute('open');
    expect(docs).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('other', { selector: 'summary' }));
    view.rerender(content('docs/design/spec.md'));
    await screen.findByRole('heading', { name: 'Preview docs/design/spec.md' });
    expect(docs).toHaveAttribute('open');
    expect(other).not.toHaveAttribute('open');
  });

  it('does not treat the controlled route update after an upload as an external reveal', async () => {
    const items: Attachment[] = [];
    const api = { ...fixture(), list: vi.fn(async () => ({ items: [...items], nextCursor: null })), put: vi.fn(async (_project: string, _task: string, path: string) => { const item = file(path); items.push(item); return item; }) };
    const Content = () => {
      const [selection, setSelection] = useState<TaskDetailNavigation>({ tab: 'attachments', path: null });
      return <TaskDetailReading projectId={projectId} taskId={taskId} api={api} description="Description" selection={selection} onSelectionChange={setSelection} overview={(description) => description} />;
    };
    render(<Content />);
    await screen.findByText('暂无附件，上传文件后即可在这里浏览。');
    fireEvent.click(screen.getByText('上传文件', { selector: 'summary' }));
    fireEvent.change(screen.getByLabelText('选择一个文件'), { target: { files: [new File(['new'], 'new.md', { type: 'text/markdown' })] } });
    fireEvent.change(screen.getByRole('textbox', { name: '目标相对路径' }), { target: { value: 'docs/design/new.md' } });
    fireEvent.click(screen.getByRole('button', { name: '上传文件' }));
    await screen.findByRole('heading', { name: 'Preview docs/design/new.md' });
    expect(screen.getByText('docs', { selector: 'summary' }).parentElement).not.toHaveAttribute('open');
    expect(screen.getByText('design', { selector: 'summary' }).parentElement).not.toHaveAttribute('open');
    expect(screen.getByText('new.md', { selector: '.attachment-file-name' })).not.toBeVisible();
  });

  it('renders Markdown structure, root images, original raw HTML and the existing URL policy', async () => {
    const api = fixture();
    const source = '# 中英文 Heading\n\nParagraph **bold**.\n\n- One\n- Two\n\n> Quote\n\n```ts\nconst x = 1;\n```\n\n| Name | State |\n| --- | --- |\n| 中文 | Ready |\n\n![图示](images/图%20示.svg)\n\n[Unsafe](javascript:alert%281%29) [External](https://example.com)\n\n<script>privateMarkup()</script>';
    const view = render(reading(api, source));
    expect(screen.getByRole('heading', { name: '中英文 Heading' })).toBeVisible();
    expect(screen.getByRole('list')).toHaveTextContent('One Two');
    expect(screen.getByRole('table')).toHaveTextContent('中文Ready');
    expect(view.container.querySelector('blockquote')).toHaveTextContent('Quote');
    expect(view.container.querySelector('pre code')?.textContent).toBe('const x = 1;\n');
    expect(screen.getByRole('img', { name: '图示' })).toHaveAttribute('src', `${root}images/%E5%9B%BE%20%E7%A4%BA.svg`);
    expect(screen.getByText('Unsafe')).toHaveAttribute('href', '');
    expect(screen.getByRole('link', { name: 'External' })).toHaveAttribute('href', 'https://example.com');
    expect(screen.getByText('<script>privateMarkup()</script>')).toBeVisible();
    expect(view.container.querySelector('script')).toBeNull();
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce());
    view.rerender(reading(api, ''));
    expect(screen.getByText('暂无描述')).toBeVisible();
    expect(api.list).toHaveBeenCalledOnce();
  });

  it('hands an encoded root reference to the single mounted controller and focuses the existing preview pane', async () => {
    const item = file('docs/方案 %?#.md');
    const api = fixture([item]);
    render(reading(api, '[方案](docs/方案%20%25%3F%23.md)'));
    const link = screen.getByRole('link', { name: '方案' });
    expect(link).toHaveAttribute('href', `${root}docs/%E6%96%B9%E6%A1%88%20%25%3F%23.md`);
    expect(fireEvent.click(link)).toBe(false);
    expect(screen.getByRole('tab', { name: '附件' })).toHaveAttribute('aria-selected', 'true');
    expect(pane()).toHaveFocus();
    await screen.findByRole('heading', { name: `Preview ${item.path}` });
    expect(api.readText).toHaveBeenCalledWith(projectId, taskId, item.path, expect.any(AbortSignal));
    expect(screen.getByRole('button', { name: /方案/, pressed: true })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('link', { name: '在新标签页打开' })).toHaveAttribute('href', `/projects/${projectId}/tasks/${taskId}/attachments/docs/%E6%96%B9%E6%A1%88%20%25%3F%23.md`);
    showOverview();
    fireEvent.click(link);
    expect(pane()).toHaveFocus();
    expect(api.list).toHaveBeenCalledOnce();
    expect(api.readText).toHaveBeenCalledOnce();
  });

  it('preserves frame identity and current browser keyboard ownership across description and tab navigation', async () => {
    const api = fixture([file('mockui/index.html', 'text/html')]);
    render(reading(api, '[原型](mockui/index.html)'));
    fireEvent.click(screen.getByRole('link', { name: '原型' }));
    const frame = await screen.findByTitle('HTML 预览：mockui/index.html');
    showOverview();
    fireEvent.click(screen.getByRole('link', { name: '原型' }));
    expect(screen.getByTitle('HTML 预览：mockui/index.html')).toBe(frame);
    expect(pane()).toHaveFocus();
    expect(api.checkPreview).toHaveBeenCalledOnce();
    expect(api.list).toHaveBeenCalledOnce();
  });

  it('preserves a loaded frame, upload draft and controller while keyboard ownership changes', async () => {
    const api = fixture([file('mockui/index.html', 'text/html')]);
    const ownerRoot = createRef<HTMLElement>();
    const onEscape = vi.fn();
    const content = (keyboardOwner?: AttachmentKeyboardOwner) => <main ref={ownerRoot}><TaskDetailReading projectId={projectId} taskId={taskId} api={api} description="Description" selection={{ tab: 'attachments', path: 'mockui/index.html' }} overview={(description) => description} {...(keyboardOwner === undefined ? {} : { keyboardOwner })} /></main>;
    const view = render(content());
    const frame = await screen.findByTitle('HTML 预览：mockui/index.html') as HTMLIFrameElement;
    fireEvent.load(frame);
    const frameDocument = frame.contentDocument!;
    screen.getByText('上传文件', { selector: 'summary' }).parentElement!.setAttribute('open', '');
    const fileInput = screen.getByLabelText('选择一个文件') as HTMLInputElement;
    const upload = new File(['draft'], 'draft.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [upload] } });
    const path = screen.getByRole('textbox', { name: '目标相对路径' });
    fireEvent.change(path, { target: { value: 'draft/未提交.txt' } });
    view.rerender(content({ root: ownerRoot, onEscape }));
    fireEvent.keyDown(frameDocument, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledOnce();
    expect(screen.getByTitle('HTML 预览：mockui/index.html')).toBe(frame);
    expect(screen.getByLabelText('选择一个文件')).toBe(fileInput);
    expect(fileInput.files?.[0]).toBe(upload);
    expect(path).toHaveValue('draft/未提交.txt');
    view.rerender(content());
    expect(fireEvent.keyDown(frameDocument, { key: 'Escape' })).toBe(true);
    expect(screen.getByTitle('HTML 预览：mockui/index.html')).toBe(frame);
    expect(api.list).toHaveBeenCalledOnce();
    expect(api.checkPreview).toHaveBeenCalledOnce();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('keeps an HTML frame unmounted when inventory resolution starts its availability check', async () => {
    const item = file('mockui/index.html', 'text/html');
    const inventory = deferred<AttachmentPage>();
    const availability = deferred<void>();
    const title = 'HTML 预览：mockui/index.html';
    const framesAtCheck: (HTMLElement | null)[] = [];
    const api = {
      ...fixture([item]),
      list: vi.fn(() => inventory.promise),
      checkPreview: vi.fn(() => {
        framesAtCheck.push(screen.queryByTitle(title));
        return availability.promise;
      }),
    };
    render(reading(api, '[原型](mockui/index.html)'));
    fireEvent.click(screen.getByRole('link', { name: '原型' }));
    expect(screen.queryByTitle(title)).toBeNull();
    expect(api.checkPreview).not.toHaveBeenCalled();
    await act(async () => { inventory.resolve({ items: [item], nextCursor: null }); });
    expect(framesAtCheck).toEqual([null]);
    expect(screen.queryByTitle(title)).toBeNull();
    expect(within(pane()).getByRole('status')).toHaveTextContent('正在加载预览');
    await act(async () => { availability.resolve(); });
    expect(await screen.findByTitle(title)).toBeVisible();
    expect(api.checkPreview).toHaveBeenCalledOnce();
    expect(api.list).toHaveBeenCalledOnce();
  });

  it('leaves modified, non-primary, absolute, fragment and query/hash activation native', async () => {
    const api = fixture();
    render(reading(api, '[方案](plan.md) [Query](plan.md?raw=1) [Hash](plan.md#part) [Root](/plan.md) [Protocol](https://example.com) [Fragment](#part) [Query only](?raw=1)'));
    const preventNavigation = (event: MouseEvent) => event.preventDefault();
    document.addEventListener('click', preventNavigation);
    try {
      const link = screen.getByRole('link', { name: '方案' });
      for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) fireEvent.click(link, options);
      for (const name of ['Query', 'Hash', 'Root', 'Protocol', 'Fragment', 'Query only']) fireEvent.click(screen.getByRole('link', { name }));
      fireEvent.contextMenu(link);
      expect(screen.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('link', { name: 'Query only' })).toHaveAttribute('href', `${root}?raw=1`);
      expect(api.readText).not.toHaveBeenCalled();
      await waitFor(() => expect(api.list).toHaveBeenCalledOnce());
    } finally { document.removeEventListener('click', preventNavigation); }
  });

  it('waits for all inventory pages before showing missing, retains a later match and never creates a second list', async () => {
    const page = deferred<AttachmentPage>();
    const api = { ...fixture(), list: vi.fn().mockResolvedValueOnce({ items: [file('other.md')], nextCursor: 'second' }).mockReturnValueOnce(page.promise) };
    render(reading(api));
    fireEvent.click(screen.getByRole('link', { name: '方案' }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(within(pane()).getByRole('status')).toHaveTextContent('正在加载附件');
    expect(screen.queryByText('找不到此附件，文件可能已被删除。')).toBeNull();
    await act(async () => page.resolve({ items: [file('plan.md')], nextCursor: null }));
    await screen.findByRole('heading', { name: 'Preview plan.md' });
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('shows list failures separately from missing and retries the same pending path through the inventory owner', async () => {
    const api = fixture();
    const failure = new ApiError('server', 500, 'server', 'inventory-123');
    vi.mocked(api.list).mockRejectedValueOnce(failure);
    render(reading(api));
    fireEvent.click(screen.getByRole('link', { name: '方案' }));
    const alert = await within(pane()).findByRole('alert');
    expect(alert).toHaveTextContent('附件列表加载失败');
    expect(alert).toHaveTextContent('inventory-123');
    expect(alert).not.toHaveTextContent('不存在');
    fireEvent.click(within(pane()).getByRole('button', { name: '重试附件' }));
    await screen.findByRole('heading', { name: 'Preview plan.md' });
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('distinguishes invalid paths, complete inventory missing files and preview read failures with local retry', async () => {
    const api = fixture();
    const read = vi.mocked(api.readText).mockRejectedValueOnce(new ApiError('server', 500, 'server', 'preview-123'));
    render(reading(api, '[Escape](../escape.md) [Encoded](%2e%2e/escape.md) [Missing](missing.md) [方案](plan.md)'));
    for (const name of ['Escape', 'Encoded']) {
      fireEvent.click(screen.getByText(name));
      expect(within(pane()).getByRole('alert')).toHaveTextContent('此附件引用无效或超出了任务附件根目录');
      expect(pane()).toHaveFocus();
      showOverview();
    }
    fireEvent.click(screen.getByRole('link', { name: 'Missing' }));
    await within(pane()).findByText('找不到此附件，文件可能已被删除。');
    fireEvent.click(within(pane()).getByRole('button', { name: '重试附件' }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    showOverview();
    fireEvent.click(screen.getByRole('link', { name: '方案' }));
    expect(await within(pane()).findByRole('alert')).toHaveTextContent('无法读取文件预览');
    expect(within(pane()).getByRole('alert')).toHaveTextContent('preview-123');
    fireEvent.click(within(pane()).getByRole('button', { name: '重试预览' }));
    await screen.findByRole('heading', { name: 'Preview plan.md' });
    expect(read).toHaveBeenCalledTimes(2);
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('dismisses unsubmitted file menus and confirmation when the attachment panel is hidden', async () => {
    const api = fixture();
    render(reading(api));
    fireEvent.click(screen.getByRole('tab', { name: '附件' }));
    const actions = await screen.findByRole('button', { name: '更多操作：plan.md' });
    fireEvent.click(actions);
    expect(screen.getByRole('menu')).toBeVisible();
    showOverview();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '附件' }));
    fireEvent.click(actions);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    expect(screen.getByRole('dialog', { name: '删除附件？' })).toBeVisible();
    showOverview();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it('lets manual selection supersede a pending description request without later selection or focus changes', async () => {
    const page = deferred<AttachmentPage>();
    const api = { ...fixture(), list: vi.fn().mockResolvedValueOnce({ items: [file('other.md')], nextCursor: 'second' }).mockReturnValueOnce(page.promise) };
    render(reading(api));
    fireEvent.click(screen.getByRole('link', { name: '方案' }));
    const other = await screen.findByRole('button', { name: /other.md/, pressed: false });
    other.focus();
    fireEvent.click(other);
    await screen.findByRole('heading', { name: 'Preview other.md' });
    showOverview();
    await act(async () => page.resolve({ items: [file('plan.md')], nextCursor: null }));
    expect(screen.getByRole('tab', { name: '概览' })).toHaveFocus();
    fireEvent.click(screen.getByRole('tab', { name: '附件' }));
    expect(other).toHaveAttribute('aria-pressed', 'true');
    expect(api.readText).toHaveBeenCalledOnce();
    expect(api.readText).toHaveBeenCalledWith(projectId, taskId, 'other.md', expect.any(AbortSignal));
  });

  it('aborts old task inventory and previews on switch and close and ignores late ownership', async () => {
    const pending = deferred<string>();
    const api = fixture();
    vi.mocked(api.readText).mockReturnValueOnce(pending.promise);
    const view = render(reading(api));
    fireEvent.click(screen.getByRole('link', { name: '方案' }));
    await waitFor(() => expect(api.readText).toHaveBeenCalledOnce());
    const oldSignal = vi.mocked(api.readText).mock.calls[0]![3];
    const next = '00000000-0000-4000-8000-000000000002';
    view.rerender(reading(api, '[Next](plan.md)', next));
    expect(oldSignal.aborted).toBe(true);
    expect(screen.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('link', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Preview plan.md' });
    await act(async () => pending.resolve('# Stale private content'));
    expect(screen.queryByRole('heading', { name: 'Stale private content' })).toBeNull();
    const page = deferred<AttachmentPage>();
    vi.mocked(api.list).mockReturnValueOnce(page.promise);
    fireEvent.click(screen.getByRole('button', { name: '刷新附件' }));
    const listSignal = vi.mocked(api.list).mock.calls.at(-1)![3];
    view.unmount();
    expect(listSignal.aborted).toBe(true);
  });

  it('retranslates description and navigation status while keeping the controller, pending read and upload draft', async () => {
    const pending = deferred<string>();
    const api = fixture();
    vi.mocked(api.readText).mockReturnValueOnce(pending.promise);
    const source = '# 用户 Markdown\n\n[方案](plan.md)';
    renderWithLocale(<><LanguageSelector />{reading(api, source)}</>, { locale: 'en' });
    fireEvent.click(screen.getByRole('link', { name: '方案' }));
    await waitFor(() => expect(api.readText).toHaveBeenCalledOnce());
    const previewPane = screen.getByRole('group', { name: 'Attachment preview' });
    const disclosure = screen.getByText('Upload file', { selector: 'summary' }).parentElement!;
    disclosure.setAttribute('open', '');
    const input = screen.getByRole('textbox', { name: 'Target relative path' });
    fireEvent.change(input, { target: { value: 'draft/未提交.md' } });
    fireEvent.change(screen.getByRole('combobox', { name: '语言 / Language' }), { target: { value: 'zh-CN' } });
    expect(screen.getByRole('group', { name: '附件预览' })).toBe(previewPane);
    expect(screen.getByRole('textbox', { name: '目标相对路径' })).toBe(input);
    expect(input).toHaveValue('draft/未提交.md');
    expect(api.list).toHaveBeenCalledOnce();
    expect(api.readText).toHaveBeenCalledOnce();
    await act(async () => pending.resolve('# 已读取'));
    await screen.findByRole('heading', { name: '已读取' });
    showOverview();
    expect(screen.getByRole('heading', { name: '用户 Markdown' })).toBeVisible();
  });
});
