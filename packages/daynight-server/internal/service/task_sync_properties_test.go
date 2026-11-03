package service

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
)

func TestTaskSyncPropertiesAndVersionUseOneSnapshot(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	ctx := context.Background()
	target := createTask(t, tasks, principal, project.ID, "Atomic property snapshot")
	before, err := tasks.SetProperty(ctx, principal, project.ID, target.ID, "pullRequests", `[{"url":"before\u0000中文","title":"same"},{"url":"before\u0000中文","title":"same"}]`, target.Version)
	if err != nil {
		t.Fatal(err)
	}
	baseline, err := NewTaskSync(database, 10*time.Second).Get(ctx, principal, project.ID, TaskSyncRequest{})
	if err != nil {
		t.Fatal(err)
	}
	var after core.Task
	writes := 0
	traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool {
		return strings.Contains(sql, "SELECT task_id::text,name,value FROM task_properties")
	}, start: func() {
		writes++
		var writeErr error
		after, writeErr = tasks.SetProperty(ctx, principal, project.ID, target.ID, "pullRequests", `[]`, before.Version)
		if writeErr != nil {
			t.Fatal(writeErr)
		}
	}})
	old, err := NewTaskSync(traced.store, 10*time.Second).Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: baseline.Epoch})
	if err != nil || writes != 1 || len(old.Tasks) != 1 || old.Epoch != baseline.Epoch || old.Tasks[0].Version != before.Version || !taskproperties.Equal(old.Tasks[0].Properties, before.Properties) {
		t.Fatalf("mixed task/property snapshot: %#v %v writes=%d", old, err, writes)
	}
	fresh, err := NewTaskSync(database, 10*time.Second).Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: baseline.Epoch, Since: &before.UpdatedAt})
	if err != nil || fresh.Mode != "delta" || fresh.Epoch != baseline.Epoch || len(fresh.Tasks) != 1 || fresh.Tasks[0].Version != after.Version || !taskproperties.Equal(fresh.Tasks[0].Properties, after.Properties) {
		t.Fatalf("new property state missing: %#v %v", fresh, err)
	}
	removed, err := tasks.RemoveProperty(ctx, principal, project.ID, target.ID, "pullRequests", after.Version)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err = NewTaskSync(database, 10*time.Second).Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: baseline.Epoch, Since: &after.UpdatedAt})
	if err != nil || len(fresh.Tasks) != 1 || fresh.Tasks[0].Version != removed.Version || fresh.Tasks[0].Properties == nil || len(fresh.Tasks[0].Properties) != 0 || fresh.Epoch != baseline.Epoch {
		t.Fatalf("removed property returned a default or rotated epoch: %#v %v", fresh, err)
	}
}

func TestTaskSyncIllegalPropertiesPreserveTransactionCompletionPriority(t *testing.T) {
	for _, completeFailure := range []bool{false, true} {
		name := "validation"
		if completeFailure {
			name = "completion cancellation"
		}
		t.Run(name, func(t *testing.T) {
			tasks, database, project, databaseURL, principal := taskService(t)
			target := createTask(t, tasks, principal, project.ID, "Bad persisted property")
			if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests',$2)`, target.ID, `[{"url":"private-sync-value"}]`); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			source := database
			if completeFailure {
				traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool {
					return strings.Contains(sql, "SELECT task_id::text,name,value FROM task_properties")
				}, end: cancel})
				source = traced.store
			}
			result, err := NewTaskSync(source, 10*time.Second).Get(ctx, principal, project.ID, TaskSyncRequest{})
			if !reflect.DeepEqual(result, core.TaskSync{}) {
				t.Fatalf("failed sync returned partial state: %#v", result)
			}
			if completeFailure {
				assertOperational(t, err)
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("transaction failure was hidden by invalid stored value: %v", err)
				}
			} else {
				fault := requireFault(t, err, "invalid_input")
				var validation *taskproperties.ValidationError
				if !errors.As(fault, &validation) || strings.Contains(fault.Error(), "private-sync-value") {
					t.Fatalf("stored validation lost safe typed cause: %v", fault)
				}
			}
		})
	}
}

func TestTaskSyncWindowOnlyValidatesReturnedProperties(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	old := createTask(t, tasks, principal, project.ID, "Outside delta")
	recent := createTask(t, tasks, principal, project.ID, "Inside delta")
	baseline, err := NewTaskSync(database, 10*time.Second).Get(ctx, principal, project.ID, TaskSyncRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE tasks SET updated_at=$2 WHERE id=$1`, old.ID, recent.UpdatedAt.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'unknown-property',$2)`, old.ID, `[]`); err != nil {
		t.Fatal(err)
	}
	delta, err := NewTaskSync(database, 10*time.Second).Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: baseline.Epoch, Since: &recent.UpdatedAt})
	if err != nil || len(delta.Tasks) != 1 || delta.Tasks[0].ID != recent.ID || delta.Tasks[0].Properties == nil || len(delta.Tasks[0].Properties) != 0 {
		t.Fatalf("window scanned or synthesized unrelated properties: %#v %v", delta, err)
	}
	snapshot, err := NewTaskSync(database, 10*time.Second).Get(ctx, principal, project.ID, TaskSyncRequest{})
	requireFault(t, err, "invalid_input")
	if !reflect.DeepEqual(snapshot, core.TaskSync{}) {
		t.Fatalf("snapshot accepted corrupt sibling or returned partial state: %#v", snapshot)
	}
}
