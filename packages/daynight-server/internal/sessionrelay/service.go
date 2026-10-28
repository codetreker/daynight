// Package sessionrelay owns durable session routing. Native effects remain in
// the controller; database commits never claim that a native operation ran.
package sessionrelay

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const PollInterval = 250 * time.Millisecond
const HeartbeatTimeout = 30 * time.Second
const MaxSessionResourceBytes = 64 * 1024 * 1024

type Service struct {
	DB  *store.Store
	now func() time.Time
}

func New(db *store.Store) *Service     { return &Service{DB: db, now: time.Now} }
func fault(code, message string) error { return &service.Fault{Code: code, Message: message} }
func conflict() error {
	return fault("session_conflict", "Session identity or state no longer matches.")
}
func denied() error          { return fault("forbidden", "Session access is not available.") }
func number(s string) int64  { n, _ := strconv.ParseInt(s, 10, 64); return n }
func decimal(n int64) string { return strconv.FormatInt(n, 10) }
func next(s string) string   { return decimal(number(s) + 1) }
func encode(v any) []byte    { b, _ := json.Marshal(v); return b }

type record struct {
	FirstInputBlocked                                   bool
	DrainTimelineSeq                                    *int64
	Snapshot                                            sp.Snapshot
	Owner, Parent                                       string
	ConnectionParent                                    string
	Registration                                        []byte
	StopProof                                           []byte
	SourceEpoch                                         *string
	SourceEpochs                                        []string
	SourceSeq, OperationSeq                             int64
	GrantHash                                           []byte
	GrantExpiry, ConnectionExpiry, LastSeen, DrainUntil *time.Time
	GrantKind                                           string
	Consumed                                            bool
}

