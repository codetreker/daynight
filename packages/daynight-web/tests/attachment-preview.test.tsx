import { flushSync } from 'react-dom';
import { fireEvent, screen } from '@testing-library/react';
import { createLocaleRender } from './helpers/renderWithLocale';
import { describe, expect, it, vi } from 'vitest';
import type { Attachment } from '../src/api/types';
import { AttachmentPreview, type AttachmentPreviewState } from '../src/features/task-detail/attachments/AttachmentPreview';
import { dialogFocusables } from '../src/features/task-detail/focus';

const render = createLocaleRender('zh-CN');

const attachment = (path: string, contentType: string): Attachment => ({ path, contentType, sizeBytes: 10, createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z' });
const ready: AttachmentPreviewState = { path: 'docs/guide.md', status: 'ready', text: null, error: null };
const root = '/api/v1/projects/p/tasks/t/preview/';
const preview = (file: Attachment, changes: Partial<AttachmentPreviewState> = {}) => <AttachmentPreview attachment={file} preview={{ ...ready, ...changes }} url={`${root}${file.path}`} previewRoot={root} onRetry={vi.fn()} />;

describe('attachment preview', () => {
  it('renders CommonMark and GFM tables while resolving relative resources and escaping HTML', () => {
    render(preview(attachment('docs/guide.md', 'text/markdown'), { text: '# Guide\n\n| Name | State |\n| --- | --- |\n| UI | Ready |\n\n![Diagram](../images/a%20b.svg)\n\n[Design](nested/design.md#section) [External](https://example.com) [Unsafe](javascript:alert%281%29) [Escape](../../outside)\n\n<script>alert(1)</script>' }));
    expect(screen.getByRole('heading', { name: 'Guide' })).toBeVisible();
    expect(screen.getByRole('table')).toHaveTextContent('UIReady');
    expect(screen.getByRole('img', { name: 'Diagram' })).toHaveAttribute('src', `${root}images/a%20b.svg`);
    expect(screen.getByRole('link', { name: 'Design' })).toHaveAttribute('href', `${root}docs/nested/design.md#section`);
    expect(screen.getByRole('link', { name: 'External' })).toHaveAttribute('href', 'https://example.com');
    expect(screen.getByText('Unsafe')).toHaveAttribute('href', '');
    expect(screen.getByText('Escape')).toHaveAttribute('href', '');
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeVisible();
  });

  it('retains loaded native previews and blocks pending or new native sources while paused', () => {
    const image = attachment('image.png', 'image/png');
    const props = { attachment: image, preview: ready, url: `${root}image.png`, previewRoot: root, onRetry: vi.fn() };
    const view = render(<AttachmentPreview {...props} />);
    const element = screen.getByRole('img');
    fireEvent.load(element);
    view.rerender(<AttachmentPreview {...props} paused />);
    expect(screen.getByRole('img')).toBe(element);
    expect(element).toHaveAttribute('src', `${root}image.png`);
    const frame = attachment('site.html', 'text/html');
    const frameProps = { ...props, attachment: frame, url: `${root}site.html` };
    view.rerender(<AttachmentPreview {...frameProps} paused />);
    expect(screen.queryByTitle('HTML 预览：site.html')).toBeNull();
    view.rerender(<AttachmentPreview {...frameProps} />);
    const loadedFrame = screen.getByTitle('HTML 预览：site.html') as HTMLIFrameElement;
    Object.defineProperty(loadedFrame.contentDocument!, 'URL', { configurable: true, value: 'about:blank' });
    view.rerender(<AttachmentPreview {...frameProps} paused />);
    expect(screen.getByTitle('HTML 预览：site.html')).toBe(loadedFrame);
    expect(loadedFrame).not.toHaveAttribute('src');
    fireEvent.load(loadedFrame);
    expect(loadedFrame).not.toHaveAttribute('src');
    view.rerender(<AttachmentPreview {...frameProps} />);
    expect(loadedFrame).toHaveAttribute('src', `${root}site.html`);
    fireEvent.load(loadedFrame);
    view.rerender(<AttachmentPreview {...frameProps} paused />);
    expect(screen.getByTitle('HTML 预览：site.html')).toBe(loadedFrame);
  });

  it('retains an interactive frame document before its load event', () => {
    const props = { attachment: attachment('site.html', 'text/html'), preview: ready, url: `${root}site.html`, previewRoot: root, onRetry: vi.fn() };
    const view = render(<AttachmentPreview {...props} />);
    const frame = screen.getByTitle('HTML 预览：site.html') as HTMLIFrameElement;
    const document = frame.contentDocument!;
    Object.defineProperty(document, 'URL', { configurable: true, value: new URL(props.url, window.location.href).href });
    const body = document.createElement('body'); document.appendChild(document.createElement('html')).appendChild(body);
    const input = document.createElement('input'); input.value = 'unsaved'; body.append(input);
    view.rerender(<AttachmentPreview {...props} paused />);
    expect(frame).toHaveAttribute('src', props.url);
    expect(frame.contentDocument).toBe(document);
    expect(input.value).toBe('unsaved');
    view.rerender(<AttachmentPreview {...props} />);
    expect(frame.contentDocument).toBe(document);
    expect(input.value).toBe('unsaved');
  });

  it('removes markdown link addresses and blocks unloaded images without replacing loaded images', () => {
    const markdown = attachment('guide.md', 'text/markdown');
    const props = { attachment: markdown, preview: { ...ready, text: '[Link](other.txt) [Local](#section) ![Loaded](a.png) ![Pending](b.png)' }, url: `${root}guide.md`, previewRoot: root, onRetry: vi.fn() };
    const view = render(<AttachmentPreview {...props} />);
    const loaded = screen.getByRole('img', { name: 'Loaded' });
    fireEvent.load(loaded);
    view.rerender(<AttachmentPreview {...props} paused />);
    expect(screen.getByText('Link')).not.toHaveAttribute('href');
    expect(screen.getByText('Link')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('link', { name: 'Local' })).toHaveAttribute('href', '#section');
    expect(screen.getByRole('img', { name: 'Loaded' })).toBe(loaded);
    expect(loaded).toHaveAttribute('src', `${root}a.png`);
    expect(screen.getByRole('img', { name: 'Pending' })).not.toHaveAttribute('src');
    view.rerender(<AttachmentPreview {...props} />);
    expect(screen.getByRole('img', { name: 'Pending' })).toHaveAttribute('src', `${root}b.png`);
  });

  it('exposes loading, retry, and idle states without displaying private errors', () => {
    const retry = vi.fn();
    const props = { attachment: attachment('a.txt', 'text/plain'), preview: { ...ready, status: 'loading' as const }, url: `${root}a.txt`, previewRoot: root, onRetry: retry };
    const view = render(<AttachmentPreview {...props} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在加载预览');
    view.rerender(<AttachmentPreview {...props} preview={{ ...ready, status: 'error', error: new Error('private') }} />);
    expect(screen.getByRole('alert')).not.toHaveTextContent('private');
    fireEvent.click(screen.getByRole('button', { name: '重试预览' }));
    expect(retry).toHaveBeenCalledOnce();
    view.rerender(<AttachmentPreview {...props} preview={{ ...ready, status: 'idle' }} />);
    expect(view.container.querySelector('.attachment-preview-body')).toBeEmptyDOMElement();
  });

  it('uses text, native images, PDF, trusted HTML, and download-only states', () => {
    const view = render(preview(attachment('data.json', 'application/json'), { text: '{\n  "ok": true\n}' }));
    expect(view.container.querySelector('pre')?.textContent).toBe('{\n  "ok": true\n}');
    view.rerender(preview(attachment('image.png', 'image/png')));
    expect(screen.getByRole('img')).toHaveAttribute('src', `${root}image.png`);
    view.rerender(preview(attachment('brief.pdf', 'application/pdf')));
    expect(screen.getByTitle('PDF 预览：brief.pdf')).toHaveAttribute('tabindex', '0');
    view.rerender(preview(attachment('site/index.html', 'text/html')));
    const frame = screen.getByTitle('HTML 预览：site/index.html');
    expect(frame).toHaveAttribute('src', `${root}site/index.html`);
    expect(frame).not.toHaveAttribute('sandbox');
    view.rerender(preview(attachment('archive.zip', 'application/zip')));
    expect(screen.getByText('此文件暂不支持预览，请下载后打开。')).toBeVisible();
  });

  it('shows image loading failures and retries, and handles inaccessible frame documents', () => {
    const view = render(preview(attachment('image.png', 'image/png')));
    expect(screen.getByRole('status')).toHaveTextContent('正在加载预览');
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('alert')).toHaveTextContent('无法加载文件预览');
    expect(screen.getByRole('link', { name: '重新登录预览' })).toHaveAttribute('href', 'https://preview.daynight.test/auth/sso/start');
    expect(screen.getByRole('link', { name: '重新登录预览' })).toHaveAttribute('target', '_blank');
    fireEvent.click(screen.getByRole('button', { name: '重试预览' }));
    fireEvent.load(screen.getByRole('img'));
    expect(screen.queryByRole('status')).toBeNull();
    view.rerender(preview(attachment('site/index.html', 'text/html')));
    const frame = screen.getByTitle('HTML 预览：site/index.html');
    Object.defineProperty(frame, 'contentDocument', { value: null });
    fireEvent.load(frame);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('uses sequential native controls and editing hosts while excluding inert and collapsed descendants', () => {
    const view = render(<div><button type="button" disabled>Disabled</button><div inert><a href="#">Inert</a></div><details><summary>Directory</summary><button type="button">Hidden file</button><details><summary>Nested</summary><button type="button">Nested file</button></details></details><details open><summary>Open directory</summary><button type="button">Visible file</button></details><input type="hidden" /><a href="#" tabIndex={-1}>Skipped link</a><div contentEditable suppressContentEditableWarning>Editable</div></div>);
    expect(dialogFocusables(view.container).map((element) => element.textContent)).toEqual(['Directory', 'Open directory', 'Visible file', 'Editable']);
  });
});
