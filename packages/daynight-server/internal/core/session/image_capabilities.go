package session

import (
	"context"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"

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
	_, intents := tx.dao.(store.SessionIntentDAO)
	_, archives := tx.dao.(store.SessionArchiveDAO)
	_, uploads := s.files.(filestorage.UploadStorage)
	_, resources := s.files.(filestorage.ResourceStorage)
	ready := s.imageDecoder != nil && s.files != nil && intents && archives && uploads && resources
	capabilities := effectiveImageCapabilities(r.Snapshot, provider, ready)
	old := r.Snapshot.Capabilities.Images
	if old != nil {
		capabilities.Revision = old.Revision
	}
	if old != nil && !jsonEqual(encode(old), encode(capabilities)) {
		capabilities.Revision = next(old.Revision)
	}
	r.Snapshot.Capabilities.Images = capabilities
	updateImageBudget(r, usage)
	return nil
}

// Provider qualification owns native profile evidence. The service narrows that
// report to its installed components and public limits without inventing support.
func effectiveImageCapabilities(snapshot sp.Snapshot, provider *sp.ProviderImageCapabilities, ready bool) *sp.ImageCapabilities {
	reason := "capability_unknown"
	c := &sp.ImageCapabilities{Revision: "1", ProviderRevision: "1", ExpectedNativeSessionID: snapshot.Identity.NativeSessionID, Send: "unknown", Steer: "unknown", ReasonCode: &reason, InputMediaTypes: []string{}, MaxImageBytes: "0", MaxMessageImageBytes: "0", Geometry: sp.ImageGeometry{Version: 1}}
	close := func(code string) *sp.ImageCapabilities {
		c.Send, c.Steer, c.ReasonCode = "unsupported", "unsupported", &code
		if code == "capability_unknown" {
			c.Send, c.Steer = "unknown", "unknown"
		}
		return c
	}
	if provider != nil {
		validated, err := sp.DecodeProviderImageCapabilities(encode(provider))
		if err != nil {
			return close("capability_unknown")
		}
		provider = &validated
		c.ProviderRevision, c.ModelID, c.ControlsRevision = provider.Revision, provider.ModelID, provider.ControlsRevision
	}
	if snapshot.ContentRevision != sp.ContentRevision || !ready {
		return close("component_unsupported")
	}
	if provider == nil {
		return c
	}
	var controlsRevision *string
	if snapshot.Controls != nil {
		controlsRevision = &snapshot.Controls.Revision
	}
	if !sameNative(provider.ExpectedNativeSessionID, snapshot.Identity.NativeSessionID) || !sameNative(provider.ControlsRevision, controlsRevision) {
		return close("capability_unknown")
	}
	supported := provider.Send == "supported" || provider.Steer == "supported"
	if snapshot.Controls != nil {
		if supported && snapshot.Controls.SettingsError != nil {
			return close("capability_unknown")
		}
		for _, setting := range snapshot.Controls.Settings {
			if setting.Category == "model" && (supported || provider.ModelID != nil) && (setting.Value == nil || !sameNative(setting.Value, provider.ModelID)) {
				return close("capability_unknown")
			}
		}
	}
	c.Send, c.Steer, c.ReasonCode = provider.Send, provider.Steer, provider.ReasonCode
	if supported {
		if provider.ReasonCode != nil && slices.Contains([]string{"profile_disabled", "component_unsupported", "provider_unsupported", "worker_upgrade_required", "policy_restricted"}, *provider.ReasonCode) {
			return close("capability_unknown")
		}
	}
	for _, mime := range []string{"image/png", "image/jpeg", "image/webp"} {
		if slices.Contains(provider.InputMediaTypes, mime) {
			c.InputMediaTypes = append(c.InputMediaTypes, mime)
		}
	}
	c.MaxImageBytes = decimal(min(number(provider.MaxImageBytes), number(provider.MaxMessageImageBytes), int64(sp.MaxImageBytes)))
	c.MaxMessageImageBytes = decimal(min(number(provider.MaxMessageImageBytes), int64(sp.MaxMessageImageBytes)))
	c.MaxImagesPerMessage = min(provider.MaxImagesPerMessage, sp.MaxImagesPerMessage)
	c.Geometry = provider.Geometry
	if c.Geometry.Known {
		c.Geometry.MaxWidth = min(c.Geometry.MaxWidth, 16384)
		c.Geometry.MaxHeight = min(c.Geometry.MaxHeight, 16384)
		c.Geometry.MaxPixels = min(c.Geometry.MaxPixels, 33554432)
		c.Geometry.MaxFrames = min(c.Geometry.MaxFrames, 256)
	}
	return c
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
