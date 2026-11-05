package sessionrelay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"slices"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol/v2"
	"github.com/jackc/pgx/v5"
)

// Terminal command bodies are transient. The durable ledger keeps the original
// actor, target and hash so loss of a relay cannot replay uncertain native input.
type terminalInputTarget struct {
	Kind            string     `json:"kind"`
	BrowserClientID string     `json:"browserClientId"`
	ConnectionEpoch string     `json:"connectionEpoch"`
	SegmentID       string     `json:"segmentId"`
	Binding         v2.Binding `json:"binding"`
	ControlEpoch    string     `json:"controlEpoch"`
	LeaseID         string     `json:"leaseId"`
	LeaseSeq        string     `json:"leaseSeq"`
}
type terminalCommand struct {
	v2.Envelope
	Request *v2.ControlRequest   `json:"request,omitempty"`
	Input   *terminalInputTarget `json:"input,omitempty"`
}
type terminalOperation struct {
	Command  terminalCommand
	Result   v2.OperationResult
	Actor    model.Principal
	Hash     []byte
	Epoch    *int64
	Deadline time.Time
}

type terminalFrameWrite struct {
	raw          []byte
	fence        v2.Envelope
	epoch, owner string
	lastSeen     time.Time
}

type terminalBodyWrite struct {
	raw          []byte
	fence        v2.Envelope
	epoch, owner string
	deadline     time.Time
}

func (w *terminalFrameWrite) matches(f v2.Envelope, epoch string) bool {
	return w != nil && w.fence.SessionID == f.SessionID && w.fence.ClaimID == f.ClaimID && w.fence.ExecutionGeneration == f.ExecutionGeneration && w.epoch == epoch
}

func (s *Service) touchTerminalSnapshot(f v2.Envelope, epoch string, seen time.Time) {
	s.terminalMutex.Lock()
	defer s.terminalMutex.Unlock()
	for _, entry := range []*terminalFrameWrite{s.terminalFrames[f.SessionID], s.terminalFrameWrites[f.SessionID]} {
		if entry.matches(f, epoch) && seen.After(entry.lastSeen) {
			entry.lastSeen = seen
		}
	}
}

// A closed socket releases only its own preview, even if its credential expired
// before database cleanup. A delayed old disconnect cannot clear a new epoch.
func (s *Service) forgetTerminalConnection(owner string, f v2.Envelope, epoch string) {
	s.terminalMutex.Lock()
	defer s.terminalMutex.Unlock()
	if entry := s.terminalFrames[f.SessionID]; entry.matches(f, epoch) && entry.owner == owner {
		delete(s.terminalFrames, f.SessionID)
	}
	if entry := s.terminalFrameWrites[f.SessionID]; entry.matches(f, epoch) && entry.owner == owner {
		delete(s.terminalFrameWrites, f.SessionID)
	}
	for operationID, entry := range s.terminalPending[f.SessionID] {
		if entry.owner == owner && entry.fence.SessionID == f.SessionID && entry.fence.ClaimID == f.ClaimID && entry.fence.ExecutionGeneration == f.ExecutionGeneration && entry.epoch == epoch {
			delete(s.terminalPending[f.SessionID], operationID)
		}
	}
	if len(s.terminalPending[f.SessionID]) == 0 {
		delete(s.terminalPending, f.SessionID)
	}
}

// Ordering is durable independently of preview publication. The frame hash
// permits exact retries without retaining terminal text in PostgreSQL.
type terminalFrameIdentity struct {
	ExecutionGeneration string
	SegmentID           string
	FrameSeq            string
	SHA256              string
}

// A reserved write is bounded and becomes visible only after its transaction
// commits. Deleting the reservation fences delayed callbacks without retaining
// tombstones for completed Sessions.
func (s *Service) stageTerminalSnapshot(r *terminalRecord, raw []byte) (commit, cancel func(), err error) {
	s.terminalMutex.Lock()
	defer s.terminalMutex.Unlock()
	id := r.Envelope.SessionID
	now := s.now()
	if s.terminalFrames == nil {
		s.terminalFrames = map[string]*terminalFrameWrite{}
	}
	if s.terminalFrameWrites == nil {
		s.terminalFrameWrites = map[string]*terminalFrameWrite{}
	}
	// HTTP-only producers have no socket cleanup callback. Reclaim their expired
	// committed previews on allocation; an in-flight reservation keeps its slot.
	for key, entry := range s.terminalFrames {
		if s.terminalFrameWrites[key] == nil && now.Sub(entry.lastSeen) > HeartbeatTimeout {
			delete(s.terminalFrames, key)
		}
	}
	if _, exists := s.terminalFrames[id]; !exists && s.terminalFrameWrites[id] == nil {
		count := len(s.terminalFrames)
		for key := range s.terminalFrameWrites {
			if _, exists := s.terminalFrames[key]; !exists {
				count++
			}
		}
		if count >= maxLiveSessions {
			return nil, nil, fault("rate_limited", "Terminal preview capacity is unavailable.")
		}
	}
	write := &terminalFrameWrite{raw: raw, fence: r.Envelope, epoch: r.ConnectionEpoch, owner: r.Owner.OwnerUserID, lastSeen: now}
	s.terminalFrameWrites[id] = write
	finish := func(publish bool) {
		s.terminalMutex.Lock()
		defer s.terminalMutex.Unlock()
		if s.terminalFrameWrites[id] != write {
			return
		}
		delete(s.terminalFrameWrites, id)
		if publish && s.now().Sub(write.lastSeen) <= HeartbeatTimeout {
			s.terminalFrames[id] = write
		}
	}
	return func() { finish(true) }, func() { finish(false) }, nil
}

