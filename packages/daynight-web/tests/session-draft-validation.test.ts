import { describe, expect, it } from 'vitest';
import type { ImageCapabilities, ImageTarget, ImageUploadReceipt, ImageUploadSpec } from '../../daynight/src/session/image-values';
import { assertDraftUploadReceipt, imageSetIssue, safeImageLabel } from '../src/features/task-agent-session/drafts/draft-validation';

const target: ImageTarget = { serverOrigin: 'https://daynight.test', actorUserId: '00000001-1111-4111-8111-111111111111', fence: { sessionId: '00000002-1111-4111-8111-111111111111', claimId: '00000003-1111-4111-8111-111111111111', executionGeneration: '1' }, expectedNativeSessionId: null };
const spec: ImageUploadSpec = { uploadId: '00000004-1111-4111-8111-111111111111', imageId: '00000005-1111-4111-8111-111111111111', target, name: 'one.png', mediaType: 'image/png', byteLength: '68', sha256: 'a'.repeat(64) };
const metadata = { mediaType: 'image/png' as const, byteLength: 68, sha256: spec.sha256, width: 1, height: 1, frameCount: 1 };
const capability: ImageCapabilities = { revision: '2', providerRevision: '1', expectedNativeSessionId: null, modelId: 'vision', controlsRevision: '1', send: 'supported', steer: 'unsupported', reasonCode: null, inputMediaTypes: ['image/png'], maxImageBytes: '10485760', maxMessageImageBytes: '20971520', maxImagesPerMessage: 8, geometry: { version: 1, known: true, maxWidth: 16384, maxHeight: 16384, maxPixels: 33554432, maxFrames: 256 } };
const receipt = (): ImageUploadReceipt => ({ uploadId: spec.uploadId, imageId: spec.imageId, target, state: 'complete', acceptedOffset: spec.byteLength, spec: { name: spec.name, mediaType: spec.mediaType, byteLength: spec.byteLength, sha256: spec.sha256 }, resource: { resourceId: '00000006-1111-4111-8111-111111111111', revision: '1', status: 'available', name: spec.name, mediaType: spec.mediaType, byteLength: spec.byteLength, sha256: spec.sha256, width: 1, height: 1, frameCount: 1, error: null }, expiresAt: '2026-11-12T00:00:00Z', error: null });

describe('complete image draft admission', () => {
  it('keeps safe UTF-8 labels within the protocol byte limit and names empty candidates', () => {
    expect(safeImageLabel('\u0000\n', spec.imageId, 'image/png')).toBe('image-00000005.png');
    const label = safeImageLabel('图'.repeat(500), spec.imageId, 'image/png');
    expect(new TextEncoder().encode(label).length).toBeLessThanOrEqual(1024);
    expect(label).not.toContain('\ufffd');
  });
  it('requires the complete set and both current capability dimensions', () => {
    expect(imageSetIssue([metadata], capability, target, 'send')).toBeNull();
    expect(imageSetIssue([metadata], capability, target, 'steer')).not.toBeNull();
    expect(imageSetIssue([metadata], { ...capability, geometry: { ...capability.geometry, known: false } }, target, 'send')).not.toBeNull();
    expect(imageSetIssue([metadata, metadata], { ...capability, maxImagesPerMessage: 1 }, target, 'send')).not.toBeNull();
    expect(imageSetIssue([{ ...metadata, byteLength: 11_000_000 }], capability, target, 'send')).not.toBeNull();
    expect(imageSetIssue([metadata], capability, { ...target, expectedNativeSessionId: 'new-native' }, 'send')).not.toBeNull();
  });
  it('matches upload target, image, original specification and the full available resource', () => {
    expect(() => assertDraftUploadReceipt(spec, receipt(), metadata)).not.toThrow();
    for (const bad of [
      { ...receipt(), imageId: '00000007-1111-4111-8111-111111111111' },
      { ...receipt(), target: { ...target, expectedNativeSessionId: 'new-native' } },
      { ...receipt(), spec: { ...receipt().spec, name: 'other.png' } },
      { ...receipt(), resource: { ...receipt().resource!, sha256: 'b'.repeat(64) } },
      { ...receipt(), resource: { ...receipt().resource!, width: 2 } },
      { ...receipt(), resource: { ...receipt().resource!, frameCount: null } },
      { ...receipt(), acceptedOffset: '67' },
    ]) expect(() => assertDraftUploadReceipt(spec, bad, metadata)).toThrow();
  });
});
