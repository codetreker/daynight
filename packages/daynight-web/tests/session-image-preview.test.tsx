import { useRef, type ReactNode } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionResource } from '../src/api/types';
import { SessionImageScope, suspendSessionImagePreviews } from '../src/features/task-agent-session/images/SessionImageScope';
import { SessionResourceView } from '../src/features/task-agent-session/SessionResourceView';
import type { ImageAssetAdapter, ImageScope, VerifiedImageLease, DecodedImageLease } from '../src/features/task-agent-session/images/image-store';
import { ImageFailure, SessionImageStore } from '../src/features/task-agent-session/images/image-store';
import { imageDownloads } from '../src/features/task-agent-session/images/image-download';
import { createLocaleRender } from './helpers/renderWithLocale';
import { sessionImageBytes } from './helpers/sessionImages';

const render = createLocaleRender('en');
const descriptor: SessionResource = { resourceId: '00000012-1111-4111-8111-111111111111', name: 'Image.png', status: 'available', mediaType: 'image/png', byteLength: '68', sha256: '0'.repeat(64), width: 1, height: 1, frameCount: 1, revision: '1', error: null };

// This adapter controls read/decode outcomes. Real container/decode and URL
// lifetime checks belong to the image-store and browser suites.
function fixture() {
  let valid = true, canRead = true;
  const invalidation = new Set<() => void>(), releases: ReturnType<typeof vi.fn>[] = [], decodes: ReturnType<typeof vi.fn>[] = [];
  const decoded: DecodedImageLease[] = [];
  const scope = {
    get valid() { return valid; }, canRead: () => valid && canRead, canDownload: () => valid && canRead,
    subscribeInvalidation: (listener: () => void) => { invalidation.add(listener); return () => { invalidation.delete(listener); }; },
    asset: () => asset,
  } as unknown as ImageScope;
  const acquire = vi.fn(async (_signal: AbortSignal): Promise<VerifiedImageLease> => {
    const release = vi.fn(), decodedRelease = vi.fn(); releases.push(release); decodes.push(decodedRelease);
    const image = { url: 'blob:controlled-image', width: 1, height: 1, get valid() { return valid; }, release: decodedRelease, subscribeInvalidation: () => () => {} } as DecodedImageLease;
    decoded.push(image);
    return { blob: new Blob(['controlled adapter']), mediaType: 'image/png', byteLength: 68, sha256: descriptor.sha256!, storedSize: { width: 1, height: 1 }, get valid() { return valid; }, subscribeInvalidation: scope.subscribeInvalidation, release, decode: async () => image } satisfies VerifiedImageLease;
  });
  const asset = { scope, key: 'saved-image', resource: descriptor, canRead: scope.canRead, canDownload: scope.canDownload, subscribeInvalidation: scope.subscribeInvalidation, acquire } satisfies ImageAssetAdapter;
  return { scope, asset, acquire, releases, decodes, decoded, denyReads: () => { canRead = false; }, revoke: () => { valid = false; invalidation.forEach(listener => listener()); } };
}
function Surface({ scope, active = true, access = 'live', readAdmitted = true, onEscape = () => {}, children, label = 'Image.png', onPreviewChange }: {
  readonly scope: ImageScope; readonly active?: boolean; readonly access?: 'live' | 'none'; readonly readAdmitted?: boolean; readonly onEscape?: () => void; readonly children?: ReactNode; readonly label?: string; readonly onPreviewChange?: (open: boolean) => void;
}) {
  const root = useRef<HTMLElement>(null);
  return <section ref={root} data-testid="owner" onKeyDown={event => { if (event.key === 'Escape') onEscape(); }}>
    <SessionImageScope scope={scope} active={active} readAdmitted={readAdmitted} rootRef={root} {...(onPreviewChange ? { onPreviewChange } : {})}>
      <div className="session-timeline" tabIndex={0} data-testid="timeline">{children ?? <SessionResourceView resource={descriptor} label={label} active={active} resourceAccess={access} mediaKey="message/image" onLoad={async () => { throw new Error('The image scope owns reads.'); }} />}</div>
    </SessionImageScope>
  </section>;
}