func terminalControlTransition(request v2.ControlRequest, actor string, state v2.ControlState, now time.Time) error {
	if state.ConnectionEpoch != request.ConnectionEpoch || number(state.ControlEpoch) < number(request.ControlEpoch) {
		return conflict()
	}
	switch request.Action {
	case "acquire_control", "renew_control":
		l := state.Lease
		if state.State != "manual" || l == nil || l.HolderUserID != actor || l.BrowserClientID != request.BrowserClientID || l.ControlEpoch != state.ControlEpoch {
			return conflict()
		}
		expiry, err := time.Parse(time.RFC3339Nano, l.ExpiresAt)
		if err != nil || !expiry.After(now) || expiry.After(now.Add(time.Duration(v2.LeaseTTLMillis)*time.Millisecond)) {
			return conflict()
		}
		if request.Action == "renew_control" {
			if request.LeaseID == nil || l.LeaseID != *request.LeaseID || state.ControlEpoch != request.ControlEpoch {
				return conflict()
			}
		} else if number(state.ControlEpoch) <= number(request.ControlEpoch) {
			return conflict()
		}
	case "release_control":
		if state.State != "suspended" || state.Lease != nil || number(state.ControlEpoch) <= number(request.ControlEpoch) {
			return conflict()
		}
	case "resolve_initial_assignment":
		if state.State != "suspended" || state.Lease != nil || state.InitialAssignment != "transport_completed" || number(state.ControlEpoch) <= number(request.ControlEpoch) {
			return conflict()
		}
	case "resume_automation":
		if state.State != "automation" || state.Lease != nil || !request.DraftHandled || number(state.ControlEpoch) <= number(request.ControlEpoch) {
			return conflict()
		}
	default:
		return conflict()
	}
	return nil
}

// Only an explicit disposition can resolve uncertain initial delivery. State
// observations cannot silently turn it back into an automatically sendable task.
func terminalInitialProgress(previous, next string, request *v2.ControlRequest) bool {
	if previous == next {
		return true
	}
	switch previous {
	case "pending":
		return next == "dispatching" || next == "transport_completed" || next == "unknown"
	case "dispatching":
		// The fenced Worker can prove a zero-write rejection from its durable
		// input receipt. Only that outcome returns an attempt to pending;
		// uncertain or completed delivery below cannot become sendable again.
		return next == "pending" || next == "transport_completed" || next == "unknown"
	case "unknown", "unconfirmed":
		return request != nil && request.Action == "resolve_initial_assignment" && request.InitialUnknownDisposition != nil && *request.InitialUnknownDisposition == "delivered_continue" && next == "transport_completed"
	}
	return false
}

func loadTerminalOperation(ctx context.Context, tx pgx.Tx, id, operationID string) (terminalOperation, error) {
	var out terminalOperation
	var command, result []byte
	var kind string
	err := tx.QueryRow(ctx, `SELECT command,receipt,actor_user_id::text,credential_id::text,credential_kind,body_hash,dispatch_epoch,deadline FROM session_operations WHERE session_id=$1 AND operation_id=$2`, id, operationID).Scan(&command, &result, &out.Actor.UserID, &out.Actor.CredentialID, &kind, &out.Hash, &out.Epoch, &out.Deadline)
	if err != nil {
		return out, err
	}
	out.Actor.Kind = model.CredentialKind(kind)
	if err = json.Unmarshal(command, &out.Command); err != nil {
		return out, err
	}
	err = json.Unmarshal(result, &out.Result)
	return out, err
}
func terminalResultMessage(op terminalOperation) v2.Message {
	envelope := op.Command.Envelope
	envelope.Type = "operation_result"
	return v2.Message{Envelope: envelope, Payload: op.Result}
}
func writeTerminalResult(ctx context.Context, tx pgx.Tx, id string, result v2.OperationResult) error {
	_, err := tx.Exec(ctx, `UPDATE session_operations SET receipt=$3 WHERE session_id=$1 AND operation_id=$2`, id, result.OperationID, encode(result))
	return err
}
func terminalResult(id, state, code string) v2.OperationResult {
	out := v2.OperationResult{OperationID: id, State: state}
	if code != "" {
		out.ErrorCode = &code
	}
	return out
}
func terminalFenceMatches(r *terminalRecord, m v2.Envelope) bool {
	return m.SessionID == r.Envelope.SessionID && m.ClaimID == r.Envelope.ClaimID && m.ExecutionGeneration == r.Envelope.ExecutionGeneration && m.Protocol == v2.Protocol && m.AgentControlMode == "herdr" && m.ContentKind == "terminal_recording"
}
func terminalCheckedMessage(m v2.Message) (v2.Message, error) {
	raw, err := json.Marshal(m)
	if err != nil {
		return m, fault("invalid_input", "Invalid terminal message.")
	}
	checked, err := v2.DecodeMessage(raw)
	if err != nil {
		return m, fault("invalid_input", "Invalid terminal message.")
	}
	return checked, nil
}
func terminalSummary(m v2.Message) (terminalCommand, string) {
	command := terminalCommand{Envelope: m.Envelope}
	switch p := m.Payload.(type) {
	case v2.ControlRequest:
		command.Request = &p
		return command, p.OperationID
	case v2.Operation:
		command.Input = &terminalInputTarget{Kind: p.Kind, ConnectionEpoch: p.ConnectionEpoch, SegmentID: p.SegmentID, Binding: p.Binding, ControlEpoch: p.ControlEpoch, LeaseID: p.LeaseID, LeaseSeq: p.LeaseSeq}
		return command, p.OperationID
	}
	return command, ""
}
func terminalHash(m v2.Message) ([]byte, error) {
	canonical, err := v2.CanonicalJSON(m)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(canonical)
	return hash[:], nil
}

