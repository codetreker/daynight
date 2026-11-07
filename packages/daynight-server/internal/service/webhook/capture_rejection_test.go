package webhook_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

func assertCaptureBusinessRefusal(t *testing.T, err error, code, scope string) {
	t.Helper()
	if failed, state := store.DatabaseErrorFacts(err); failed {
		t.Fatalf("database failure SQLSTATE %s: %v", state, err)
	}
	var transaction *store.TransactionError
	if errors.As(err, &transaction) && (transaction.Phase != "operation" || transaction.Outcome != store.TransactionNotCommitted || transaction.CommitAttempted || transaction.CleanupFailed) {
		t.Fatalf("unconfirmed transaction or cleanup: %+v", transaction)
	}
	var threadTx *store.ThreadTransactionError
	if errors.As(err, &threadTx) && (threadTx.CommitAttempted || threadTx.OutcomeUnknown || threadTx.RollbackFailed) {
		t.Fatalf("unconfirmed Thread transaction or cleanup: %+v", threadTx)
	}
	var threadMessage *taskservice.ThreadMessageError
	if errors.As(err, &threadMessage) && threadMessage.Outcome != store.TransactionNotCommitted {
		t.Fatalf("unconfirmed Thread outcome: %+v", threadMessage)
	}
	if scope == "step" {
		fault, pure := taskservice.TaskStepsFault(err)
		if !pure || fault == nil || fault.Code != code {
			t.Fatalf("step response expected %s, got %v", code, err)
		}
	} else {
		if scope == "thread" {
			if fault, classified := taskservice.ThreadResponseFault(err); classified {
				t.Fatalf("Thread transaction failure classified as %s", fault.Code)
			}
		}
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != code {
			t.Fatalf("expected %s, got %v", code, err)
		}
	}
}

