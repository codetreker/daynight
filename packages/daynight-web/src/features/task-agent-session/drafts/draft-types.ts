import type { ImageTarget, ImageUploadReceipt, ImageUploadSpec, InputMime, SessionCommand, SessionFence, SessionOperation } from '../../../../../daynight/src/session/protocol';

export type DraftResolver =
  | { readonly kind: 'task'; readonly projectId: string; readonly taskId: string }
  | { readonly kind: 'session'; readonly sessionId: string; readonly testExecutionId: string };
export type DraftOwnerIdentity = { readonly target: ImageTarget; readonly resolver: DraftResolver };
export type DraftHandle = { readonly ownerKey: string; readonly accessEpoch: number };
export type DraftOwner = DraftHandle & {
  readonly identity: DraftOwnerIdentity;
  readonly executionKey: string;
  readonly accountKey: string;
  readonly storeVersion: number;
  readonly editableDraftId: string | null;
  readonly unresolvedSubmissionId: string | null;
  /** Historical recovery never becomes editable again, including after another revocation. */
  readonly recoveryOnly?: true;
  readonly blocked: 'revoked' | 'account_changed' | 'deleted' | 'recovery_only' | null;
  readonly cleanupPending: boolean;
  readonly allocatedBytes: number;
  readonly legacyImported: boolean;
};
export type DraftImageItem = {
  readonly incarnation?: string;
  readonly draftImageId: string;
  readonly imageId: string;
  readonly byteRevision: string;
  readonly label: string;
  readonly blobId: string | null;
  readonly validation: 'pending' | 'valid' | 'bytes_missing' | 'bytes_invalid' | 'rejected';
  readonly error: string | null;
  readonly uploadId: string | null;
};
export type RejectedDraftCandidate = { readonly candidateId: string; readonly label: string; readonly reason: string };
export type DraftRecord = {
  readonly ownerKey: string;
  readonly draftId: string;
  readonly revision: string;
  readonly storeVersion: number;
  readonly text: string;
  readonly items: readonly DraftImageItem[];
  readonly rejectedCandidates: readonly RejectedDraftCandidate[];
  readonly overflowRejectedCount: number;
  readonly state: 'editable' | 'frozen' | 'detached';
  readonly savedAt: number;
};
export type DraftBlobInput = {
  readonly validation?: 'verified';
  readonly blobId: string;
  readonly blob: Blob;
  readonly byteLength: number;
  readonly sha256: string;
  readonly mediaType: InputMime;
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly byteRevision: string;
};
export type PendingDraftBlobInput = Pick<DraftBlobInput, 'blobId' | 'blob' | 'byteLength' | 'byteRevision'> & { readonly validation: 'pending' };
export type StoredDraftBlobInput = DraftBlobInput | PendingDraftBlobInput;
export type DraftBlob = StoredDraftBlobInput & { readonly ownerKey: string; readonly references: readonly string[]; readonly originalId?: string };
export type DraftBlobValidationRef = { readonly draftId: string; readonly draftImageId: string; readonly itemIncarnation: string; readonly blobId: string; readonly byteRevision: string; readonly originalId: string };
export type DraftImageMetadata = Pick<DraftBlobInput, 'byteLength' | 'sha256' | 'mediaType' | 'width' | 'height' | 'frameCount'>;
export const isValidatedDraftBlob = (blob: StoredDraftBlobInput): blob is DraftBlobInput => blob.validation !== 'pending';
export type DraftUploadAction =
  | { readonly kind: 'prepare' | 'complete' | 'query' | 'release' }
  | { readonly kind: 'chunk'; readonly offset: string; readonly length: number; readonly sha256: string };
export type NewDraftUpload = {
  readonly draftImageId: string;
  readonly byteRevision: string;
  readonly blobId: string;
  readonly spec: ImageUploadSpec;
};
export type DraftUpload = NewDraftUpload & {
  readonly ownerKey: string;
  readonly uploadId: string;
  readonly storeVersion: number;
  readonly requestSequence: number;
  readonly observedSequence: number;
  readonly receipt: ImageUploadReceipt | null;
  readonly pendingAction: DraftUploadAction | null;
  readonly outcomeUnknown: boolean;
  readonly releaseIntent: boolean;
};
export type DraftSubmission = {
  readonly ownerKey: string;
  readonly operationId: string;
  readonly kind: 'send_message' | 'execute_command';
  readonly executionKey: string;
  readonly target: ImageTarget;
  readonly fence: SessionFence;
  readonly draftId: string;
  readonly draftRevision: string;
  readonly command: SessionCommand | null;
  readonly snapshot: DraftRecord | null;
  readonly blobIds: readonly string[];
  readonly uploadIds: readonly string[];
  readonly state: 'prepared' | 'dispatch_claimed' | 'unknown' | 'accepted' | 'rejected' | 'local_not_dispatched';
  readonly lastOperation: SessionOperation | null;
  readonly legacy: { readonly revision: string; readonly kind: 'send_message' | 'execute_command' } | null;
  readonly sensitiveCleared: boolean;
};
export type DraftSnapshot = {
  readonly owner: DraftOwner;
  readonly editable: DraftRecord | null;
  readonly frozen: DraftRecord | null;
  readonly submission: DraftSubmission | null;
  readonly uploads: readonly DraftUpload[];
  readonly executionBlocked: boolean;
};
export type DraftRecoveryRef = { readonly ownerKey: string; readonly operationId: string; readonly choiceRevision: string };
export type DraftRecoverySnapshot = DraftSnapshot & { readonly submission: DraftSubmission };
export type DraftDetachedRef = DraftHandle & { readonly draftId: string; readonly revision: string; readonly storeVersion: number };
export type DraftDetachedSnapshot = DraftSnapshot & { readonly editable: DraftRecord; readonly submission: null };
export type DraftWrite = {
  readonly draftId: string;
  readonly expectedStoreVersion: number;
  readonly text: string;
  readonly items: readonly DraftImageItem[];
  readonly rejectedCandidates: readonly RejectedDraftCandidate[];
  readonly overflowRejectedCount: number;
  readonly blobs?: readonly StoredDraftBlobInput[];
};
export type DraftFreeze = {
  readonly draftId: string;
  readonly expectedStoreVersion: number;
  readonly command: SessionCommand;
  readonly commandDraft?: { readonly text: string; readonly commandName: string };
};
export type LegacyDraftImport = {
  readonly text: string;
  readonly revision: string;
  readonly submission: { readonly operationId: string; readonly revision: string; readonly kind?: 'send_message' | 'execute_command' } | null;
};
declare const draftDispatchAuthority: unique symbol;
export type DraftDispatchAuthority = { readonly [draftDispatchAuthority]: true };
export type DraftDispatchClaim = { readonly submission: DraftSubmission; readonly authority: DraftDispatchAuthority };
export type DraftSettlement = { readonly operationId: string; readonly outcome: 'accepted' | 'rejected'; readonly operation: SessionOperation };
export type DraftStoreErrorCode = 'conflict' | 'blocked' | 'unavailable' | 'quota' | 'bytes_missing' | 'bytes_invalid' | 'execution_blocked' | 'invalid' | 'revision_exhausted';
