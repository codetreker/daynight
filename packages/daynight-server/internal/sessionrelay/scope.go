package sessionrelay

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

// scopeTask retains task-before-session lock ordering. Test sessions have no task.
func scopeTask(ctx context.Context, tx pgx.Tx, project, id string) (task, error) {
	if project == "" && id == "" {
		return task{}, nil
	}
	return lockTask(ctx, tx, project, id)
}
func (s *Service) scopePermission(ctx context.Context, tx pgx.Tx, p core.Principal, r *record) (bool, error) {
	if r.Snapshot.TestExecutionID == "" {
		return member(ctx, tx, p, r.Snapshot.Identity.ProjectID, s.now())
	}
	if err := credential(ctx, tx, p, s.now()); err != nil {
		return false, err
	}
	if p.UserID != r.Owner {
		return false, denied()
	}
	// The browser's own login does not outlive the controller's revoked parent PAT.
	if r.Parent != "" {
		if err := credential(ctx, tx, core.Principal{Kind: core.PATCredential, UserID: r.Owner, CredentialID: r.Parent}, s.now()); err != nil {
			return false, err
		}
	}
	return true, nil
}
func (s *Service) RegisterTest(ctx context.Context, p core.Principal, input sp.TestRegistration) (sp.Snapshot, error) {
	var out sp.Snapshot
	if p.Kind != core.PATCredential {
		return out, denied()
	}
	err := s.transact(ctx, func(tx pgx.Tx) error {
		if err := credential(ctx, tx, p, s.now()); err != nil {
			return err
		}
		// The owner row serializes registration retries without allocating placeholder tasks.
		if _, err := tx.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, p.UserID); err != nil {
			return err
		}
		var id string
		err := tx.QueryRow(ctx, `SELECT id::text FROM task_sessions WHERE scope='test' AND owner_user_id=$1 AND (registration_id=$2 OR test_execution_id=$3)`, p.UserID, input.RegistrationID, input.TestExecutionID).Scan(&id)
		if err == nil {
			r, e := load(ctx, tx, id)
			if e != nil {
				return e
			}
			if !jsonEqual(r.Registration, encode(input)) {
				return conflict()
			}
			if _, e = s.scopePermission(ctx, tx, p, r); e != nil {
				return e
			}
			out = permissions(r, true, s.now())
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		initial := "not_submitted"
		if input.InitialInput == "none" {
			initial = "not_required"
		}
		out = sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), TestExecutionID: input.TestExecutionID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{OwnerUserID: p.UserID, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, AgentControlMode: "web", Provider: input.Provider}, SessionRevision: "1", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: initial, Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}
		_, err = tx.Exec(ctx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot,parent_credential_id) VALUES($1,'test',$2,$3,$4,$5,$6,$7)`, out.SessionID, input.TestExecutionID, p.UserID, input.RegistrationID, encode(input), encode(durableSnapshot(out)), p.CredentialID)
		return err
	})
	return out, err
}
func (s *Service) TestSnapshot(ctx context.Context, p core.Principal, id string) (sp.Snapshot, error) {
	var out sp.Snapshot
	err := s.browser(ctx, p, "", "", id, func(_ pgx.Tx, r *record, t task, write bool) error {
		out = permissions(r, write && active(t, r), s.now())
		return nil
	})
	return out, err
}
func (s *Service) StopTest(ctx context.Context, p core.Principal, id string, input sp.TestStop) (sp.Snapshot, error) {
	var out sp.Snapshot
	if p.Kind != core.PATCredential {
		return out, denied()
	}
	err := s.browser(ctx, p, "", "", id, func(tx pgx.Tx, r *record, _ task, _ bool) error {
		v := &r.Snapshot
		if input.Fence != v.Fence || input.ControllerID != v.Identity.ControllerID || input.ControllerInstanceID != v.Identity.ControllerInstanceID || input.StopProof.PreviousControllerInstanceID != v.Identity.ControllerInstanceID {
			return conflict()
		}
		stopped, e := time.Parse(time.RFC3339Nano, input.StopProof.StoppedAt)
		if e != nil || stopped.After(s.now().Add(time.Second)) {
			return conflict()
		}
		if v.Lifecycle == "archived" {
			if !jsonEqual(r.StopProof, encode(input.StopProof)) {
				return conflict()
			}
			out = permissions(r, false, s.now())
			return nil
		}
		if input.StopProof.Kind == "never_started" && (r.Consumed || v.ConnectionEpoch != "0" || r.SourceEpoch != nil || v.Identity.NativeSessionID != nil) {
			return conflict()
		}
		v.Lifecycle = "archived"
		v.ConnectionState = "disconnected"
		v.Synchronized = false
		v.Activity = "stopped"
		v.CurrentTurnID = nil
		v.CleanupInteractionIDs = nil
		// Accepted work never ran. Offered or dispatching work lacks a native outcome.
		rows, e := tx.Query(ctx, `SELECT operation_id::text FROM session_operations WHERE session_id=$1 AND receipt->>'state' IN ('accepted','offered','dispatching')`, id)
		if e != nil {
			return e
		}
		var ids []string
		for rows.Next() {
			var op string
			if e = rows.Scan(&op); e != nil {
				rows.Close()
				return e
			}
			ids = append(ids, op)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		for _, op := range ids {
			o, e := loadOperation(ctx, tx, id, op)
			if e != nil {
				return e
			}
			if o.Receipt.State == "accepted" {
				o.Receipt.State = "rejected"
			} else {
				o.Receipt.State = "unknown"
			}
			if e = s.updateReceipt(ctx, tx, r, o.Receipt); e != nil {
				return e
			}
		}
		if _, e = tx.Exec(ctx, `UPDATE task_sessions SET stop_proof=$2,grant_hash=NULL,grant_expires_at=NULL,connection_expires_at=NULL WHERE id=$1`, id, encode(input.StopProof)); e != nil {
			return e
		}
		if e = s.emit(ctx, tx, r, "snapshot", *v, nil); e != nil {
			return e
		}
		if e = save(ctx, tx, r); e != nil {
			return e
		}
		out = permissions(r, false, s.now())
		return nil
	})
	return out, err
}
