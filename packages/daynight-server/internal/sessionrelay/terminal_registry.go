package sessionrelay

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol/v2"
	"github.com/jackc/pgx/v5"
)

type terminalRecording struct {
	Responsibility  *v2.RecordingResponsibility
	Evidence        *v2.RecordingEvidence
	ObservedContent bool
}
type terminalRecord struct {
	AutomationRecoveries map[string]*terminalAutomationRecovery
	Envelope             v2.Envelope
	Registration         v2.Registration
	RegistrationDigest   string
	RegistrationEpoch    string
	Owner                v2.Owner
	Binding              v2.Binding
	Runs                 []v2.Run
	FinalizationID       *string
	ConnectionEpoch      string
	ChannelEpoch         string
	ControlEpoch         string
	Control              *v2.ControlState
	ControlActor         *core.Principal
	LastLeaseSeq         string
	OperationSeq         int64
	Snapshot             *v2.Snapshot `json:"-"`
	LastFrame            *terminalFrameIdentity
	LastSeen             *time.Time
	ServerInstance       string
	Recording            map[string]terminalRecording
}

func suspendTerminalState(r *terminalRecord) {
	if r.Control != nil {
		if r.Control.State != "closing" && r.Control.State != "closed" {
			r.Control.State = "suspended"
		}
		r.Control.Lease = nil
		r.Control.AvailableActions = []string{}
		r.Control.ConnectionEpoch = r.ConnectionEpoch
	}
}
func terminalEnvelope(r *terminalRecord, kind string, payload v2.Payload) v2.Message {
	e := r.Envelope
	e.Type = kind
	return v2.Message{Envelope: e, Payload: payload}
}
func terminalOwner(p core.Principal, r *terminalRecord) error {
	if p.Kind != core.PATCredential || p.UserID != r.Owner.OwnerUserID {
		return denied()
	}
	return nil
}
func terminalActive(t task, r *terminalRecord) bool {
	w := t.Worker
	return r.FinalizationID == nil && t.Status == "in_progress" && w != nil && w.State == core.WorkerActive && w.ClaimID == r.Envelope.ClaimID && w.UserID == r.Owner.OwnerUserID && w.WorkerID == r.Owner.WorkerID && w.WorktreeID == r.Owner.WorktreeID && w.AgentControlMode == core.AgentControlModeHerdr && string(w.Agent) == r.Owner.Provider
}
func terminalRecordingReady(r *terminalRecord) bool {
	rec := r.Recording[r.Envelope.ExecutionGeneration]
	return rec.Responsibility != nil && rec.Responsibility.RecordingEnabled && (rec.Evidence == nil || !rec.Evidence.Closed && rec.Evidence.CaptureError == nil) && len(r.Runs) > 0 && r.Runs[len(r.Runs)-1].StoppedAt == nil
}
func loadTerminal(ctx context.Context, tx pgx.Tx, id string) (*terminalRecord, error) {
	var raw []byte
	if err := tx.QueryRow(ctx, `SELECT terminal_state FROM task_sessions WHERE id=$1 AND backend='herdr' FOR UPDATE`, id).Scan(&raw); err != nil {
		return nil, err
	}
	r := &terminalRecord{}
	if err := json.Unmarshal(raw, r); err != nil {
		return nil, err
	}
	return r, nil
}
func saveTerminal(ctx context.Context, tx pgx.Tx, r *terminalRecord) error {
	_, err := tx.Exec(ctx, `UPDATE task_sessions SET terminal_state=$2,last_seen=$3,server_instance=$4 WHERE id=$1 AND backend='herdr'`, r.Envelope.SessionID, encode(r), r.LastSeen, r.ServerInstance)
	return err
}
func (s *Service) terminalAccess(ctx context.Context, p core.Principal, project, taskID, id string, finalize bool, fn func(pgx.Tx, *terminalRecord, task, bool) error) error {
	return s.transact(ctx, func(tx pgx.Tx) error {
		t, deleted, err := scopeArchiveTask(ctx, tx, project, taskID, finalize)
		if err != nil {
			return err
		}
		admin, err := member(ctx, tx, p, project, s.now())
		if err != nil {
			return err
		}
		r, err := loadTerminal(ctx, tx, id)
		if err != nil {
			return err
		}
		if r.Owner.ProjectID != project || r.Owner.TaskID != taskID {
			return conflict()
		}
		if deleted {
			if err = terminalOwner(p, r); err != nil {
				return err
			}
		}
		return fn(tx, r, t, admin || p.UserID == r.Owner.OwnerUserID)
	})
}
func validTerminalMessage(m v2.Message, kind string) error {
	if m.Type != kind {
		return fault("invalid_payload", "Unexpected terminal message type.")
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return fault("invalid_payload", "Invalid terminal message.")
	}
	if _, err = v2.DecodeMessage(raw); err != nil {
		return fault("invalid_payload", "Invalid terminal message.")
	}
	return nil
}
func terminalFence(r *terminalRecord, e v2.Envelope) error {
	if r.Envelope.SessionID != e.SessionID || r.Envelope.ClaimID != e.ClaimID || r.Envelope.ExecutionGeneration != e.ExecutionGeneration {
		return fault("stale_fence", "The terminal execution fence changed.")
	}
	return nil
}
func terminalBinding(previous, next v2.Binding) error {
	a, b := previous, next
	a.NativeSessionID = nil
	b.NativeSessionID = nil
	if !reflect.DeepEqual(a, b) {
		return fault("target_changed", "The terminal binding changed.")
	}
	if err := v2.AssertNativeSessionIDProgression(previous.NativeSessionID, next.NativeSessionID); err != nil {
		return fault("target_changed", "The native session identity changed.")
	}
	return nil
}
func terminalTime(t time.Time) string {
	return t.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

// RegisterTerminal binds the original Worker to the shared Session registry.
// Reconnect is a fenced, idempotent network transition, never a new native run.
func (s *Service) RegisterTerminal(ctx context.Context, p core.Principal, project, taskID string, m v2.Message) (v2.Message, error) {
	var out v2.Message
	if err := validTerminalMessage(m, "registration"); err != nil {
		return out, err
	}
	in := m.Payload.(v2.Registration)
	if p.Kind != core.PATCredential || in.Owner.OwnerUserID != p.UserID {
		return out, denied()
	}
	if in.Owner.ProjectID != project || in.Owner.TaskID != taskID || s.Origin == "" || in.Owner.ServerOrigin != s.Origin {
		return out, conflict()
	}
	err := s.transact(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT id FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE`, project, taskID); err != nil {
			return err
		}
		t, err := lockTask(ctx, tx, project, taskID)
		if err != nil {
			return err
		}
		if _, err = member(ctx, tx, p, project, s.now()); err != nil {
			return err
		}
		r := &terminalRecord{Envelope: m.Envelope, Owner: in.Owner, Binding: in.Binding}
		if !terminalActive(t, r) {
			return conflict()
		}
		var id string
		err = tx.QueryRow(ctx, `SELECT id::text FROM task_sessions WHERE id=$1 OR (project_id=$2 AND (registration_id=$3 OR (task_id=$4 AND claim_id=$5)))`, m.SessionID, project, in.RegistrationID, taskID, m.ClaimID).Scan(&id)
		digest := v2.HashBytes(encode(m))
		if errors.Is(err, pgx.ErrNoRows) {
			if in.Mode != "register" || m.ExecutionGeneration != "1" {
				return conflict()
			}
			now := s.now()
			r.Registration = in
			r.RegistrationDigest = digest
			r.RegistrationEpoch = "1"
			r.ConnectionEpoch = "1"
			r.ControlEpoch = "0"
			r.LastLeaseSeq = "0"
			r.LastSeen = &now
			r.ServerInstance = s.instance
			r.Recording = map[string]terminalRecording{}
			r.Runs = []v2.Run{}
			_, err = tx.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,backend,terminal_state,last_seen,server_instance) VALUES($1,$2,$3,$4,$5,$6,$7,NULL,'herdr',$8,$9,$10)`, m.SessionID, project, taskID, m.ClaimID, p.UserID, in.RegistrationID, encode(in), encode(r), now, s.instance)
			if err != nil {
				return err
			}
		} else {
			if err != nil {
				return err
			}
			if id != m.SessionID {
				return conflict()
			}
			r, err = loadTerminal(ctx, tx, id)
			if err != nil {
				return err
			}
			if !terminalActive(t, r) || !reflect.DeepEqual(r.Owner, in.Owner) {
				return conflict()
			}
			if err = terminalFence(r, m.Envelope); err != nil {
				return err
			}
			if err = terminalBinding(r.Binding, in.Binding); err != nil {
				return err
			}
			if r.RegistrationDigest == digest {
				out = terminalEnvelope(r, "registration_ack", v2.RegistrationAck{RegistrationID: in.RegistrationID, ConnectionEpoch: r.RegistrationEpoch})
				return nil
			}
			if in.Mode != "reconnect" || in.ConnectionEpoch == nil || *in.ConnectionEpoch != r.ConnectionEpoch || in.RegistrationID != r.Registration.RegistrationID || number(r.ConnectionEpoch) == math.MaxInt64 {
				return conflict()
			}
			if r.ServerInstance != s.instance && r.LastSeen != nil && s.now().Sub(*r.LastSeen) < HeartbeatTimeout {
				return fault("input_busy", "The original relay connection is still active.")
			}
			if err = invalidateTerminalOperations(ctx, tx, id); err != nil {
				return err
			}
			r.Binding = in.Binding
			r.Registration = in
			r.RegistrationDigest = digest
			r.ConnectionEpoch = next(r.ConnectionEpoch)
			r.RegistrationEpoch = r.ConnectionEpoch
			suspendTerminalState(r)
			r.ControlActor = nil
			r.Snapshot = nil
			r.LastLeaseSeq = "0"
			r.ServerInstance = s.instance
			now := s.now()
			r.LastSeen = &now
			if err = saveTerminal(ctx, tx, r); err != nil {
				return err
			}
		}
		out = terminalEnvelope(r, "registration_ack", v2.RegistrationAck{RegistrationID: in.RegistrationID, ConnectionEpoch: r.ConnectionEpoch})
		return nil
	})
	return out, err
}

