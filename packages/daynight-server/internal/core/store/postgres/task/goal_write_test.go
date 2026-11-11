package task_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

func TestGoalWriteTimingParentAndProgress(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	writer := task.NewWriter(f.tx, f.project)
	created := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	goal := mustTask(t, writer, store.TaskWrite{Type: model.TaskTypeGoal, Title: "Goal", Status: model.TaskInProgress, GoalTiming: &store.GoalTiming{ObservedAt: created, StartedAt: &created}})
	if goal.Type != model.TaskTypeGoal || goal.ParentID != nil || !goal.CreatedAt.Equal(created) || !goal.UpdatedAt.Equal(created) || goal.StartedAt == nil || !goal.StartedAt.Equal(created) {
		t.Fatalf("created goal: %+v", goal)
	}
	child := mustTask(t, writer, store.TaskWrite{Type: model.TaskTypeTask, Title: "Child", Status: model.TaskTodo, ParentID: &goal.ID})
	if child.ParentID == nil || *child.ParentID != goal.ID {
		t.Fatalf("child parent: %+v", child)
	}
	progress, err := writer.GoalProgresses(ctx, f.project, []string{goal.ID})
	mustOK(t, err)
	if progress[goal.ID].Total != 1 || progress[goal.ID].Unfinished != 1 {
		t.Fatalf("progress: %+v", progress)
	}
	ended := created.Add(time.Minute)
	goal, err = writer.UpdateTask(ctx, goal.ID, store.TaskWrite{Title: goal.Title, Status: model.TaskCancelled, GoalTiming: &store.GoalTiming{ObservedAt: ended, StartedAt: &created, CancelledAt: &ended}})
	mustOK(t, err)
	if goal.CancelledAt == nil || !goal.CancelledAt.Equal(ended) || !goal.UpdatedAt.Equal(ended) || goal.StartedAt == nil || !goal.StartedAt.Equal(created) {
		t.Fatalf("cancelled goal: %+v", goal)
	}
	reopened := ended.Add(time.Minute)
	goal, err = writer.UpdateTask(ctx, goal.ID, store.TaskWrite{Title: goal.Title, Status: model.TaskTodo, GoalTiming: &store.GoalTiming{ObservedAt: reopened}})
	mustOK(t, err)
	if goal.StartedAt != nil || goal.CompletedAt != nil || goal.CancelledAt != nil || !goal.UpdatedAt.Equal(reopened) {
		t.Fatalf("reopened goal: %+v", goal)
	}
	child, err = writer.UpdateTask(ctx, child.ID, store.TaskWrite{Title: child.Title, Status: child.Status})
	mustOK(t, err)
	if child.ParentID != nil {
		t.Fatalf("parent not cleared: %+v", child)
	}
}

func TestTaskHeaderReportsParentDeletion(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	writer := task.NewWriter(f.tx, f.project)
	goal := mustTask(t, writer, store.TaskWrite{Type: model.TaskTypeGoal, Title: "Goal"})
	child := mustTask(t, writer, store.TaskWrite{Title: "Child", ParentID: &goal.ID})
	if _, err := f.tx.Exec(ctx, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, goal.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Task(ctx, child.ID); !errors.Is(err, model.ErrTaskDeleted) {
		t.Fatalf("locked child remains available: %v", err)
	}
	for _, read := range []func() (model.TaskHeader, error){func() (model.TaskHeader, error) { return writer.TaskHeader(ctx, child.ID) }, func() (model.TaskHeader, error) { return task.NewReader(f.tx).TaskHeader(ctx, f.project, child.ID) }} {
		header, err := read()
		mustOK(t, err)
		if header.Type != model.TaskTypeTask || header.DeletedAt == nil {
			t.Fatalf("header: %+v", header)
		}
	}
}

// A resource transaction can hold the parent's SHARE lock while waiting for the
// child. The Project writer must read the parent without waiting on that lock.
func TestParentReadDoesNotReverseResourceLockOrder(t *testing.T) {
	db := writerStore(t)
	project := writerProject(t, db, 90)
	goalID := testutil.QueryID(91)
	childID := testutil.QueryID(92)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	_, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,type,status) VALUES($1,$2,'goal','goal','todo')`, goalID, project.ID)
	mustOK(t, err)
	_, err = db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,type,status,parent_id) VALUES($1,$2,'child','task','todo',$3)`, childID, project.ID, goalID)
	mustOK(t, err)
	locked := make(chan struct{})
	readParent := make(chan struct{})
	writerDone := make(chan error, 1)
	go func() {
		_, err := db.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
			if _, err := scope.TaskDAO().Task(ctx, childID); err != nil {
				return err
			}
			close(locked)
			select {
			case <-readParent:
			case <-ctx.Done():
				return ctx.Err()
			}
			parent, err := scope.TaskDAO().ParentTask(ctx, goalID)
			if err == nil && parent.ID != goalID {
				return fmt.Errorf("unexpected parent %s", parent.ID)
			}
			return err
		})
		writerDone <- err
	}()
	<-locked
	tx, err := db.Pool.Begin(ctx)
	mustOK(t, err)
	defer tx.Rollback(context.Background())
	var pid int32
	mustOK(t, tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid))
	_, err = tx.Exec(ctx, `SELECT id FROM tasks WHERE id=$1 FOR SHARE`, goalID)
	mustOK(t, err)
	resourceDone := make(chan error, 1)
	go func() {
		_, err := tx.Exec(ctx, `SELECT id FROM tasks WHERE id=$1 FOR SHARE`, childID)
		resourceDone <- err
	}()
	for {
		var waiting bool
		mustOK(t, db.Pool.QueryRow(ctx, `SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE pid=$1`, pid).Scan(&waiting))
		if waiting {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("resource transaction did not wait for child lock")
		case <-time.After(10 * time.Millisecond):
		}
	}
	close(readParent)
	select {
	case err := <-writerDone:
		mustOK(t, err)
	case <-ctx.Done():
		t.Fatal("parent read blocked behind resource transaction")
	}
	select {
	case err := <-resourceDone:
		mustOK(t, err)
	case <-ctx.Done():
		t.Fatal("resource transaction did not finish")
	}
}
