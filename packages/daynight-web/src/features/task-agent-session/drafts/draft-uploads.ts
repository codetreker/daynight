import { IMAGE_LIMITS, type ImageUploadReceipt } from '../../../../../daynight/src/session/image-values';
import type { SessionResourceClient } from '../../../../../daynight/src/session/resource-client';
import type { SessionDraftStore } from './draft-store';
import { isValidatedDraftBlob } from './draft-types';
import type { DraftBlobInput, DraftHandle, DraftUpload, DraftUploadAction } from './draft-types';
import { underDraftLock } from './draft-send';
import { assertDraftUploadReceipt } from './draft-validation';

export type DraftUploadOptions = {
  readonly store: SessionDraftStore;
  readonly locks: LockManager | null;
  readonly resources: SessionResourceClient;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly canPrepare: () => boolean;
  readonly changed: () => Promise<void>;
};

/** Persist each intent before invoking the resource client, and retain the lock through settlement. */
export class DraftUploader {
  constructor(private readonly options: DraftUploadOptions) {}
  private live(): void {
    this.options.signal.throwIfAborted();
    if (!this.options.isCurrent()) throw new Error('image_target_changed');
  }
  async run(handle: DraftHandle, uploadId: string, original: DraftBlobInput | null, observe = false, retryOriginalPrepare = false): Promise<void> {
    const o = this.options;
    if (original && !isValidatedDraftBlob(original)) throw new Error('image_bytes_invalid');
    await underDraftLock(o.locks, handle.ownerKey, `upload:${uploadId}`, async () => {
      this.live();
      let upload = (await o.store.read(handle)).uploads.find(value => value.uploadId === uploadId);
      if (!upload) return;
      const request = async (action: DraftUploadAction, invoke: () => Promise<ImageUploadReceipt>): Promise<boolean> => {
        this.live();
        upload = await o.store.beginUploadRequest(handle, uploadId, upload!.storeVersion, action);
        this.live();
        const sequence = upload.requestSequence;
        try {
          const receipt = await invoke();
          this.live();
          assertDraftUploadReceipt(upload.spec, receipt, original ?? undefined);
          upload = await o.store.observeUpload(handle, uploadId, sequence, receipt);
          this.live(); await o.changed();
          return true;
        } catch (error) {
          // A cancelled or failed request may already have reached the service.
          // Epoch checks prevent a revoked owner from being resurrected here.
          if (o.isCurrent()) {
            upload = await o.store.markUploadUnknown(handle, uploadId, sequence);
            await o.changed();
          }
          throw error;
        }
      };
      if (observe && upload.receipt || upload.outcomeUnknown || upload.pendingAction || upload.requestSequence > 0) {
        const unobservedPrepare = upload.pendingAction?.kind === 'prepare' && !upload.receipt && !upload.releaseIntent;
        try { await request({ kind: 'query' }, () => o.resources.getUpload(uploadId, o.signal)); }
        catch (error) {
          if (!retryOriginalPrepare || !unobservedPrepare || !original || !o.canPrepare()) throw error;
          this.live();
          // Explicit retry repeats the immutable idempotent specification. A
          // failed GET never authorizes a different identity or a message send.
          await request({ kind: 'prepare' }, () => o.resources.prepareUpload(upload!.spec, o.signal));
        }
      }
      this.live();
      if (upload.releaseIntent) {
        if (upload.receipt?.state !== 'released') await request({ kind: 'release' }, () => o.resources.releaseUpload(uploadId, o.signal));
        return;
      }
      if (!o.canPrepare() || !original) return;
      if (!upload.receipt) await request({ kind: 'prepare' }, () => o.resources.prepareUpload(upload!.spec, o.signal));
      while (upload.receipt?.state === 'receiving' && BigInt(upload.receipt.acceptedOffset) < BigInt(upload.spec.byteLength)) {
        this.live(); if (!o.canPrepare()) return;
        const offset = upload.receipt.acceptedOffset;
        const bytes = new Uint8Array(await original.blob.slice(Number(offset), Number(offset) + IMAGE_LIMITS.chunkBytes).arrayBuffer());
        this.live(); if (!o.canPrepare()) return;
        if (!bytes.length) throw new Error('image_bytes_missing');
        const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        this.live(); if (!o.canPrepare()) return;
        await request({ kind: 'chunk', offset, length: bytes.length, sha256 }, () => o.resources.writeUploadChunk(uploadId, offset, bytes, sha256, o.signal));
        if (upload.receipt?.state === 'receiving' && BigInt(upload.receipt.acceptedOffset) <= BigInt(offset)) throw new Error('image_upload_did_not_advance');
      }
      this.live();
      if (upload.receipt?.state === 'receiving' && o.canPrepare()) await request({ kind: 'complete' }, () => o.resources.completeUpload(uploadId, upload!.spec.sha256, upload!.spec.byteLength, o.signal));
    });
  }
}