func (s *Service) storeTerminalBody(r *terminalRecord, operationID string, raw []byte, deadline time.Time) (cancel func(), err error) {
	s.terminalMutex.Lock()
	defer s.terminalMutex.Unlock()
	id := r.Envelope.SessionID
	now := s.now()
	if s.terminalPending == nil {
		s.terminalPending = map[string]map[string]*terminalBodyWrite{}
	}
	s.expireTerminalBodiesLocked(now)
	entries := s.terminalPending[id]
	if entries == nil {
		if len(s.terminalPending) >= maxLiveSessions {
			return nil, fault("rate_limited", "Terminal relay capacity is unavailable.")
		}
		entries = map[string]*terminalBodyWrite{}
		s.terminalPending[id] = entries
	}
	clear(entries)
	write := &terminalBodyWrite{raw: bytes.Clone(raw), fence: r.Envelope, epoch: r.ConnectionEpoch, owner: r.Owner.OwnerUserID, deadline: deadline}
	entries[operationID] = write
	// Rollback releases the database lock before caller cleanup. Cancel only
	// this reservation, because a same-ID retry may already have replaced it.
	return func() { s.cancelTerminalBody(id, operationID, write) }, nil
}

func (s *Service) cancelTerminalBody(id, operationID string, write *terminalBodyWrite) {
	s.terminalMutex.Lock()
	defer s.terminalMutex.Unlock()
	if s.terminalPending[id][operationID] != write {
		return
	}
	delete(s.terminalPending[id], operationID)
	if len(s.terminalPending[id]) == 0 {
		delete(s.terminalPending, id)
	}
}
func (s *Service) expireTerminalBodiesLocked(now time.Time) {
	// The durable operation deadline also bounds its transient body. Reclamation
	// does not depend on a still-authorized Worker polling or finishing an archive.
	for sessionID, entries := range s.terminalPending {
		for operationID, entry := range entries {
			if !now.Before(entry.deadline) {
				delete(entries, operationID)
			}
		}
		if len(entries) == 0 {
			delete(s.terminalPending, sessionID)
		}
	}
}
func (s *Service) terminalBody(id, operationID string) []byte {
	s.terminalMutex.Lock()
	defer s.terminalMutex.Unlock()
	entry := s.terminalPending[id][operationID]
	if entry == nil {
		return nil
	}
	if !s.now().Before(entry.deadline) {
		delete(s.terminalPending[id], operationID)
		if len(s.terminalPending[id]) == 0 {
			delete(s.terminalPending, id)
		}
		return nil
	}
	return bytes.Clone(entry.raw)
}
func (s *Service) forgetTerminalBody(id, operationID string) {
	s.terminalMutex.Lock()
	defer s.terminalMutex.Unlock()
	delete(s.terminalPending[id], operationID)
	if len(s.terminalPending[id]) == 0 {
		delete(s.terminalPending, id)
	}
}
func (s *Service) terminalSnapshot(r *terminalRecord) *v2.Snapshot {
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
func (s *Service) forgetTerminalSnapshot(id string) {
	s.terminalMutex.Lock()
	defer s.terminalMutex.Unlock()
	delete(s.terminalFrames, id)
	delete(s.terminalFrameWrites, id)
}

func invalidateTerminalOperations(ctx context.Context, tx pgx.Tx, id string) error {
	_, err := tx.Exec(ctx, `UPDATE session_operations SET receipt=jsonb_build_object('operationId',operation_id::text,'state',CASE WHEN receipt->>'state'='queued' THEN 'rejected' ELSE 'unknown' END,'errorCode',CASE WHEN receipt->>'state'='queued' THEN 'stale_fence' ELSE 'input_unknown' END) WHERE session_id=$1 AND receipt->>'state' IN ('queued','dispatching')`, id)
	return err
}
func (s *Service) suspendTerminal(ctx context.Context, tx pgx.Tx, r *terminalRecord) error {
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
	s.terminalMutex.Lock()
	pending := make(map[string]*terminalBodyWrite, len(s.terminalPending[r.Envelope.SessionID]))
	for id, write := range s.terminalPending[r.Envelope.SessionID] {
		pending[id] = write
	}
	s.terminalMutex.Unlock()
	afterCommit(tx, func() {
		for id, write := range pending {
			s.cancelTerminalBody(r.Envelope.SessionID, id, write)
		}
	})
	return saveTerminal(ctx, tx, r)
}
func (s *Service) refreshTerminalControl(ctx context.Context, tx pgx.Tx, r *terminalRecord, t task) error {
	// A missing local cache is a routing condition, not evidence that the
	// original Worker's connection or lease was lost.
	if r.ServerInstance != s.instance && terminalActive(t, r) && r.LastSeen != nil && s.now().Sub(*r.LastSeen) <= HeartbeatTimeout {
		return fault("relay_instance_unavailable", "The live terminal Worker belongs to another relay instance.")
	}
	s.terminalMutex.Lock()
	s.expireTerminalBodiesLocked(s.now())
	s.terminalMutex.Unlock()
	_, err := tx.Exec(ctx, `UPDATE session_operations SET receipt=jsonb_build_object('operationId',operation_id::text,'state',CASE WHEN receipt->>'state'='queued' THEN 'rejected' ELSE 'unknown' END,'errorCode',CASE WHEN receipt->>'state'='queued' THEN 'input_busy' ELSE 'input_unknown' END) WHERE session_id=$1 AND deadline<=$2 AND receipt->>'state' IN ('queued','dispatching')`, r.Envelope.SessionID, s.now())
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
			admin, e := member(ctx, tx, *r.ControlActor, r.Owner.ProjectID, s.now())
			if e != nil {
				var refusal *model.Fault
				if !errors.As(e, &refusal) {
					return e
				}
				valid = false
			} else {
				valid = admin || r.ControlActor.UserID == r.Owner.OwnerUserID
			}
		}
		if !valid {
			return s.suspendTerminal(ctx, tx, r)
		}
	}
	return nil
}

