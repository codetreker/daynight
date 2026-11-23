package task_test

import (
	"context"
	"errors"
	"io"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/google/uuid"
)

func TestOrdinaryLifecycleQueriesPropagateFailures(t *testing.T) {
	for _, operation := range []string{"children", "cascade"} {
		for _, failure := range []string{"cancelled", "stream", "task_properties"} {
			if operation == "children" && failure == "task_properties" {
				continue
			}
			t.Run(operation+"/"+failure, func(t *testing.T) {
				f := newFixture(t)
				root, child := uuid.NewString(), uuid.NewString()
				_, err := f.tx.Exec(t.Context(), `INSERT INTO tasks(id,project_id,type,title,status,parent_id) VALUES($1,$3,'task','root','todo',NULL),($2,$3,'task','child','todo',$1)`, root, child, f.project)
				mustOK(t, err)
				ctx := t.Context()
				var dao store.TaskWriteDAO = task.NewWriter(f.tx, f.project)
				want := error(io.ErrUnexpectedEOF)
				if failure == "cancelled" {
					var cancel context.CancelFunc
					ctx, cancel = context.WithCancel(ctx)
					cancel()
					want = context.Canceled
				} else {
					tx := &interruptedTx{Tx: f.tx, target: 1}
					if failure == "task_properties" {
						tx.target = 2
						tx.rejectQuery = true
					}
					dao = task.NewWriter(tx, f.project)
				}
				if operation == "children" {
					result, err := dao.UnfinishedChildIDs(ctx, root)
					if result != nil || !errors.Is(err, want) {
						t.Fatalf("children=%v error=%v want cause %v", result, err, want)
					}
				} else {
					result, err := dao.(store.TaskCascadeCancelDAO).TaskCascadeCancel(ctx, root)
					if result != nil || !errors.Is(err, want) {
						t.Fatalf("plan=%v error=%v want cause %v", result, err, want)
					}
				}
			})
		}
	}
}

func TestCascadeCancellationPlanRejectsMissingOrHiddenTarget(t *testing.T) {
	f := newFixture(t)
	root := uuid.NewString()
	_, err := f.tx.Exec(t.Context(), `INSERT INTO tasks(id,project_id,type,title,status,ancestor_deleted_at) VALUES($1,$2,'task','hidden','todo',now())`, root, f.project)
	mustOK(t, err)
	planner := task.NewWriter(f.tx, f.project).(store.TaskCascadeCancelDAO)
	for _, id := range []string{root, uuid.NewString()} {
		rows, err := planner.TaskCascadeCancel(t.Context(), id)
		if rows != nil || !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("target %s: plan=%v error=%v", id, rows, err)
		}
	}
}
