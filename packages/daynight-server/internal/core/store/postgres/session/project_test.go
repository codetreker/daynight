package session_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func testProjectSessionStartupAndDrain(t *testing.T, db *postgres.Store) {
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
	defer rollbackSessionTestTransaction(t, tx)
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

func testSessionStartupIdentityMatchesOnlyCurrentBinding(t *testing.T, db *postgres.Store) {
	ctx := t.Context()
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
	worker := model.WorkerClaim{ClaimID: uuid.NewString(), UserID: uuid.NewString(), WorkerID: uuid.NewString(), WorktreeID: uuid.NewString()}
	report := sp.StartupReport{SchemaVersion: 1, Source: "worker", SessionID: uuid.NewString(), ClaimID: worker.ClaimID, ExecutionGeneration: "2", ControllerInstanceID: uuid.NewString(), Revision: "2", ObservedAt: "2026-11-05T00:00:00Z"}
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: report.SessionID, ClaimID: worker.ClaimID, ExecutionGeneration: "2"}}, Lifecycle: "active", Identity: sp.Identity{ControllerInstanceID: report.ControllerInstanceID, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID}}
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		return dao.InsertTaskSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: report.SessionID, ProjectID: project.ID, TaskID: task.ID}, ClaimID: worker.ClaimID, OwnerID: worker.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: snapshot})
	})
	check := func(w model.WorkerClaim, r sp.StartupReport) (bool, error) {
		tx, err := db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer rollbackSessionTestTransaction(t, tx)
		return pgsession.NewProjectDAO(tx, project.ID).MatchSessionStartup(ctx, task.ID, &w, r)
	}
	if matched, err := check(worker, report); err != nil || !matched {
		t.Fatalf("current identity: %t %v", matched, err)
	}
	for name, mutate := range map[string]func(*model.WorkerClaim, *sp.StartupReport){
		"old generation":   func(_ *model.WorkerClaim, r *sp.StartupReport) { r.ExecutionGeneration = "1" },
		"foreign session":  func(_ *model.WorkerClaim, r *sp.StartupReport) { r.SessionID = uuid.NewString() },
		"old claim":        func(_ *model.WorkerClaim, r *sp.StartupReport) { r.ClaimID = uuid.NewString() },
		"foreign instance": func(_ *model.WorkerClaim, r *sp.StartupReport) { r.ControllerInstanceID = uuid.NewString() },
		"foreign owner":    func(w *model.WorkerClaim, _ *sp.StartupReport) { w.UserID = uuid.NewString() },
		"foreign worker":   func(w *model.WorkerClaim, _ *sp.StartupReport) { w.WorkerID = uuid.NewString() },
		"foreign worktree": func(w *model.WorkerClaim, _ *sp.StartupReport) { w.WorktreeID = uuid.NewString() },
	} {
		t.Run(name, func(t *testing.T) {
			w, r := worker, report
			mutate(&w, &r)
			if matched, err := check(w, r); err != nil || matched {
				t.Fatalf("identity mismatch accepted: %t %v", matched, err)
			}
		})
	}
	mustQueryExec(t, db, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{lifecycle}','"archived"') WHERE id=$1`, report.SessionID)
	if matched, err := check(worker, report); err != nil || matched {
		t.Fatalf("archived session accepted: %t %v", matched, err)
	}
	mustQueryExec(t, db, `UPDATE task_sessions SET snapshot='[]' WHERE id=$1`, report.SessionID)
	if _, err := check(worker, report); err == nil {
		t.Fatal("corrupt persisted identity accepted")
	}
}

func testDrainTaskSessionsPreservesActiveClaim(t *testing.T, db *postgres.Store) {
	ctx := context.Background()
	s := db
	project := queryProject(t, s, 1)
	task := queryTask(t, s, project.ID, 2, model.TaskInProgress)
	activeClaim, staleClaim := uuid.NewString(), uuid.NewString()
	activeSession, staleSession := uuid.NewString(), uuid.NewString()
	for _, item := range []struct{ session, claim string }{{activeSession, activeClaim}, {staleSession, staleClaim}} {
		raw, _ := json.Marshal(map[string]any{"lifecycle": "active", "lastTimelineSeq": "3"})
		mustQueryExec(t, s, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`, item.session, project.ID, task.ID, item.claim, uuid.NewString(), uuid.NewString(), raw)
	}
	var before time.Time
	if err := s.Pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	sessionProjectDAOTransaction(t, s, project.ID, func(dao store.ProjectSessionDAO) error {
		return dao.DrainTaskSessions(ctx, task.ID, store.TaskSessionDrain{
			ActiveClaim: &activeClaim, SourceLifecycle: "active", GraceSeconds: 60, TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle",
			RemoveFields: []string{"controls"}, SnapshotValues: map[string]any{"lifecycle": "draining"},
		})
	})
	var after time.Time
	if err := s.Pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	var active, stale string
	var deadline time.Time
	if err := s.Pool.QueryRow(ctx, `SELECT snapshot->>'lifecycle' FROM task_sessions WHERE id=$1`, activeSession).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if err := s.Pool.QueryRow(ctx, `SELECT snapshot->>'lifecycle', draining_until FROM task_sessions WHERE id=$1`, staleSession).Scan(&stale, &deadline); err != nil {
		t.Fatal(err)
	}
	if active != "active" || stale != "draining" || deadline.Before(before.Add(time.Minute)) || deadline.After(after.Add(time.Minute)) {
		t.Fatalf("active=%s stale=%s before=%v deadline=%v after=%v", active, stale, before, deadline, after)
	}
}
