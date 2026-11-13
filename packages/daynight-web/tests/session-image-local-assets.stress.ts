import { expect, it, vi } from 'vitest';
import { SessionImageStore, type ImageScopeIdentity } from '../src/features/task-agent-session/images/image-store';
import { sessionImageBytes } from './helpers/sessionImages';

it('validates a second 10 MiB original while the first draft frame stays visible', { timeout: 15_000 }, async () => {
  const images = new SessionImageStore(), signal = () => new AbortController().signal;
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3, height: 2, close() {} })));
  try {
    const identity: ImageScopeIdentity = { serverOrigin: 'https://daynight.test', actorUserId: 'owner', authorizationGeneration: '1', owner: { kind: 'session', fence: { sessionId: '00000002-1111-4111-8111-111111111111', claimId: '00000003-1111-4111-8111-111111111111', executionGeneration: '1' }, nativeSessionId: 'native' } };
    const scope = images.createScope({ identity, read: async () => { throw new Error('Local originals do not use the network.'); }, canRead: () => true, canDownload: () => true });
    const bytes = sessionImageBytes('png'), size = 10 * 1_048_576;
    const padded = new Uint8Array(size), view = new DataView(padded.buffer), chunk = bytes.length - 12, length = size - bytes.length - 12;
    padded.set(bytes.subarray(0, chunk)); view.setUint32(chunk, length); padded.set(new TextEncoder().encode('paDd'), chunk + 4);
    let crc = 0xffffffff;
    for (let at = chunk + 4; at < chunk + 8 + length; at++) { crc ^= padded[at]!; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    view.setUint32(chunk + 8 + length, (crc ^ 0xffffffff) >>> 0); padded.set(bytes.subarray(-12), size - 12);
    const original = new Blob([padded], { type: 'image/png' });
    const first = images.createLocalAsset(scope, { key: 'first-full-original', blob: original });
    await first.validate(signal()); const visible = await first.acquire(signal());
    const second = images.createLocalAsset(scope, { key: 'second-full-original', blob: original });
    let validated = false; const pending = second.validate(signal()).then(() => { validated = true; }); void pending.catch(() => {});
    await vi.waitFor(() => expect(validated).toBe(true), { timeout: 3_000 }); await pending;
    expect(visible.valid).toBe(true); expect(images.usage()).toMatchObject({ bytes: size * 2, items: 2, queued: 0 });
    visible.release();
  } finally { await images.close(); vi.unstubAllGlobals(); }
});