func (s *Service) terminalOnline(r *terminalRecord) bool {
	return r.ServerInstance == s.instance && r.LastSeen != nil && s.now().Sub(*r.LastSeen) <= HeartbeatTimeout
}
func (s *Service) terminalCommandAllowed(ctx context.Context, tx pgx.Tx, r *terminalRecord, t task, p model.Principal, c terminalCommand) error {
	if !terminalActive(t, r) || !terminalFenceMatches(r, c.Envelope) {
		return fault("stale_fence", "Terminal execution is no longer active.")
	}
	if !s.terminalOnline(r) {
		return fault("controller_offline", "Connect the original terminal Worker.")
	}
	caps := r.Registration.Capabilities
	if !caps.Observe || !caps.Control || !caps.Archive || !terminalRecordingReady(r) || r.Control == nil {
		return fault("unsupported_protocol", "Terminal control requires a complete Worker capability set.")
	}
	if r.Control.Lease != nil {
		expiry, err := time.Parse(time.RFC3339Nano, r.Control.Lease.ExpiresAt)
		if err != nil || !s.now().Before(expiry) {
			return fault("lease_expired", "The terminal lease expired.")
		}
	}
	if r.Control.State == "closing" || r.Control.State == "closed" {
		return conflict()
	}
	if request := c.Request; request != nil {
		if request.ConnectionEpoch != r.ConnectionEpoch || request.ControlEpoch != r.ControlEpoch {
			return fault("stale_fence", "Terminal control epoch changed.")
		}
		if !slices.Contains(r.Control.AvailableActions, request.Action) {
			return fault("automation_suspended", "The requested control action is unavailable.")
		}
		switch request.Action {
		case "acquire_control":
			if r.Control.Lease != nil || r.Control.InitialAssignment == "dispatching" {
				return fault("input_busy", "The terminal is already controlled or dispatching input.")
			}
		case "renew_control", "release_control":
			if request.LeaseID == nil || r.Control.Lease == nil || *request.LeaseID != r.Control.Lease.LeaseID || r.Control.Lease.HolderUserID != p.UserID || r.Control.Lease.BrowserClientID != request.BrowserClientID {
				return fault("lease_expired", "The terminal lease is no longer held by this browser.")
			}
		case "resolve_initial_assignment", "resume_automation":
			if r.Control.Lease != nil || r.Control.State != "suspended" {
				return fault("input_busy", "Release the terminal lease before deciding initial delivery or resuming automation.")
			}
			unresolved := r.Control.InitialAssignment == "unknown" || r.Control.InitialAssignment == "unconfirmed"
			if request.Action == "resolve_initial_assignment" && !unresolved {
				return conflict()
			}
			if request.Action == "resume_automation" && unresolved {
				return fault("input_unknown", "Resolve the unknown initial assignment explicitly.")
			}
		default:
			return conflict()
		}
	} else if input := c.Input; input != nil {
		lease := r.Control.Lease
		if !slices.Contains(r.Control.AvailableActions, input.Kind) {
			return fault("automation_suspended", "This terminal input action is unavailable.")
		}
		if input.ConnectionEpoch != r.ConnectionEpoch || input.ControlEpoch != r.ControlEpoch {
			return fault("stale_fence", "Terminal control epoch changed.")
		}
		if r.Control.State != "manual" || lease == nil || lease.LeaseID != input.LeaseID || lease.HolderUserID != p.UserID || lease.BrowserClientID != input.BrowserClientID {
			return fault("lease_expired", "An active terminal lease is required.")
		}
		if err := terminalBinding(r.Binding, input.Binding); err != nil {
			return err
		}
		if len(r.Runs) == 0 {
			return fault("target_changed", "The terminal segment changed.")
		}
		run := r.Runs[len(r.Runs)-1]
		if run.StoppedAt != nil || len(run.SegmentIDs) == 0 || run.SegmentIDs[len(run.SegmentIDs)-1] != input.SegmentID {
			return fault("target_changed", "The terminal segment changed.")
		}
	} else {
		return fault("invalid_input", "Unsupported terminal command.")
	}
	return nil
}