describe('shared Session image preview', () => {
  it('keeps a retained original open and closes only that preview when its final reference is removed', async () => {
    const bytes = sessionImageBytes('png'), store = new SessionImageStore();
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const resource = { ...descriptor, width: 3, height: 2, byteLength: String(bytes.length), sha256 };
    const blob = await new Response(bytes).blob();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3, height: 2, close() {} })));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reference-test');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const scope = store.createScope({ identity: { serverOrigin: window.location.origin, actorUserId: 'owner', authorizationGeneration: '1', owner: { kind: 'record', recordId: 'record', namespace: 'test', revision: '1' } }, read: async () => blob, canRead: () => true, canDownload: () => true });
    const view = render(<Surface scope={scope}><SessionResourceView resource={resource} label="Image.png" active onLoad={vi.fn()} /></Surface>);
    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'View image: Image.png' }));
    const dialog = screen.getByRole('dialog'); await within(dialog).findByRole('img');
    act(() => scope.retainResources(new Set([resource.resourceId])));
    expect(screen.getByRole('dialog')).toBe(dialog);
    act(() => scope.retainResources(new Set()));
    expect(scope.valid).toBe(true); expect(screen.queryByRole('dialog')).toBeNull();
    expect(dialog.querySelector('img')).toBeNull(); expect(revoke).toHaveBeenCalledWith('blob:reference-test');
    expect(document.body.style.overflow).toBe('');
    view.unmount(); await store.close();
  });
  it('opens inside the owner outside the timeline and owns only its inner Escape', async () => {
    const f = fixture(), outerEscape = vi.fn(), changed = vi.fn();
    render(<Surface scope={f.scope} onEscape={outerEscape} onPreviewChange={changed} />);
    const image = await screen.findByRole('img', { name: 'Image.png' });
    expect(image).toHaveAttribute('data-media-key', 'message/image');
    expect(screen.queryByRole('link')).toBeNull();
    const trigger = screen.getByRole('button', { name: 'View image: Image.png' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Image.png' });
    expect(screen.getByTestId('owner')).toContainElement(dialog);
    expect(screen.getByTestId('timeline')).not.toContainElement(dialog);
    expect(within(dialog).getByRole('button', { name: 'Close image preview' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByTestId('timeline').style.overflow).toBe('hidden');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Original size' }));
    expect(within(dialog).getByRole('button', { name: 'Original size' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Close image preview' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus(); expect(outerEscape).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe('');
    expect(screen.getByTestId('timeline').style.overflow).toBe('');
    expect(changed).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(trigger, { key: 'Escape' }); expect(outerEscape).toHaveBeenCalledOnce();
  });

  it('keeps cached descriptors inert without reading or offering download controls', () => {
    const f = fixture(); render(<Surface scope={f.scope} access="none" />);
    expect(screen.getByText('Image unavailable in the recent preview')).toBeVisible();
    expect(screen.queryByRole('img')).toBeNull(); expect(screen.queryByRole('button')).toBeNull();
    expect(f.acquire).not.toHaveBeenCalled();
  });

  it('restores focus to the timeline when the original trigger is inside a hidden ancestor', async () => {
    const f = fixture(); render(<Surface scope={f.scope} />);
    await screen.findByRole('img'); const trigger = screen.getByRole('button', { name: 'View image: Image.png' });
    fireEvent.click(trigger); const dialog = screen.getByRole('dialog');
    trigger.parentElement!.style.display = 'none';
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close image preview' }));
    expect(screen.getByTestId('timeline')).toHaveFocus();
  });

  it('separates a linked image from its preview actions', async () => {
    const f = fixture();
    render(<Surface scope={f.scope}><a href="https://example.com/report"><SessionResourceView resource={descriptor} label="Linked" active presentation="linked" onLoad={vi.fn()} /></a><SessionResourceView resource={descriptor} label="Linked" active presentation="actions" onLoad={vi.fn()} /></Surface>);
    await screen.findByRole('img');
    const link = screen.getByRole('link'); expect(within(link).queryByRole('button')).toBeNull();
    expect(f.acquire).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'View image: Linked' }));
    expect(screen.getByRole('dialog', { name: 'Linked' })).toBeVisible();
  });

  it('synchronously leaves the top layer for a higher modal and restores the same view afterward', async () => {
    const f = fixture(); render(<Surface scope={f.scope} />);
    await screen.findByRole('img'); fireEvent.click(screen.getByRole('button', { name: 'View image: Image.png' }));
    const dialog = screen.getByRole('dialog') as HTMLDialogElement;
    await within(dialog).findByRole('img');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Original size' }));
    const requests = f.acquire.mock.calls.length; let resume!: () => void;
    act(() => {
      resume = suspendSessionImagePreviews();
      expect(dialog.open).toBe(false);
      expect(dialog.querySelector('img')).not.toHaveAttribute('src');
      expect(screen.getByTestId('timeline').style.overflow).toBe('');
      expect(document.body.style.overflow).toBe('');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => resume());
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByRole('button', { name: 'Original size' })).toHaveAttribute('aria-pressed', 'true');
    expect(f.acquire).toHaveBeenCalledTimes(requests + 1);
  });

  it('does not republish a pending preview after revocation', async () => {
    const f = fixture();
    let resolve!: (lease: VerifiedImageLease) => void;
    f.acquire.mockImplementation(() => new Promise(value => { resolve = value; }));
    render(<Surface scope={f.scope} />);
    fireEvent.click(screen.getByRole('button', { name: 'View image: Image.png' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    act(() => f.revoke()); expect(screen.queryByRole('dialog')).toBeNull();
    const release = vi.fn(), decode = vi.fn();
    await act(async () => { resolve({ release, decode } as unknown as VerifiedImageLease); });
    expect(release).toHaveBeenCalledOnce(); expect(decode).not.toHaveBeenCalled(); expect(screen.queryByRole('img')).toBeNull();
  });

  it('releases frame and preview leases when its pane becomes inactive', async () => {
    const f = fixture(); const view = render(<Surface scope={f.scope} />);
    await screen.findByRole('img'); fireEvent.click(screen.getByRole('button', { name: 'View image: Image.png' }));
    await within(screen.getByRole('dialog')).findByRole('img');
    view.rerender(<Surface scope={f.scope} active={false} />);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('img')).toBeNull();
    await waitFor(() => expect(f.releases.every(release => release.mock.calls.length === 1)).toBe(true));
    expect(f.decodes.every(release => release.mock.calls.length === 1)).toBe(true);
  });

  it('keeps displayed pixels during an unchanged authorization check while refusing new downloads', async () => {
    const f = fixture(); const view = render(<Surface scope={f.scope} />);
    const image = await screen.findByRole('img'); fireEvent.click(screen.getByRole('button', { name: 'View image: Image.png' }));
    const dialog = screen.getByRole('dialog'); await within(dialog).findByRole('img');
    const requests = f.acquire.mock.calls.length; f.denyReads(); view.rerender(<Surface scope={f.scope} />);
    expect(screen.getByRole('dialog')).toBe(dialog); expect(screen.getAllByRole('img')).toContain(image);
    expect(within(dialog).getByRole('button', { name: 'Download image: Image.png' })).toBeDisabled(); expect(f.acquire).toHaveBeenCalledTimes(requests);
  });


  it('starts a cold frame only after read admission returns without clearing displayed pixels on recheck', async () => {
    const f = fixture(); const view = render(<Surface scope={f.scope} readAdmitted={false} />);
    expect(f.acquire).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'View image: Image.png' })).toBeDisabled();
    view.rerender(<Surface scope={f.scope} readAdmitted />);
    const image = await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'View image: Image.png' }));
    const dialog = screen.getByRole('dialog'); await within(dialog).findByRole('img');
    const requests = f.acquire.mock.calls.length;
    view.rerender(<Surface scope={f.scope} readAdmitted={false} />);
    expect(screen.getByRole('dialog')).toBe(dialog); expect(screen.getAllByRole('img')).toContain(image);
    expect(within(dialog).getByRole('button', { name: 'Download image: Image.png' })).toBeDisabled();
    expect(f.acquire).toHaveBeenCalledTimes(requests);
  });

  it('cancels the download URL lifetime after preparation resolves when its owner becomes inactive', async () => {
    const f = fixture(), download = vi.spyOn(imageDownloads, 'download').mockResolvedValue();
    const view = render(<Surface scope={f.scope} />); await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'Download image: Image.png' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download image: Image.png' })).not.toBeDisabled());
    const signal = download.mock.calls[0]![0].signal; expect(signal.aborted).toBe(false);
    view.rerender(<Surface scope={f.scope} active={false} />);
    expect(signal.aborted).toBe(true);
  });

  it('retains a prepared download after user closure until its owner becomes inactive', async () => {
    const f = fixture(), download = vi.spyOn(imageDownloads, 'download').mockResolvedValue();
    const view = render(<Surface scope={f.scope} />); await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'View image: Image.png' }));
    const dialog = screen.getByRole('dialog'); await within(dialog).findByRole('img');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download image: Image.png' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Download image: Image.png' })).not.toBeDisabled());
    const signal = download.mock.calls[0]![0].signal;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close image preview' }));
    expect(signal.aborted).toBe(false);
    view.rerender(<Surface scope={f.scope} active={false} />);
    expect(signal.aborted).toBe(true);
  });

  it('offers the verified original download after a local decoder failure', async () => {
    const f = fixture(), onInvalidResource = vi.fn();
    f.acquire.mockResolvedValue({ release: vi.fn(), subscribeInvalidation: () => () => {}, decode: async () => { throw new Error('Decoder unavailable'); } } as unknown as VerifiedImageLease);
    const download = vi.spyOn(imageDownloads, 'download').mockResolvedValue();
    render(<Surface scope={f.scope}><SessionResourceView resource={descriptor} label="Image.png" active onLoad={vi.fn()} onInvalidResource={onInvalidResource} /></Surface>); await screen.findByText('This browser cannot display this image.');
    fireEvent.click(screen.getByRole('button', { name: 'Download image: Image.png' }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(download.mock.calls[0]?.[0].asset).toBe(f.asset);
    expect(onInvalidResource).not.toHaveBeenCalled();
  });

  it('distinguishes a damaged saved original from a browser decoder failure', async () => {
    const f = fixture(), onInvalidResource = vi.fn(); f.acquire.mockRejectedValue(new ImageFailure('integrity_failed', 'Digest mismatch'));
    render(<Surface scope={f.scope}><SessionResourceView resource={descriptor} label="Image.png" active onLoad={vi.fn()} onInvalidResource={onInvalidResource} /></Surface>);
    expect(await screen.findByText('The saved image is damaged or no longer matches its description.')).toBeVisible();
    expect(screen.queryByText('This browser cannot display this image.')).toBeNull();
    expect(onInvalidResource).not.toHaveBeenCalled();
  });

  it('reports a full download queue without calling the image unavailable', async () => {
    const f = fixture(); vi.spyOn(imageDownloads, 'download').mockRejectedValue(new ImageFailure('download_busy', 'Busy'));
    render(<Surface scope={f.scope} />); await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'Download image: Image.png' }));
    expect(await screen.findByText('Downloads are busy. Try again shortly.')).toBeVisible();
    expect(screen.getByRole('img')).toBeVisible();
  });
});
