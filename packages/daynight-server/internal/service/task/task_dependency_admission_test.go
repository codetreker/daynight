package task_test

import (
	"context"
	"fmt"
	"slices"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskDependencyAdmissionPrecedesGraphAndWrites(t *testing.T) {
	ctx := t.Context()
	f := newTaskFailureFixture(t, ctx, store.TransactionCommitted)
	prerequisites := make([]model.Task, 16)
	ids := make([]string, len(prerequisites))
	for i := range prerequisites {
		prerequisites[i] = f.target
		prerequisites[i].ID = fmt.Sprintf("%08x-0000-4000-8000-000000000001", i+1)
		prerequisites[i].Status = model.TaskTodo
		ids[i] = prerequisites[i].ID
	}
	firstFifteen := slices.Clone(ids[:15])
	external := slices.Clone(firstFifteen[:2])
	f.expectPrerequisites(t, prerequisites[:15])
	reached := 0
	f.tasks.ReachableFn = func(actual context.Context, from, to string, replacement store.DependencyReplacement) (bool, error) {
		if actual != ctx || !slices.Contains(firstFifteen, from) || replacement.TaskID != to || !slices.Equal(replacement.DependsOn, firstFifteen) {
			t.Fatal("wrong admitted graph query")
		}
		reached++
		return false, nil
	}
	var created model.Task
	f.tasks.CreateTaskFn = func(actual context.Context, id string, values store.TaskWrite) (model.Task, error) {
		if actual != ctx || values.Title != "Target" || !slices.Equal(values.DependsOn, firstFifteen) || !slices.Equal(values.ExternalDependsOn, external) {
			t.Fatalf("wrong admitted dependency candidate: %#v", values)
		}
		created = f.target
		created.ID = id
		created.Title = values.Title
		created.AssignedTo = values.AssignedTo
		created.DependsOn = slices.Clone(values.DependsOn)
		created.ExternalDependsOn = slices.Clone(values.ExternalDependsOn)
		created.BlockedBy = slices.Clone(firstFifteen)
		created.Ready = false
		return created, nil
	}
	captureDAO := &captureDAOMock{taskMockBase: f.database.taskMockBase.withLabel("capture")}
	f.scope.CaptureDAOFn = func() store.WebhookCaptureDAO { return captureDAO }
	capture := taskDeletionCapture(func(actual context.Context, dao store.WebhookCaptureDAO, facts []protocol.Fact) error {
		if actual != ctx || dao != captureDAO || len(facts) != 1 || facts[0].Type != protocol.Created || facts[0].TaskID != created.ID {
			t.Fatalf("wrong admitted task source: %#v", facts)
		}
		return nil
	})
	tasks := taskservice.NewTasks(f.database, capture)
	target, err := tasks.Create(ctx, f.principal, f.project.ID, taskcore.CreateTask{Title: "Target", DependsOn: firstFifteen, ExternalDependsOn: external})
	if err != nil || target.ID == "" || reached != 15 || !slices.Equal(target.DependsOn, firstFifteen) || len(target.ExternalDependsOn) != 2 || target.Ready {
		t.Fatalf("15-dependency admission: %#v, %v; graph calls=%d", target, err, reached)
	}
	rejected := newTaskFailureFixture(t, ctx, store.TransactionCommitted)
	rejected.expectTask(t, target)
	_, err = taskservice.NewTasks(rejected.database).Update(ctx, rejected.principal, rejected.project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, Title: pointer("Must not persist"), DependsOn: &ids})
	requireFault(t, err, "invalid_input")
	if rejected.callbackError != nil {
		t.Fatal("capacity refusal escaped transaction callback")
	}
	calls := rejected.database.trace.snapshot()
	if slices.Contains(calls, "tasks.TasksByID") || slices.Contains(calls, "tasks.Reachable") || slices.Contains(calls, "tasks.UpdateTask") {
		t.Fatalf("16-dependency rejection reached graph or writes: %v", calls)
	}
}
