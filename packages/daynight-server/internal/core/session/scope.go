package session

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"time"
)

// scopeTask retains task-before-session lock ordering. Test sessions have no task.
func scopeTask(ctx context.Context, tx *operationTx, project, id string) (task, error) {
	if project == "" && id == "" {
		return task{}, nil
	}
	return lockTask(ctx, tx, project, id)
}
func (s *Execution) RegisterTest(ctx context.Context, p model.Principal, input sp.TestRegistration) (sp.Snapshot, error) {
	var out sp.Snapshot
	if p.Kind != model.PATCredential {
		return out, denied()
	}
	err := s.testRegistrationRun(ctx, p, input, func(op *Operation, scope store.SessionScope, existing *Access) error {
		_, tx := op.scoped(scope)
		if existing != nil {
			out = permissions(existing.record, true, s.now())
			return nil
		}
		out = initialTestSnapshot(p, input)
		return tx.dao.InsertTestSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: out.SessionID}, TestExecutionID: input.TestExecutionID, OwnerID: p.UserID, RegistrationID: input.RegistrationID, Registration: encode(input), Snapshot: durableSnapshot(out), ParentCredentialID: p.CredentialID})
	})
	return out, err
}
func (s *Execution) TestSnapshot(ctx context.Context, p model.Principal, id string) (sp.Snapshot, error) {
	var out sp.Snapshot
	err := s.browser(ctx, p, "", "", id, func(_ *operationTx, r *record, t task, write bool) error {
		out = permissions(r, write && active(t, r), s.now())
		return nil
	})
	return out, err
}
func (s *Execution) StopTest(ctx context.Context, p model.Principal, id string, input sp.TestStop) (sp.Snapshot, error) {
	var out sp.Snapshot
	if p.Kind != model.PATCredential {
		return out, denied()
	}
	err := s.browser(ctx, p, "", "", id, func(tx *operationTx, r *record, _ task, _ bool) error {
		if r.BotID != nil {
			return denied()
		}
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
		ids, e := tx.dao.StoppingTestOperations(ctx, id)
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
		if e = tx.dao.SetTestSessionStop(ctx, id, encode(input.StopProof)); e != nil {
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
