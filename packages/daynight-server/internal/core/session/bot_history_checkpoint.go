package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func decodeSavedBotHistoryCheckpoint(raw []byte) (sp.BotHistoryCheckpoint, error) {
	// PostgreSQL JSONB may add whitespace and normalize string escapes. Admission
	// measures the protocol encoding rather than that storage representation.
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return sp.BotHistoryCheckpoint{}, err
	}
	wire, err := sp.MarshalWire(value)
	if err != nil {
		return sp.BotHistoryCheckpoint{}, err
	}
	return sp.DecodeBotHistoryCheckpoint(wire)
}

func botHistoryDAO(tx *operationTx) (store.BotHistoryWindowDAO, error) {
	dao, ok := tx.dao.(store.BotHistoryWindowDAO)
	if !ok {
		return nil, fault("component_unsupported", "Bot history checkpoints require a server upgrade.")
	}
	return dao, nil
}

func requireBotHistoryWindowConnection(ctx context.Context, tx *operationTx, r *record, version int) error {
	if r.BotID == nil {
		return nil
	}
	dao, ok := tx.dao.(store.BotHistoryWindowDAO)
	if !ok {
		if version == 0 {
			return nil
		}
		return fault("component_unsupported", "Bot history checkpoints require a server upgrade.")
	}
	_, err := dao.BotHistoryCheckpoint(ctx, r.Snapshot.SessionID)
	if errors.Is(err, model.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if version != sp.BotHistoryWindowVersion {
		return fault("upgrade_required", "This Bot requires the history-window capability.")
	}
	return nil
}

func readBotHistoryCheckpoint(ctx context.Context, tx *operationTx, r *record) (sp.BotHistoryCheckpoint, error) {
	dao, err := botHistoryDAO(tx)
	if err != nil {
		return sp.BotHistoryCheckpoint{}, err
	}
	raw, err := dao.BotHistoryCheckpoint(ctx, r.Snapshot.SessionID)
	if errors.Is(err, model.ErrNotFound) {
		return sp.BotHistoryCheckpoint{}, fault("history_unavailable", "The Bot history checkpoint has not been published.")
	}
	if err != nil {
		return sp.BotHistoryCheckpoint{}, err
	}
	v, err := decodeSavedBotHistoryCheckpoint(raw)
	if err != nil {
		return v, fault("source_corrupt", "The Bot history checkpoint is invalid.")
	}
	if v.ControllerFence != r.Snapshot.ControllerFence || v.HistoryEpoch != r.Snapshot.HistoryEpoch || r.SourceEpoch == nil || v.SourceEpoch != *r.SourceEpoch || v.SourceThrough != decimal(r.SourceSeq) {
		return v, fault("history_unavailable", "The current Bot history checkpoint has not been published.")
	}
	return v, nil
}

func verifyBotWindowImageOccurrence(ctx context.Context, tx *operationTx, r *record, occurrence sp.ImageOccurrence) error {
	checkpoint, err := readBotHistoryCheckpoint(ctx, tx, r)
	if err != nil {
		return err
	}
	for _, entry := range checkpoint.Entries {
		if entry.EntryID != occurrence.EntryID {
			continue
		}
		for _, retained := range entry.ImageOccurrences {
			if jsonEqual(encode(retained), encode(occurrence)) {
				return nil
			}
		}
	}
	return fault("resource_conflict", "The image occurrence is outside the committed Bot history window.")
}

// CommitBotHistoryCheckpoint atomically replaces display references and the
// complete retained metadata. It never writes timeline bodies or operation state.
func (s *Execution) CommitBotHistoryCheckpoint(ctx context.Context, credential string, in sp.BotHistoryCheckpoint) (sp.BotHistoryCheckpointReceipt, error) {
	wire, err := sp.MarshalWire(in)
	if err != nil {
		return sp.BotHistoryCheckpointReceipt{}, fault("invalid_input", "Invalid Bot history checkpoint.")
	}
	if _, err := sp.DecodeBotHistoryCheckpoint(wire); err != nil {
		return sp.BotHistoryCheckpointReceipt{}, fault("invalid_input", "Invalid Bot history checkpoint.")
	}
	err = s.controller(ctx, in.ControllerFence, func(tx *operationTx, r *record, _ task) error {
		hash := sha256.Sum256([]byte(credential))
		if !bytes.Equal(hash[:], r.GrantHash) {
			return denied()
		}
		if r.BotID == nil || r.Live == nil || r.Live.BotHistoryWindowVersion != sp.BotHistoryWindowVersion {
			return fault("upgrade_required", "A negotiated Bot history window is required.")
		}
		if r.Snapshot.Lifecycle != "active" || in.HistoryEpoch != r.Snapshot.HistoryEpoch || r.SourceEpoch == nil || in.SourceEpoch != *r.SourceEpoch || in.SourceThrough != decimal(r.SourceSeq) {
			return fault("reset_required", "The Bot history source changed before publication.")
		}
		dao, err := botHistoryDAO(tx)
		if err != nil {
			return err
		}
		raw, err := dao.BotHistoryCheckpoint(ctx, in.SessionID)
		if err != nil && !errors.Is(err, model.ErrNotFound) {
			return err
		}
		if err == nil {
			previous, e := decodeSavedBotHistoryCheckpoint(raw)
			if e != nil {
				return fault("source_corrupt", "The saved Bot history checkpoint is invalid.")
			}
			if e = validateBotHistoryCheckpointAdvance(previous, in); e != nil {
				return e
			}
			if jsonEqual(raw, encode(in)) {
				return nil
			}
		}
		if err = s.replaceBotWindowReferences(ctx, tx, r, in); err != nil {
			return err
		}
		return dao.SaveBotHistoryCheckpoint(ctx, in.SessionID, wire)
	})
	if err != nil {
		return sp.BotHistoryCheckpointReceipt{}, err
	}
	return sp.BotHistoryCheckpointReceipt{BotHistoryWindowBoundary: in.BotHistoryWindowBoundary, SourceEpoch: in.SourceEpoch, SourceThrough: in.SourceThrough}, nil
}

func validateBotHistoryCheckpointAdvance(old, next sp.BotHistoryCheckpoint) error {
	if old.HistoryEpoch != next.HistoryEpoch {
		return nil
	}
	if number(next.WindowRevision) < number(old.WindowRevision) {
		return fault("content_changed", "The Bot history window revision moved backwards.")
	}
	if next.WindowRevision == old.WindowRevision {
		// Reconnection and source reset may rebind the same logical checkpoint.
		copy := old
		copy.ControllerFence = next.ControllerFence
		copy.SourceEpoch = next.SourceEpoch
		copy.SourceThrough = next.SourceThrough
		if !jsonEqual(encode(copy), encode(next)) {
			return fault("content_changed", "A Bot history window revision has different content.")
		}
		return nil
	}
	if old.EarlierHistoryUnavailable && !next.EarlierHistoryUnavailable || old.ThroughSeq != nil && (next.ThroughSeq == nil || number(*next.ThroughSeq) < number(*old.ThroughSeq)) || old.RetainedFromSeq != nil && next.RetainedFromSeq != nil && number(*next.RetainedFromSeq) < number(*old.RetainedFromSeq) {
		return fault("content_changed", "The Bot history retention boundary moved backwards.")
	}
	known := map[string]sp.BotHistoryCheckpointEntry{}
	for _, entry := range old.Entries {
		known[entry.EntryID] = entry
	}
	if !next.EarlierHistoryUnavailable {
		retained := map[string]bool{}
		for _, entry := range next.Entries {
			retained[entry.EntryID] = true
		}
		for _, entry := range old.Entries {
			if !retained[entry.EntryID] {
				return fault("content_changed", "Bot history eviction must retain its omission boundary.")
			}
		}
		if old.RetainedFromSeq != nil && next.RetainedFromSeq != nil && number(*next.RetainedFromSeq) > number(*old.RetainedFromSeq) {
			return fault("content_changed", "Bot history eviction must retain its omission boundary.")
		}
	}
	for _, entry := range next.Entries {
		prior, found := known[entry.EntryID]
		if !found {
			if old.ThroughSeq != nil && number(entry.EntrySeq) <= number(*old.ThroughSeq) {
				return fault("content_changed", "An evicted Bot history entry cannot be restored.")
			}
			continue
		}
		if prior.EntrySeq != entry.EntrySeq || number(entry.Revision) < number(prior.Revision) || entry.Revision == prior.Revision && !jsonEqual(encode(prior), encode(entry)) {
			return fault("content_changed", "A Bot history entry revision is inconsistent.")
		}
	}
	return nil
}

func (s *Execution) replaceBotWindowReferences(ctx context.Context, tx *operationTx, r *record, in sp.BotHistoryCheckpoint) error {
	dao, err := botHistoryDAO(tx)
	if err != nil {
		return err
	}
	resources, err := resourceDAO(tx)
	if err != nil {
		return err
	}
	// Pin the entire new closure first. A missing or reclaiming original refuses
	// the transaction before any old reference can be released.
	for _, entry := range in.Entries {
		for _, id := range entry.ResourceIDs {
			resource, e := resources.SavedSessionResource(ctx, in.SessionID, id)
			if e != nil {
				return e
			}
			if resource.GCPending || resource.Resource.Status != "available" {
				return fault("resource_conflict", "A Bot window references an unavailable resource.")
			}
			if e = resources.AddSessionResourceReference(ctx, store.SessionResourceReference{SessionID: in.SessionID, ResourceID: id, Kind: "bot_window", ReferenceID: entry.EntryID}); e != nil {
				return e
			}
		}
	}
	retained := map[store.SessionResourceReference]bool{}
	for _, entry := range in.Entries {
		for _, id := range entry.ResourceIDs {
			retained[store.SessionResourceReference{SessionID: in.SessionID, ResourceID: id, Kind: "bot_window", ReferenceID: entry.EntryID}] = true
		}
	}
	for _, kind := range []string{"bot_window", "message"} {
		refs, e := dao.SessionResourceReferences(ctx, in.SessionID, kind)
		if e != nil {
			return e
		}
		for _, ref := range refs {
			if retained[ref] {
				continue
			}
			if kind == "message" {
				capture, e := resources.SessionCaptureByImage(ctx, in.SessionID, ref.ReferenceID)
				if errors.Is(e, model.ErrNotFound) {
					continue
				}
				if e != nil {
					return e
				}
				if _, pending := r.Live.PendingInteractions[capture.Request.Occurrence.EntryID]; pending {
					continue
				}
				if capture.Receipt.State != "committed" {
					continue
				}
				for _, entry := range in.Entries {
					for _, occurrence := range entry.ImageOccurrences {
						if !jsonEqual(encode(occurrence), encode(capture.Request.Occurrence)) {
							continue
						}
						included := false
						for _, id := range entry.ResourceIDs {
							included = included || id == ref.ResourceID
						}
						if !included {
							return fault("resource_conflict", "A retained image is missing from the Bot window resource closure.")
						}
					}
				}
			}
			if e = resources.RemoveSessionResourceReference(ctx, ref); e != nil {
				return e
			}
			if e = dao.QueueBotHistoryReclaim(ctx, in.SessionID, ref.ResourceID); e != nil {
				return e
			}
		}
	}
	return nil
}

// An image copy may finish after its display occurrence was evicted. Keep the
// capture receipt as execution evidence, but do not recreate its display pin.
func retireEvictedBotCapture(ctx context.Context, tx *operationTx, r *record, capture store.SessionCaptureRecord, resource string) (bool, error) {
	if r.BotID == nil {
		return false, nil
	}
	dao, ok := tx.dao.(store.BotHistoryWindowDAO)
	if !ok {
		return false, nil
	}
	raw, err := dao.BotHistoryCheckpoint(ctx, r.Snapshot.SessionID)
	if errors.Is(err, model.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	checkpoint, err := decodeSavedBotHistoryCheckpoint(raw)
	if err != nil {
		return false, fault("source_corrupt", "The saved Bot history checkpoint is invalid.")
	}
	if r.Live != nil {
		if _, pending := r.Live.PendingInteractions[capture.Request.Occurrence.EntryID]; pending {
			return false, nil
		}
	}
	if r.SourceEpoch == nil || checkpoint.SourceEpoch != *r.SourceEpoch {
		return false, fault("history_unavailable", "The current Bot history checkpoint has not been published.")
	}
	for _, entry := range checkpoint.Entries {
		for _, occurrence := range entry.ImageOccurrences {
			if jsonEqual(encode(occurrence), encode(capture.Request.Occurrence)) {
				return false, nil
			}
		}
	}
	return true, dao.QueueBotHistoryReclaim(ctx, r.Snapshot.SessionID, resource)
}