func load(ctx context.Context, tx pgx.Tx, id string) (*record, error) {
	r := &record{}
	var raw []byte
	var parent, kind, connectionParent *string
	err := tx.QueryRow(ctx, `SELECT snapshot,owner_user_id::text,parent_credential_id::text,registration,source_epoch::text,source_epochs::text[],last_source_seq,last_operation_seq,grant_hash,grant_expires_at,connection_expires_at,last_seen,draining_until,grant_kind,grant_consumed,stop_proof,connection_parent_credential_id::text,draining_timeline_seq,EXISTS(SELECT 1 FROM session_operations WHERE session_id=task_sessions.id AND command->>'kind'='send_message' AND receipt->>'state' IN ('accepted','offered','dispatching','provider_accepted','confirmed','unknown')) FROM task_sessions WHERE id=$1 FOR UPDATE`, id).Scan(&raw, &r.Owner, &parent, &r.Registration, &r.SourceEpoch, &r.SourceEpochs, &r.SourceSeq, &r.OperationSeq, &r.GrantHash, &r.GrantExpiry, &r.ConnectionExpiry, &r.LastSeen, &r.DrainUntil, &kind, &r.Consumed, &r.StopProof, &connectionParent, &r.DrainTimelineSeq, &r.FirstInputBlocked)
	if err != nil {
		return nil, err
	}
	if connectionParent != nil {
		r.ConnectionParent = *connectionParent
	}
	if parent != nil {
		r.Parent = *parent
	}
	if kind != nil {
		r.GrantKind = *kind
	}
	err = json.Unmarshal(raw, &r.Snapshot)
	return r, err
}
func save(ctx context.Context, tx pgx.Tx, r *record) error {
	r.Snapshot.Operations = sp.Operations{}
	_, err := tx.Exec(ctx, `UPDATE task_sessions SET snapshot=$2,source_epoch=$3,source_epochs=$4,last_source_seq=$5,last_operation_seq=$6 WHERE id=$1`, r.Snapshot.SessionID, encode(r.Snapshot), r.SourceEpoch, r.SourceEpochs, r.SourceSeq, r.OperationSeq)
	return err
}
func transact(ctx context.Context, db *store.Store, fn func(pgx.Tx) error) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if err = fn(tx); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fault("not_found", "Session was not found.")
		}
		return err
	}
	return tx.Commit(ctx)
}
func credential(ctx context.Context, tx pgx.Tx, p core.Principal, now time.Time) error {
	table := "sessions"
	predicate := "expires_at>$3"
	if p.Kind == core.PATCredential {
		table = "personal_access_tokens"
		predicate = "(expires_at IS NULL OR expires_at>$3)"
	} else if p.Kind != core.SessionCredential {
		return denied()
	}
	var id string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM `+table+` WHERE id=$1 AND user_id=$2 AND `+predicate+` FOR SHARE`, p.CredentialID, p.UserID, now).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fault("unauthenticated", "Credential expired or was revoked.")
		}
		return err
	}
	return nil
}
func member(ctx context.Context, tx pgx.Tx, p core.Principal, project string, now time.Time) (bool, error) {
	if err := credential(ctx, tx, p, now); err != nil {
		return false, err
	}
	var role string
	err := tx.QueryRow(ctx, `SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE`, project, p.UserID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, denied()
	}
	return role == "admin", err
}

type task struct {
	Properties core.TaskProperties
	Status     string
}

func lockTask(ctx context.Context, tx pgx.Tx, project, id string) (task, error) {
	var t task
	var raw string
	err := tx.QueryRow(ctx, `SELECT status,properties FROM tasks WHERE project_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`, project, id).Scan(&t.Status, &raw)
	if err == nil {
		t.Properties, err = taskproperties.Decode([]byte(raw))
	}
	return t, err
}
func current(t task, r *record) bool {
	if r.Snapshot.TestExecutionID != "" {
		return true
	}
	w := t.Properties.Worker
	return w != nil && w.ClaimID == r.Snapshot.ClaimID && w.AgentControlMode == core.AgentControlModeWeb
}
func active(t task, r *record) bool {
	return r.Snapshot.Lifecycle == "active" && (r.Snapshot.TestExecutionID != "" || current(t, r) && t.Status == "in_progress" && t.Properties.Worker.State == core.WorkerActive)
}
func (s *Service) browser(ctx context.Context, p core.Principal, project, taskID, id string, fn func(pgx.Tx, *record, task, bool) error) error {
	return transact(ctx, s.DB, func(tx pgx.Tx) error {
		if project == "" && taskID == "" {
			r, err := load(ctx, tx, id)
			if err != nil {
				return err
			}
			if r.Snapshot.TestExecutionID == "" {
				return conflict()
			}
			if _, err = s.scopePermission(ctx, tx, p, r); err != nil {
				return err
			}
			if err = s.archiveExpired(ctx, tx, r); err != nil {
				return err
			}
			return fn(tx, r, task{}, true)
		}
		t, err := lockTask(ctx, tx, project, taskID)
		if err != nil {
			return err
		}
		admin, err := member(ctx, tx, p, project, s.now())
		if err != nil {
			return err
		}
		r, err := load(ctx, tx, id)
		if err != nil {
			return err
		}
		if r.Snapshot.TestExecutionID != "" || r.Snapshot.Identity.ProjectID != project || r.Snapshot.Identity.TaskID != taskID || !current(t, r) {
			return conflict()
		}
		if err := s.archiveExpired(ctx, tx, r); err != nil {
			return err
		}
		return fn(tx, r, t, admin || r.Owner == p.UserID)
	})
}

func (s *Service) archiveExpired(ctx context.Context, tx pgx.Tx, r *record) error {
	if r.Snapshot.Lifecycle != "draining" || r.DrainUntil == nil || s.now().Before(*r.DrainUntil) {
		return nil
	}
	r.Snapshot.Lifecycle = "archived"
	r.Snapshot.ConnectionState = "disconnected"
	r.Snapshot.Synchronized = false
	if err := s.emit(ctx, tx, r, "snapshot", r.Snapshot, nil); err != nil {
		return err
	}
	return save(ctx, tx, r)
}
func controlActivity(activity string) bool {
	return activity == "idle" || activity == "working" || activity == "waiting_input"
}

func permissions(r *record, write bool, now time.Time) sp.Snapshot {
	v := r.Snapshot
	v.Operations = sp.Operations{}
	// Permission projection must not mutate the persisted controller catalog.
	if v.Controls != nil {
		controls := *v.Controls
		controls.Settings = append([]sp.Setting{}, v.Controls.Settings...)
		controls.Commands = append([]sp.NativeCommand{}, v.Controls.Commands...)
		v.Controls = &controls
	}
	if r.DrainUntil != nil && !now.Before(*r.DrainUntil) {
		v.Lifecycle = "archived"
	}
	if r.LastSeen == nil || now.Sub(*r.LastSeen) > HeartbeatTimeout {
		v.ConnectionState = "disconnected"
	}
	if v.Controls != nil && (!write || v.Lifecycle != "active" || v.ConnectionState != "connected" || !v.Synchronized || !controlActivity(v.Activity)) {
		for i := range v.Controls.Settings {
			v.Controls.Settings[i].Mutable = false
		}
		for i := range v.Controls.Commands {
			v.Controls.Commands[i].Available = false
		}
	}
	if !write || v.Lifecycle == "archived" || v.ConnectionState != "connected" || !v.Synchronized {
		return v
	}
	if v.Lifecycle == "draining" {
		v.Operations.CanRespond = v.Capabilities.Respond && len(v.CleanupInteractionIDs) > 0
		return v
	}
	accepted := v.InitialInputState == "provider_accepted" || v.InitialInputState == "confirmed" || v.TestExecutionID != "" && v.InitialInputState == "not_required"
	v.Operations.CanSend = v.Capabilities.Send && accepted && (v.Identity.NativeSessionID != nil || v.TestExecutionID != "" && v.InitialInputState == "not_required" && v.Activity == "idle") && (v.Activity == "idle" || v.Activity == "working" && v.Capabilities.Steer && v.CurrentTurnID != nil)
	if v.TestExecutionID != "" && v.Identity.NativeSessionID == nil && r.FirstInputBlocked {
		v.Operations.CanSend = false
	}
	v.Operations.CanCancel = v.Capabilities.Cancel && v.CurrentTurnID != nil
	v.Operations.CanRespond = v.Capabilities.Respond
	return v
}
func (s *Service) Register(ctx context.Context, p core.Principal, project, taskID string, input sp.Registration) (sp.Snapshot, error) {
	var result sp.Snapshot
	if p.Kind != core.PATCredential {
		return result, denied()
	}
	err := transact(ctx, s.DB, func(tx pgx.Tx) error {
		// Serialize registration on the task row; event streaming only takes a shared task lock.
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
		w := t.Properties.Worker
		if w == nil || t.Status != "in_progress" || w.State != core.WorkerActive || w.AgentControlMode != core.AgentControlModeWeb || w.UserID != p.UserID || w.ClaimID != input.ClaimID || w.WorkerID != input.WorkerID || w.WorktreeID != input.WorktreeID || string(w.Agent) != input.Provider {
			return conflict()
		}
		var existing string
		err = tx.QueryRow(ctx, `SELECT id::text FROM task_sessions WHERE project_id=$1 AND (registration_id=$2 OR (task_id=$3 AND claim_id=$4))`, project, input.RegistrationID, taskID, input.ClaimID).Scan(&existing)
		if err == nil {
			r, err := load(ctx, tx, existing)
			if err != nil {
				return err
			}
			var prior sp.Registration
			if json.Unmarshal(r.Registration, &prior) != nil || prior != input {
				return conflict()
			}
			result = permissions(r, true, s.now())
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		result = sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), ClaimID: input.ClaimID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{ProjectID: project, TaskID: taskID, WorkerID: input.WorkerID, WorktreeID: input.WorktreeID, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, AgentControlMode: "web", Provider: input.Provider}, SessionRevision: "1", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: "not_submitted", Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}
		_, err = tx.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, result.SessionID, project, taskID, input.ClaimID, p.UserID, input.RegistrationID, encode(input), encode(result))
		return err
	})
	return result, err
}

type GrantResult struct {
	TestExecutionID      string    `json:"testExecutionId,omitempty"`
	Token                string    `json:"token"`
	ExpiresAt            time.Time `json:"expiresAt"`
	SessionID            string    `json:"sessionId"`
	ClaimID              string    `json:"claimId,omitempty"`
	ExecutionGeneration  string    `json:"executionGeneration"`
	ControllerID         string    `json:"controllerId"`
	ControllerInstanceID string    `json:"controllerInstanceId"`
}

func (s *Service) Grant(ctx context.Context, p core.Principal, project, taskID, id string, g sp.Grant) (GrantResult, error) {
	var out GrantResult
	if p.Kind != core.PATCredential {
		return out, denied()
	}
	err := s.browser(ctx, p, project, taskID, id, func(tx pgx.Tx, r *record, t task, _ bool) error {
		v := &r.Snapshot
		if !active(t, r) || r.Owner != p.UserID || g.ClaimID != v.ClaimID || g.TestExecutionID != v.TestExecutionID || g.ControllerID != v.Identity.ControllerID {
			return conflict()
		}
		if g.PreviousGeneration != nil && g.ExecutionGeneration == v.ExecutionGeneration {
			if g.StopProof == nil || number(*g.PreviousGeneration)+1 != number(v.ExecutionGeneration) || g.ControllerInstanceID != v.Identity.ControllerInstanceID || !jsonEqual(r.StopProof, encode(g.StopProof)) {
				return conflict()
			}
		} else if g.PreviousGeneration != nil {
			if g.StopProof == nil || *g.PreviousGeneration != v.ExecutionGeneration || number(g.ExecutionGeneration) != number(v.ExecutionGeneration)+1 || g.StopProof.PreviousControllerInstanceID != v.Identity.ControllerInstanceID || g.ControllerInstanceID == v.Identity.ControllerInstanceID {
				return conflict()
			}
			stopped, err := time.Parse(time.RFC3339Nano, g.StopProof.StoppedAt)
			if err != nil || stopped.After(s.now().Add(time.Second)) {
				return conflict()
			}
			v.Controls = nil
			v.TurnStartedAt = nil
			v.ExecutionGeneration = g.ExecutionGeneration
			v.Identity.ControllerInstanceID = g.ControllerInstanceID
			v.ConnectionState = "disconnected"
			v.Synchronized = false
			if _, err = tx.Exec(ctx, `UPDATE task_sessions SET stop_proof=$2,connection_expires_at=NULL WHERE id=$1`, id, encode(g.StopProof)); err != nil {
				return err
			}
			if err = s.emit(ctx, tx, r, "snapshot", *v, nil); err != nil {
				return err
			}
		} else if g.ExecutionGeneration != v.ExecutionGeneration || g.ControllerInstanceID != v.Identity.ControllerInstanceID || g.StopProof != nil {
			return conflict()
		}
		if g.Kind == "bootstrap" && v.ConnectionEpoch != "0" && g.PreviousGeneration == nil {
			return conflict()
		}
		ttl := 15 * time.Minute
		if g.Kind == "bootstrap" {
			ttl = 120 * time.Second
		}
		out = GrantResult{TestExecutionID: v.TestExecutionID, Token: "dncontroller_" + rand.Text(), ExpiresAt: s.now().Add(ttl).UTC(), SessionID: id, ClaimID: v.ClaimID, ExecutionGeneration: v.ExecutionGeneration, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID}
		h := sha256.Sum256([]byte(out.Token))
		_, err := tx.Exec(ctx, `UPDATE task_sessions SET grant_hash=$2,grant_expires_at=$3,grant_kind=$4,grant_consumed=false,parent_credential_id=$5 WHERE id=$1`, id, h[:], out.ExpiresAt, g.Kind, p.CredentialID)
		if err != nil {
			return err
		}
		return save(ctx, tx, r)
	})
	return out, err
}
func (s *Service) Connect(ctx context.Context, token string, h sp.ControllerMessage, instance string) (sp.Snapshot, error) {
	var out sp.Snapshot
	hash := sha256.Sum256([]byte(token))
	err := transact(ctx, s.DB, func(tx pgx.Tx) error {
		var project, taskID, id string
		if err := tx.QueryRow(ctx, `SELECT COALESCE(project_id::text,''),COALESCE(task_id::text,''),id::text FROM task_sessions WHERE grant_hash=$1`, hash[:]).Scan(&project, &taskID, &id); err != nil {
			return err
		}
		t, err := scopeTask(ctx, tx, project, taskID)
		if err != nil {
			return err
		}
		r, err := load(ctx, tx, id)
		if err != nil {
			return err
		}
		if _, err = s.scopePermission(ctx, tx, core.Principal{Kind: core.PATCredential, UserID: r.Owner, CredentialID: r.Parent}, r); err != nil {
			return err
		}
		v := &r.Snapshot
		if !bytes.Equal(hash[:], r.GrantHash) || r.GrantExpiry == nil || !s.now().Before(*r.GrantExpiry) || r.Consumed && r.GrantKind == "bootstrap" || !active(t, r) || h.SessionID != id || h.ClaimID != v.ClaimID || h.TestExecutionID != v.TestExecutionID || h.ExecutionGeneration != v.ExecutionGeneration || h.ControllerID != v.Identity.ControllerID || h.ControllerInstanceID != v.Identity.ControllerInstanceID || h.Provider != v.Identity.Provider || h.SchemaVersion != 1 || h.ProjectionVersion != 1 {
			return conflict()
		}
		if r.SourceEpoch == nil {
			r.SourceEpoch = &h.SourceEpoch
			r.SourceEpochs = append(r.SourceEpochs, h.SourceEpoch)
		} else if *r.SourceEpoch != h.SourceEpoch {
			return conflict()
		}
		if number(h.LastAckedSourceSeq) > r.SourceSeq {
			return conflict()
		}
		v.ConnectionEpoch = next(v.ConnectionEpoch)
		v.ConnectionState = "synchronizing"
		v.Synchronized = false
		now := s.now()
		r.LastSeen = &now
		r.ConnectionExpiry = r.GrantExpiry
		if _, err = tx.Exec(ctx, `UPDATE task_sessions SET grant_consumed=true,server_instance=$2,connected_at=$3,last_seen=$3,connection_expires_at=$4,connection_parent_credential_id=parent_credential_id WHERE id=$1`, id, instance, now, r.GrantExpiry); err != nil {
			return err
		}
		if err = s.emit(ctx, tx, r, "snapshot", *v, nil); err != nil {
			return err
		}
		out = permissions(r, false, now)
		return save(ctx, tx, r)
	})
	return out, err
}
func (s *Service) controller(ctx context.Context, f sp.ControllerFence, fn func(pgx.Tx, *record, task) error) error {
	return transact(ctx, s.DB, func(tx pgx.Tx) error {
		var project, taskID string
		if err := tx.QueryRow(ctx, `SELECT COALESCE(project_id::text,''),COALESCE(task_id::text,'') FROM task_sessions WHERE id=$1`, f.SessionID).Scan(&project, &taskID); err != nil {
			return err
		}
		t, err := scopeTask(ctx, tx, project, taskID)
		if err != nil {
			return err
		}
		r, err := load(ctx, tx, f.SessionID)
		if err != nil {
			return err
		}
		if _, err = s.scopePermission(ctx, tx, core.Principal{Kind: core.PATCredential, UserID: r.Owner, CredentialID: r.ConnectionParent}, r); err != nil {
			return err
		}
		if r.Snapshot.ControllerFence != f || r.ConnectionExpiry == nil || !s.now().Before(*r.ConnectionExpiry) || r.Snapshot.Lifecycle == "archived" || r.DrainUntil != nil && !s.now().Before(*r.DrainUntil) {
			return conflict()
		}
		if !active(t, r) && r.Snapshot.Lifecycle != "draining" {
			return conflict()
		}
		return fn(tx, r, t)
	})
}
func (s *Service) emit(ctx context.Context, tx pgx.Tx, r *record, kind string, payload any, source *sp.SourceEvent) error {
	v := &r.Snapshot
	v.LastEventSeq = next(v.LastEventSeq)
	if kind == "snapshot" {
		v.SessionRevision = next(v.SessionRevision)
		payload = *v
	}
	event := map[string]any{"protocol": sp.Protocol, "sessionId": v.SessionID, "claimId": v.ClaimID, "executionGeneration": v.ExecutionGeneration, "connectionEpoch": v.ConnectionEpoch, "eventSeq": v.LastEventSeq, "historyEpoch": v.HistoryEpoch, "kind": kind, "payload": payload}
	sp.BindingFields(v.Fence, event)
	if operation, ok := payload.(sp.Operation); ok {
		event["executionGeneration"] = operation.ExecutionGeneration
	}
	var epoch, seq, body any
	if source != nil {
		epoch = r.SourceEpoch
		seq = number(source.SourceSeq)
		body = encode(source)
	}
	_, err := tx.Exec(ctx, `INSERT INTO session_events(session_id,event_seq,source_epoch,source_seq,source_body,event) VALUES($1,$2,$3,$4,$5,$6)`, v.SessionID, number(v.LastEventSeq), epoch, seq, body, encode(event))
	return err
}
