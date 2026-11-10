import { act, screen, waitFor } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ImagePart, ImageUnavailablePart, MarkdownImageMetadata } from '../../daynight/src/session/image-values';
import { SessionMarkdown } from '../src/features/task-agent-session/SessionMarkdown';
import { ChatMarkdown } from '../src/ui/ChatMarkdown';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const image = (n = 1) => ({ type: 'image' as const, imageId: id(n), resourceId: id(100 + n), label: `Image ${n}` });
function metadata(text: string, spans: readonly [number, number][], overrides: Partial<MarkdownImageMetadata> = {}): MarkdownImageMetadata {
  return { partId: id(10), revision: '1', textSha256: digest(text), complete: true, truncated: false, bindings: spans.map(([start, end], index) => ({ start, end, imageId: id(index + 1), part: image(index + 1) })), retainedImages: [], ...overrides };
}
const draw = vi.fn((part: ImagePart | ImageUnavailablePart, mode: string) => mode === 'actions'
  ? <button data-image-actions={part.imageId}>Preview {part.label}</button>
  : <span data-image-visual={part.imageId}>{part.label}{mode === 'standalone' ? <button>Preview {part.label}</button> : null}</span>);

// The callback stands in for the shared frame: this suite owns admission to that
// frame and DOM placement, while the frame/store suites own byte reads and leases.
describe('Session Markdown image bindings', () => {
  it('renders only exact Markdown image nodes after the complete body digest is verified', async () => {
    const text = '😀\n![inline](file:///private/image.png)\n\n![reference][photo]\n\n[photo]: https://images.example/photo.png';
    const inline = text.indexOf('!['), inlineEnd = text.indexOf(')', inline) + 1;
    const reference = text.indexOf('![reference]'), referenceEnd = reference + '![reference][photo]'.length;
    const view = render(<SessionMarkdown text={text} metadata={metadata(text, [[inline, inlineEnd], [reference, referenceEnd]])} renderImage={draw} />);
    expect(view.container.querySelector('[data-image-visual]')).toBeNull();
    await screen.findByText('Image 2');
    expect(view.container.querySelectorAll('[data-image-visual]')).toHaveLength(2);
    expect(view.container.querySelector('img[src], a[href^="file:"]')).toBeNull();
    expect(view.container.querySelector('br')).not.toBeNull();
  });

  it('keeps linked image actions outside the original anchor in image order', async () => {
    const text = '[before ![a](image:a) between ![b](image:b) after](https://example.com/page)';
    const spans = ['![a](image:a)', '![b](image:b)'].map(source => [text.indexOf(source), text.indexOf(source) + source.length] as [number, number]);
    const view = render(<SessionMarkdown text={text} metadata={metadata(text, spans)} renderImage={draw} />);
    const actions = await screen.findAllByRole('button', { name: /Preview Image/ });
    const anchor = screen.getByRole('link');
    expect(anchor).toHaveAttribute('href', 'https://example.com/page');
    expect(anchor.textContent).toBe('before Image 1 between Image 2 after');
    expect(anchor.querySelector('button')).toBeNull();
    expect(actions.map(action => action.textContent)).toEqual(['Preview Image 1', 'Preview Image 2']);
    expect(view.container.querySelector('p')?.querySelector('div')).toBeNull();
    expect(anchor.compareDocumentPosition(actions[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(['file:///private/page', 'javascript:alert(1)'])('keeps independent image actions when the outer link %s is refused', async href => {
    const source = '![a](image:a)', text = `[${source}](<${href}>)`;
    render(<SessionMarkdown text={text} metadata={metadata(text, [[1, source.length + 1]])} renderImage={draw} />);
    await screen.findByRole('button', { name: 'Preview Image 1' });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it.each([
    ['ordinary text', 'not-an-image', 0, 12],
    ['inline code', '`![a](image:a)`', 1, 14],
    ['fenced code', '```\n![a](image:a)\n```', 4, 17],
    ['raw HTML', '<img src="https://example.com/raw.png">', 0, 40],
    ['unresolved reference', '![a][missing]', 0, 13],
    ['partial image span', '![a](image:a)', 0, 5],
  ] as const)('rejects a binding to %s without rendering its resource', async (_label, text, start, end) => {
    const renderImage = vi.fn(), onInvalidBindings = vi.fn();
    render(<SessionMarkdown text={text} metadata={metadata(text, [[start, Math.min(end, text.length)]])} renderImage={renderImage} onInvalidBindings={onInvalidBindings} />);
    await waitFor(() => expect(onInvalidBindings).toHaveBeenCalledTimes(1));
    expect(renderImage).not.toHaveBeenCalled();
    expect(document.querySelector('img')).toBeNull();
  });

  it('rejects a wrong body digest and keeps the readable text', async () => {
    const text = 'Readable ![a](image:a)', onInvalidBindings = vi.fn(), renderImage = vi.fn();
    render(<SessionMarkdown text={text} metadata={metadata(text, [[9, text.length]], { textSha256: '0'.repeat(64) })} renderImage={renderImage} onInvalidBindings={onInvalidBindings} />);
    await waitFor(() => expect(onInvalidBindings).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Readable/)).toBeVisible();
    expect(renderImage).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid part identity', { partId: 'not-a-uuid' }],
    ['invalid source revision', { revision: '0' }],
    ['unknown binding projection', { bindings: null }],
    ['incomplete body', { complete: false, bindings: [] }],
    ['truncated body', { truncated: true }],
  ] as const)('never admits current images with %s', async (_label, changes) => {
    const text = '![a](image:a)', renderImage = vi.fn(), onInvalidBindings = vi.fn();
    const hash = vi.spyOn(crypto.subtle, 'digest');
    render(<SessionMarkdown text={text} metadata={metadata(text, [[0, text.length]], changes)} renderImage={renderImage} onInvalidBindings={onInvalidBindings} />);
    if (hash.mock.results.length > 0) await act(async () => { await hash.mock.results[0]!.value; });
    else expect(onInvalidBindings).toHaveBeenCalledOnce();
    expect(renderImage).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps unbound images unavailable without denying independently bound nodes', async () => {
    const source = '![a](image:a)', text = `${source} ![unbound](https://example.com/image.png)`;
    const view = render(<SessionMarkdown text={text} metadata={metadata(text, [[0, source.length]])} renderImage={draw} />);
    await screen.findByText('Image 1');
    expect(screen.getByText('unbound — Resource unavailable')).toBeVisible();
    expect(view.container.querySelectorAll('[data-image-visual]')).toHaveLength(1);
    expect(view.container.querySelector('img')).toBeNull();
  });

  it('retains the original image-unavailable error for the shared frame', async () => {
    const text = '![a](image:a)', value = metadata(text, [[0, text.length]]), error = { code: 'source_unavailable', message: 'The original source is unavailable.' };
    const failed = { type: 'image_unavailable' as const, imageId: id(1), label: 'Image 1', error }, renderImage = vi.fn(draw);
    render(<SessionMarkdown text={text} metadata={{ ...value, bindings: [{ ...value.bindings![0]!, part: failed }] }} renderImage={renderImage} />);
    await screen.findByText('Image 1');
    expect(renderImage).toHaveBeenCalledWith(failed, 'standalone');
  });

  it('never applies a late verification to changed text or metadata', async () => {
    const first = '![a](image:a)', second = '![b](image:b)', calls: { resolve: (value: ArrayBuffer) => void; bytes: Buffer }[] = [];
    vi.spyOn(crypto.subtle, 'digest').mockImplementation((_algorithm, data) => new Promise(resolve => { calls.push({ resolve, bytes: Buffer.from(data as ArrayBuffer) }); }));
    const renderImage = vi.fn(draw);
    const view = render(<SessionMarkdown text={first} metadata={metadata(first, [[0, first.length]])} renderImage={renderImage} />);
    view.rerender(<SessionMarkdown text={second} metadata={metadata(second, [[0, second.length]], { revision: '2' })} renderImage={renderImage} />);
    expect(calls).toHaveLength(2);
    await act(async () => { const result = createHash('sha256').update(calls[0]!.bytes).digest(); calls[0]!.resolve(result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength)); });
    expect(renderImage).not.toHaveBeenCalled();
    await act(async () => { const result = createHash('sha256').update(calls[1]!.bytes).digest(); calls[1]!.resolve(result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength)); });
    expect(await screen.findByText('Image 1')).toBeVisible();
  });

  it('does not reverify or recreate an admitted frame for equivalent metadata', async () => {
    const text = '![a](image:a)', value = metadata(text, [[0, text.length]]), hash = vi.spyOn(crypto.subtle, 'digest');
    const view = render(<SessionMarkdown text={text} metadata={value} renderImage={draw} />);
    const frame = await screen.findByText('Image 1');
    view.rerender(<SessionMarkdown text={text} metadata={structuredClone(value)} renderImage={draw} />);
    expect(screen.getByText('Image 1')).toBe(frame);
    expect(hash).toHaveBeenCalledTimes(1);
  });

  it('shows retained images under their original metadata and never renders duplicate identities', async () => {
    const text = 'Revised text', old = image(2);
    const value = metadata(text, [], { revision: '2', retainedImages: [{ imageId: old.imageId, start: 0, end: 4, part: old, sourceRevision: '1', sourceTextSha256: digest('old'), linkHref: 'https://example.com/old' }] });
    const view = render(<SessionMarkdown text={text} metadata={value} renderImage={draw} />);
    await screen.findByText('Earlier images');
    const details = view.container.querySelector('details')!;
    expect(details).not.toHaveAttribute('open');
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await screen.findByRole('button', { name: 'Preview Image 2' });
    expect(details.querySelector('a')?.querySelector('button')).toBeNull();
    const duplicate = { ...value, retainedImages: [...value.retainedImages, value.retainedImages[0]!] }, onInvalidBindings = vi.fn();
    view.rerender(<SessionMarkdown text={text} metadata={duplicate} renderImage={draw} onInvalidBindings={onInvalidBindings} />);
    await waitFor(() => expect(onInvalidBindings).toHaveBeenCalledTimes(1));
    expect(view.container.querySelector('[data-image-visual]')).toBeNull();
  });

  it('leaves cached descriptors inert before and after an admitted live render', async () => {
    const text = '![a](image:a)', value = metadata(text, [[0, text.length]]), renderImage = vi.fn(draw);
    const view = render(<SessionMarkdown text={text} metadata={value} renderImage={renderImage} resourceAccess="none" />);
    await act(async () => {});
    expect(renderImage).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).toBeNull();
    view.rerender(<SessionMarkdown text={text} metadata={value} renderImage={renderImage} resourceAccess="live" />);
    await screen.findByRole('button', { name: 'Preview Image 1' });
    renderImage.mockClear();
    view.rerender(<SessionMarkdown text={text} metadata={value} renderImage={renderImage} resourceAccess="none" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(renderImage).not.toHaveBeenCalled();
  });

  it('keeps default ChatMarkdown consumers unable to load image sources', () => {
    const view = render(<ChatMarkdown text={'![a](https://example.com/p.png)\n<img src="file:///private/image.png">'} resourceUnavailable="Unavailable" tableLabel="Table" />);
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.textContent).toContain('Unavailable');
  });

  it('preserves instance-scoped footnotes and table regions with controlled images', async () => {
    const source = '![a](image:a)', text = `${source}\n\n| Result |\n| --- |\n| ok[^note] |\n\n[^note]: detail`;
    render(<SessionMarkdown text={text} metadata={metadata(text, [[0, source.length]])} renderImage={draw} />);
    await screen.findByText('Image 1');
    const region = screen.getByRole('region', { name: 'Markdown table' });
    expect(region).toHaveAttribute('tabindex', '0');
    const footnote = region.querySelector('a')!;
    expect(footnote.getAttribute('href')).toMatch(/^#chat-markdown-.*-fn-note$/);
    expect(document.getElementById(footnote.getAttribute('aria-describedby')!)).not.toBeNull();
  });
});