func validRunProgression(old, nextRun v2.Run) error {
	if old.ExecutionGeneration != nextRun.ExecutionGeneration || old.Owner != nextRun.Owner || old.StartedAt != nextRun.StartedAt {
		return conflict()
	}
	if err := terminalBinding(old.Binding, nextRun.Binding); err != nil {
		return err
	}
	if old.StopProof != nil && !reflect.DeepEqual(old, nextRun) {
		return conflict()
	}
	if len(nextRun.SegmentIDs) < len(old.SegmentIDs) || !reflect.DeepEqual(old.SegmentIDs, nextRun.SegmentIDs[:len(old.SegmentIDs)]) {
		return conflict()
	}
	return nil
}

// Preparation-only stop proof and content evidence are mutually exclusive in
// either write order. Capture errors remain evidence, never successful zeroes.
func validPreparedRecording(run v2.Run, rec terminalRecording) error {
	if run.StopProof != nil && run.StopProof.NativeLaunch == "not_submitted" && (rec.ObservedContent || rec.Evidence != nil && (rec.Evidence.SelectedFrameCount != "0" || rec.Evidence.RegisteredFrameCount != "0")) {
		return fault("source_corrupt", "A preparation-only stop cannot have recorded terminal content.")
	}
	return nil
}

// UpdateTerminalLedger grants exactly one next generation under the same lock as
// finalization. A stopped generation and its segment ownership are immutable.
func (s *Service) UpdateTerminalLedger(ctx context.Context, p core.Principal, project, taskID, id, epoch string, m v2.Message) (v2.Message, error) {
	var out v2.Message
	if err := validTerminalMessage(m, "generation_ledger"); err != nil {
		return out, err
	}
	in := m.Payload.(v2.GenerationLedger)
	if in.FinalizationID != nil {
		return out, conflict()
	}
	err := s.terminalAccess(ctx, p, project, taskID, id, true, func(tx pgx.Tx, r *terminalRecord, t task, _ bool) error {
		if epoch != r.ConnectionEpoch {
			return fault("stale_fence", "The terminal connection changed.")
		}
		if err := terminalOwner(p, r); err != nil {
			return err
		}
		if r.FinalizationID != nil || m.SessionID != r.Envelope.SessionID || m.ClaimID != r.Envelope.ClaimID {
			return conflict()
		}
		if len(in.Runs) < len(r.Runs) || len(in.Runs) > len(r.Runs)+1 || len(in.Runs) == 0 {
			return conflict()
		}
		for i, run := range in.Runs {
			if run.Owner != r.Owner {
				return conflict()
			}
			at, _ := time.Parse(time.RFC3339Nano, run.StartedAt)
			if at.After(s.now().Add(time.Second)) {
				return conflict()
			}
			if i < len(r.Runs) {
				if err := validRunProgression(r.Runs[i], run); err != nil {
					return err
				}
			}
			if err := validPreparedRecording(run, r.Recording[run.ExecutionGeneration]); err != nil {
				return err
			}
		}
		generationChanged := m.ExecutionGeneration != r.Envelope.ExecutionGeneration
		if len(r.Runs) == 0 {
			if m.ExecutionGeneration != "1" || !terminalActive(t, r) {
				return conflict()
			}
			if err := terminalBinding(r.Binding, in.Runs[0].Binding); err != nil {
				return err
			}
		} else if generationChanged {
			// The validated ledger carries native identity forward from both run
			// bindings and stop proofs. A proof may first learn it at shutdown;
			// recovering from that identity must not rewrite the frozen run.
			previousProof := in.Runs[len(r.Runs)-1].StopProof
			if !terminalActive(t, r) || len(in.Runs) != len(r.Runs)+1 || number(m.ExecutionGeneration) != number(r.Envelope.ExecutionGeneration)+1 || previousProof == nil || previousProof.NativeLaunch != "" || previousProof.Binding.NativeSessionID == nil {
				return conflict()
			}
			if err := invalidateTerminalOperations(ctx, tx, id); err != nil {
				return err
			}
			suspendTerminalState(r)
			r.ControlActor = nil
			r.LastSeen = nil
			r.LastLeaseSeq = "0"
			if r.Control != nil {
				r.Control.State = "suspended"
			}
		} else if len(in.Runs) != len(r.Runs) {
			return conflict()
		}
		// Completing the original ledger is allowed after claim termination; it never
		// grants a replacement run or access to the current claim.
		r.Runs = in.Runs
		r.Binding = in.Runs[len(in.Runs)-1].Binding
		r.Envelope.ExecutionGeneration = m.ExecutionGeneration
		if err := saveTerminal(ctx, tx, r); err != nil {
			return err
		}
		out = terminalEnvelope(r, "generation_ledger", v2.GenerationLedger{Runs: r.Runs, FinalizationID: r.FinalizationID})
		return nil
	})
	return out, err
}
func (s *Service) FinalizeTerminal(ctx context.Context, p core.Principal, project, taskID, id, epoch string, m v2.Message) (v2.Message, error) {
	var out v2.Message
	if err := validTerminalMessage(m, "finalization"); err != nil {
		return out, err
	}
	in := m.Payload.(v2.Finalization)
	err := s.terminalAccess(ctx, p, project, taskID, id, true, func(tx pgx.Tx, r *terminalRecord, t task, _ bool) error {
		if epoch != r.ConnectionEpoch {
			return fault("stale_fence", "The terminal connection changed.")
		}
		if err := terminalOwner(p, r); err != nil {
			return err
		}
		if err := terminalFence(r, m.Envelope); err != nil {
			return err
		}
		if r.FinalizationID != nil {
			if *r.FinalizationID != in.FinalizationID || !reflect.DeepEqual(r.Runs, in.Runs) {
				return conflict()
			}
		} else {
			if terminalActive(t, r) || len(r.Runs) == 0 || !reflect.DeepEqual(r.Runs, in.Runs) {
				return fault("stop_unknown", "The original stopped ledger must be recorded before finalization.")
			}
			for _, run := range r.Runs {
				if run.StopProof == nil {
					return fault("stop_unknown", "Every registered run must be stopped.")
				}
				rec := r.Recording[run.ExecutionGeneration]
				if err := validPreparedRecording(run, rec); err != nil {
					return err
				}
				if rec.Responsibility == nil || rec.Evidence == nil || !rec.Evidence.Closed {
					return fault("source_corrupt", "Every run requires closed recording evidence before finalization.")
				}
			}
			if err := invalidateTerminalOperations(ctx, tx, id); err != nil {
				return err
			}
			r.FinalizationID = &in.FinalizationID
			suspendTerminalState(r)
			r.ControlActor = nil
			r.LastSeen = nil
			if err := saveTerminal(ctx, tx, r); err != nil {
				return err
			}
		}
		afterCommit(tx, func() {
			s.forgetTerminalSnapshot(id)
			s.terminalMutex.Lock()
			delete(s.terminalPending, id)
			s.terminalMutex.Unlock()
		})
		out = terminalEnvelope(r, "generation_ledger", v2.GenerationLedger{Runs: r.Runs, FinalizationID: r.FinalizationID})
		return nil
	})
	return out, err
}

