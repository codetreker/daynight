import { createElement } from 'react';
import { screen, within } from '@testing-library/react';
import { createLocaleRender } from './helpers/renderWithLocale';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TaskAttachments } from '../src/features/task-detail/attachments/TaskAttachments';
import { longConfirmationPath } from './mockups/attachment-paths';
import { createAttachmentFixture, mockupLongPath } from './mockups/fixture';

const render = createLocaleRender('zh-CN');
const signal = () => new AbortController().signal;

describe('development attachment fixture', () => {
  it('provides directory and native-format fixtures through production component contracts', async () => {
    const fixture = createAttachmentFixture('files');
    const page = await fixture.api.list('project', 'task', {}, signal());
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((item) => item.path)).toEqual(expect.arrayContaining(['docs/guide.md', 'images/workflow.svg', 'site/index.html', 'brief.pdf', 'archive.bin']));
    expect(await fixture.api.readText('project', 'task', 'docs/guide.md', signal())).toContain('| 文件 | 用途 |');
    expect(fixture.urls.preview('site/index.html')).toBe('/tests/mockups/files/site/index.html');
    expect(fixture.urls.download('brief.pdf')).toBe('/tests/mockups/files/brief.pdf');
    expect(fixture.urls.page('docs/guide.md')).toBe('/tests/mockups/attachments.html?file=docs%2Fguide.md&scenario=files');
    expect(await fixture.api.readText('project', 'task', mockupLongPath, signal())).toContain('Long text reading fixture');
    expect(fixture.urls.preview(mockupLongPath)).toBe('/tests/mockups/files/data/tall.txt');
    expect(new TextEncoder().encode(longConfirmationPath)).toHaveLength(723);
    expect(longConfirmationPath.split('/').every((part) => new TextEncoder().encode(part).length === 180)).toBe(true);
    expect(fixture.urls.preview(longConfirmationPath)).toBe('/tests/mockups/files/data/tall.txt');
    expect(await fixture.api.readText('project', 'task', longConfirmationPath, signal())).toContain('Long text reading fixture');
    expect(fixture.urls.previewRoot).toBe('/tests/mockups/files/');
    fixture.dispose();
  });

  it('accepts a relocatable asset root and standalone page for bundled interactive previews', () => {
    const fixture = createAttachmentFixture('files', { files: './files/', page: './index.html' });
    expect(fixture.urls.preview('site/index.html')).toBe('./files/site/index.html');
    expect(fixture.urls.previewRoot).toBe('./files/');
    expect(fixture.urls.page('docs/guide.md')).toBe('./index.html?file=docs%2Fguide.md&scenario=files');
    fixture.dispose();
  });

  it('adds, overwrites, deletes, and releases the page-owned object URLs', async () => {
    const create = vi.fn().mockReturnValueOnce('blob:one').mockReturnValueOnce('blob:two');
    const revoke = vi.fn();
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
    const fixture = createAttachmentFixture('empty');
    expect((await fixture.api.list('p', 't', {}, signal())).items).toHaveLength(0);
    const first = await fixture.api.put('p', 't', 'note.txt', new File(['first'], 'first.txt', { type: 'text/plain' }), signal());
    expect(fixture.urls.preview('note.txt')).toBe('blob:one');
    expect(await fixture.api.readText('p', 't', 'note.txt', signal())).toBe('first');
    const second = await fixture.api.put('p', 't', 'note.txt', new File(['second'], 'second.txt'), signal());
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.contentType).toBe('text/plain');
    expect(fixture.urls.download('note.txt')).toBe('blob:two');
    expect((await fixture.api.list('p', 't', {}, signal())).items).toHaveLength(1);
    await fixture.api.remove('p', 't', 'note.txt', signal());
    expect((await fixture.api.list('p', 't', {}, signal())).items).toHaveLength(0);
    expect(fixture.urls.preview('note.txt')).toBe('blob:two');
    expect(fixture.urls.download('note.txt')).toBe('blob:two');
    await expect(fixture.api.readText('p', 't', 'note.txt', signal())).rejects.toThrow('does not exist');
    expect(() => fixture.urls.preview('never-created.txt')).toThrow('never allocated');
    fixture.dispose();
    expect(revoke.mock.calls).toEqual([['blob:one'], ['blob:two']]);
  });

  it('keeps the production attachment section mounted after adding, overwriting, and deleting a file', async () => {
    const revoke = vi.fn();
    let nextUrl = 0;
    vi.stubGlobal('URL', class extends URL { static createObjectURL = () => `blob:mockup-${++nextUrl}`; static revokeObjectURL = revoke; });
    const fixture = createAttachmentFixture('empty');
    const view = render(createElement(TaskAttachments, { projectId: 'mockup-project', taskId: 'mockup-task', api: fixture.api, urls: fixture.urls }));
    await screen.findByText('暂无附件，上传文件后即可在这里浏览。');
    const user = userEvent.setup();
    const summary = screen.getByText('上传文件', { selector: 'summary' });
    expect(screen.getByLabelText('选择一个文件')).not.toBeVisible();
    await user.click(summary);
    const upload = async (contents: string) => {
      await user.upload(screen.getByLabelText('选择一个文件'), new File([contents], 'new.txt', { type: 'text/plain' }));
      const path = screen.getByRole('textbox', { name: '目标相对路径' });
      await user.clear(path);
      await user.type(path, 'notes/new.txt');
      await user.click(screen.getByRole('button', { name: '上传文件' }));
      await screen.findByText(contents);
    };
    await upload('First mockup contents');
    await upload('Overwritten mockup contents');
    expect(screen.getByRole('heading', { name: '附件 · 1' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '更多操作：notes/new.txt' }));
    await user.click(screen.getByRole('menuitem', { name: '删除' }));
    await user.click(within(screen.getByRole('dialog', { name: '删除附件？' })).getByRole('button', { name: '删除附件' }));
    await screen.findByText('暂无附件，上传文件后即可在这里浏览。');
    expect(screen.getByRole('heading', { name: '附件 · 0' })).toBeVisible();
    expect(screen.queryByRole('region', { name: '附件预览' })).toBeNull();
    expect(view.container).not.toBeEmptyDOMElement();
    expect(revoke).not.toHaveBeenCalled();
    fixture.dispose();
    expect(revoke.mock.calls).toEqual([['blob:mockup-1'], ['blob:mockup-2']]);
  });

  it('exposes a retryable deletion failure without changing its last-known inventory', async () => {
    const fixture = createAttachmentFixture('delete-error');
    const before = await fixture.api.list('p', 't', {}, signal());
    await expect(fixture.api.remove('p', 't', 'docs/guide.md', signal())).rejects.toMatchObject({ status: 503, requestId: 'mockup-delete-1' });
    expect(await fixture.api.list('p', 't', {}, signal())).toEqual(before);
    await fixture.api.remove('p', 't', 'docs/guide.md', signal());
    expect((await fixture.api.list('p', 't', {}, signal())).items.map(({ path }) => path)).not.toContain('docs/guide.md');
    expect((await fixture.api.list('p', 't', {}, signal())).items.map(({ path }) => path)).toContain('examples/guide.md');
    fixture.dispose();
  });

  it('keeps the pending-deletion fixture unsettled until its owning request is aborted', async () => {
    const fixture = createAttachmentFixture('delete-pending');
    const controller = new AbortController();
    const pending = fixture.api.remove('p', 't', 'docs/guide.md', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect((await fixture.api.list('p', 't', {}, signal())).items.map(({ path }) => path)).toContain('docs/guide.md');
    fixture.dispose();
  });

  it('keeps uploaded bytes and listing unchanged when its upload-error scenario rejects', async () => {
    const fixture = createAttachmentFixture('upload-error');
    const before = await fixture.api.list('p', 't', {}, signal());
    await expect(fixture.api.put('p', 't', 'new.txt', new File(['new'], 'new.txt'), signal())).rejects.toThrow('Mockup upload failed');
    expect(await fixture.api.list('p', 't', {}, signal())).toEqual(before);
    fixture.dispose();
  });
});
