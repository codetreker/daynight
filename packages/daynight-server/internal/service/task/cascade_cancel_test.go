package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

type cascadeWriter struct {
	store.TaskWriteDAO
	rows []model.Task
}

func (d *cascadeWriter) TaskCascadeCancel(_ context.Context, id string) ([]model.Task, error) {
	for _, row := range d.rows {
		if row.ID == id {
			return d.rows, nil
		}
	}
	return nil, model.ErrNotFound
}

type cascadeCapture struct {
	facts []protocol.Fact
	err   error
}

func (c *cascadeCapture) CaptureBatch(context.Context, store.WebhookCaptureDAO, wm.Actor, []protocol.Fact) error {
	return errors.New("unexpected single-task capture")
}
func (c *cascadeCapture) CaptureStatusBatch(_ context.Context, _ store.WebhookCaptureDAO, _ wm.Actor, facts []protocol.Fact) error {
	c.facts = facts
	return c.err
}

func TestCascadeCancellationPlansBeforeWritesAndCapturesOnce(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "capture failure"}[fail], func(t *testing.T) {
			f := newTaskRuleFixture(t)
			root := f.target
			root.Type, root.Status = model.TaskTypeTask, model.TaskTodo
			child := root
			child.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
			child.ParentID = &root.ID
			rows := []model.Task{root, child}
			f.scope.TaskDAOFn = func() store.TaskWriteDAO { return &cascadeWriter{TaskWriteDAO: f.writer, rows: rows} }
			f.database.WriteProjectFn = func(ctx context.Context, project string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
				if _, ok := ctx.Deadline(); !ok || project != f.project.ID {
					t.Fatal("missing cancellation deadline or project")
				}
				return store.Completion{Outcome: store.TransactionCommitted}, work(f.scope)
			}
			var written, drained []string
			f.writer.UpdateTaskFn = func(_ context.Context, id string, values store.TaskWrite) (model.Task, error) {
				if values.Status != model.TaskCancelled {
					t.Fatal("wrong proposed status")
				}
				written = append(written, id)
				for _, row := range rows {
					if row.ID == id {
						row.Status = values.Status
						row.Version++
						return row, nil
					}
				}
				t.Fatal("unexpected task")
				return model.Task{}, nil
			}
			f.sessions.DrainTaskSessionsFn = func(_ context.Context, id string, _ store.TaskSessionDrain) error {
				drained = append(drained, id)
				return nil
			}
			f.sessions.TransitionTaskSessionReceiptsFn = func(context.Context, string, store.TaskSessionReceiptTransition) error { return nil }
			capture := &cascadeCapture{}
			cause := errors.New("capture failed")
			if fail {
				capture.err = cause
			}
			f.tasks = taskservice.NewTasks(f.database, capture)
			result, err := f.tasks.SetStatus(context.Background(), f.principal, f.project.ID, root.ID, taskcore.SetTaskStatus{Version: root.Version, Status: model.TaskCancelled, CancelDescendants: true})
			if fail && !errors.Is(err, cause) || !fail && (err != nil || result.Status != model.TaskCancelled) {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			if !reflect.DeepEqual(written, []string{root.ID, child.ID}) || !reflect.DeepEqual(drained, written) || len(capture.facts) != 2 || capture.facts[1].TaskID != child.ID {
				t.Fatalf("written=%v drained=%v facts=%v", written, drained, capture.facts)
			}
		})
	}
}

func TestCascadeCancellationRefusesActiveDescendantBeforeAnyWrite(t *testing.T) {
	f := newTaskRuleFixture(t)
	root := f.target
	root.Type, root.Status = model.TaskTypeTask, model.TaskTodo
	child, _, _ := workerTestCurrent(t, model.WorkerActive)
	child.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	child.ParentID = &root.ID
	f.scope.TaskDAOFn = func() store.TaskWriteDAO {
		return &cascadeWriter{TaskWriteDAO: f.writer, rows: []model.Task{root, child}}
	}
	f.database.WriteProjectFn = func(_ context.Context, _ string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionCommitted}, work(f.scope)
	}
	capture := &cascadeCapture{}
	f.tasks = taskservice.NewTasks(f.database, capture)
	_, err := f.tasks.SetStatus(context.Background(), f.principal, f.project.ID, root.ID, taskcore.SetTaskStatus{Version: root.Version, Status: model.TaskCancelled, CancelDescendants: true})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "invalid_transition" || !reflect.DeepEqual(fault.TaskIDs, []string{child.ID}) || len(capture.facts) != 0 {
		t.Fatalf("fault=%+v err=%v facts=%v", fault, err, capture.facts)
	}
}