// SubmitTerminal durably reserves an operation ID before exposing an offer. A
// repeated intent reads its prior outcome; it never issues another native input.
func (s *Service) SubmitTerminal(ctx context.Context, p model.Principal, project, taskID, id, browserClientID string, m v2.Message) (v2.Message, error) {
	checked, err := terminalCheckedMessage(m)
	if err != nil {
		return v2.Message{}, err
	}
	m = checked
	c, operationID := terminalSummary(m)
	if c.Request != nil && c.Request.BrowserClientID != browserClientID {
		return v2.Message{}, denied()
	}
	if c.Input != nil {
		c.Input.BrowserClientID = browserClientID
	}
	if operationID == "" {
		return v2.Message{}, fault("invalid_input", "Only terminal input or control requests can be submitted.")
	}
	hash, err := terminalHash(m)
	if err != nil {
		return v2.Message{}, err
	}
	var out v2.Message
	var cancelBody func()
	err = s.terminalAccess(ctx, p, project, taskID, id, false, func(tx pgx.Tx, r *terminalRecord, t task, write bool) error {
		if !write {
			return denied()
		}
		if c.SessionID != id {
			return conflict()
		}
		old, e := loadTerminalOperation(ctx, tx, id, operationID)
		if e == nil {
			if old.Actor.UserID != p.UserID || old.Command.Input != nil && old.Command.Input.BrowserClientID != browserClientID {
				return denied()
			}
			if !bytes.Equal(old.Hash, hash) {
				return fault("operation_conflict", "Operation ID already has a different terminal intent.")
			}
			out = terminalResultMessage(old)
			return nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if e = s.refreshTerminalControl(ctx, tx, r, t); e != nil {
			return e
		}
		if e = s.terminalCommandAllowed(ctx, tx, r, t, p, c); e != nil {
			return e
		}
		if c.Input != nil {
			operation := m.Payload.(v2.Operation)
			if !slices.Contains(r.Control.AvailableActions, operation.Kind) {
				return fault("automation_suspended", "This terminal input action is unavailable.")
			}
			if number(c.Input.LeaseSeq) <= number(r.LastLeaseSeq) {
				return fault("stale_fence", "Terminal lease sequence was already used.")
			}
		}
		var pending bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_operations WHERE session_id=$1 AND receipt->>'state' IN ('queued','dispatching'))`, id).Scan(&pending); e != nil {
			return e
		}
		if pending {
			return fault("input_busy", "A terminal operation is already pending.")
		}
		if r.OperationSeq >= maxSessionOperations {
			return fault("rate_limited", "Terminal operation ledger limit reached.")
		}
		raw, e := json.Marshal(m)
		if e != nil {
			return e
		}
		deadline := s.now().Add(time.Duration(v2.InputTimeoutMillis) * time.Millisecond).Truncate(time.Microsecond)
		if cancelBody, e = s.storeTerminalBody(r, operationID, raw, deadline); e != nil {
			return e
		}
		invalidateAutomationRecoveries(r)
		result := terminalResult(operationID, "queued", "")
		r.OperationSeq++
		if c.Input != nil {
			r.LastLeaseSeq = c.Input.LeaseSeq
		}
		_, e = tx.Exec(ctx, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, id, operationID, r.OperationSeq, hash, encode(c), p.UserID, p.CredentialID, string(p.Kind), encode(result), deadline)
		if e != nil {
			return e
		}
		out = terminalResultMessage(terminalOperation{Command: c, Result: result})
		return saveTerminal(ctx, tx, r)
	})
	if err != nil && cancelBody != nil {
		cancelBody()
	}
	return out, err
}
func (s *Service) TerminalOperation(ctx context.Context, p model.Principal, project, taskID, id, operationID string) (v2.Message, error) {
	var out v2.Message
	err := s.terminalAccess(ctx, p, project, taskID, id, false, func(tx pgx.Tx, r *terminalRecord, t task, _ bool) error {
		if err := s.refreshTerminalControl(ctx, tx, r, t); err != nil {
			return err
		}
		op, err := loadTerminalOperation(ctx, tx, id, operationID)
		if err != nil {
			return err
		}
		out = terminalResultMessage(op)
		return nil
	})
	return out, err
}

// PollTerminal consumes an offer once. Committing dispatching precedes returning
// the body, so a lost response is unknown and never causes automatic replay.
func (s *Service) PollTerminal(ctx context.Context, p model.Principal, project, taskID, id string, f v2.Envelope, epoch string) ([]v2.Message, error) {
	out := []v2.Message{}
	err := s.terminalAccess(ctx, p, project, taskID, id, false, func(tx pgx.Tx, r *terminalRecord, t task, _ bool) error {
		if err := terminalOwner(p, r); err != nil {
			return err
		}
		if !terminalFenceMatches(r, f) || epoch != r.ConnectionEpoch || r.ServerInstance != s.instance || !terminalActive(t, r) {
			return conflict()
		}
		if err := s.refreshTerminalControl(ctx, tx, r, t); err != nil {
			return err
		}
		now := s.now()
		r.LastSeen = &now
		afterCommit(tx, func() { s.touchTerminalSnapshot(r.Envelope, epoch, now) })
		rows, err := tx.Query(ctx, `SELECT operation_id::text FROM session_operations WHERE session_id=$1 AND receipt->>'state'='queued' ORDER BY operation_seq LIMIT 1`, id)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		for _, operationID := range ids {
			op, err := loadTerminalOperation(ctx, tx, id, operationID)
			if err != nil {
				return err
			}
			admin, authorizeErr := member(ctx, tx, op.Actor, project, s.now())
			if authorizeErr == nil && !admin && op.Actor.UserID != r.Owner.OwnerUserID {
				authorizeErr = denied()
			}
			if authorizeErr == nil {
				authorizeErr = s.terminalCommandAllowed(ctx, tx, r, t, op.Actor, op.Command)
			}
			raw := s.terminalBody(id, operationID)
			if authorizeErr != nil || len(raw) == 0 {
				if authorizeErr != nil {
					var refusal *model.Fault
					if !errors.As(authorizeErr, &refusal) {
						return authorizeErr
					}
				}
				op.Result = terminalResult(operationID, "rejected", "permission_denied")
				if len(raw) == 0 {
					op.Result = terminalResult(operationID, "rejected", "stale_fence")
				}
			} else {
				offer, err := v2.DecodeMessage(raw)
				if err != nil {
					return err
				}
				if op.Command.Request != nil {
					digest, err := v2.ControlRequestDigest(op.Actor.UserID, *op.Command.Request)
					if err != nil {
						return err
					}
					offer = terminalEnvelope(r, "control_dispatch", v2.ControlDispatch{ActorUserID: op.Actor.UserID, RequestDigest: digest, Request: *op.Command.Request})
				}
				op.Result = terminalResult(operationID, "dispatching", "")
				if _, err = tx.Exec(ctx, `UPDATE session_operations SET dispatch_epoch=$3 WHERE session_id=$1 AND operation_id=$2`, id, operationID, number(epoch)); err != nil {
					return err
				}
				out = append(out, offer)
			}
			if err = writeTerminalResult(ctx, tx, id, op.Result); err != nil {
				return err
			}
			afterCommit(tx, func() { s.forgetTerminalBody(id, operationID) })
		}
		return saveTerminal(ctx, tx, r)
	})
	return out, err
}

// HandleTerminalControl accepts Worker observations on the bound connection.
// Late results remain attached to their original operation and cannot regrant a lease.
func (s *Service) HandleTerminalControl(ctx context.Context, p model.Principal, project, taskID, id, epoch string, m v2.Message) (v2.Message, error) {
	checked, err := terminalCheckedMessage(m)
	if err != nil {
		return v2.Message{}, err
	}
	m = checked
	var out v2.Message
	var cancelFrame func()
	err = s.terminalAccess(ctx, p, project, taskID, id, m.Type == "operation_result" || m.Type == "control_ack", func(tx pgx.Tx, r *terminalRecord, t task, _ bool) error {
		if err := terminalOwner(p, r); err != nil {
			return err
		}
		switch payload := m.Payload.(type) {
		case v2.OperationResult:
			op, err := loadTerminalOperation(ctx, tx, id, payload.OperationID)
			if err != nil {
				return err
			}
			if op.Command.Input == nil {
				return conflict()
			}
			payload, err = s.acceptTerminalResult(ctx, tx, r, op, m.Envelope, epoch, payload)
			if err != nil {
				return err
			}
			out = terminalResultMessage(terminalOperation{Command: op.Command, Result: payload})
			return nil
		case v2.ControlAck:
			op, err := loadTerminalOperation(ctx, tx, id, payload.Result.OperationID)
			if err != nil {
				return err
			}
			if op.Command.Request == nil {
				return conflict()
			}
			digest, err := v2.ControlRequestDigest(op.Actor.UserID, *op.Command.Request)
			if err != nil {
				return err
			}
			if digest != payload.RequestDigest || payload.ControlState.ConnectionEpoch != epoch {
				return conflict()
			}
			payload.Result, err = s.acceptTerminalResult(ctx, tx, r, op, m.Envelope, epoch, payload.Result)
			if err != nil {
				return err
			}
			current := op.Result.State == "dispatching" && terminalFenceMatches(r, m.Envelope) && epoch == r.ConnectionEpoch && r.ServerInstance == s.instance && terminalActive(t, r) && r.Control != nil && r.ControlEpoch == op.Command.Request.ControlEpoch && s.terminalOnline(r)
			if current && payload.Result.State == "transport_completed" {
				admin, authorization := member(ctx, tx, op.Actor, project, s.now())
				if authorization != nil {
					var refusal *model.Fault
					if !errors.As(authorization, &refusal) {
						return authorization
					}
				}
				if authorization == nil && (admin || op.Actor.UserID == r.Owner.OwnerUserID) {
					authorization = s.terminalCommandAllowed(ctx, tx, r, t, op.Actor, op.Command)
				} else if authorization == nil {
					authorization = denied()
				}
				if authorization == nil {
					if !terminalInitialProgress(r.Control.InitialAssignment, payload.ControlState.InitialAssignment, op.Command.Request) {
						return conflict()
					}
					if err = terminalControlTransition(*op.Command.Request, op.Actor.UserID, payload.ControlState, s.now()); err != nil {
						return err
					}
					previous := r.Control.Lease
					state := payload.ControlState
					r.Control = &state
					r.ControlEpoch = state.ControlEpoch
					if state.Lease != nil {
						actor := op.Actor
						r.ControlActor = &actor
					} else {
						r.ControlActor = nil
					}
					if previous == nil || state.Lease == nil || previous.LeaseID != state.Lease.LeaseID {
						r.LastLeaseSeq = "0"
					}
				} else {
					if err = s.suspendTerminal(ctx, tx, r); err != nil {
						return err
					}
				}
			} else if current && payload.Result.State == "unknown" {
				if err = s.suspendTerminal(ctx, tx, r); err != nil {
					return err
				}
			}
			out = terminalResultMessage(terminalOperation{Command: op.Command, Result: payload.Result})
			return saveTerminal(ctx, tx, r)
		}
		if !terminalFenceMatches(r, m.Envelope) || epoch != r.ConnectionEpoch || r.ServerInstance != s.instance || !terminalActive(t, r) {
			return fault("stale_fence", "The terminal connection was superseded.")
		}
		if err := s.refreshTerminalControl(ctx, tx, r, t); err != nil {
			return err
		}
		now := s.now()
		r.LastSeen = &now
		afterCommit(tx, func() { s.touchTerminalSnapshot(r.Envelope, epoch, now) })
		switch payload := m.Payload.(type) {
		case v2.ControlState:
			if payload.ConnectionEpoch != epoch || number(payload.ControlEpoch) < number(r.ControlEpoch) {
				return conflict()
			}
			if r.Control != nil && !terminalInitialProgress(r.Control.InitialAssignment, payload.InitialAssignment, nil) {
				return conflict()
			}
			if r.Control != nil && (r.Control.State == "closed" && payload.State != "closed" || r.Control.State == "closing" && payload.State != "closing" && payload.State != "closed") {
				return conflict()
			}
			if payload.Lease != nil {
				if r.Control == nil || r.Control.Lease == nil || !reflect.DeepEqual(payload.Lease, r.Control.Lease) {
					return fault("permission_denied", "A terminal lease requires a correlated durable control acknowledgement.")
				}
			}
			if payload.State == "automation" && r.Control != nil && r.Control.State != "automation" {
				return fault("automation_suspended", "Resuming automation requires an explicit control acknowledgement.")
			}
			if payload.ControlEpoch == r.ControlEpoch && r.Control == nil && r.ControlEpoch != "0" {
				return conflict()
			}
			if number(payload.ControlEpoch) > number(r.ControlEpoch) {
				if err := invalidateTerminalOperations(ctx, tx, id); err != nil {
					return err
				}
				r.ControlActor = nil
				r.LastLeaseSeq = "0"
			}
			state := payload
			r.Control = &state
			r.ControlEpoch = payload.ControlEpoch
			if payload.Lease == nil {
				r.ControlActor = nil
				r.LastLeaseSeq = "0"
			}
			out = terminalEnvelope(r, "control_state", payload)
		case v2.Snapshot:
			if payload.ConnectionEpoch != epoch || len(r.Runs) == 0 {
				return conflict()
			}
			run := &r.Runs[len(r.Runs)-1]
			if run.StoppedAt != nil || len(run.SegmentIDs) == 0 || run.SegmentIDs[len(run.SegmentIDs)-1] != payload.SegmentID {
				return fault("target_changed", "The terminal collection segment changed.")
			}
			ordinal := 0
			for _, run := range r.Runs {
				ordinal += len(run.SegmentIDs)
			}
			if payload.SegmentOrdinal != decimal(int64(ordinal)) {
				return conflict()
			}
			if err := terminalBinding(r.Binding, payload.Binding); err != nil {
				return err
			}
			frame := &terminalFrameIdentity{ExecutionGeneration: r.Envelope.ExecutionGeneration, SegmentID: payload.SegmentID, FrameSeq: payload.Frame.FrameSeq, SHA256: v2.HashBytes(encode(payload.Frame))}
			if prior := r.LastFrame; prior != nil && prior.ExecutionGeneration == frame.ExecutionGeneration && prior.SegmentID == frame.SegmentID && number(frame.FrameSeq) <= number(prior.FrameSeq) {
				if frame.FrameSeq != prior.FrameSeq || frame.SHA256 != prior.SHA256 {
					return conflict()
				}
			}
			r.LastFrame = frame
			rec := r.Recording[r.Envelope.ExecutionGeneration]
			if rec.Responsibility != nil && rec.Responsibility.RecordingEnabled {
				rec.ObservedContent = true
				r.Recording[r.Envelope.ExecutionGeneration] = rec
			}
			r.Binding.NativeSessionID = payload.Binding.NativeSessionID
			run.Binding.NativeSessionID = payload.Binding.NativeSessionID
			raw, err := json.Marshal(m)
			if err != nil {
				return err
			}
			var publish func()
			publish, cancelFrame, err = s.stageTerminalSnapshot(r, raw)
			if err != nil {
				return err
			}
			afterCommit(tx, publish)
			out = terminalEnvelope(r, "snapshot", payload)
		default:
			return fault("invalid_input", "Unexpected terminal Worker message.")
		}
		return saveTerminal(ctx, tx, r)
	})
	if err != nil && cancelFrame != nil {
		cancelFrame()
	}
	return out, err
}
func (s *Service) acceptTerminalResult(ctx context.Context, tx pgx.Tx, r *terminalRecord, op terminalOperation, f v2.Envelope, epoch string, result v2.OperationResult) (v2.OperationResult, error) {
	c := op.Command
	if f.SessionID != c.SessionID || f.ClaimID != c.ClaimID || f.ExecutionGeneration != c.ExecutionGeneration || op.Epoch == nil || *op.Epoch != number(epoch) {
		return result, conflict()
	}
	if result.State != "transport_completed" && result.State != "rejected" && result.State != "unknown" {
		return result, conflict()
	}
	if reflect.DeepEqual(op.Result, result) {
		return result, nil
	}
	if op.Result.State != "dispatching" {
		return result, conflict()
	}
	if !s.now().Before(op.Deadline) {
		// A late result cannot undo a previously observable timeout. The caller
		// must retain input_unknown until it can inspect the native target.
		result = terminalResult(result.OperationID, "unknown", "input_unknown")
		if err := writeTerminalResult(ctx, tx, r.Envelope.SessionID, result); err != nil {
			return result, err
		}
		return result, nil
	}
	return result, writeTerminalResult(ctx, tx, r.Envelope.SessionID, result)
}

func (s *Service) DisconnectTerminal(ctx context.Context, p model.Principal, project, taskID, id string, f v2.Envelope, epoch string) error {
	if p.Kind == model.PATCredential && id == f.SessionID {
		defer s.forgetTerminalConnection(p.UserID, f, epoch)
	}
	return s.terminalAccess(ctx, p, project, taskID, id, true, func(tx pgx.Tx, r *terminalRecord, _ task, _ bool) error {
		if err := terminalOwner(p, r); err != nil {
			return err
		}
		if !terminalFenceMatches(r, f) || epoch != r.ConnectionEpoch || r.ServerInstance != s.instance {
			return nil
		}
		if err := s.suspendTerminal(ctx, tx, r); err != nil {
			return err
		}
		r.LastSeen = nil
		return saveTerminal(ctx, tx, r)
	})
}

// DisconnectTerminalViewer revokes only the departing browser's lease. It never
// resumes automation or sends terminal keystrokes to discard a user's draft.
func (s *Service) DisconnectTerminalViewer(ctx context.Context, p model.Principal, project, taskID, id, browserClientID, claimID, connectionEpoch string) error {
	return s.terminalAccess(ctx, p, project, taskID, id, false, func(tx pgx.Tx, r *terminalRecord, _ task, _ bool) error {
		// A browser identity may be reused after Worker reconnect. Release only
		// the connection captured when this viewer subscribed; a run advancing on
		// that same connection does not transfer the viewer to a different owner.
		if r.Envelope.SessionID != id || r.Envelope.ClaimID != claimID || r.ConnectionEpoch != connectionEpoch || r.ServerInstance != s.instance {
			return nil
		}
		held := r.Control != nil && r.Control.Lease != nil && r.Control.Lease.HolderUserID == p.UserID && r.Control.Lease.BrowserClientID == browserClientID
		var pending bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_operations WHERE session_id=$1 AND actor_user_id=$2 AND command->'request'->>'browserClientId'=$3 AND receipt->>'state' IN ('queued','dispatching'))`, id, p.UserID, browserClientID).Scan(&pending); err != nil {
			return err
		}
		if !held && !pending {
			return nil
		}
		return s.suspendTerminal(ctx, tx, r)
	})
}
