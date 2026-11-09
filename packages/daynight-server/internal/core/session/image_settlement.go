package session

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type imageStorageAccess func(context.Context, func(*operationTx, *record) error) error

func imageUploadExpiryEligible(ctx context.Context, dao store.SessionResourceDAO, upload store.SessionUploadRecord, now time.Time) (bool, error) {
	if now.Before(upload.ExpiresAt) {
		return false, nil
	}
	switch upload.Receipt.State {
	case "receiving", "verifying":
		return true, nil
	case "complete":
		count, err := dao.SessionResourceReferenceCount(ctx, upload.SessionID, upload.BlobID)
		if err != nil {
			return false, err
		}
		own, err := dao.SessionResourceReferenceExists(ctx, store.SessionResourceReference{SessionID: upload.SessionID, ResourceID: upload.BlobID, Kind: "upload", ReferenceID: upload.Spec.UploadID})
		if err != nil {
			return false, err
		}
		allowed := 0
		if own {
			allowed = 1
		}
		return count <= allowed, nil
	}
	return false, nil
}

func (s *Execution) expireUploadLocked(ctx context.Context, tx *operationTx, r *record, upload store.SessionUploadRecord) (store.SessionUploadRecord, error) {
	dao, err := resourceDAO(tx)
	if err != nil {
		return upload, err
	}
	eligible, err := imageUploadExpiryEligible(ctx, dao, upload, s.now())
	if err != nil || !eligible {
		return upload, err
	}
	if upload.Receipt.State == "complete" {
		if err = dao.RemoveSessionResourceReference(ctx, store.SessionResourceReference{SessionID: upload.SessionID, ResourceID: upload.BlobID, Kind: "upload", ReferenceID: upload.Spec.UploadID}); err != nil {
			return upload, err
		}
	}
	upload.Receipt.State, upload.Receipt.Resource = "expired", nil
	upload.Receipt.Error = &sp.ImageError{Code: "upload_expired", Message: "The original image upload expired."}
	return upload, s.saveImageUpload(ctx, tx, r, upload)
}

func (s *Execution) cleanupUploadStorage(ctx context.Context, project, id, uploadID string, access imageStorageAccess, releaseController func(context.Context) error) (result error) {
	var upload store.SessionUploadRecord
	var chunks []store.SessionUploadChunk
	var leases []store.SessionResourceLease
	var path string
	var namespace sessionresource.Namespace
	terminal := false
	if err := access(ctx, func(tx *operationTx, r *record) error {
		dao, e := resourceDAO(tx)
		if e != nil {
			return e
		}
		upload, e = dao.SessionUpload(ctx, id, uploadID)
		if e != nil {
			return e
		}
		namespace, e = sessionresource.NewNamespace(project, r.Owner, id)
		if e != nil {
			return e
		}
		terminal = upload.Receipt.State == "released" || upload.Receipt.State == "expired" || upload.Receipt.State == "failed"
		if !terminal && upload.Receipt.State != "complete" {
			return conflict()
		}
		if !upload.StorageReleased {
			chunks, e = dao.SessionUploadChunks(ctx, id, uploadID)
			if e != nil {
				return e
			}
		}
		if !terminal {
			return nil
		}
		settlement, ok := tx.dao.(store.SessionResourceSettlementDAO)
		if !ok {
			return fault("component_unsupported", "Resource reclamation requires a server upgrade.")
		}
		claimed, e := settlement.MarkSessionResourceReclaim(ctx, id, upload.BlobID)
		if e != nil {
			return e
		}
		if !claimed {
			return fault("resource_in_use", "A durable reference still retains this original.")
		}
		path, e = BlobAddress(project, r.Owner, id, upload.BlobID)
		if e != nil {
			return e
		}
		saved, e := dao.SavedSessionResource(ctx, id, upload.BlobID)
		if e != nil && !errors.Is(e, model.ErrNotFound) {
			return e
		}
		if e == nil && (saved.BlobID != upload.BlobID || saved.BlobPath != path || !saved.GCPending) {
			return fault("resource_conflict", "Original resource reclamation identity changed.")
		}
		leases, e = dao.ListSessionResourceLeases(ctx, id)
		return e
	}); err != nil {
		return err
	}
	if terminal {
		if err := releaseController(ctx); err != nil {
			return err
		}
		for _, lease := range leases {
			if lease.ResourceID != "" && lease.ResourceID != upload.BlobID {
				continue
			}
			gate, err := filestorage.TryAcquireMediaLease(ctx, s.files, "session-resource-lease/"+lease.ID)
			if errors.Is(err, filestorage.ErrGateBusy) {
				return fault("resource_busy", "An original resource reader or writer is still running.")
			}
			if err != nil {
				return err
			}
			// Retain the exact old owner gate through physical deletion and the
			// final transaction, including an unconfirmed database completion.
			defer func() { result = errors.Join(result, gate.Close()) }()
			err = access(ctx, func(tx *operationTx, _ *record) error {
				dao, e := resourceDAO(tx)
				if e != nil {
					return e
				}
				return dao.ReleaseSessionResourceLease(ctx, id, lease.ID)
			})
			if err != nil {
				return err
			}
		}
	}
	payloadGate, err := s.files.AcquireGate(ctx, filestorage.MediaLeaseGate, "session-upload-payload/"+id+"/"+uploadID)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, payloadGate.Close()) }()
	// All earlier read-response publishers exited before this sweep. Their exact
	// shared chunk paths consume the same reservation as ordinary upload chunks.
	if err = access(ctx, func(tx *operationTx, _ *record) error { return settleUploadMedia(ctx, tx, id, uploadID, upload.BlobID) }); err != nil {
		return err
	}
	for _, chunk := range chunks {
		if err := s.files.Delete(ctx, sessionresource.Bucket, chunk.Path); err != nil {
			return err
		}
	}
	// The upload gate is held by every caller, and terminal settlement has
	// joined the exact prior lease owners above. A file can outlive a failed
	// chunk-row transaction, so row-by-row deletion alone cannot return quota.
	sweeper, ok := s.files.(filestorage.UploadStorage)
	if !ok {
		return fault("component_unsupported", "Complete upload reclamation requires a storage upgrade.")
	}
	if err := sweeper.DeleteSessionUpload(ctx, namespace, uploadID); err != nil {
		return err
	}
	if terminal {
		if err := s.files.Delete(ctx, sessionresource.Bucket, path); err != nil {
			return err
		}
	}
	return access(ctx, func(tx *operationTx, r *record) error {
		dao, e := resourceDAO(tx)
		if e != nil {
			return e
		}
		current, e := dao.SessionUpload(ctx, id, uploadID)
		if e != nil {
			return e
		}
		if current.BlobID != upload.BlobID || current.Receipt.State != upload.Receipt.State {
			return conflict()
		}
		if terminal {
			if e = tx.dao.(store.SessionResourceSettlementDAO).DeleteReclaimedSessionResource(ctx, id, upload.BlobID); e != nil {
				return e
			}
		}
		current.StorageReleased = true
		return s.saveImageUpload(ctx, tx, r, current)
	})
}