func TestCascadeCancellationIdentifiesIncompatibleDescendant(t *testing.T) {
	f := newTaskRuleFixture(t)
	root := f.target
	root.Type, root.Status = model.TaskTypeTask, model.TaskTodo
	child, _, _ := workerTestCurrent(t, model.WorkerActive)
	child.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	child.ParentID = &root.ID
	f.scope.TaskDAOFn = func() store.TaskWriteDAO {
		return &cascadeWriter{TaskWriteDAO: f.writer, rows: []model.Task{root, child}}
	}
	f.database.WriteProjectFn = func(_ context.Context, _ string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionNotCommitted}, work(f.scope)
	}
	ctx := taskcore.WithLegacyWorkerProtocol(context.Background())
	_, err := f.tasks.SetStatus(ctx, f.principal, f.project.ID, root.ID, taskcore.SetTaskStatus{Version: root.Version, Status: model.TaskCancelled, CancelDescendants: true})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "invalid_transition" || !reflect.DeepEqual(fault.TaskIDs, []string{child.ID}) {
		t.Fatalf("fault=%+v err=%v", fault, err)
	}
}

func TestCascadeCancellationLogsRequestCorrelation(t *testing.T) {
	f := newTaskRuleFixture(t)
	root := f.target
	root.Type, root.Status = model.TaskTypeTask, model.TaskTodo
	child, _, _ := workerTestCurrent(t, model.WorkerActive)
	child.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	f.scope.TaskDAOFn = func() store.TaskWriteDAO {
		return &cascadeWriter{TaskWriteDAO: f.writer, rows: []model.Task{root, child}}
	}
	f.database.WriteProjectFn = func(_ context.Context, _ string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionCommitted}, work(f.scope)
	}
	var output bytes.Buffer
	f.tasks.SetLifecycleLogger(slog.New(slog.NewJSONHandler(&output, nil)))
	ctx := requestid.With(t.Context(), "request-cascade")
	_, _ = f.tasks.SetStatus(ctx, f.principal, f.project.ID, root.ID, taskcore.SetTaskStatus{Version: root.Version, Status: model.TaskCancelled, CancelDescendants: true})
	var entry map[string]any
	if err := json.Unmarshal(output.Bytes(), &entry); err != nil {
		t.Fatalf("log: %v %s", err, output.String())
	}
	if entry["request_id"] != "request-cascade" || entry["component"] != "task" || entry["planned_count"] != float64(2) || entry["changed_count"] != float64(0) || entry["outcome"] != "invalid_transition" {
		t.Fatalf("cancellation log: %v", entry)
	}
}

func TestCascadeCancellationPreservesNoOpAndRejectsStaleVersion(t *testing.T) {
	for _, stale := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancelled no-op", true: "stale version"}[stale], func(t *testing.T) {
			f := newTaskRuleFixture(t)
			root := f.target
			root.Type, root.Status = model.TaskTypeTask, model.TaskCancelled
			child := root
			child.ID, child.Status = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", model.TaskTodo
			child.ParentID = &root.ID
			f.scope.TaskDAOFn = func() store.TaskWriteDAO {
				return &cascadeWriter{TaskWriteDAO: f.writer, rows: []model.Task{root, child}}
			}
			f.database.WriteProjectFn = func(_ context.Context, _ string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
				err := work(f.scope)
				if err != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			}
			version := root.Version
			if stale {
				version++
			}
			result, err := f.tasks.SetStatus(t.Context(), f.principal, f.project.ID, root.ID, taskcore.SetTaskStatus{Version: version, Status: model.TaskCancelled, CancelDescendants: true})
			if stale {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "version_conflict" {
					t.Fatalf("stale: %v", err)
				}
			} else if err != nil || !reflect.DeepEqual(root, result) {
				t.Fatalf("no-op result=%+v err=%v", result, err)
			}
		})
	}
}

func TestCascadeCancellationMissingTargetIsNotFound(t *testing.T) {
	f := newTaskRuleFixture(t)
	root := f.target
	root.Type = model.TaskTypeTask
	f.scope.TaskDAOFn = func() store.TaskWriteDAO { return &cascadeWriter{TaskWriteDAO: f.writer} }
	f.database.WriteProjectFn = func(_ context.Context, _ string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionNotCommitted}, work(f.scope)
	}
	_, err := f.tasks.SetStatus(t.Context(), f.principal, f.project.ID, root.ID, taskcore.SetTaskStatus{Version: root.Version, Status: model.TaskCancelled, CancelDescendants: true})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "not_found" {
		t.Fatalf("missing target: %v", err)
	}
}
