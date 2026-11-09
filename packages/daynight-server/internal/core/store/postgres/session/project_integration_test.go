package session_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestProjectSessionStartupAndDrain(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
	worker := model.WorkerClaim{ClaimID: uuid.NewString(), UserID: uuid.NewString(), WorkerID: uuid.NewString(), WorktreeID: uuid.NewString()}
	report := sp.StartupReport{SessionID: uuid.NewString(), ClaimID: worker.ClaimID, ExecutionGeneration: "2", ControllerInstanceID: uuid.NewString()}
	activeClaim := uuid.NewString()
	oldID := report.SessionID
	register := func(dao store.SessionDAO, id, claim string) error {
		return dao.InsertTaskSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: worker.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "2"}}, Lifecycle: "active", LastTimelineSeq: "9", Identity: sp.Identity{ControllerInstanceID: report.ControllerInstanceID, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID}}})
	}
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := register(dao, oldID, worker.ClaimID); err != nil {
			return err
		}
		return register(dao, uuid.NewString(), activeClaim)
	})
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	dao := pgsession.NewProjectDAO(tx, project.ID)
	matched, err := dao.MatchSessionStartup(ctx, task.ID, &worker, report)
	if err != nil || !matched {
		t.Fatalf("current startup identity: %v %v", matched, err)
	}
	stale := report
	stale.ExecutionGeneration = "1"
	matched, err = dao.MatchSessionStartup(ctx, task.ID, &worker, stale)
	if err != nil || matched {
		t.Fatalf("stale startup identity: %v %v", matched, err)
	}
	missing := report
	missing.SessionID = uuid.NewString()
	matched, err = dao.MatchSessionStartup(ctx, task.ID, &worker, missing)
	if err != nil || matched {
		t.Fatalf("missing startup identity: %v %v", matched, err)
	}
	operation := uuid.NewString()
	if err := pgsession.New(tx).InsertSessionOperation(ctx, store.SessionOperation{SessionID: oldID, OperationID: operation, Seq: 1, Hash: []byte("operation"), Actor: model.Principal{Kind: model.SessionCredential, UserID: worker.UserID, CredentialID: uuid.NewString()}, Command: sp.Command{Kind: "send_message", Payload: json.RawMessage(`{}`)}, Receipt: sp.Operation{State: "accepted"}}); err != nil {
		t.Fatal(err)
	}
	drain := store.TaskSessionDrain{ActiveClaim: &activeClaim, GraceSeconds: 30, TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle", SourceLifecycle: "active", RemoveFields: []string{"operations"}, SnapshotValues: map[string]any{"lifecycle": "draining"}}
	if err := dao.DrainTaskSessions(ctx, task.ID, drain); err != nil {
		t.Fatal(err)
	}
	if err := dao.TransitionTaskSessionReceipts(ctx, task.ID, store.TaskSessionReceiptTransition{LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"providerResult"}}); err != nil {
		t.Fatal(err)
	}
	record, err := pgsession.New(tx).LockSession(ctx, oldID)
	if err != nil || record.Snapshot.Lifecycle != "draining" || record.DrainUntil == nil || record.DrainTimelineSeq == nil || *record.DrainTimelineSeq != 9 {
		t.Fatalf("drain snapshot: %+v %v", record, err)
	}
	receipt, err := pgsession.New(tx).SessionOperation(ctx, oldID, operation)
	if err != nil || receipt.Receipt.State != "rejected" {
		t.Fatalf("drain receipt: %+v %v", receipt, err)
	}
	var retained int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE claim_id=$1 AND snapshot->>'lifecycle'='active' AND draining_until IS NULL`, activeClaim).Scan(&retained); err != nil || retained != 1 {
		t.Fatalf("active claim was drained: %d %v", retained, err)
	}
	if _, err := tx.Exec(ctx, `UPDATE task_sessions SET snapshot='[]' WHERE id=$1`, oldID); err != nil {
		t.Fatal(err)
	}
	if _, err := dao.MatchSessionStartup(ctx, task.ID, &worker, report); err == nil {
		t.Fatal("corrupt startup snapshot accepted")
	}
	drain.SnapshotValues = map[string]any{"unsupported": make(chan int)}
	if err := dao.DrainTaskSessions(ctx, task.ID, drain); err == nil {
		t.Fatal("unencodable drain patch accepted")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	for name, run := range map[string]func() error{
		"startup": func() error { _, err := dao.MatchSessionStartup(ctx, task.ID, &worker, report); return err },
		"drain":   func() error { return dao.DrainTaskSessions(ctx, task.ID, store.TaskSessionDrain{}) },
		"receipt": func() error {
			return dao.TransitionTaskSessionReceipts(ctx, task.ID, store.TaskSessionReceiptTransition{})
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := run(); !errors.Is(err, pgx.ErrTxClosed) {
				t.Fatalf("closed transaction cause: %v", err)
			}
		})
	}
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		record, err := dao.LockSession(ctx, oldID)
		if err != nil || record.Snapshot.Lifecycle != "active" || record.DrainUntil != nil {
			t.Fatalf("rolled back drain persisted: %+v %v", record, err)
		}
		_, err = dao.SessionOperation(ctx, oldID, operation)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("rolled back receipt persisted: %v", err)
		}
		return nil
	})
}
