package sessionrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"slices"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/jackc/pgx/v5"
)

func envelope(r *record, kind string) map[string]any {
	v := r.Snapshot
	return sp.BindingFields(v.Fence, map[string]any{"type": kind, "protocol": sp.Protocol, "sessionId": v.SessionID, "claimId": v.ClaimID, "executionGeneration": v.ExecutionGeneration, "connectionEpoch": v.ConnectionEpoch})
}
func (s *Service) SourceSeq(ctx context.Context, f sp.ControllerFence) (int64, error) {
	var n int64
	err := s.controller(ctx, f, func(_ pgx.Tx, r *record, _ task) error { n = r.SourceSeq; return nil })
	return n, err
}
func (s *Service) Handle(ctx context.Context, m sp.ControllerMessage) (map[string]any, error) {
	var out map[string]any
	err := s.controller(ctx, m.ControllerFence, func(tx pgx.Tx, r *record, t task) error {
		var err error
		switch m.Type {
		case "events":
			out, err = s.events(ctx, tx, r, m)
		case "source_reset":
			if r.SourceEpoch == nil {
				return conflict()
			}
			if *r.SourceEpoch != m.NewSourceEpoch {
				if *r.SourceEpoch != m.PreviousSourceEpoch || slices.Contains(r.SourceEpochs, m.NewSourceEpoch) {
					return conflict()
				}
				r.SourceEpoch = &m.NewSourceEpoch
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
		if _, err = tx.Exec(ctx, `UPDATE task_sessions SET last_seen=$2 WHERE id=$1`, r.Snapshot.SessionID, now); err != nil {
			return err
		}
		return save(ctx, tx, r)
	})
	return out, err
}
func (s *Service) events(ctx context.Context, tx pgx.Tx, r *record, m sp.ControllerMessage) (map[string]any, error) {
	if r.SourceEpoch == nil || *r.SourceEpoch != m.SourceEpoch {
		return nil, conflict()
	}
	// A batch identity cannot be reused for a different list of source events.
	rows, err := tx.Query(ctx, `SELECT source_body FROM session_events WHERE session_id=$1 AND batch_id=$2 ORDER BY source_seq`, r.Snapshot.SessionID, m.BatchID)
	if err != nil {
		return nil, err
	}
	var previous [][]byte
	for rows.Next() {
		var b []byte
		if err = rows.Scan(&b); err != nil {
			rows.Close()
			return nil, err
		}
		previous = append(previous, b)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(previous) > 0 {
		if len(previous) != len(m.Events) {
			return nil, conflict()
		}
		for i, e := range m.Events {
			if !jsonEqual(previous[i], encode(e)) {
				return nil, conflict()
			}
		}
	}
	for _, e := range m.Events {
		n := number(e.SourceSeq)
		if n <= r.SourceSeq {
			var raw []byte
			err = tx.QueryRow(ctx, `SELECT source_body FROM session_events WHERE session_id=$1 AND source_epoch=$2 AND source_seq=$3`, r.Snapshot.SessionID, m.SourceEpoch, n).Scan(&raw)
			if err != nil {
				return nil, err
			}
			if !jsonEqual(raw, encode(e)) {
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
			v := &r.Snapshot
			if (state.InitialInputState == "not_required") != (v.InitialInputState == "not_required") {
				return nil, conflict()
			}
			if v.Identity.NativeSessionID != nil && (state.NativeSessionID == nil || *v.Identity.NativeSessionID != *state.NativeSessionID) {
				return nil, conflict()
			}
			if (v.InitialInputState == "provider_accepted" || v.InitialInputState == "confirmed") && (state.InitialInputState == "not_submitted" || state.InitialInputState == "dispatching") {
				return nil, conflict()
			}
			if state.Synchronized {
				var unresolved int
				if err = tx.QueryRow(ctx, `SELECT count(*) FROM session_operations WHERE session_id=$1 AND dispatch_epoch IS DISTINCT FROM $2 AND receipt->>'state' IN ('offered','dispatching')`, v.SessionID, number(v.ConnectionEpoch)).Scan(&unresolved); err != nil {
					return nil, err
				}
				if unresolved != 0 {
					return nil, fault("reconcile_required", "Reconcile previously offered operations before synchronization.")
				}
			}
			v.Identity.NativeSessionID = state.NativeSessionID
			v.InitialInputState = state.InitialInputState
			v.Synchronized = state.Synchronized
			v.Activity = state.Activity
			v.CurrentTurnID = state.CurrentTurnID
			v.Capabilities = state.Capabilities
			if v.Controls != nil && state.Controls != nil {
				previous, next := number(v.Controls.Revision), number(state.Controls.Revision)
				if next < previous || next == previous && !jsonEqual(encode(v.Controls), encode(state.Controls)) {
					return nil, conflict()
				}
			}
			v.Controls = state.Controls
			v.TurnStartedAt = state.TurnStartedAt
			if len(state.CleanupInteractionIDs) > 0 {
				if v.Lifecycle != "draining" || r.DrainTimelineSeq == nil {
					return nil, conflict()
				}
				var old bool
				err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_timeline WHERE session_id=$1 AND entry_seq<=$2 AND entry->>'kind'='interaction' AND entry->'interaction'->>'interactionId'=ANY($3::text[]))`, v.SessionID, *r.DrainTimelineSeq, state.CleanupInteractionIDs).Scan(&old)
				if err != nil {
					return nil, err
				}
				if old {
					return nil, conflict()
				}
			}
			v.CleanupInteractionIDs = state.CleanupInteractionIDs
			if state.Synchronized {
				v.ConnectionState = "connected"
			} else {
				v.ConnectionState = "synchronizing"
			}
			if err = s.emit(ctx, tx, r, "snapshot", *v, &e); err != nil {
				return nil, err
			}
		case "timeline_upsert":
			entry, err := sp.DecodeSourceTimeline(e.Payload)
			if err != nil {
				return nil, err
			}
			var old []byte
			var seq, revision int64
			err = tx.QueryRow(ctx, `SELECT entry,entry_seq,revision FROM session_timeline WHERE session_id=$1 AND entry_id=$2`, r.Snapshot.SessionID, entry.EntryID).Scan(&old, &seq, &revision)
			if errors.Is(err, pgx.ErrNoRows) {
				r.Snapshot.LastTimelineSeq = next(r.Snapshot.LastTimelineSeq)
				seq = number(r.Snapshot.LastTimelineSeq)
			} else if err != nil {
				return nil, err
			}
			entry.EntrySeq = decimal(seq)
			if revision > number(entry.Revision) || revision == number(entry.Revision) && !jsonEqual(old, encode(entry)) {
				return nil, conflict()
			}
			if _, err = tx.Exec(ctx, `INSERT INTO session_timeline(session_id,entry_id,entry_seq,revision,entry) VALUES($1,$2,$3,$4,$5) ON CONFLICT(session_id,entry_id) DO UPDATE SET revision=excluded.revision,entry=excluded.entry`, r.Snapshot.SessionID, entry.EntryID, seq, number(entry.Revision), encode(entry)); err != nil {
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
			if resource.Status == "available" {
				return nil, fault("invalid_input", "Resource availability requires a verified upload.")
			}
			var old []byte
			err = tx.QueryRow(ctx, `SELECT descriptor FROM session_resources WHERE session_id=$1 AND resource_id=$2`, r.Snapshot.SessionID, resource.ResourceID).Scan(&old)
			if err == nil {
				prior, _ := sp.DecodeResource(old)
				if prior.Status == "available" || prior.SHA256 != nil && (resource.SHA256 == nil || *prior.SHA256 != *resource.SHA256) {
					return nil, conflict()
				}
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return nil, err
			}
			if resource.ByteLength != nil && number(*resource.ByteLength) > sp.MaxResourceBytes {
				return nil, fault("payload_too_large", "Resource exceeds 8 MiB.")
			}
			var count int
			if err = tx.QueryRow(ctx, `SELECT count(*) FROM session_resources WHERE session_id=$1`, r.Snapshot.SessionID).Scan(&count); err != nil {
				return nil, err
			}
			if count >= 1000 && old == nil {
				return nil, fault("payload_too_large", "Session resource limit reached.")
			}
			if _, err = tx.Exec(ctx, `INSERT INTO session_resources(session_id,resource_id,descriptor) VALUES($1,$2,$3) ON CONFLICT(session_id,resource_id) DO UPDATE SET descriptor=excluded.descriptor`, r.Snapshot.SessionID, resource.ResourceID, encode(resource)); err != nil {
				return nil, err
			}
			if err = s.emit(ctx, tx, r, "resource", resource, &e); err != nil {
				return nil, err
			}
		case "gap":
			var payload map[string]any
			if err = json.Unmarshal(e.Payload, &payload); err != nil {
				return nil, err
			}
			payload["cursor"] = nil
			if err = s.emit(ctx, tx, r, "gap", payload, &e); err != nil {
				return nil, err
			}
		default:
			return nil, fault("invalid_input", "Unsupported source event.")
		}
		if _, err = tx.Exec(ctx, `UPDATE session_events SET batch_id=$2 WHERE session_id=$1 AND event_seq=$3`, r.Snapshot.SessionID, m.BatchID, number(r.Snapshot.LastEventSeq)); err != nil {
			return nil, err
		}
		r.SourceSeq = n
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
func (s *Service) Disconnect(ctx context.Context, f sp.ControllerFence) error {
	return s.controller(ctx, f, func(tx pgx.Tx, r *record, _ task) error {
		r.Snapshot.ConnectionState = "disconnected"
		r.Snapshot.Synchronized = false
		if err := s.emit(ctx, tx, r, "snapshot", r.Snapshot, nil); err != nil {
			return err
		}
		return save(ctx, tx, r)
	})
}
