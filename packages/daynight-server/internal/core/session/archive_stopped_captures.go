package session

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// stoppedCaptureImages builds the image-to-original index outside the Session lock.
func stoppedCaptureImages(entries []sp.TimelineEntry) (map[string]string, error) {
	images := map[string]string{}
	var visit func(any)
	visit = func(value any) {
		switch v := value.(type) {
		case []any:
			for _, child := range v {
				visit(child)
			}
		case map[string]any:
			if v["type"] == "image" {
				image, iok := v["imageId"].(string)
				resource, rok := v["resourceId"].(string)
				if iok && rok {
					images[image] = resource
				}
			}
			for _, child := range v {
				visit(child)
			}
		}
	}
	for _, entry := range entries {
		data, err := sp.MarshalWire(entry)
		if err != nil {
			return nil, err
		}
		var value any
		if json.Unmarshal(data, &value) != nil {
			return nil, errors.New("invalid decoded archive entry")
		}
		visit(value)
	}
	return images, nil
}

// verifyStoppedCaptures compares the frozen inventory with the final projection
// while holding the Session lock. It never starts a new source read.
func (s *Execution) verifyStoppedCaptures(ctx context.Context, tx *operationTx, r *record, ledger archiveLedger, images map[string]string) error {
	return s.reconcileStoppedCaptures(ctx, tx, r, ledger, images, nil)
}

// reconcileStoppedCaptures keeps pre-publication validation read-only. The
// completion transaction repeats the checks and records eligible pins for final publication.
func (s *Execution) reconcileStoppedCaptures(ctx context.Context, tx *operationTx, r *record, ledger archiveLedger, images map[string]string, pending *[]sp.ImageOccurrence) error {
	inventory, ok := tx.dao.(store.SessionCaptureInventoryDAO)
	if !ok {
		return fault("component_unsupported", "Stopped capture inventory requires a server upgrade.")
	}
	occurrences := make(map[string]archiveLedgerOccurrence, len(ledger.Occurrences))
	for _, occurrence := range ledger.Occurrences {
		occurrences[occurrence.ImageID] = occurrence
	}
	var online []sp.ImageOccurrence
	onlineResources := map[string]bool{}
	after := ""
	for {
		rows, err := inventory.SessionCaptures(ctx, r.Snapshot.SessionID, after, 1000)
		if err != nil {
			return err
		}
		for _, capture := range rows {
			position := capture.Request.Occurrence
			if capture.Receipt.State == "reserved" || capture.Receipt.State == "copying" {
				return fault("archive_incomplete", "An image capture has not settled.")
			}
			if capture.Receipt.State == "failed" {
				continue
			}
			if capture.Receipt.State != "committed" {
				return invalidArchiveFile(archiveConflict())
			}
			if capture.Receipt.ResourceID == nil {
				return invalidArchiveFile(archiveConflict())
			}
			if ledger.ContentPolicy == "task_body" && position.Container != "content" {
				online = append(online, position)
				onlineResources[*capture.Receipt.ResourceID] = true
				continue
			}
			actual, found := occurrences[position.ImageID]
			if !found || actual.EntryID != position.EntryID || actual.Container != position.Container || !model.EqualOptional(actual.PartID, position.PartID) || !model.EqualOptional(actual.SourceRevision, position.SourceRevision) || !model.EqualOptional(actual.SourceTextSHA256, position.SourceTextSHA256) || !model.EqualOptional(actual.CallIDSHA256, archiveCallIDSHA256(position.CallID)) || images[position.ImageID] != *capture.Receipt.ResourceID {
				return invalidArchiveFile(fault("archive_incomplete", "A captured image is missing from final history."))
			}
		}
		if len(rows) < 1000 {
			break
		}
		next := rows[len(rows)-1].Request.CaptureID
		if next == "" || next <= after {
			return errors.New("invalid capture inventory cursor")
		}
		after = next
	}
	for _, body := range ledger.Resources {
		delete(onlineResources, body.ResourceID)
	}
	if len(onlineResources) > 0 {
		dao, err := resourceDAO(tx)
		if err != nil {
			return err
		}
		leases, err := dao.ListSessionResourceLeases(ctx, r.Snapshot.SessionID)
		if err != nil {
			return err
		}
		for _, lease := range leases {
			if lease.Kind == "read" && (lease.ResourceID == "" || onlineResources[lease.ResourceID]) {
				return fault("resource_busy", "An online image reader is still running.")
			}
		}
	}
	if pending != nil {
		*pending = online
	}
	return nil
}
