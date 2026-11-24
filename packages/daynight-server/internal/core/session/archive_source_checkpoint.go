package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// applyStoppedSourceTail advances only the durable source checkpoint. Its caller
// owns stopped-writer authorization and the archive owner gate. State events are
// validated as original journal facts without reactivating a Session or applying
// provider/operation outcomes from a tail replay.
func (s *Execution) applyStoppedSourceTail(ctx context.Context, tx *operationTx, r *record, in sp.ArchiveSourceTailRequest) (sp.ArchiveSourceTailReceipt, error) {
	var out sp.ArchiveSourceTailReceipt
	if in.Fence != r.Snapshot.Fence || in.ControllerID != r.Snapshot.Identity.ControllerID || in.ControllerInstanceID != r.Snapshot.Identity.ControllerInstanceID || r.SourceEpoch == nil || *r.SourceEpoch != in.SourceEpoch {
		return out, conflict()
	}
	if len(in.Events) == 0 || len(in.Events) > sp.MaxBatchEvents {
		return out, fault("invalid_input", "A bounded original source batch is required.")
	}
	dao, ok := tx.dao.(store.SessionSourceDAO)
	if !ok {
		return out, fault("component_unsupported", "Durable source acknowledgements require a server upgrade.")
	}
	batch := sha256.Sum256(encode(in.Events))
	batchKey := store.SessionSourceHash{SessionID: r.Snapshot.SessionID, SourceEpoch: in.SourceEpoch, Kind: "batch", Identity: in.BatchID, Through: number(in.Events[len(in.Events)-1].SourceSeq), Digest: batch[:]}
	previous, e := dao.SessionSourceHash(ctx, batchKey)
	if e == nil && !bytes.Equal(previous, batch[:]) {
		return out, conflict()
	}
	if e != nil && !errors.Is(e, model.ErrNotFound) {
		return out, e
	}
	current, e := s.applyStoppedSourceEvents(ctx, tx, r, in.SourceEpoch, in.Events)
	if e != nil {
		return out, e
	}

	if e = saveSourceHash(ctx, dao, batchKey); e != nil {
		return out, e
	}
	return sp.ArchiveSourceTailReceipt{SourceEpoch: in.SourceEpoch, BatchID: in.BatchID, LastAckedSourceSeq: decimal(current)}, nil
}

// applyStoppedSourceEvents verifies every overlap and advances only a contiguous
// suffix. Its caller owns batch or recovery identity and the enclosing transaction.
func (s *Execution) applyStoppedSourceEvents(ctx context.Context, tx *operationTx, r *record, epoch string, events []sp.SourceEvent) (int64, error) {
	dao, ok := tx.dao.(store.SessionSourceDAO)
	if !ok {
		return 0, fault("component_unsupported", "Durable source acknowledgements require a server upgrade.")
	}
	var e error
	current := r.SourceSeq
	native := r.Snapshot.Identity.NativeSessionID
	last := int64(-1)
	for _, event := range events {
		if _, e = sp.DecodeSourceEvent(encode(event)); e != nil {
			return 0, fault("invalid_input", "The original source event is invalid.")
		}
		seq := number(event.SourceSeq)
		if last >= 0 && seq != last+1 {
			return 0, fault("source_gap", "Original source events must remain contiguous.")
		}
		last = seq
		switch event.Kind {
		case "state":
			state, e := sp.DecodeState(event.Payload)
			if e != nil {
				return 0, e
			}
			// Initial journal states can predate native creation. Only a known
			// non-null identity constrains later original non-null observations.
			if state.NativeSessionID != nil {
				if native != nil && !sameNative(state.NativeSessionID, native) {
					return 0, conflict()
				}
				native = state.NativeSessionID
			}
		case "timeline_upsert":
			if _, e = sp.DecodeSourceTimeline(event.Payload); e != nil {
				return 0, e
			}
		case "resource":
			resource, e := sp.DecodeResource(event.Payload)
			if e != nil {
				return 0, e
			}
			if e = sourceResourceLimit(r, resource); e != nil {
				return 0, e
			}
		default:
			return 0, fault("source_gap", "A source gap cannot advance a stopped archive checkpoint.")
		}
		hash := sha256.Sum256(encode(event))
		key := store.SessionSourceHash{SessionID: r.Snapshot.SessionID, SourceEpoch: epoch, Kind: "event", Identity: event.SourceSeq, Through: seq, Digest: hash[:]}
		if seq <= current {
			previous, e := dao.SessionSourceHash(ctx, key)
			if errors.Is(e, model.ErrNotFound) {
				return 0, fault("source_gap", "The original source digest is outside the retained acknowledgement window.")
			}
			if e != nil {
				return 0, e
			}
			if !bytes.Equal(previous, hash[:]) {
				return 0, conflict()
			}
			continue
		}
		if seq != current+1 {
			return 0, fault("source_gap", "The missing original source tail must be supplied before archive history.")
		}
		if e = saveSourceHash(ctx, dao, key); e != nil {
			return 0, e
		}
		current = seq
	}
	r.SourceSeq = current
	r.Snapshot.Identity.NativeSessionID = native
	if e = save(ctx, tx, r); e != nil {
		return 0, e
	}
	return current, nil
}

