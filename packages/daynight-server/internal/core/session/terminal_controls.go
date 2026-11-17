package session

import (
	"bytes"
	"context"
	"errors"
	"math"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

type terminalFrameWrite struct {
	projectID    string
	raw          []byte
	fence        v2.Envelope
	epoch, owner string
	lastSeen     time.Time
}

// Ordering is durable independently of preview publication. The frame hash
// permits exact retries without retaining terminal text in PostgreSQL.
type terminalFrameIdentity struct {
	ExecutionGeneration string
	SegmentID           string
	FrameSeq            string
	SHA256              string
}

func terminalFenceMatches(r *terminalRecord, m v2.Envelope) bool {
	return m.SessionID == r.Envelope.SessionID && m.ClaimID == r.Envelope.ClaimID && m.ExecutionGeneration == r.Envelope.ExecutionGeneration && m.Protocol == v2.Protocol && m.AgentControlMode == "herdr" && m.ContentKind == "terminal_recording"
}
func (s *Execution) terminalSnapshot(r *terminalRecord) *v2.Snapshot {
	if r.FinalizationID != nil || r.ServerInstance != s.instance {
		return nil
	}
	s.terminalMutex.Lock()
	var raw []byte
	if entry := s.terminalFrames[r.Envelope.SessionID]; entry != nil && s.now().Sub(entry.lastSeen) <= HeartbeatTimeout {
		raw = bytes.Clone(entry.raw)
	}
	s.terminalMutex.Unlock()
	var m v2.Message
	var err error
	if len(raw) == 0 {
		return nil
	}
	m, err = v2.DecodeMessage(raw)
	if err != nil || !terminalFenceMatches(r, m.Envelope) {
		return nil
	}
	p, ok := m.Payload.(v2.Snapshot)
	if !ok || p.ConnectionEpoch != r.ConnectionEpoch {
		return nil
	}
	return &p
}
func (s *Execution) forgetTerminalSnapshot(id string) {
	s.terminalMutex.Lock()
	defer s.terminalMutex.Unlock()
	delete(s.terminalFrames, id)
	delete(s.terminalFrameWrites, id)
}

func invalidateTerminalOperations(ctx context.Context, tx *operationTx, id string) error {
	return tx.dao.InvalidateTerminalOperations(ctx, id)
}
func (s *Execution) suspendTerminal(ctx context.Context, tx *operationTx, r *terminalRecord) error {
	if r.Control != nil {
		if number(r.ControlEpoch) == math.MaxInt64 {
			r.Control.State = "closed"
		} else {
			r.ControlEpoch = next(r.ControlEpoch)
		}
		r.Control.ControlEpoch = r.ControlEpoch
		suspendTerminalState(r)
		r.Control.UnavailableReason = nil
	}
	r.ControlActor = nil
	r.LastLeaseSeq = "0"
	if err := invalidateTerminalOperations(ctx, tx, r.Envelope.SessionID); err != nil {
		return err
	}
	return saveTerminal(ctx, tx, r)
}
func (s *Execution) refreshTerminalControl(ctx context.Context, tx *operationTx, r *terminalRecord, t task) error {
	// A missing local cache is a routing condition, not evidence that the
	// original Worker's connection or lease was lost.
	if r.ServerInstance != s.instance && terminalActive(t, r) && r.LastSeen != nil && s.now().Sub(*r.LastSeen) <= HeartbeatTimeout {
		return fault("relay_instance_unavailable", "The live terminal Worker belongs to another relay instance.")
	}
	err := tx.dao.ExpireTerminalOperations(ctx, r.Envelope.SessionID, s.now())
	if err != nil {
		return err
	}
	if r.Control == nil {
		return nil
	}
	if !terminalActive(t, r) || !terminalRecordingReady(r) || r.LastSeen == nil || s.now().Sub(*r.LastSeen) > HeartbeatTimeout {
		if r.Control.Lease != nil || r.ControlActor != nil {
			return s.suspendTerminal(ctx, tx, r)
		}
		return nil
	}
	if r.Control.Lease != nil {
		expiry, e := time.Parse(time.RFC3339Nano, r.Control.Lease.ExpiresAt)
		valid := e == nil && s.now().Before(expiry) && r.ControlActor != nil
		if valid {
			e := s.authorizationRun(ctx, tx.op, tx.scope, *r.ControlActor, Authority{ProjectID: r.Owner.ProjectID})
			if e != nil {
				var refusal *model.Fault
				if !errors.As(e, &refusal) {
					return e
				}
				valid = false
			} else {
				valid = r.ControlActor.UserID == r.Owner.OwnerUserID
			}
		}
		if !valid {
			return s.suspendTerminal(ctx, tx, r)
		}
	}
	return nil
}

func (s *Execution) terminalOnline(r *terminalRecord) bool {
	return r.ServerInstance == s.instance && r.LastSeen != nil && s.now().Sub(*r.LastSeen) <= HeartbeatTimeout
}