func (s *Service) UpdateTerminalRecording(ctx context.Context, p core.Principal, project, taskID, id, epoch string, m v2.Message) (v2.Message, error) {
	var out v2.Message
	if m.Type != "recording_responsibility" && m.Type != "recording_evidence" {
		return out, fault("invalid_payload", "Expected recording responsibility or evidence.")
	}
	if err := validTerminalMessage(m, m.Type); err != nil {
		return out, err
	}
	err := s.terminalAccess(ctx, p, project, taskID, id, true, func(tx pgx.Tx, r *terminalRecord, t task, _ bool) error {
		if epoch != r.ConnectionEpoch {
			return fault("stale_fence", "The terminal connection changed.")
		}
		if err := terminalOwner(p, r); err != nil {
			return err
		}
		if m.SessionID != r.Envelope.SessionID || m.ClaimID != r.Envelope.ClaimID {
			return conflict()
		}
		n := number(m.ExecutionGeneration)
		if n < 1 || n > int64(len(r.Runs)) {
			return conflict()
		}
		rec := r.Recording[m.ExecutionGeneration]
		if m.Type == "recording_responsibility" {
			in := m.Payload.(v2.RecordingResponsibility)
			if rec.Responsibility != nil {
				if !reflect.DeepEqual(*rec.Responsibility, in) {
					return conflict()
				}
				out = m
				return nil
			}
			if !terminalActive(t, r) || m.ExecutionGeneration != r.Envelope.ExecutionGeneration || r.Runs[n-1].StopProof != nil {
				return conflict()
			}
			rec.Responsibility = &in
		} else {
			in := m.Payload.(v2.RecordingEvidence)
			if rec.Responsibility == nil || in.ResponsibilityID != rec.Responsibility.ResponsibilityID {
				return conflict()
			}
			candidate := rec
			candidate.Evidence = &in
			if err := validPreparedRecording(r.Runs[n-1], candidate); err != nil {
				return err
			}
			canonical, canonicalErr := v2.CanonicalJSON(m)
			if canonicalErr != nil {
				return canonicalErr
			}
			digest := v2.HashBytes(canonical)
			var priorHash string
			priorErr := tx.QueryRow(ctx, `SELECT body_hash FROM session_recording_evidence WHERE session_id=$1 AND execution_generation=$2 AND evidence_id=$3`, id, n, in.EvidenceID).Scan(&priorHash)
			if priorErr == nil {
				if priorHash != digest {
					return conflict()
				}
				out = m
				return nil
			}
			if !errors.Is(priorErr, pgx.ErrNoRows) {
				return priorErr
			}
			if rec.Evidence != nil {
				if reflect.DeepEqual(*rec.Evidence, in) {
					out = m
					return nil
				}
				if rec.Evidence.EvidenceID == in.EvidenceID || rec.Evidence.Closed || number(in.Revision) <= number(rec.Evidence.Revision) || number(in.SelectedFrameCount) < number(rec.Evidence.SelectedFrameCount) || number(in.RegisteredFrameCount) < number(rec.Evidence.RegisteredFrameCount) || rec.Evidence.CaptureError != nil && !reflect.DeepEqual(rec.Evidence.CaptureError, in.CaptureError) {
					return conflict()
				}
			}
			if rec.ObservedContent && in.Closed && in.SelectedFrameCount == "0" {
				return fault("source_corrupt", "Closed evidence cannot erase observed content.")
			}
			if r.FinalizationID != nil || in.Closed && r.Runs[n-1].StopProof == nil {
				return conflict()
			}
			if !rec.Responsibility.RecordingEnabled && (in.SelectedFrameCount != "0" || in.RegisteredFrameCount != "0") {
				return conflict()
			}
			if _, err := tx.Exec(ctx, `INSERT INTO session_recording_evidence(session_id,execution_generation,evidence_id,revision,body_hash) VALUES($1,$2,$3,$4,$5)`, id, n, in.EvidenceID, number(in.Revision), digest); err != nil {
				return err
			}
			rec.Evidence = &in
		}
		if r.Recording == nil {
			r.Recording = map[string]terminalRecording{}
		}
		r.Recording[m.ExecutionGeneration] = rec
		if err := saveTerminal(ctx, tx, r); err != nil {
			return err
		}
		out = m
		return nil
	})
	return out, err
}

// BindTerminalConnection consumes a connection epoch once. Retrying registration
// can recover its ACK, but opening another socket requires an explicit reconnect.
func (s *Service) BindTerminalConnection(ctx context.Context, p core.Principal, project, taskID, id string, f v2.Envelope, epoch string) error {
	return s.terminalAccess(ctx, p, project, taskID, id, false, func(tx pgx.Tx, r *terminalRecord, t task, _ bool) error {
		if err := terminalOwner(p, r); err != nil {
			return err
		}
		if err := terminalFence(r, f); err != nil {
			return err
		}
		if !terminalActive(t, r) || r.ConnectionEpoch != epoch || r.ChannelEpoch == epoch || r.ServerInstance != s.instance {
			return conflict()
		}
		r.ChannelEpoch = epoch
		return saveTerminal(ctx, tx, r)
	})
}
