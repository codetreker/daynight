import { IMAGE_LIMITS, type ImageCapabilities, type ImageTarget, type ImageUploadReceipt, type ImageUploadSpec, type InputMime } from '../../../../../daynight/src/session/image-values';
import { sessionFenceKey } from '../../../../../daynight/src/session/protocol';

export type DraftImageMetadata = { readonly mediaType: InputMime; readonly byteLength: number; readonly sha256: string; readonly width: number; readonly height: number; readonly frameCount: number };
export function safeImageLabel(name: string, id: string, mime: InputMime = 'image/png'): string {
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  let length = 0, label = '';
  for (const point of clean) {
    const bytes = new TextEncoder().encode(point).length;
    if (length + bytes > 1024) break;
    label += point; length += bytes;
  }
  return label || `image-${id.slice(0, 8)}.${mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'}`;
}
export function sameImageTarget(a: ImageTarget, b: ImageTarget): boolean {
  return a.serverOrigin === b.serverOrigin && a.actorUserId === b.actorUserId && sessionFenceKey(a.fence) === sessionFenceKey(b.fence) && a.expectedNativeSessionId === b.expectedNativeSessionId;
}
/** Local admission complements, but never replaces, authoritative upload validation. */
export function imageSetIssue(items: readonly DraftImageMetadata[], capability: ImageCapabilities | null, target: ImageTarget, mode: 'send' | 'steer'): string | null {
  if (!capability || capability[mode] !== 'supported' || !capability.geometry.known) return capability?.reasonCode || 'image_capability_unavailable';
  if (capability.expectedNativeSessionId !== target.expectedNativeSessionId) return 'image_target_changed';
  if (items.length > Math.min(IMAGE_LIMITS.images, capability.maxImagesPerMessage)) return 'image_count_limit';
  let total = 0;
  for (const item of items) {
    if (!capability.inputMediaTypes.includes(item.mediaType)) return 'image_format_unsupported';
    if (item.byteLength < 1 || item.byteLength > Math.min(IMAGE_LIMITS.imageBytes, Number(capability.maxImageBytes))) return 'image_byte_limit';
    const g = capability.geometry;
    if (item.width < 1 || item.height < 1 || item.width > Math.min(g.maxWidth, IMAGE_LIMITS.maxWidth) || item.height > Math.min(g.maxHeight, IMAGE_LIMITS.maxHeight) || item.width * item.height > Math.min(g.maxPixels, IMAGE_LIMITS.maxPixels) || item.frameCount < 1 || item.frameCount > Math.min(g.maxFrames, IMAGE_LIMITS.maxFrames)) return 'image_geometry_limit';
    total += item.byteLength;
  }
  return total > Math.min(IMAGE_LIMITS.messageBytes, Number(capability.maxMessageImageBytes)) ? 'image_message_limit' : null;
}
/** Bind a receipt to the immutable original; a matching upload ID alone is insufficient. */
export function assertDraftUploadReceipt(spec: ImageUploadSpec, receipt: ImageUploadReceipt, metadata?: DraftImageMetadata): void {
  const invalid = () => { throw new Error('Image upload receipt does not match the saved original.'); };
  if (receipt.uploadId !== spec.uploadId || receipt.imageId !== spec.imageId || !sameImageTarget(receipt.target, spec.target) || receipt.spec.name !== spec.name || receipt.spec.mediaType !== spec.mediaType || receipt.spec.byteLength !== spec.byteLength || receipt.spec.sha256 !== spec.sha256 || BigInt(receipt.acceptedOffset) > BigInt(spec.byteLength)) invalid();
  if (receipt.state !== 'complete') return;
  const r = receipt.resource;
  if (!r || r.status !== 'available' || r.name !== spec.name || r.mediaType !== spec.mediaType || r.byteLength !== spec.byteLength || r.sha256 !== spec.sha256 || receipt.acceptedOffset !== spec.byteLength || !r.width || !r.height || !r.frameCount || r.frameCount > IMAGE_LIMITS.maxFrames) invalid();
  if (metadata && (r!.width !== metadata.width || r!.height !== metadata.height || r!.frameCount !== metadata.frameCount || Number(spec.byteLength) !== metadata.byteLength || spec.sha256 !== metadata.sha256 || spec.mediaType !== metadata.mediaType)) invalid();
}
