package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Final history publication ends online-only image ownership. The ordinary
// upload settlement path retains deletion responsibility and waits for readers;
// shared message or archive references keep their resource alive.
func (s *Execution) retireOnlineImageReferences(ctx context.Context, tx *operationTx, r *record, positions []sp.ImageOccurrence, bodyResources []sp.Resource) error {
	if len(positions) == 0 {
		return nil
	}
	dao, err := resourceDAO(tx)
	if err != nil {
		return err
	}
	for _, position := range positions {
		capture, err := dao.SessionCaptureByImage(ctx, r.Snapshot.SessionID, position.ImageID)
		if errors.Is(err, model.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		if !jsonEqual(encode(capture.Request.Occurrence), encode(position)) {
			return archiveConflict()
		}
		if capture.Receipt.State == "reserved" || capture.Receipt.State == "copying" {
			return fault("archive_incomplete", "An online image capture has not settled.")
		}
		if capture.Receipt.State != "committed" {
			continue
		}
		if capture.Receipt.ResourceID == nil {
			return archiveConflict()
		}
		resource := *capture.Receipt.ResourceID
		retained := false
		for _, body := range bodyResources {
			if body.ResourceID == resource {
				retained = true
				break
			}
		}
		// Keep the existing pin until sealing establishes the archive reference.
		// A body may reuse a tool capture without creating a second capture receipt.
		if retained {
			continue
		}
		if err = dao.RemoveSessionResourceReference(ctx, store.SessionResourceReference{SessionID: r.Snapshot.SessionID, ResourceID: resource, Kind: "message", ReferenceID: position.ImageID}); err != nil {
			return err
		}
		count, err := dao.SessionResourceReferenceCount(ctx, r.Snapshot.SessionID, resource)
		if err != nil {
			return err
		}
		if count != 0 {
			continue
		}
		owners, ok := tx.dao.(store.SessionResourceUploadDAO)
		if !ok {
			return fault("component_unsupported", "Resource upload ownership requires a server upgrade.")
		}
		upload, err := owners.SessionUploadByResource(ctx, r.Snapshot.SessionID, resource)
		if err != nil {
			return err
		}
		if upload.BlobID != resource {
			return archiveConflict()
		}
		if upload.Receipt.State == "released" {
			continue
		}
		if upload.Receipt.State != "complete" {
			return archiveConflict()
		}
		upload.Receipt.State, upload.Receipt.Resource, upload.Receipt.Error = "released", nil, nil
		if err = s.saveImageUpload(ctx, tx, r, upload); err != nil {
			return err
		}
	}
	return nil
}
