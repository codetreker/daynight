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
	current := r.SourceSeq
	native := r.Snapshot.Identity.NativeSessionID
	last := int64(-1)
	for _, event := range in.Events {
		if _, e = sp.DecodeSourceEvent(encode(event)); e != nil {
			return out, fault("invalid_input", "The original source event is invalid.")
		}
		seq := number(event.SourceSeq)
		if last >= 0 && seq != last+1 {
			return out, fault("source_gap", "Original source events must remain contiguous.")
		}
		last = seq
		switch event.Kind {
		case "state":
			state, e := sp.DecodeState(event.Payload)
			if e != nil {
				return out, e
			}
			// Initial journal states can predate native creation. Only a known
			// non-null identity constrains later original non-null observations.
			if state.NativeSessionID != nil {
				if native != nil && !sameNative(state.NativeSessionID, native) {
					return out, conflict()
				}
				native = state.NativeSessionID
			}
		case "timeline_upsert":
			if _, e = sp.DecodeSourceTimeline(event.Payload); e != nil {
				return out, e
			}
		case "resource":
			resource, e := sp.DecodeResource(event.Payload)
			if e != nil {
				return out, e
			}
			if e = sourceResourceLimit(r, resource); e != nil {
				return out, e
			}
		default:
			return out, fault("source_gap", "A source gap cannot advance a stopped archive checkpoint.")
		}
		hash := sha256.Sum256(encode(event))
		key := store.SessionSourceHash{SessionID: r.Snapshot.SessionID, SourceEpoch: in.SourceEpoch, Kind: "event", Identity: event.SourceSeq, Through: seq, Digest: hash[:]}
		if seq <= current {
			previous, e := dao.SessionSourceHash(ctx, key)
			if errors.Is(e, model.ErrNotFound) {
				return out, fault("source_gap", "The original source digest is outside the retained acknowledgement window.")
			}
			if e != nil {
				return out, e
			}
			if !bytes.Equal(previous, hash[:]) {
				return out, conflict()
			}
			continue
		}
		if seq != current+1 {
			return out, fault("source_gap", "The missing original source tail must be supplied before archive history.")
		}
		if e = saveSourceHash(ctx, dao, key); e != nil {
			return out, e
		}
		current = seq
	}
	if e = saveSourceHash(ctx, dao, batchKey); e != nil {
		return out, e
	}
	r.SourceSeq = current
	r.Snapshot.Identity.NativeSessionID = native
	if e = save(ctx, tx, r); e != nil {
		return out, e
	}
	return sp.ArchiveSourceTailReceipt{SourceEpoch: in.SourceEpoch, BatchID: in.BatchID, LastAckedSourceSeq: decimal(current)}, nil
}
