package session

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const maxSessionIntentBytes = 2 << 20

func canonicalIntent(c sp.Command) ([]byte, error) {
	raw := encode(c)
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	delete(value, "requestId")
	normalizeMessageOrigin(c.Kind, value["payload"])
	return sp.CanonicalImageJSON(value)
}
func imageCommandHash(c sp.Command) []byte {
	intent, err := canonicalIntent(c)
	if err != nil {
		return nil
	}
	h := sha256.Sum256(intent)
	return h[:]
}
func (s *Execution) authorizeImages(ctx context.Context, tx *operationTx, r *record, c sp.Command) error {
	if !sp.ContainsImages(c.Payload) {
		return nil
	}
	var input sp.SendMessage
	if json.Unmarshal(c.Payload, &input) != nil || input.Target == nil {
		return fault("invalid_input", "Image send requires a complete target.")
	}
	actor := model.Principal{UserID: r.Owner}
	if err := s.imageTarget(actor, r, *input.Target); err != nil {
		return err
	}
	caps := r.Snapshot.Capabilities.Images
	if caps == nil || caps.Revision != input.ExpectedImageCapabilityRevision || !sameNative(caps.ExpectedNativeSessionID, r.Snapshot.Identity.NativeSessionID) {
		return fault("capability_changed", "Image input capabilities changed.")
	}
	action := caps.Send
	if input.ExpectedTurnID != nil {
		action = caps.Steer
	}
	if action != "supported" {
		return fault("component_unsupported", "Native image input is not enabled for this provider profile.")
	}
	d, e := resourceDAO(tx)
	if e != nil {
		return e
	}
	total := int64(0)
	count := 0
	for _, part := range input.Content {
		if part.Type != "image" {
			continue
		}
		count++
		u, e := d.SessionUpload(ctx, r.Snapshot.SessionID, part.UploadID)
		if e != nil {
			return e
		}
		if u.ActorID != r.Owner || u.Spec.ImageID != part.ImageID || u.Receipt.State != "complete" || u.Receipt.Resource == nil || u.Receipt.Resource.ResourceID != part.ResourceID || u.Spec.SHA256 != part.SHA256 || u.Spec.ByteLength != part.ByteLength || !jsonEqual(encode(u.Spec.Target), encode(input.Target)) {
			return fault("resource_conflict", "Image intent does not match its completed upload.")
		}
		if !s.now().Before(u.ExpiresAt) {
			original, e := d.SessionResourceReferenceExists(ctx, store.SessionResourceReference{SessionID: c.SessionID, ResourceID: part.ResourceID, Kind: "operation", ReferenceID: c.OperationID})
			if e != nil {
				return e
			}
			if !original {
				return fault("upload_expired", "The original image upload expired before input admission.")
			}
		}
		saved, e := d.SavedSessionResource(ctx, r.Snapshot.SessionID, part.ResourceID)
		if e != nil {
			return e
		}
		if !jsonEqual(encode(saved.Resource), encode(u.Receipt.Resource)) {
			return fault("resource_conflict", "Saved image descriptor changed.")
		}
		total += number(part.ByteLength)
	}
	if count > sp.MaxImagesPerMessage || total > sp.MaxMessageImageBytes {
		return fault("quota_exceeded", "Image message exceeds its input budget.")
	}
	return nil
}
func persistIntent(ctx context.Context, tx *operationTx, c sp.Command) error {
	d, ok := tx.dao.(store.SessionIntentDAO)
	if !ok {
		if sp.ContainsImages(c.Payload) {
			return fault("component_unsupported", "Persistent image intents require a server upgrade.")
		}
		return nil
	}
	bytes, e := canonicalIntent(c)
	if e != nil {
		return e
	}
	if len(bytes) > maxSessionIntentBytes {
		return fault("quota_exceeded", "The canonical operation intent exceeds its storage budget.")
	}
	if e = d.InsertSessionOperationIntent(ctx, c.SessionID, c.OperationID, bytes); e != nil {
		return e
	}
	if sp.ContainsImages(c.Payload) {
		resources, e := resourceDAO(tx)
		if e != nil {
			return e
		}
		var input sp.SendMessage
		_ = json.Unmarshal(c.Payload, &input)
		for _, part := range input.Content {
			if part.Type == "image" {
				if e = resources.AddSessionResourceReference(ctx, store.SessionResourceReference{SessionID: c.SessionID, ResourceID: part.ResourceID, Kind: "operation", ReferenceID: c.OperationID}); e != nil {
					return e
				}
				if e = resources.AddSessionResourceReference(ctx, store.SessionResourceReference{SessionID: c.SessionID, ResourceID: part.ResourceID, Kind: "native_resume", ReferenceID: c.OperationID}); e != nil {
					return e
				}
			}
		}
	}
	return nil
}
func persistedIntent(ctx context.Context, tx *operationTx, session, id string) (sp.Command, bool, error) {
	d, ok := tx.dao.(store.SessionIntentDAO)
	if !ok {
		return sp.Command{}, false, nil
	}
	raw, e := d.SessionOperationIntent(ctx, session, id)
	if errors.Is(e, model.ErrNotFound) {
		return sp.Command{}, false, nil
	}
	if e != nil {
		return sp.Command{}, false, e
	}
	if len(raw) > maxSessionIntentBytes {
		return sp.Command{}, false, fault("resource_conflict", "Persisted operation intent exceeds its storage budget.")
	}
	var c sp.Command
	if json.Unmarshal(raw, &c) != nil || c.SessionID != session || c.OperationID != id {
		return c, false, fault("resource_conflict", "Persisted operation intent is corrupt.")
	}
	c.RequestID = "recovered"
	return c, true, nil
}
