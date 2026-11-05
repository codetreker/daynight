package store

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestSessionStartupFenceRejectsForeignAndStaleIdentity(t *testing.T) {
	ctx := context.Background()
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	queryTask(t, db, project.ID, 2, model.TaskInProgress)
	worker := model.WorkerClaim{ClaimID: uuid.NewString(), UserID: uuid.NewString(), WorkerID: uuid.NewString(), WorktreeID: uuid.NewString()}
	report := sp.StartupReport{SessionID: uuid.NewString(), ClaimID: worker.ClaimID, ExecutionGeneration: "2", ControllerInstanceID: uuid.NewString()}
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: report.SessionID, ClaimID: worker.ClaimID, ExecutionGeneration: "2"}}, Lifecycle: "active", Identity: sp.Identity{ControllerInstanceID: report.ControllerInstanceID, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID}}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, db, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`, report.SessionID, project.ID, queryID(2), worker.ClaimID, worker.UserID, uuid.NewString(), raw)
	check := func(ctx context.Context, w model.WorkerClaim, r sp.StartupReport) (bool, error) {
		var matched bool
		err := db.WriteProject(context.Background(), project.ID, func(tx *ProjectTx) error {
			var err error
			matched, err = tx.MatchSessionStartup(ctx, queryID(2), &w, r)
			return err
		})
		return matched, err
	}
	if matched, err := check(ctx, worker, report); err != nil || !matched {
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
			if matched, err := check(ctx, w, r); err != nil || matched {
				t.Fatalf("identity mismatch accepted: %t %v", matched, err)
			}
		})
	}
	mustQueryExec(t, db, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{lifecycle}','"archived"') WHERE id=$1`, report.SessionID)
	if matched, err := check(ctx, worker, report); err != nil || matched {
		t.Fatalf("archived session accepted: %t %v", matched, err)
	}
	mustQueryExec(t, db, `UPDATE task_sessions SET snapshot='[]' WHERE id=$1`, report.SessionID)
	if _, err := check(ctx, worker, report); err == nil {
		t.Fatal("corrupt persisted identity accepted")
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := check(canceled, worker, report); err == nil {
		t.Fatal("canceled identity check reported success")
	}
}
