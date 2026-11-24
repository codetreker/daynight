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

// pendingImageRetirements preserves both the last active checkpoint and the
// stopped inventory until archive publication succeeds.
func pendingImageRetirements(groups ...[]sp.ImageOccurrence) ([]sp.ImageOccurrence, error) {
	var pending []sp.ImageOccurrence
	seen := map[string]sp.ImageOccurrence{}
	for _, group := range groups {
		for _, position := range group {
			if old, ok := seen[position.ImageID]; ok {
				if !jsonEqual(encode(old), encode(position)) {
					return nil, archiveConflict()
				}
				continue
			}
			seen[position.ImageID] = position
			pending = append(pending, position)
		}
	}
	return pending, nil
}

// The read lease may have been acquired after history was accepted. Check it
// under the same lock as the ready receipt and ownership changes.
func (s *Execution) retirePendingImages(ctx context.Context, tx *operationTx, r *record, positions []sp.ImageOccurrence, body []sp.Resource) error {
	dao, err := resourceDAO(tx)
	if err != nil {
		return err
	}
	bodyIDs := map[string]bool{}
	for _, resource := range body {
		bodyIDs[resource.ResourceID] = true
	}
	online := map[string]bool{}
	for _, position := range positions {
		capture, e := dao.SessionCaptureByImage(ctx, r.Snapshot.SessionID, position.ImageID)
		if errors.Is(e, model.ErrNotFound) {
			continue
		}
		if e != nil {
			return e
		}
		if !jsonEqual(encode(capture.Request.Occurrence), encode(position)) {
			return archiveConflict()
		}
		if capture.Receipt.State == "reserved" || capture.Receipt.State == "copying" {
			return fault("archive_incomplete", "An online image capture has not settled.")
		}
		if capture.Receipt.State == "committed" {
			if capture.Receipt.ResourceID == nil {
				return archiveConflict()
			}
			if !bodyIDs[*capture.Receipt.ResourceID] {
				online[*capture.Receipt.ResourceID] = true
			}
		}
	}
	if len(online) > 0 {
		leases, e := dao.ListSessionResourceLeases(ctx, r.Snapshot.SessionID)
		if e != nil {
			return e
		}
		for _, lease := range leases {
			if lease.Kind == "read" && (lease.ResourceID == "" || online[lease.ResourceID]) {
				return fault("resource_busy", "An online image reader is still running.")
			}
		}
	}
	return s.retireOnlineImageReferences(ctx, tx, r, positions, body)
}