// captureState observes complete source and notification rows from one snapshot.
func captureState(t *testing.T, f *captureFixture) string {
	t.Helper()
	var snapshot string
	err := f.db.Pool.QueryRow(f.ctx, `SELECT jsonb_build_array(
		(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM tasks t),
		(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.task_id,p.name),'[]'::jsonb) FROM task_properties p),
		(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.task_id,s.id),'[]'::jsonb) FROM task_steps s),
		(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.task_id),'[]'::jsonb) FROM task_threads h),
		(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.task_id,m.message_id),'[]'::jsonb) FROM task_thread_messages m),
		(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb) FROM webhook_events e),
		(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb) FROM webhook_deliveries d),
		(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.delivery_id,m.subscription_id,m.binding_id),'[]'::jsonb) FROM webhook_delivery_matches m)
	)::text`).Scan(&snapshot)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestCaptureRefusalsAndNoopsLeaveSourceAndOutboxUnchanged(t *testing.T) {
	f := newCaptureFixture(t, 1)
	tasks, steps, threads := taskservice.NewTasks(f.db, f.capture), taskservice.NewTaskSteps(f.db, f.capture), taskservice.NewTaskThreads(f.db, f.capture)
	parent, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "no-op"})
	if err != nil {
		t.Fatal(err)
	}
	first, err := steps.Add(f.ctx, f.principal, f.project, parent.ID, taskservice.AddTaskStep{Version: parent.Version, ID: "00000001", Title: "first"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := steps.Add(f.ctx, f.principal, f.project, parent.ID, taskservice.AddTaskStep{Version: first.Resource.Version, ID: "00000002", Title: "second"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = threads.Post(f.ctx, f.principal, f.project, parent.ID, taskservice.CreateThreadMessage{Body: "existing"}); err != nil {
		t.Fatal(err)
	}
	version := second.Resource.Version
	original := captureState(t, f)
	parentTitle, stepTitle, firstID := "no-op", "first", "00000001"
	missing := uuid.NewString()
	cases := []struct {
		name  string
		code  string
		scope string
		call  func() error
	}{
		{"invalid task creation", "invalid_input", "task", func() error {
			_, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: " "})
			return err
		}},
		{"same task title", "", "task", func() error {
			got, err := tasks.Update(f.ctx, f.principal, f.project, parent.ID, taskcore.UpdateTask{Version: version, Title: &parentTitle})
			if err == nil && (got.Version != version || got.Title != parentTitle) {
				return fmt.Errorf("task title no-op returned version %d title %q", got.Version, got.Title)
			}
			return err
		}},
		{"same task status", "", "task", func() error {
			got, err := tasks.SetStatus(f.ctx, f.principal, f.project, parent.ID, taskcore.SetTaskStatus{Version: version, Status: model.TaskTodo})
			if err == nil && (got.Version != version || got.Status != model.TaskTodo) {
				return fmt.Errorf("task status no-op returned version %d status %s", got.Version, got.Status)
			}
			return err
		}},
		{"stale task status", "version_conflict", "task", func() error {
			_, err := tasks.SetStatus(f.ctx, f.principal, f.project, parent.ID, taskcore.SetTaskStatus{Version: version - 1, Status: model.TaskInProgress})
			return err
		}},
		{"stale task deletion", "version_conflict", "task", func() error {
			return tasks.Delete(f.ctx, f.principal, f.project, parent.ID, taskcore.DeleteTask{Version: version - 1})
		}},
		{"duplicate step", "step_id_conflict", "step", func() error {
			_, err := steps.Add(f.ctx, f.principal, f.project, parent.ID, taskservice.AddTaskStep{Version: version, ID: firstID, Title: "duplicate"})
			return err
		}},
		{"same step title", "", "step", func() error {
			got, err := steps.Update(f.ctx, f.principal, f.project, parent.ID, firstID, taskservice.UpdateTaskStep{Version: version, Title: &stepTitle})
			if err == nil && (got.Changed || got.Resource.Version != version) {
				return fmt.Errorf("step no-op changed=%t version=%d", got.Changed, got.Resource.Version)
			}
			return err
		}},
		{"same step status", "", "step", func() error {
			got, err := steps.SetStatus(f.ctx, f.principal, f.project, parent.ID, firstID, taskservice.SetTaskStepStatus{Version: version, Status: model.TaskStepTodo})
			if err == nil && (got.Changed || got.Resource.Version != version) {
				return fmt.Errorf("step no-op changed=%t version=%d", got.Changed, got.Resource.Version)
			}
			return err
		}},
		{"same step placement", "", "step", func() error {
			got, err := steps.Move(f.ctx, f.principal, f.project, parent.ID, "00000002", taskservice.MoveTaskStep{Version: version, After: &firstID})
			if err == nil && (got.Changed || got.Resource.Version != version) {
				return fmt.Errorf("step no-op changed=%t version=%d", got.Changed, got.Resource.Version)
			}
			return err
		}},
		{"missing step deletion", "not_found", "step", func() error {
			_, err := steps.Delete(f.ctx, f.principal, f.project, parent.ID, "00000003", taskservice.DeleteTaskStep{Version: version})
			return err
		}},
		{"empty thread message", "invalid_input", "thread", func() error {
			_, err := threads.Post(f.ctx, f.principal, f.project, parent.ID, taskservice.CreateThreadMessage{})
			return err
		}},
		{"missing thread reply", "message_not_found", "thread", func() error {
			_, err := threads.Post(f.ctx, f.principal, f.project, parent.ID, taskservice.CreateThreadMessage{Body: "reply", ReplyTo: &missing})
			return err
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call()
			if tc.code == "" {
				if err != nil {
					t.Fatalf("no-op failed: %v", err)
				}
			} else {
				assertCaptureBusinessRefusal(t, err, tc.code, tc.scope)
			}
			if got := captureState(t, f); got != original {
				t.Fatal("source or notification rows changed")
			}
		})
	}
}

func TestCaptureWorkerCompletionAndRejectedClaim(t *testing.T) {
	f := newCaptureFixture(t, 1)
	tasks := taskservice.NewTasks(f.db, f.capture)
	current, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "completion", AssignedTo: &f.principal.UserID})
	if err != nil {
		t.Fatal(err)
	}
	allow := true
	current, err = tasks.Update(f.ctx, f.principal, f.project, current.ID, taskcore.UpdateTask{Version: current.Version, AllowAgents: &allow})
	if err != nil {
		t.Fatal(err)
	}
	d := taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, WorktreeID: uuid.NewString()}
	current, err = tasks.ClaimWorker(f.ctx, f.principal, f.project, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: d})
	if err != nil {
		t.Fatal(err)
	}
	before := captureState(t, f)
	wrong := uuid.NewString()
	_, err = tasks.SetStatus(f.ctx, f.principal, f.project, current.ID, taskcore.SetTaskStatus{Version: current.Version, Status: model.TaskDone, ClaimID: &wrong})
	assertCaptureBusinessRefusal(t, err, "claim_conflict", "task")
	if captureState(t, f) != before {
		t.Fatal("rejected completion changed source or outbox")
	}
	current, err = tasks.SetStatus(f.ctx, f.principal, f.project, current.ID, taskcore.SetTaskStatus{Version: current.Version, Status: model.TaskDone, ClaimID: &d.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	var body []byte
	var matches int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.body,(SELECT count(*) FROM webhook_delivery_matches m WHERE m.delivery_id=d.id) FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.task_id=$1 AND e.event_type='task.status_changed' AND e.task_version=$2`, current.ID, current.Version).Scan(&body, &matches); err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Data struct {
			PreviousStatus string `json:"previousStatus"`
			Status         string `json:"status"`
		} `json:"data"`
	}
	if err = json.Unmarshal(body, &wire); err != nil || wire.Data.PreviousStatus != "in_progress" || wire.Data.Status != "done" || matches != 1 {
		t.Fatalf("worker completion event=%s matches=%d err=%v", body, matches, err)
	}
}
