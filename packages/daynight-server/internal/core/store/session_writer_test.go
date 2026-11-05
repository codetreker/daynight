package store

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestSessionWriterSharesTransactionAndReportsCompletion(t *testing.T) {
	ctx := context.Background()
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	taskID := queryID(2)
	queryTask(t, db, project.ID, 2, model.TaskInProgress)
	id, claim, owner, registration := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}}, Lifecycle: "active"}
	insert := func(scope SessionScope) error {
		if _, err := scope.SessionDAO().LockTask(ctx, project.ID, taskID); err != nil {
			return err
		}
		return scope.SessionDAO().InsertTaskSession(ctx, SessionRegistration{Location: SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: taskID}, ClaimID: claim, OwnerID: owner, RegistrationID: registration, Registration: []byte(`{}`), Snapshot: snapshot})
	}
	abort := errors.New("abort")
	completion, err := db.WriteSession(ctx, func(scope SessionScope) error {
		if err := insert(scope); err != nil {
			return err
		}
		if _, err := scope.SessionDAO().LockSession(ctx, id); err != nil {
			return err
		}
		return abort
	})
	if !errors.Is(err, abort) || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("rollback: completion=%+v err=%v", completion, err)
	}
	completion, err = db.WriteSession(ctx, func(scope SessionScope) error {
		if _, err := scope.SessionDAO().LockSession(ctx, id); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("rolled back Session is visible: %v", err)
		}
		return insert(scope)
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("commit: completion=%+v err=%v", completion, err)
	}
	completion, err = db.WriteSession(ctx, func(scope SessionScope) error {
		r, err := scope.SessionDAO().LockSession(ctx, id)
		if err != nil {
			return err
		}
		if r.Snapshot.SessionID != id || r.Owner != owner {
			t.Fatalf("unexpected Session: %+v", r)
		}
		r.Snapshot.Lifecycle = "archived"
		return scope.SessionDAO().SaveSession(ctx, r)
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("update: completion=%+v err=%v", completion, err)
	}
	_, err = db.WriteSession(ctx, func(scope SessionScope) error {
		r, err := scope.SessionDAO().LockSession(ctx, id)
		if err == nil && r.Snapshot.Lifecycle != "archived" {
			t.Fatalf("saved lifecycle: %q", r.Snapshot.Lifecycle)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}
