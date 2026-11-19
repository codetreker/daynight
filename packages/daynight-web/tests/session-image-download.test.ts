import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageDownloadQueue, imageDownloadName } from '../src/features/task-agent-session/images/image-download';
import { SessionImageStore, type ImageScopeIdentity } from '../src/features/task-agent-session/images/image-store';
import { sessionImageBytes } from './helpers/sessionImages';
const identity: ImageScopeIdentity = { serverOrigin: 'https://daynight.test', actorUserId: '00000001-1111-4111-8111-111111111111', owner: { kind: 'record', recordId: 'record', namespace: 'attachment', revision: '1' }, authorizationGeneration: '1' };
const images = new Set<SessionImageStore>(), queues = new Set<ImageDownloadQueue>();
afterEach(async () => { for (const queue of queues) queue.close(); queues.clear(); await Promise.all([...images].map(store => store.close())); images.clear(); });
async function setup() {
  const bytes = sessionImageBytes('png'), store = new SessionImageStore(), downloads = new ImageDownloadQueue(); images.add(store); queues.add(downloads);
  const blob = await new Response(bytes).blob(), sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  let admitted = true;
  const read = vi.fn(async () => blob), scope = store.createScope({ identity, read, canRead: () => admitted, canDownload: () => admitted });
  const asset = scope.asset({ resourceId: '00000004-1111-4111-8111-111111111111', revision: '1', name: 'sample.png', status: 'available', mediaType: 'image/png', byteLength: String(bytes.length), sha256, width: 3, height: 2, frameCount: 1, error: null })!;
  const other = scope.asset({ resourceId: '00000005-1111-4111-8111-111111111111', revision: '1', name: 'other.png', status: 'available', mediaType: 'image/png', byteLength: String(bytes.length), sha256, width: 3, height: 2, frameCount: 1, error: null })!;
  return { scope, asset, other, downloads, read, store, deny: () => { admitted = false; }, request: (signal = new AbortController().signal) => ({ scope, asset, signal, label: 'Reference.png' }) };
}

describe('image download lifetimes', () => {
  it('uses a dedicated verified Blob URL, then revokes it on the retention deadline', async () => {
    vi.useFakeTimers(); const { request, downloads, read } = await setup();
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download'), revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let target: HTMLAnchorElement | null = null; vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { target = this; });
    await downloads.download(request());
    expect(target).toMatchObject({ href: 'blob:download', download: 'Reference.png', target: '' });
    expect(create).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce(); expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000); expect(revoke).toHaveBeenCalledWith('blob:download');
  });
  it('bounds waiting downloads to two requests without acquiring their bytes', async () => {
    vi.useFakeTimers(); const { request, downloads, asset, read } = await setup();
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const acquire = asset.acquire; let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
    vi.spyOn(asset, 'acquire').mockImplementationOnce(async (signal, priority) => { await gate; return acquire(signal, priority); });
    const first = downloads.download(request());
    const second = downloads.download(request()), third = downloads.download(request());
    const secondRejected = expect(second).rejects.toMatchObject({ code: 'download_busy' }), thirdRejected = expect(third).rejects.toMatchObject({ code: 'download_busy' });
    await expect(downloads.download(request())).rejects.toMatchObject({ code: 'download_busy' });
    await vi.advanceTimersByTimeAsync(65_001); await secondRejected; await thirdRejected;
    expect(read).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    open(); await first; expect(click).toHaveBeenCalledOnce();
  });
  it('starts each consecutive download once the previous one reaches the browser and bounds retained URLs to two', async () => {
    vi.useFakeTimers(); const { request, downloads } = await setup();
    let serial = 0; vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:download-${++serial}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clicked: string[] = []; vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.href); });
    await downloads.download(request());
    const second = downloads.download(request()), third = downloads.download(request());
    await expect(second).resolves.toBeUndefined(); await expect(third).resolves.toBeUndefined();
    expect(clicked).toEqual(['blob:download-1', 'blob:download-2', 'blob:download-3']);
    expect(revoke.mock.calls).toEqual([['blob:download-1']]);
    await vi.advanceTimersByTimeAsync(59_999); expect(revoke).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(revoke.mock.calls).toEqual([['blob:download-1'], ['blob:download-2'], ['blob:download-3']]);
  });
  it('revokes every retained URL when the queue closes', async () => {
    const { request, downloads } = await setup();
    let serial = 0; vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:download-${++serial}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await downloads.download(request()); await downloads.download(request());
    expect(revoke).not.toHaveBeenCalled();
    downloads.close();
    expect(revoke.mock.calls).toEqual([['blob:download-1'], ['blob:download-2']]);
  });
  it('frees the foreground download reservation for an uncached original once a download is triggered', async () => {
    const { request, downloads, other, read } = await setup();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await downloads.download(request()); expect(read).toHaveBeenCalledOnce();
    const lease = await other.acquire(new AbortController().signal, 'download');
    expect(read).toHaveBeenCalledTimes(2); expect(lease.valid).toBe(true); lease.release();
  });
  it('cancels queued downloads and revokes a retained URL synchronously on access loss', async () => {
    const { request, downloads, scope } = await setup();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download'); const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await downloads.download(request());
    const controller = new AbortController(), queued = downloads.download(request(controller.signal));
    const rejected = expect(queued).rejects.toMatchObject({ code: 'access_revoked' });
    const closed = scope.invalidate();
    expect(revoke).toHaveBeenCalledWith('blob:download');
    await rejected; await closed; expect(click).toHaveBeenCalledOnce();
  });
  it('refuses a request whose scope does not own its asset or whose permission is checking', async () => {
    const a = await setup(), b = await setup();
    await expect(a.downloads.download({ ...a.request(), scope: b.scope })).rejects.toMatchObject({ code: 'access_pending' });
    a.deny(); await expect(a.downloads.download(a.request())).rejects.toMatchObject({ code: 'access_pending' });
    expect(a.read).not.toHaveBeenCalled();
  });
});

describe('safe image download names', () => {
  it('removes controls, paths, dangerous extensions and reserved names while preserving Unicode characters', () => {
    expect(imageDownloadName('../folder\\photo\u202e.svg', 'image/png', 'image-1')).toBe('photo.png');
    expect(imageDownloadName('CON.png', 'image/jpeg', 'id-2')).toBe('image-id2.jpg');
    expect(imageDownloadName('\0\u202e', 'image/gif', 'id-3')).toBe('image-id3.gif');
    expect([...imageDownloadName('😀'.repeat(200) + '.txt', 'image/avif', 'id')]).toHaveLength(120);
  });
});
