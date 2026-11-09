package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func (s *Execution) refreshImageState(ctx context.Context, tx *operationTx, r *record, provider *sp.ProviderImageCapabilities) error {
	if r.Snapshot.ContentRevision != 2 {
		r.Snapshot.Capabilities.Images = nil
		r.Snapshot.ImageBudget = nil
		return nil
	}
	d, e := resourceDAO(tx)
	if e != nil {
		return e
	}
	usage, e := d.SessionResourceUsage(ctx, r.Snapshot.SessionID)
	if e != nil {
		return e
	}
	reason := "provider_unsupported"
	if s.imageDecoder == nil {
		reason = "component_unsupported"
	}
	providerRevision := "1"
	var modelID, controlsRevision *string
	if provider != nil {
		providerRevision = provider.Revision
		modelID, controlsRevision = provider.ModelID, provider.ControlsRevision
	}
	old := r.Snapshot.Capabilities.Images
	revision := "1"
	if old != nil {
		revision = old.Revision
	}
	capabilities := &sp.ImageCapabilities{Revision: revision, ProviderRevision: providerRevision, ExpectedNativeSessionID: r.Snapshot.Identity.NativeSessionID, ModelID: modelID, ControlsRevision: controlsRevision, Send: "unsupported", Steer: "unsupported", ReasonCode: &reason, InputMediaTypes: []string{"image/png", "image/jpeg", "image/webp"}, MaxImageBytes: decimal(sp.MaxImageBytes), MaxMessageImageBytes: decimal(sp.MaxMessageImageBytes), MaxImagesPerMessage: sp.MaxImagesPerMessage, Geometry: sp.ImageGeometry{Version: 1, Known: true, MaxWidth: 16384, MaxHeight: 16384, MaxPixels: 33554432, MaxFrames: 256}}
	if old != nil && !jsonEqual(encode(old), encode(capabilities)) {
		capabilities.Revision = next(old.Revision)
	}
	r.Snapshot.Capabilities.Images = capabilities
	updateImageBudget(r, usage)
	return nil
}

func updateImageBudget(r *record, usage store.SessionResourceUsage) bool {
	budget := imageBudget(usage)
	old := r.Snapshot.ImageBudget
	if old != nil {
		budget.Revision = old.Revision
		if jsonEqual(encode(old), encode(budget)) {
			return false
		}
		budget.Revision = next(old.Revision)
	}
	r.Snapshot.ImageBudget = budget
	return true
}

// A budget change shares the authorized transaction with the upload receipt.
// Publication of the live snapshot follows the transaction's confirmed commit.
func (s *Execution) saveImageUpload(ctx context.Context, tx *operationTx, r *record, upload store.SessionUploadRecord) error {
	d, e := resourceDAO(tx)
	if e != nil {
		return e
	}
	if e = d.SaveSessionUpload(ctx, upload); e != nil {
		return e
	}
	return s.syncImageBudget(ctx, tx, r)
}
func (s *Execution) syncImageBudget(ctx context.Context, tx *operationTx, r *record) error {
	if r.Snapshot.ContentRevision != 2 {
		return nil
	}
	d, e := resourceDAO(tx)
	if e != nil {
		return e
	}
	usage, e := d.SessionResourceUsage(ctx, r.Snapshot.SessionID)
	if e != nil {
		return e
	}
	if !updateImageBudget(r, usage) {
		return nil
	}
	if e = s.emit(ctx, tx, r, "snapshot", r.Snapshot, nil); e != nil {
		return e
	}
	return save(ctx, tx, r)
}
