package task_test

import (
	"math"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestTaskSameStatusAtMaximumRevisionDoesNotWrite(t *testing.T) {
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	current := f.target
	current.Version, current.Status = math.MaxInt64, model.TaskDone
	current.Description = "Maximum revision completed material"
	current.StartedAt, current.CompletedAt = &current.CreatedAt, &current.UpdatedAt
	f.current(ctx, current)
	f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
	_, err := f.tasks.SetStatus(ctx, f.principal, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: math.MaxInt64 - 1, Status: model.TaskDone})
	requireFault(t, err, "version_conflict")
	for range 2 {
		got, err := f.tasks.SetStatus(ctx, f.principal, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: math.MaxInt64, Status: model.TaskDone})
		if err != nil || !reflect.DeepEqual(got, current) {
			t.Fatalf("maximum revision same-status request lost current facts: %#v %#v %v", current, got, err)
		}
	}
}
