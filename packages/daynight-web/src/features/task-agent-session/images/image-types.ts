import type { DisplayMime, SessionFence, SessionResource } from '../../../../../daynight/src/session/protocol';

export type ImageReadPriority = 'background' | 'preview' | 'download';
export type ImageScopeIdentity = {
  readonly serverOrigin: string;
  readonly actorUserId: string;
  readonly authorizationGeneration: string;
  readonly owner: { readonly kind: 'session'; readonly fence: SessionFence; readonly nativeSessionId: string | null }
    | { readonly kind: 'record'; readonly recordId: string; readonly namespace: string; readonly revision: string };
};
export type ImageFailureCode = 'access_pending' | 'access_revoked' | 'resource_changed' | 'integrity_failed' | 'unsupported_format' | 'read_failed' | 'read_timeout' | 'cache_busy' | 'decode_failed' | 'decode_timeout' | 'download_busy';
export class ImageFailure extends Error {
  constructor(readonly code: ImageFailureCode, message: string) { super(message); this.name = 'ImageFailure'; }
}
export const displayMimes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const;
export const isDisplayMime = (value: string | null): value is DisplayMime => displayMimes.includes(value as DisplayMime);
export type ImageSize = { readonly width: number; readonly height: number };
export type DecodedImageLease = ImageSize & {
  readonly url: string;
  readonly valid: boolean;
  subscribeInvalidation(listener: () => void): () => void;
  release(): void;
};
export type VerifiedImageLease = {
  readonly blob: Blob;
  readonly mediaType: DisplayMime;
  readonly byteLength: number;
  readonly sha256: string;
  readonly storedSize: ImageSize | null;
  readonly valid: boolean;
  decode(signal: AbortSignal, priority?: ImageReadPriority): Promise<DecodedImageLease>;
  subscribeInvalidation(listener: () => void): () => void;
  release(): void;
};
export type ImageScope = {
  readonly identity: ImageScopeIdentity;
  readonly key: string;
  readonly valid: boolean;
  canRead(): boolean;
  canDownload(): boolean;
  asset(resource: SessionResource): ImageAssetAdapter | null;
  /** Retire removed originals after the owner has reconciled its complete known references. */
  retainResources(resourceIds: ReadonlySet<string>): void;
  /** Revokes publication immediately; resolves only after owned readers and decoders end. */
  invalidate(): Promise<void>;
  subscribeInvalidation(listener: () => void): () => void;
};
export type ImageAssetAdapter = {
  readonly scope: ImageScope;
  readonly key: string;
  readonly resource: SessionResource | null;
  canRead(): boolean;
  canDownload(): boolean;
  acquire(signal: AbortSignal, priority?: ImageReadPriority): Promise<VerifiedImageLease>;
  subscribeInvalidation(listener: () => void): () => void;
};
export type LocalImageMetadata = ImageSize & {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly byteLength: number;
  readonly sha256: string;
  readonly frameCount: number;
};
export type LocalImageAssetAdapter = ImageAssetAdapter & {
  readonly resource: null;
  /** Present only after complete byte, container and pixel validation. */
  readonly metadata: LocalImageMetadata | null;
  validate(signal: AbortSignal): Promise<LocalImageMetadata>;
  /** Revokes this byte version, without changing persisted draft or saved references. */
  release(): void;
};
