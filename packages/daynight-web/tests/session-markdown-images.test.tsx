import { act, screen, waitFor } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { useRef, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ImagePart, ImageUnavailablePart, MarkdownImageMetadata } from '../../daynight/src/session/image-values';
import { SessionMarkdown } from '../src/features/task-agent-session/SessionMarkdown';
import { SessionImageFrame } from '../src/features/task-agent-session/images/SessionImageFrame';
import { SessionImageScope } from '../src/features/task-agent-session/images/SessionImageScope';
import type { ImageAssetAdapter, ImageScope, VerifiedImageLease } from '../src/features/task-agent-session/images/image-types';
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

function holdDigests() {
  const pending: (() => void)[] = [];
  vi.spyOn(crypto.subtle, 'digest').mockImplementation((_algorithm, data) => new Promise(resolve => {
    const bytes = Buffer.from(data as ArrayBuffer);
    pending.push(() => { const result = createHash('sha256').update(bytes).digest(); resolve(result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength)); });
  }));
  return pending;
}

// The real frame owns acquisition and release here; only adapter byte/decode
// outcomes are controlled so a Markdown remount exposes its lifetime cost.
function frameFixture() {
  const releases: ReturnType<typeof vi.fn>[] = [], decodedReleases: ReturnType<typeof vi.fn>[] = [];
  const scope: ImageScope = {
    identity: { serverOrigin: window.location.origin, actorUserId: 'owner', authorizationGeneration: '1', owner: { kind: 'record', recordId: id(50), namespace: 'test', revision: '1' } },
    key: 'record', valid: true, canRead: () => true, canDownload: () => true, asset: () => asset,
    retainResources() {}, invalidate: async () => {}, subscribeInvalidation: () => () => {},
  };
  const acquire = vi.fn(async (): Promise<VerifiedImageLease> => {
    const release = vi.fn(), decodedRelease = vi.fn(); releases.push(release); decodedReleases.push(decodedRelease);
    return { blob: new Blob(['controlled original']), mediaType: 'image/png', byteLength: 19, sha256: '0'.repeat(64), storedSize: { width: 3, height: 2 }, valid: true,
      subscribeInvalidation: () => () => {}, release,
      decode: async () => ({ url: 'blob:controlled-image', width: 3, height: 2, valid: true, subscribeInvalidation: () => () => {}, release: decodedRelease }),
    };
  });
  const asset: ImageAssetAdapter = { scope, key: 'image', resource: null, canRead: scope.canRead, canDownload: scope.canDownload, subscribeInvalidation: scope.subscribeInvalidation, acquire };
  const renderImage = vi.fn((part: ImagePart | ImageUnavailablePart, presentation: 'standalone' | 'linked' | 'actions') => <SessionImageFrame asset={asset} label={part.label} active presentation={presentation} />);
  return { scope, acquire, releases, decodedReleases, renderImage };
}
function ImageSurface({ scope, children }: { readonly scope: ImageScope; readonly children: ReactNode }) {
  const root = useRef<HTMLElement>(null);
  return <section ref={root}><SessionImageScope scope={scope} active rootRef={root}><div className="session-timeline">{children}</div></SessionImageScope></section>;
}

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

  it.each(['standalone', 'linked'] as const)('keeps the %s frame, focus and leases while trailing text is verified', async mode => {
    const source = '![a](image:a)', text = mode === 'linked' ? `[${source}](https://example.com/page)` : source;
    const start = text.indexOf(source), value = metadata(text, [[start, start + source.length]]), f = frameFixture();
    const surface = (body: string, data: MarkdownImageMetadata) => <ImageSurface scope={f.scope}><SessionMarkdown text={body} metadata={data} renderImage={f.renderImage} /></ImageSurface>;
    const view = render(surface(text, value));
    const frame = await screen.findByRole('img', { name: 'Image 1' }), trigger = screen.getByRole('button', { name: 'View image: Image 1' });
    trigger.focus();
    const pending = holdDigests(), next = `${text} trailing text`;
    view.rerender(surface(next, { ...value, revision: '2', textSha256: digest(next) }));
    expect(screen.queryByRole('img', { name: 'Image 1' })).toBe(frame);
    expect(screen.getByRole('button', { name: 'View image: Image 1' })).toBe(trigger);
    expect(trigger).toHaveFocus(); expect(f.acquire).toHaveBeenCalledOnce();
    expect(f.releases[0]).not.toHaveBeenCalled(); expect(f.decodedReleases[0]).not.toHaveBeenCalled();
    await act(async () => pending[0]!());
    expect(screen.getByRole('img', { name: 'Image 1' })).toBe(frame); expect(trigger).toHaveFocus();
    expect(screen.getByText(/trailing text/)).toBeVisible(); expect(f.acquire).toHaveBeenCalledOnce();
    expect(f.releases[0]).not.toHaveBeenCalled(); expect(f.decodedReleases[0]).not.toHaveBeenCalled();
    view.unmount(); expect(f.releases[0]).toHaveBeenCalledOnce(); expect(f.decodedReleases[0]).toHaveBeenCalledOnce();
  });

  it.each(['appended', 'replacement'] as const)('does not admit an unverified %s binding while preserving the previous presentation', async mode => {
    const text = '![a](image:a)', value = metadata(text, [[0, text.length]]), renderImage = vi.fn(draw);
    const view = render(<SessionMarkdown text={text} metadata={value} renderImage={renderImage} />);
    const frame = await screen.findByText('Image 1');
    const pending = holdDigests(), next = mode === 'appended' ? `${text} ![b](image:b)` : text;
    const revised = mode === 'appended' ? metadata(next, [[0, text.length], [text.length + 1, next.length]], { revision: '2' })
      : metadata(next, [[0, text.length]], { revision: '2', bindings: [{ start: 0, end: text.length, imageId: id(2), part: image(2) }] });
    renderImage.mockClear();
    view.rerender(<SessionMarkdown text={next} metadata={revised} renderImage={renderImage} />);
    expect(screen.queryByText('Image 1')).toBe(frame); expect(screen.queryByText('Image 2')).toBeNull();
    expect(renderImage.mock.calls.every(([part]) => part.imageId === id(1))).toBe(true);
    await act(async () => pending[0]!());
    expect(screen.getByText('Image 2')).toBeVisible();
    if (mode === 'appended') expect(screen.getByText('Image 1')).toBe(frame);
    else expect(screen.queryByText('Image 1')).toBeNull();
  });

  it('discards the previous presentation after a bad digest and ignores superseded verification', async () => {
    const text = '![a](image:a)', value = metadata(text, [[0, text.length]]), onInvalidBindings = vi.fn();
    const view = render(<SessionMarkdown text={text} metadata={value} renderImage={draw} onInvalidBindings={onInvalidBindings} />);
    const frame = await screen.findByText('Image 1'), pending = holdDigests();
    const next = `${text} first`, latest = `${text} latest`;
    view.rerender(<SessionMarkdown text={next} metadata={{ ...value, revision: '2', textSha256: digest(next) }} renderImage={draw} onInvalidBindings={onInvalidBindings} />);
    view.rerender(<SessionMarkdown text={latest} metadata={{ ...value, revision: '3', textSha256: '0'.repeat(64) }} renderImage={draw} onInvalidBindings={onInvalidBindings} />);
    await act(async () => pending[0]!());
    expect(screen.getByText('Image 1')).toBe(frame); expect(screen.queryByText(/first/)).toBeNull();
    await act(async () => pending[1]!());
    expect(onInvalidBindings).toHaveBeenCalledOnce(); expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/latest/)).toBeVisible();
    view.rerender(<SessionMarkdown text={latest} metadata={{ ...value, revision: '4', textSha256: digest(latest) }} renderImage={draw} />);
    expect(screen.queryByRole('button')).toBeNull();
    await act(async () => pending[2]!());
    expect(screen.getByRole('button', { name: 'Preview Image 1' })).toBeVisible();
  });

  it.each(['different part', 'missing metadata', 'invalid metadata', 'incomplete', 'truncated', 'cached'] as const)('does not preserve an admitted image across %s', async mode => {
    const text = '![a](image:a)', value = metadata(text, [[0, text.length]]), renderImage = vi.fn(draw);
    const view = render(<SessionMarkdown text={text} metadata={value} renderImage={renderImage} />);
    await screen.findByRole('button', { name: 'Preview Image 1' });
    const pending = holdDigests(), next = `${text} next`;
    const changed = mode === 'missing metadata' ? undefined : { ...value, revision: '2', textSha256: digest(next),
      ...(mode === 'different part' ? { partId: id(99) } : {}), ...(mode === 'invalid metadata' ? { partId: 'invalid' } : {}),
      ...(mode === 'incomplete' ? { complete: false, bindings: [] } : {}), ...(mode === 'truncated' ? { truncated: true } : {}) };
    renderImage.mockClear();
    view.rerender(<SessionMarkdown text={next} {...(changed ? { metadata: changed } : {})} renderImage={renderImage} resourceAccess={mode === 'cached' ? 'none' : 'live'} />);
    expect(screen.queryByRole('button')).toBeNull(); expect(renderImage).not.toHaveBeenCalled();
    view.rerender(<SessionMarkdown text={next} metadata={{ ...value, revision: '3', textSha256: digest(next) }} renderImage={renderImage} />);
    expect(screen.queryByRole('button')).toBeNull(); expect(renderImage).not.toHaveBeenCalled();
    await act(async () => { for (const resolve of pending) resolve(); });
    expect(screen.getByRole('button', { name: 'Preview Image 1' })).toBeVisible();
  });

  it('never applies an old presentation or late digest across owner changes, including returning to the first owner', async () => {
    const text = '![a](image:a)', value = metadata(text, [[0, text.length]]), first = frameFixture(), second = frameFixture();
    const surface = (f: ReturnType<typeof frameFixture>) => <ImageSurface scope={f.scope}><SessionMarkdown text={text} metadata={value} renderImage={f.renderImage} /></ImageSurface>;
    const view = render(surface(first)); await screen.findByRole('img');
    const pending = holdDigests(); first.renderImage.mockClear();
    view.rerender(surface(second));
    expect(screen.queryByRole('img')).toBeNull(); expect(second.renderImage).not.toHaveBeenCalled(); expect(second.acquire).not.toHaveBeenCalled();
    view.rerender(surface(first));
    expect(screen.queryByRole('img')).toBeNull(); expect(first.renderImage).not.toHaveBeenCalled(); expect(first.acquire).toHaveBeenCalledOnce();
    await act(async () => pending[0]!());
    expect(screen.queryByRole('img')).toBeNull(); expect(second.acquire).not.toHaveBeenCalled();
    await act(async () => pending[1]!());
    await screen.findByRole('img'); expect(first.acquire).toHaveBeenCalledTimes(2);
  });

  it('updates retained images with their verified body without admitting pending additions', async () => {
    const text = 'Revised text', old = image(1), added = image(2);
    const retained = { imageId: old.imageId, start: 0, end: 4, part: old, sourceRevision: '1', sourceTextSha256: digest('old'), linkHref: null };
    const value = metadata(text, [], { revision: '2', retainedImages: [retained] });
    const view = render(<SessionMarkdown text={text} metadata={value} renderImage={draw} />);
    const details = view.container.querySelector('details')!;
    act(() => { details.open = true; details.dispatchEvent(new Event('toggle')); });
    const trigger = await screen.findByRole('button', { name: 'Preview Image 1' }); trigger.focus();
    const pending = holdDigests(), next = `${text} appended`;
    const revised = { ...value, revision: '3', textSha256: digest(next), retainedImages: [retained, { ...retained, imageId: added.imageId, part: added, sourceRevision: '2' }] };
    view.rerender(<SessionMarkdown text={next} metadata={revised} renderImage={draw} />);
    expect(screen.queryByRole('button', { name: 'Preview Image 1' })).toBe(trigger); expect(trigger).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Preview Image 2' })).toBeNull();
    await act(async () => pending[0]!());
    expect(screen.getByRole('button', { name: 'Preview Image 1' })).toBe(trigger); expect(trigger).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Preview Image 2' })).toBeVisible(); expect(screen.getByText(next)).toBeVisible();
    view.rerender(<SessionMarkdown text={next} metadata={revised} renderImage={draw} resourceAccess="none" />);
    expect(screen.queryByRole('button')).toBeNull();
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