func (s *Execution) applyStoppedSourceRecovery(ctx context.Context, tx *operationTx, r *record, in sp.ArchiveSourceRecoveryRequest) (sp.ArchiveSourceRecoveryReceipt, error) {
	var out sp.ArchiveSourceRecoveryReceipt
	if in.Fence != r.Snapshot.Fence || in.ControllerID != r.Snapshot.Identity.ControllerID || in.ControllerInstanceID != r.Snapshot.Identity.ControllerInstanceID || r.SourceEpoch == nil || *r.SourceEpoch != in.SourceEpoch {
		return out, conflict()
	}
	if len(in.Events) == 0 || len(in.Events) > sp.MaxBatchEvents {
		return out, fault("invalid_input", "A bounded original source batch is required.")
	}
	cutoff := number(in.Cutoff)
	last := number(in.Events[len(in.Events)-1].SourceSeq)
	if r.SourceSeq > cutoff || last > cutoff {
		return out, conflict()
	}
	dao, ok := tx.dao.(store.SessionSourceDAO)
	if !ok {
		return out, fault("component_unsupported", "Durable source acknowledgements require a server upgrade.")
	}
	recoveries, ok := tx.dao.(store.SessionSourceRecoveryDAO)
	if !ok {
		return out, fault("component_unsupported", "Durable source recovery requires a server upgrade.")
	}
	count, err := recoveries.SessionSourceRecoveryCount(ctx, r.Snapshot.SessionID)
	if err != nil {
		return out, err
	}
	digest := sha256.Sum256(encode(in))
	previous, err := recoveries.SessionSourceRecovery(ctx, r.Snapshot.SessionID, in.RecoveryID)
	if err == nil {
		if !bytes.Equal(previous.Digest, digest[:]) || previous.VerifiedThrough != last {
			return out, conflict()
		}
		return sp.ArchiveSourceRecoveryReceipt{SourceEpoch: in.SourceEpoch, RecoveryID: in.RecoveryID, VerifiedThrough: decimal(previous.VerifiedThrough), CurrentThrough: decimal(r.SourceSeq)}, nil
	}
	if !errors.Is(err, model.ErrNotFound) {
		return out, err
	}
	if count >= 4096 {
		return out, fault("quota_exceeded", "The source recovery ledger is full.")
	}
	_, err = dao.SessionSourceHash(ctx, store.SessionSourceHash{SessionID: r.Snapshot.SessionID, SourceEpoch: in.SourceEpoch, Kind: "batch", Identity: in.OldBatchID})
	if err == nil {
		return out, conflict()
	}
	if !errors.Is(err, model.ErrNotFound) {
		return out, err
	}
	current, err := s.applyStoppedSourceEvents(ctx, tx, r, in.SourceEpoch, in.Events)
	if err != nil {
		return out, err
	}
	if err = recoveries.SaveSessionSourceRecovery(ctx, store.SessionSourceRecovery{SessionID: r.Snapshot.SessionID, RecoveryID: in.RecoveryID, Digest: digest[:], VerifiedThrough: last}); err != nil {
		return out, err
	}
	return sp.ArchiveSourceRecoveryReceipt{SourceEpoch: in.SourceEpoch, RecoveryID: in.RecoveryID, VerifiedThrough: decimal(last), CurrentThrough: decimal(current)}, nil
}