// SettleExpiredUploads is called by stopped archive preparation and sealing.
// The original upload gate proves its writer exited before expiry and cleanup;
// durable reservations and resource rows remain until physical cleanup commits.
func (op *ArchiveOperation) SettleExpiredUploads(ctx context.Context) (result error) {
	if err := op.check(ArchiveV1Upload); err != nil {
		return err
	}
	ctx, finish, err := op.execution.beginImageIO(ctx, op.id, uuid.NewString())
	if err != nil {
		return err
	}
	defer func() { result = joinImageCleanup(result, finish) }()
	access := func(ctx context.Context, work func(*operationTx, *record) error) error {
		return op.execution.archiveAccess(ctx, op.principal, op.project, op.task, op.id, true, func(tx *operationTx, r *record, t task) error {
			if r.Owner != op.owner {
				return conflict()
			}
			if e := archiveStopped(r, t); e != nil {
				return e
			}
			return work(tx, r)
		})
	}
	var uploads []store.SessionUploadRecord
	if err := access(ctx, func(tx *operationTx, _ *record) error {
		dao, ok := tx.dao.(store.SessionResourceSettlementDAO)
		if !ok {
			return fault("component_unsupported", "Upload settlement requires a server upgrade.")
		}
		var e error
		uploads, e = dao.ListSessionUploadsForSettlement(ctx, op.id, op.execution.now())
		return e
	}); err != nil {
		return err
	}
	for _, upload := range uploads {
		if err := op.settleExpiredUpload(ctx, upload, access); err != nil {
			return err
		}
	}
	return nil
}
func (op *ArchiveOperation) settleExpiredUpload(ctx context.Context, upload store.SessionUploadRecord, access imageStorageAccess) (result error) {
	gate, err := op.execution.files.AcquireGate(ctx, filestorage.PrivateGate, "session-image-upload/"+op.id+"/"+upload.Spec.UploadID)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, gate.Close()) }()
	if err = access(ctx, func(tx *operationTx, r *record) error {
		dao, e := resourceDAO(tx)
		if e != nil {
			return e
		}
		current, e := dao.SessionUpload(ctx, op.id, upload.Spec.UploadID)
		if e != nil {
			return e
		}
		_, e = op.execution.expireUploadLocked(ctx, tx, r, current)
		return e
	}); err != nil {
		return err
	}
	return op.execution.cleanupUploadStorage(ctx, op.project, op.id, upload.Spec.UploadID, access, func(ctx context.Context) error { return op.archivedControllerRelease(ctx, upload, access) })
}
func (op *ArchiveOperation) archivedControllerRelease(ctx context.Context, upload store.SessionUploadRecord, access imageStorageAccess) error {
	return access(ctx, func(tx *operationTx, _ *record) error {
		media, ok := tx.dao.(store.SessionMediaDAO)
		if !ok {
			return nil
		}
		prepare, e := media.SessionMediaRequest(ctx, op.id, mediaIdentity(upload.Spec.UploadID, "prepare"))
		if errors.Is(e, model.ErrNotFound) {
			return nil
		}
		if e != nil {
			return e
		}
		release, e := media.SessionMediaRequest(ctx, op.id, mediaIdentity(upload.Spec.UploadID, "release"))
		if errors.Is(e, model.ErrNotFound) {
			return fault("archive_incomplete", "The original Controller preparation has not confirmed release.")
		}
		if e != nil {
			return e
		}
		var spec sp.ImageUploadSpec
		var receipt sp.LocalImagePreparation
		if json.Unmarshal(prepare.Body, &spec) != nil || json.Unmarshal(release.Result, &receipt) != nil || !release.Complete || release.Error != nil || receipt.State != "released" || receipt.UploadID != upload.Spec.UploadID || receipt.ImageID != spec.ImageID || !jsonEqual(encode(receipt.Target), encode(spec.Target)) || receipt.Validated != nil || receipt.Error != nil {
			return fault("archive_incomplete", "The original Controller preparation has not confirmed release.")
		}
		return nil
	})
}
