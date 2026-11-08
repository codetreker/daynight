package postgres

import (
	"math"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTaskCompletionCommitsAtMaximumRevision(t *testing.T) {
	database := isolatedStore(t)
	ctx := t.Context()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 11, model.TaskTodo)
	values := taskMutationValues(task)
	values.Status = model.TaskInProgress
	if err := writeProjectForTest(database, ctx, project.ID, func(scope store.ProjectWriteScope) error {
		_, err := scope.TaskDAO().UpdateTask(ctx, task.ID, values)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, "UPDATE tasks SET version=$1 WHERE id=$2", int64(math.MaxInt64-1), task.ID)
	before := snapshotTask(t, database, project.ID, task.ID)
	if before.StartedAt == nil || before.CompletedAt != nil || before.Version != math.MaxInt64-1 {
		t.Fatalf("maximum completion fixture lost its current interval: %#v", before)
	}
	values = taskMutationValues(before)
	values.Status = model.TaskDone
	var completed model.Task
	completion, err := database.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
		var err error
		completed, err = scope.TaskDAO().UpdateTask(ctx, task.ID, values)
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted || completed.Version != math.MaxInt64 || completed.Status != model.TaskDone ||
		!reflect.DeepEqual(completed.StartedAt, before.StartedAt) || completed.CompletedAt == nil || !completed.CompletedAt.Equal(completed.UpdatedAt) {
		t.Fatalf("maximum revision completion did not commit its exact interval: %#v %#v %v", completed, completion, err)
	}
	for range 2 {
		if stored := snapshotTask(t, database, project.ID, task.ID); !reflect.DeepEqual(stored, completed) {
			t.Fatalf("maximum revision persisted read changed facts: %#v %#v", completed, stored)
		}
	}
}
