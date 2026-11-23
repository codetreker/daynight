package task_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/jackc/pgx/v5/pgconn"
)

func startChild(ctx context.Context, scope store.ProjectWriteScope, id string, version int64) (model.Task, error) {
	dao := scope.TaskDAO()
	mutation, err := taskcore.PrepareStatus(ctx, dao, model.Principal{}, id, taskcore.SetTaskStatus{Version: version, Status: model.TaskInProgress})
	if err != nil {
		return model.Task{}, err
	}
	if _, err := taskcore.ApplyMutation(ctx, dao, mutation); err != nil {
		return model.Task{}, err
	}
	parent, err := taskcore.PrepareParentStart(ctx, dao, mutation)
	if err != nil {
		return model.Task{}, err
	}
	applied, err := taskcore.ApplyMutation(ctx, dao, parent)
	return applied.Task, err
}

func startFixture(t *testing.T, db *postgres.Store) (model.Project, string, string, string) {
	t.Helper()
	project := writerProject(t, db, 200)
	goalID, firstID, secondID := testutil.QueryID(201), testutil.QueryID(202), testutil.QueryID(203)
	_, err := db.Pool.Exec(t.Context(), `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','goal','todo')`, goalID, project.ID)
	mustOK(t, err)
	_, err = db.Pool.Exec(t.Context(), `INSERT INTO tasks(id,project_id,type,title,status,parent_id) VALUES($1,$3,'task','first','todo',$4),($2,$3,'task','second','todo',$4)`, firstID, secondID, project.ID, goalID)
	mustOK(t, err)
	return project, goalID, firstID, secondID
}

func TestGoalStartSerializesChildrenAndAppearsInSync(t *testing.T) {
	db := writerStore(t)
	project, goalID, firstID, secondID := startFixture(t, db)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	before := testutil.SnapshotTask(t, db, project.ID, goalID)
	var lower time.Time
	mustOK(t, db.Pool.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&lower))

	firstPrepared := make(chan error, 1)
	release := make(chan struct{})
	firstDone := make(chan error, 1)
	var firstGoal model.Task
	go func() {
		completion, err := db.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
			var err error
			firstGoal, err = startChild(ctx, scope, firstID, 1)
			firstPrepared <- err
			if err != nil {
				return err
			}
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		if err == nil && completion.Outcome != store.TransactionCommitted {
			err = fmt.Errorf("first completion: %s", completion.Outcome)
		}
		firstDone <- err
	}()
	select {
	case err := <-firstPrepared:
		mustOK(t, err)
	case <-ctx.Done():
		t.Fatal("first child did not reach transaction barrier")
	}
	secondDone := make(chan error, 1)
	go func() {
		completion, err := db.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
			_, err := startChild(ctx, scope, secondID, 1)
			return err
		})
		if err == nil && completion.Outcome != store.TransactionCommitted {
			err = fmt.Errorf("second completion: %s", completion.Outcome)
		}
		secondDone <- err
	}()
	waitProjectLock(t, ctx, db)
	close(release)
	for _, result := range []<-chan error{firstDone, secondDone} {
		select {
		case err := <-result:
			mustOK(t, err)
		case <-ctx.Done():
			t.Fatal("child transaction did not finish")
		}
	}
	goal := testutil.SnapshotTask(t, db, project.ID, goalID)
	if goal.Status != model.TaskInProgress || goal.Version != before.Version+1 || goal.StartedAt == nil || !goal.StartedAt.Equal(goal.UpdatedAt) || goal.CompletedAt != nil || goal.CancelledAt != nil || goal.UpdatedAt.Before(lower) || !reflect.DeepEqual(goal, firstGoal) {
		t.Fatalf("Goal start changed twice or lost timing: before=%+v first=%+v final=%+v", before, firstGoal, goal)
	}
	for _, id := range []string{firstID, secondID} {
		child := testutil.SnapshotTask(t, db, project.ID, id)
		if child.Status != model.TaskInProgress || child.Version != 2 {
			t.Fatalf("child was not started: %+v", child)
		}
	}
	err := db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		rows, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, &lower, 160)
		if err != nil {
			return err
		}
		for _, row := range rows {
			if row.ID == goalID {
				if row.Type != model.TaskTypeGoal || row.Status != goal.Status || row.Version != goal.Version || !row.UpdatedAt.Equal(goal.UpdatedAt) || !reflect.DeepEqual(row.StartedAt, goal.StartedAt) {
					return fmt.Errorf("sync Goal differs from committed row: %+v", row)
				}
				return nil
			}
		}
		return errors.New("incremental sync omitted started Goal")
	})
	mustOK(t, err)
}

func TestGoalStartTransactionRollsBackBothRows(t *testing.T) {
	for _, failParent := range []bool{true, false} {
		name := "after_both_updates"
		if failParent {
			name = "parent_update"
		}
		t.Run(name, func(t *testing.T) {
			db := writerStore(t)
			project, goalID, childID, _ := startFixture(t, db)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			beforeGoal := testutil.SnapshotTask(t, db, project.ID, goalID)
			beforeChild := testutil.SnapshotTask(t, db, project.ID, childID)
			if failParent {
				_, err := db.Pool.Exec(ctx, `CREATE FUNCTION reject_goal_start() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'goal' AND NEW.status = 'in_progress' THEN RAISE EXCEPTION 'injected goal write failure'; END IF; RETURN NEW; END $$;
					CREATE TRIGGER reject_goal_start BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION reject_goal_start()`)
				mustOK(t, err)
			}
			failure := errors.New("injected failure after both writes")
			completion, err := db.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
				if _, err := startChild(ctx, scope, childID, beforeChild.Version); err != nil {
					return err
				}
				return failure
			})
			var databaseError *pgconn.PgError
			if err == nil || completion.Outcome != store.TransactionNotCommitted ||
				(failParent && (!errors.As(err, &databaseError) || databaseError.Code != "P0001" || databaseError.Message != "injected goal write failure")) ||
				(!failParent && !errors.Is(err, failure)) {
				t.Fatalf("failure did not abort transaction: completion=%+v err=%v", completion, err)
			}
			afterGoal := testutil.SnapshotTask(t, db, project.ID, goalID)
			afterChild := testutil.SnapshotTask(t, db, project.ID, childID)
			if !reflect.DeepEqual(afterGoal, beforeGoal) || !reflect.DeepEqual(afterChild, beforeChild) {
				t.Fatalf("failed transaction persisted changes: goal=%+v child=%+v", afterGoal, afterChild)
			}
		})
	}
}
