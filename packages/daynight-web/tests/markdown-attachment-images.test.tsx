import { fireEvent, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MarkdownContent } from '../src/features/task-detail/MarkdownContent';
import { resolveMarkdownAttachmentUrl, type MarkdownAttachmentBase } from '../src/features/task-detail/attachments/model';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const root = '/api/v1/projects/p/tasks/t/preview/';
const markdown = (text: string, remotePaused = false, attachmentBase: MarkdownAttachmentBase = { kind: 'root' }) =>
  <MarkdownContent className="test-markdown" attachmentBase={attachmentBase} text={text} remotePaused={remotePaused} resolveUrl={(value) => resolveMarkdownAttachmentUrl(value, attachmentBase, root)} />;

it('retries only the failed attachment image with its unchanged encoded URL', () => {
  const text = '![Broken](images/a%20b.png?size=2%2F3#part) ![Loaded](ok.png)\n\n[Other](guide.md)';
  const view = render(<section><input aria-label="Draft" defaultValue="unsaved" />{markdown(text)}</section>);
  const broken = screen.getByRole('img', { name: 'Broken' });
  const loaded = screen.getByRole('img', { name: 'Loaded' });
  const link = screen.getByRole('link', { name: 'Other' });
  const draft = screen.getByRole('textbox');
  fireEvent.load(loaded);
  fireEvent.error(broken);
  expect(screen.getByRole('alert', { name: 'Broken' })).toHaveTextContent('Unable to load the attachment image. Try again.');
  expect(view.container.querySelector('p > span.markdown-image-error')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry image' }));
  const retried = screen.getByRole('img', { name: 'Broken' });
  expect(retried).not.toBe(broken);
  expect(retried).toHaveAttribute('src', `${root}images/a%20b.png?size=2%2F3#part`);
  fireEvent.load(retried);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('img', { name: 'Loaded' })).toBe(loaded);
  expect(screen.getByRole('link', { name: 'Other' })).toBe(link);
  expect(screen.getByRole('textbox')).toBe(draft);
  expect(draft).toHaveValue('unsaved');
});

it('uses the document directory for attachment images and preserves native failures', () => {
  render(markdown('![Relative](../images/%E4%B8%AD.png?raw=1#x) ![External](https://example.com/image.png) ![Absolute](/image.png) ![Protocol](//example.com/image.png) ![Fragment](#image) ![Invalid](../../outside.png)', false, { kind: 'document', path: 'docs/guide.md' }));
  const relative = screen.getByRole('img', { name: 'Relative' });
  expect(relative).toHaveAttribute('src', `${root}images/%E4%B8%AD.png?raw=1#x`);
  for (const name of ['External', 'Absolute', 'Protocol', 'Fragment', 'Invalid']) fireEvent.error(screen.getByRole('img', { name }));
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.error(relative);
  expect(screen.getByRole('alert', { name: 'Relative' })).toBeVisible();
});

it('keeps failures visible with retry disabled while paused and preserves loaded images', () => {
  const text = '![Broken](bad.png) ![Loaded](good.png) ![Pending](pending.png)';
  const view = render(markdown(text));
  const loaded = screen.getByRole('img', { name: 'Loaded' });
  fireEvent.load(loaded);
  fireEvent.error(screen.getByRole('img', { name: 'Broken' }));
  view.rerender(markdown(text, true));
  expect(screen.getByRole('button', { name: 'Retry image' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry image' }));
  expect(screen.queryByRole('img', { name: 'Broken' })).toBeNull();
  expect(screen.getByRole('img', { name: 'Loaded' })).toBe(loaded);
  expect(loaded).toHaveAttribute('src', `${root}good.png`);
  const pending = screen.getByRole('img', { name: 'Pending' });
  expect(pending).not.toHaveAttribute('src');
  fireEvent.load(pending);
  fireEvent.error(pending);
  expect(pending).not.toHaveAttribute('src');
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  view.rerender(markdown(text));
  expect(pending).toHaveAttribute('src', `${root}pending.png`);
  fireEvent.click(screen.getByRole('button', { name: 'Retry image' }));
  expect(screen.getByRole('img', { name: 'Broken' })).toHaveAttribute('src', `${root}bad.png`);
});

it('does not request new paused sources or let detached image events change the current source', () => {
  const view = render(markdown('![Image](old.png)'));
  const old = screen.getByRole('img', { name: 'Image' });
  view.rerender(markdown('![Image](new.png)', true));
  const next = screen.getByRole('img', { name: 'Image' });
  expect(next).not.toBe(old);
  expect(next).not.toHaveAttribute('src');
  fireEvent.load(old);
  fireEvent.error(old);
  expect(next).not.toHaveAttribute('src');
  expect(screen.queryByRole('alert')).toBeNull();
  view.rerender(markdown('![Image](new.png)'));
  fireEvent.error(next);
  fireEvent.click(screen.getByRole('button', { name: 'Retry image' }));
  const retried = screen.getByRole('img', { name: 'Image' });
  fireEvent.error(next);
  fireEvent.load(next);
  expect(screen.getByRole('img', { name: 'Image' })).toBe(retried);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('localizes a visible failure without replacing its recovery state', () => {
  const view = render(markdown('![Image](image.png)'));
  fireEvent.error(screen.getByRole('img'));
  view.setLocale('zh-CN');
  expect(screen.getByRole('alert')).toHaveTextContent('无法加载附件图片，请重试。');
  expect(screen.getByRole('button', { name: '重试图片' })).toBeVisible();
});

it('retries linked images without following the enclosing Markdown link', () => {
  const onLinkClick = vi.fn();
  const base = { kind: 'root' } as const;
  render(<MarkdownContent className="test-markdown" attachmentBase={base} text="[![Image](bad.png)](other.md)" resolveUrl={(value) => resolveMarkdownAttachmentUrl(value, base, root)} onLinkClick={onLinkClick} />);
  fireEvent.error(screen.getByRole('img'));
  fireEvent.click(screen.getByRole('button', { name: 'Retry image' }));
  expect(onLinkClick).not.toHaveBeenCalled();
  expect(screen.getByRole('img')).toHaveAttribute('src', `${root}bad.png`);
});
