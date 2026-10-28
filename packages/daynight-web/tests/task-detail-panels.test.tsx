import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Attachment } from '../src/api/types';
import { TaskDetailPanels } from '../src/features/task-detail/TaskDetailPanels';
import { TaskAttachments } from '../src/features/task-detail/attachments/TaskAttachments';
import type { AttachmentApi } from '../src/features/task-detail/attachments/useAttachments';
import { dialogFocusables } from '../src/features/task-detail/focus';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('zh-CN');
const item: Attachment = { path: 'site/index.html', contentType: 'text/html', sizeBytes: 10, createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z' };
const fixture = (): AttachmentApi => ({ list: vi.fn(async () => ({ items: [item], nextCursor: null })), checkPreview: vi.fn(async () => {}), readText: vi.fn(async () => ''), put: vi.fn(), remove: vi.fn() });
const panels = (api: AttachmentApi, task = 'first') => <TaskDetailPanels key={task} overview={<a href="#overview">Overview link</a>} attachments={<TaskAttachments projectId="project" taskId={task} api={api} urls={{ page: (path) => `/reader/${path}`, previewRoot: "/fixtures/", preview: (path) => `/fixtures/${path}`, download: (path) => `/fixtures/${path}` }} />} />;

describe('task detail panels', () => {
  it('associates panels, supports automatic arrow/Home/End activation and native Enter/Space, and excludes hidden controls', async () => {
    const view = render(panels(fixture()));
    const overview = screen.getByRole('tab', { name: '概览' });
    const attachments = screen.getByRole('tab', { name: '附件' });
    expect(overview).toHaveAttribute('aria-selected', 'true');
    expect(attachments).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel', { name: '概览' })).toHaveAttribute('id', overview.getAttribute('aria-controls'));
    expect(dialogFocusables(view.container)).toEqual([overview, screen.getByRole('link')]);
    const user = userEvent.setup();
    overview.focus();
    for (const key of ['{ArrowRight}', '{Home}', '{ArrowLeft}', '{End}']) {
      await user.keyboard(key);
      const target = key === '{Home}' ? overview : attachments;
      expect(target).toHaveFocus();
      expect(target).toHaveAttribute('aria-selected', 'true');
    }
    expect(screen.queryByRole('link')).toBeNull();
    expect(dialogFocusables(view.container)).not.toContain(screen.getByText('Overview link'));
    await user.keyboard('{Home}');
    attachments.focus();
    await user.keyboard('{Enter}');
    expect(attachments).toHaveAttribute('aria-selected', 'true');
    overview.focus();
    await user.keyboard(' ');
    expect(overview).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(overview, { key: 'ArrowDown' });
    expect(overview).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps the controller, native frame, directory state and upload draft across tab switches and resets by task', async () => {
    const api = fixture();
    const view = render(panels(api));
    fireEvent.click(screen.getByRole('tab', { name: '附件' }));
    const directory = (await screen.findByText('site', { selector: 'summary' })).parentElement!;
    expect(directory).not.toHaveAttribute('open');
    expect(screen.getByText('index.html')).not.toBeVisible();
    fireEvent.click(screen.getByText('site', { selector: 'summary' }));
    fireEvent.click(await screen.findByRole('button', { name: /index.html/, pressed: false }));
    const frame = await screen.findByTitle('HTML 预览：site/index.html') as HTMLIFrameElement;
    fireEvent.load(frame);
    const content = frame.contentDocument!;
    content.appendChild(content.createElement('html')).appendChild(content.createElement('body'));
    content.body.innerHTML = '<button id="inner">Inside frame</button>';
    directory.removeAttribute('open');
    fireEvent(directory, new Event('toggle'));
    const source = new File(['draft'], 'draft.txt');
    const user = userEvent.setup();
    const summary = screen.getByText('上传文件', { selector: 'summary' });
    const input = screen.getByLabelText('选择一个文件') as HTMLInputElement;
    expect(input).not.toBeVisible();
    expect(dialogFocusables(view.container)).toContain(summary);
    expect(dialogFocusables(view.container)).not.toContain(input);
    await user.click(summary);
    await user.upload(input, source);
    const path = screen.getByRole('textbox', { name: '目标相对路径' });
    fireEvent.change(path, { target: { value: 'drafts/unsent.txt' } });
    await user.click(summary);
    content.getElementById('inner')!.focus();
    expect(document.activeElement).toBe(frame);
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    expect(screen.getByRole('tab', { name: '概览' })).toHaveFocus();
    expect(frame.closest('[role="tabpanel"]')).toHaveAttribute('inert');
    expect(dialogFocusables(view.container)).not.toContain(frame);
    fireEvent.click(screen.getByRole('tab', { name: '附件' }));
    expect(screen.getByTitle('HTML 预览：site/index.html')).toBe(frame);
    expect(screen.getByText('上传文件', { selector: 'summary' })).toBe(summary);
    expect(summary.parentElement).not.toHaveAttribute('open');
    expect(input).not.toBeVisible();
    await user.click(summary);
    expect(screen.getByRole('textbox', { name: '目标相对路径' })).toBe(path);
    expect(path).toHaveValue('drafts/unsent.txt');
    expect(input.files?.[0]).toBe(source);
    expect(directory).not.toHaveAttribute('open');
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.checkPreview).toHaveBeenCalledTimes(1);
    view.rerender(panels(api, 'second'));
    expect(screen.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
    expect(view.container.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '附件' }));
    expect(screen.getByText('上传文件', { selector: 'summary' }).parentElement).not.toHaveAttribute('open');
    expect(screen.getByLabelText('目标相对路径')).toHaveValue('');
    expect((screen.getByLabelText('选择一个文件') as HTMLInputElement).files).toHaveLength(0);
    await act(async () => {});
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});

describe('task session panel availability', () => {
  it('adds a keyboard reachable session only when supplied and falls back when removed', () => {
    const view = render(<TaskDetailPanels overview={<p>Overview content</p>} attachments={<p>Attachments content</p>} session={<textarea aria-label="Session draft" />} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: '概览' }), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Session' }));
    expect(screen.getByRole('textbox')).toHaveValue('draft');
    view.rerender(<TaskDetailPanels overview={<p>Overview content</p>} attachments={<p>Attachments content</p>} />);
    expect(screen.queryByRole('tab', { name: 'Session' })).toBeNull();
    expect(screen.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
  });
});
