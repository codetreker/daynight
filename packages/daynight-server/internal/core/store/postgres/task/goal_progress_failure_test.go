package task_test

import (
	"errors"
	"io"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestGoalProgressAndBodiesEmptyInputAvoidsQuery(t *testing.T) {
	reader := task.NewReader(nil)
	progress, err := reader.GoalProgresses(t.Context(), "unused", nil)
	if err != nil || progress == nil || len(progress) != 0 {
		t.Fatalf("empty progress: %#v %v", progress, err)
	}
	bodies, err := reader.TaskBodies(t.Context(), "unused", nil)
	if err != nil || bodies == nil || len(bodies) != 0 {
		t.Fatalf("empty bodies: %#v %v", bodies, err)
	}
}

func TestGoalProgressAndBodiesReadFailures(t *testing.T) {
	f := newFixture(t)
	goal, child := uuid.NewString(), uuid.NewString()
	_, err := f.tx.Exec(t.Context(), `INSERT INTO tasks(id,project_id,type,title,parent_id)
 VALUES($1,$3,'goal','goal',NULL),($2,$3,'task','child',$1)`, goal, child, f.project)
	mustOK(t, err)
	for _, tc := range []struct {
		name       string
		target     int
		scan, fail bool
		progress   bool
	}{
		{"progress query", 1, false, true, true},
		{"progress scan", 1, true, false, true},
		{"progress stream", 1, false, false, true},
		{"bodies query", 1, false, true, false},
		{"bodies scan", 1, true, false, false},
		{"bodies stream", 1, false, false, false},
		{"body properties query", 2, false, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx := &interruptedTx{Tx: f.tx, target: tc.target, scanFailure: tc.scan, rejectQuery: tc.fail}
			reader := task.NewReader(tx)
			var err error
			if tc.progress {
				var value map[string]model.GoalProgress
				value, err = reader.GoalProgresses(t.Context(), f.project, []string{goal})
				if value != nil {
					t.Fatalf("partial progress escaped: %#v", value)
				}
			} else {
				var value []model.Task
				value, err = reader.TaskBodies(t.Context(), f.project, []string{child})
				if value != nil {
					t.Fatalf("partial bodies escaped: %#v", value)
				}
			}
			if !errors.Is(err, io.ErrUnexpectedEOF) {
				t.Fatalf("database failure cause lost: %v", err)
			}
			failed, _ := store.DatabaseErrorFacts(err)
			if !failed {
				t.Fatalf("database failure classification lost: %v", err)
			}
		})
	}
}

func TestGoalProgressAndBodiesClosedTransaction(t *testing.T) {
	f := newFixture(t)
	mustOK(t, f.tx.Rollback(t.Context()))
	reader := task.NewReader(f.tx)
	if value, err := reader.GoalProgresses(t.Context(), f.project, []string{uuid.NewString()}); value != nil || !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed progress transaction: %#v %v", value, err)
	}
	if value, err := reader.TaskBodies(t.Context(), f.project, []string{uuid.NewString()}); value != nil || !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed bodies transaction: %#v %v", value, err)
	}
}
