package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"log/slog"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"slices"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func envelope(r *record, kind string) map[string]any {
	v := r.Snapshot
	return sp.BindingFields(v.Fence, map[string]any{"type": kind, "protocol": sp.Protocol, "sessionId": v.SessionID, "claimId": v.ClaimID, "executionGeneration": v.ExecutionGeneration, "connectionEpoch": v.ConnectionEpoch})
}
func (s *Execution) SourceSeq(ctx context.Context, f sp.ControllerFence) (int64, error) {
	var n int64
	err := s.controller(ctx, f, func(_ *operationTx, r *record, _ task) error { n = r.SourceSeq; return nil })
	return n, err
}
func (s *Execution) Handle(ctx context.Context, m sp.ControllerMessage) (_ map[string]any, result error) {
	prepared, check, finish, err := s.prepareReadMediaResponse(ctx, m)
	if err != nil {
		return nil, err
	}
	if finish != nil {
		defer func() { result = errors.Join(result, finish()) }()
	}
	m = prepared
	var out map[string]any
	var captureError *CaptureRequestError
	cleanupHistory := false
	err = s.controller(ctx, m.ControllerFence, func(tx *operationTx, r *record, t task) error {
		if check != nil {
			if err := check(tx, r); err != nil {
				return err
			}
		}
		var err error
		switch m.Type {
		case "sync_state":
			if r.Live == nil || m.State == nil {
				return conflict()
			}
			r.Live.PendingInteractions = map[string]sp.TimelineEntry{}
			for _, entry := range m.PendingInteractions {
				if err := rememberInteraction(r, entry); err != nil {
					return err
				}
			}
			unresolved, err := tx.dao.UnreconciledSessionOperationCount(ctx, r.Snapshot.SessionID, number(r.Snapshot.ConnectionEpoch))
			if err != nil {
				return err
			}
			if unresolved > 0 {
				return fault("reconcile_required", "Reconcile prior operations before live synchronization.")
			}
			r.Live.Synced = true
			if err := s.applyState(ctx, tx, r, *m.State); err != nil {
				return err
			}
			out = envelope(r, "sync_ack")
		case "image_capture":
			out, err = s.captureMessage(ctx, tx, r, m)
			if refusal, ok := err.(*CaptureRequestError); ok {
				captureError, err = refusal, nil
			}
		case "image_response":
			out, err = s.acceptMediaResponse(ctx, tx, r, m)
		case "content_response":
			out, err = s.acceptContent(tx, r, m)
		case "events":
			out, err = s.events(ctx, tx, r, m)
		case "source_reset":
			_, cleanupHistory = tx.dao.(store.SessionArchiveDAO)
			if r.SourceEpoch == nil {
				return conflict()
			}
			if *r.SourceEpoch != m.NewSourceEpoch {
				if *r.SourceEpoch != m.PreviousSourceEpoch || slices.Contains(r.SourceEpochs, m.NewSourceEpoch) {
					return conflict()
				}
				if err = handoffHistorySource(ctx, tx, r, *r.SourceEpoch, m.NewSourceEpoch); err != nil {
					return err
				}
				r.SourceEpoch = &m.NewSourceEpoch
				if len(r.SourceEpochs) >= 64 {
					return fault("rate_limited", "Source epoch limit reached.")
				}
				r.SourceEpochs = append(r.SourceEpochs, m.NewSourceEpoch)
				r.SourceSeq = 0
				err = s.emit(ctx, tx, r, "gap", map[string]any{"reason": m.Reason, "cursor": nil}, nil)
			}
			out = envelope(r, "source_reset_ack")
			out["sourceEpoch"] = r.SourceEpoch
			out["lastEventSeq"] = r.Snapshot.LastEventSeq
		case "heartbeat":
			out = envelope(r, "heartbeat_ack")
		case "operation_begin":
			out, err = s.begin(ctx, tx, r, t, m.OperationID)
		case "operation_receipt":
			out, err = s.receipt(ctx, tx, r, *m.Operation)
		case "reconcile":
			out, err = s.reconcile(ctx, tx, r, t, m.Operations, m.Final)
		default:
			return fault("invalid_input", "Unsupported controller message.")
		}
		if err != nil {
			return err
		}
		now := s.now()
		r.LastSeen = &now
		if err = tx.dao.TouchSession(ctx, r.Snapshot.SessionID, now); err != nil {
			return err
		}
		return save(ctx, tx, r)
	})
	if err != nil {
		return nil, err
	}
	if cleanupHistory && s.files != nil {
		access := func(ctx context.Context, fn func(*operationTx, *record, store.SessionArchiveDAO, store.ArchiveBundle) error) error {
			return s.controller(ctx, m.ControllerFence, func(tx *operationTx, r *record, _ task) error {
				if sourceEpoch(r) != m.NewSourceEpoch {
					return conflict()
				}
				dao, ok := tx.dao.(store.SessionArchiveDAO)
				if !ok {
					return nil
				}
				bundle, e := dao.SessionArchiveBundle(ctx, r.Snapshot.SessionID)
				if errors.Is(e, model.ErrNotFound) {
					return nil
				}
				if e != nil {
					return e
				}
				return fn(tx, r, dao, bundle)
			})
		}
		if cleanupErr := s.cleanupRetiredHistory(ctx, m.SessionID, access); cleanupErr != nil {
			slog.ErrorContext(ctx, "Retired Session history cleanup failed", "session_id", m.SessionID, "error", cleanupErr)
		}
	}
	if captureError != nil {
		return nil, captureError
	}
	return out, nil
}
func (s *Execution) applyState(ctx context.Context, tx *operationTx, r *record, state sp.State) error {
	v := &r.Snapshot
	if (state.InitialInputState == "not_required") != (v.InitialInputState == "not_required") || v.Identity.NativeSessionID != nil && (state.NativeSessionID == nil || *state.NativeSessionID != *v.Identity.NativeSessionID) {
		return conflict()
	}
	if (v.InitialInputState == "provider_accepted" || v.InitialInputState == "confirmed") && (state.InitialInputState == "not_submitted" || state.InitialInputState == "dispatching") {
		return conflict()
	}
	if v.Controls != nil && state.Controls != nil {
		a, b := number(v.Controls.Revision), number(state.Controls.Revision)
		if b < a || b == a && !jsonEqual(encode(v.Controls), encode(state.Controls)) {
			return conflict()
		}
	}
	v.Identity.NativeSessionID = state.NativeSessionID
	v.InitialInputState = state.InitialInputState
	v.Activity = state.Activity
	v.CurrentTurnID = state.CurrentTurnID
	v.Capabilities = state.Capabilities
	if err := s.refreshImageState(ctx, tx, r, state.ProviderImages); err != nil {
		return err
	}
	v.Controls = state.Controls
	v.TurnStartedAt = state.TurnStartedAt
	v.CleanupInteractionIDs = state.CleanupInteractionIDs
	for _, id := range state.CleanupInteractionIDs {
		if v.Lifecycle != "draining" || r.DrainTimelineSeq == nil {
			return conflict()
		}
		for _, entry := range r.Live.PendingInteractions {
			var i struct {
				ID string `json:"interactionId"`
			}
			_ = json.Unmarshal(entry.Data["interaction"], &i)
			if i.ID == id && number(entry.EntrySeq) <= *r.DrainTimelineSeq {
				return conflict()
			}
		}
	}
	v.Synchronized = state.Synchronized && r.Live.Synced
	if v.Synchronized {
		v.ConnectionState = "connected"
	} else {
		v.ConnectionState = "synchronizing"
	}
	return s.emit(ctx, tx, r, "snapshot", *v, nil)
}
func rememberInteraction(r *record, entry sp.TimelineEntry) error {
	if entry.Kind != "interaction" {
		return nil
	}
	var value struct {
		State string `json:"state"`
	}
	_ = json.Unmarshal(entry.Data["interaction"], &value)
	if prior, ok := r.Live.PendingInteractions[entry.EntryID]; ok {
		if number(prior.Revision) > number(entry.Revision) || prior.Revision == entry.Revision && !jsonEqual(encode(prior), encode(entry)) {
			return conflict()
		}
	}
	if value.State == "pending" {
		r.Live.PendingInteractions[entry.EntryID] = entry
	} else {
		delete(r.Live.PendingInteractions, entry.EntryID)
	}
	return r.Live.checkCapacity()
}
func (s *Execution) events(ctx context.Context, tx *operationTx, r *record, m sp.ControllerMessage) (map[string]any, error) {
	if r.Live == nil || r.SourceEpoch == nil || *r.SourceEpoch != m.SourceEpoch {
		return nil, conflict()
	}
	batchHash := sha256.Sum256(encode(m.Events))
	var durable store.SessionSourceDAO
	if r.Snapshot.ContentRevision == 2 {
		var ok bool
		durable, ok = tx.dao.(store.SessionSourceDAO)
		if !ok {
			return nil, fault("component_unsupported", "Durable source acknowledgements require a server upgrade.")
		}
		prior, e := durable.SessionSourceHash(ctx, store.SessionSourceHash{SessionID: r.Snapshot.SessionID, SourceEpoch: m.SourceEpoch, Kind: "batch", Identity: m.BatchID})
		if e == nil && !bytes.Equal(prior, batchHash[:]) {
			return nil, conflict()
		}
		if e != nil && !errors.Is(e, model.ErrNotFound) {
			return nil, e
		}
	}
	if prior, ok := r.Live.BatchHashes[m.BatchID]; ok && prior != batchHash {
		return nil, conflict()
	}
	for _, e := range m.Events {
		n := number(e.SourceSeq)
		hash := sha256.Sum256(encode(e))
		if n <= r.SourceSeq {
			if durable != nil {
				previous, err := durable.SessionSourceHash(ctx, store.SessionSourceHash{SessionID: r.Snapshot.SessionID, SourceEpoch: m.SourceEpoch, Kind: "event", Identity: e.SourceSeq})
				if errors.Is(err, model.ErrNotFound) {
					return nil, fault("source_gap", "The original source digest is outside the retained acknowledgement window.")
				}
				if err != nil {
					return nil, err
				}
				if !bytes.Equal(previous, hash[:]) {
					return nil, conflict()
				}
			}
			if previous, ok := r.Live.SourceHashes[n]; ok && previous != hash {
				return nil, conflict()
			}
			continue
		}
		if n != r.SourceSeq+1 {
			return nil, fault("source_gap", "Source events must be contiguous.")
		}
		switch e.Kind {
		case "state":
			state, err := sp.DecodeState(e.Payload)
			if err != nil {
				return nil, err
			}
			if err = s.applyState(ctx, tx, r, state); err != nil {
				return nil, err
			}
		case "timeline_upsert":
			entry, err := sp.DecodeSourceTimeline(e.Payload)
			if err != nil {
				return nil, err
			}
			prior, exists := r.Live.TimelineVersions[entry.EntryID]
			if entry.EntrySeq == "" {
				if exists {
					entry.EntrySeq = prior.Sequence
				} else {
					entry.EntrySeq = e.SourceSeq
				}
			}
			contentHash := sha256.Sum256(encode(entry))
			if exists && (entry.EntrySeq != prior.Sequence || number(entry.Revision) < number(prior.Revision) || entry.Revision == prior.Revision && contentHash != prior.Hash) {
				return nil, conflict()
			}
			r.Live.TimelineVersions[entry.EntryID] = timelineVersion{Sequence: entry.EntrySeq, Revision: entry.Revision, Hash: contentHash}
			if !exists {
				r.Live.TimelineOrder = append(r.Live.TimelineOrder, entry.EntryID)
				if len(r.Live.TimelineOrder) > 1000 {
					delete(r.Live.TimelineVersions, r.Live.TimelineOrder[0])
					r.Live.TimelineOrder = r.Live.TimelineOrder[1:]
				}
			}
			if number(entry.EntrySeq) > number(r.Snapshot.LastTimelineSeq) {
				r.Snapshot.LastTimelineSeq = entry.EntrySeq
			}
			if err = rememberInteraction(r, entry); err != nil {
				return nil, err
			}
			if err = s.emit(ctx, tx, r, "timeline_upsert", entry, &e); err != nil {
				return nil, err
			}
		case "resource":
			resource, err := sp.DecodeResource(e.Payload)
			if err != nil {
				return nil, err
			}
			if err = sourceResourceLimit(r, resource); err != nil {
				return nil, err
			}
			if err = s.emit(ctx, tx, r, "resource", resource, &e); err != nil {
				return nil, err
			}
		case "gap":
			var payload map[string]any
			if err := json.Unmarshal(e.Payload, &payload); err != nil {
				return nil, err
			}
			payload["cursor"] = nil
			if err := s.emit(ctx, tx, r, "gap", payload, &e); err != nil {
				return nil, err
			}
		default:
			return nil, fault("invalid_input", "Unsupported source event.")
		}
		if durable != nil {
			if err := saveSourceHash(ctx, durable, store.SessionSourceHash{SessionID: r.Snapshot.SessionID, SourceEpoch: m.SourceEpoch, Kind: "event", Identity: e.SourceSeq, Through: n, Digest: hash[:]}); err != nil {
				return nil, err
			}
		}
		r.SourceSeq = n
		r.Live.SourceHashes[n] = hash
		r.Live.SourceOrder = append(r.Live.SourceOrder, n)
		if len(r.Live.SourceOrder) > 256 {
			delete(r.Live.SourceHashes, r.Live.SourceOrder[0])
			r.Live.SourceOrder = r.Live.SourceOrder[1:]
		}
	}
	if _, exists := r.Live.BatchHashes[m.BatchID]; !exists {
		r.Live.BatchHashes[m.BatchID] = batchHash
		r.Live.BatchOrder = append(r.Live.BatchOrder, m.BatchID)
		if len(r.Live.BatchOrder) > 128 {
			delete(r.Live.BatchHashes, r.Live.BatchOrder[0])
			r.Live.BatchOrder = r.Live.BatchOrder[1:]
		}
	}
	if durable != nil {
		if err := saveSourceHash(ctx, durable, store.SessionSourceHash{SessionID: r.Snapshot.SessionID, SourceEpoch: m.SourceEpoch, Kind: "batch", Identity: m.BatchID, Through: number(m.Events[len(m.Events)-1].SourceSeq), Digest: batchHash[:]}); err != nil {
			return nil, err
		}
	}
	out := envelope(r, "events_ack")
	out["batchId"] = m.BatchID
	out["sourceEpoch"] = m.SourceEpoch
	out["lastAckedSourceSeq"] = decimal(r.SourceSeq)
	out["lastEventSeq"] = r.Snapshot.LastEventSeq
	return out, nil
}
func jsonEqual(a, b []byte) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	return bytes.Equal(encode(x), encode(y))
}
func (s *Execution) Disconnect(ctx context.Context, f sp.ControllerFence) error {
	return s.controller(ctx, f, func(tx *operationTx, r *record, _ task) error {
		r.Snapshot.ConnectionState = "disconnected"
		r.Snapshot.Synchronized = false
		r.ConnectionExpiry = nil
		if err := tx.dao.DisconnectSession(ctx, r.Snapshot.SessionID); err != nil {
			return err
		}
		if err := s.emit(ctx, tx, r, "snapshot", r.Snapshot, nil); err != nil {
			return err
		}
		return save(ctx, tx, r)
	})
}

func sourceResourceLimit(r *record, resource sp.Resource) error {
	limit := int64(sp.MaxResourceBytes)
	if r.Snapshot.ContentRevision == 2 && resource.Revision != "" {
		limit = sp.MaxImageBytes
	}
	if resource.ByteLength != nil && number(*resource.ByteLength) > limit {
		return fault("payload_too_large", "Resource exceeds the negotiated Session content limit.")
	}
	return nil
}
