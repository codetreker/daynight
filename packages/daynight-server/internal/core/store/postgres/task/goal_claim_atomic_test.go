package task_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

// Both operations execute the production core admission against actual Project
// write transactions. The first is held before commit until PostgreSQL reports
// the second waiting on the Project lock.
func TestGoalEndAndClaimSerialize(t *testing.T) {
	for _, endFirst := range []bool{true, false} {
		name := "claim_before_goal_end"
		if endFirst {
			name = "goal_end_before_claim"
		}
		t.Run(name, func(t *testing.T) {
			db := writerStore(t)
			project := writerProject(t, db, 100)
			goalID, childID, userID := testutil.QueryID(101), testutil.QueryID(102), testutil.QueryID(103)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			_, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','goal','todo')`, goalID, project.ID)
			mustOK(t, err)
			_, err = db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title,status,parent_id,assigned_to,allow_agents) VALUES($1,$2,'task','child','todo',$3,$4,true)`, childID, project.ID, goalID, userID)
			mustOK(t, err)
			before := testutil.SnapshotTask(t, db, project.ID, childID)
			if before.Status != model.TaskTodo || before.ParentID == nil || *before.ParentID != goalID {
				t.Fatalf("candidate: %+v", before)
			}
			descriptor := taskcore.WorkerDescriptor{ClaimID: testutil.QueryID(104), WorkerID: testutil.QueryID(105), Machine: model.WorkerMachine{ID: testutil.QueryID(106), Name: "machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: testutil.QueryID(107)}
			var claimed model.Task
			claim := func(scope store.ProjectWriteScope) error {
				dao := scope.TaskDAO()
				current, err := dao.Task(ctx, childID)
				if err != nil {
					return err
				}
				if err = taskcore.RequireVersion(current.Version, before.Version); err != nil {
					return err
				}
				if err = taskcore.ClaimAdmission(current, userID, descriptor); err != nil {
					return err
				}
				if err = taskcore.ClaimParentAdmission(ctx, dao, current); err != nil {
					return err
				}
				now, err := dao.ObservedAt(ctx)
				if err != nil {
					return err
				}
				values, err := taskcore.AcquireWorker(current, userID, descriptor, now)
				if err != nil {
					return err
				}
				claimed, err = dao.UpdateTask(ctx, childID, values)
				return err
			}
			end := func(scope store.ProjectWriteScope) error {
				dao := scope.TaskDAO()
				goal, err := dao.Task(ctx, goalID)
				if err != nil {
					return err
				}
				mutation, err := taskcore.PrepareStatus(ctx, dao, model.Principal{UserID: userID}, goalID, taskcore.SetTaskStatus{Version: goal.Version, Status: model.TaskDone})
				if err != nil {
					return err
				}
				_, err = taskcore.ApplyMutation(ctx, dao, mutation)
				return err
			}
			first, second := claim, end
			if endFirst {
				first, second = end, claim
			}
			firstPrepared := make(chan error, 1)
			release := make(chan struct{})
			firstDone := make(chan error, 1)
			go func() {
				completion, err := db.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
					if err := first(scope); err != nil {
						firstPrepared <- err
						return err
					}
					firstPrepared <- nil
					select {
					case <-release:
						return nil
					case <-ctx.Done():
						return ctx.Err()
					}
				})
				if err == nil && completion.Outcome != store.TransactionCommitted {
					err = fmt.Errorf("first outcome: %s", completion.Outcome)
				}
				firstDone <- err
			}()
			select {
			case err := <-firstPrepared:
				mustOK(t, err)
			case <-ctx.Done():
				t.Fatal("first write did not reach barrier")
			}
			secondDone := make(chan error, 1)
			go func() {
				completion, err := db.WriteProject(ctx, project.ID, second)
				if err == nil && completion.Outcome != store.TransactionCommitted {
					err = fmt.Errorf("second outcome: %s", completion.Outcome)
				}
				secondDone <- err
			}()
			waitProjectLock(t, ctx, db)
			close(release)
			select {
			case err := <-firstDone:
				mustOK(t, err)
			case <-ctx.Done():
				t.Fatal("first write did not commit")
			}
			select {
			case err := <-secondDone:
				if endFirst {
					var fault *model.Fault
					if !errors.As(err, &fault) || fault.Code != "invalid_transition" {
						t.Fatalf("stale candidate accepted or wrong error: %v", err)
					}
				} else {
					mustOK(t, err)
				}
			case <-ctx.Done():
				t.Fatal("second write did not complete")
			}
			after := testutil.SnapshotTask(t, db, project.ID, childID)
			goal := testutil.SnapshotTask(t, db, project.ID, goalID)
			if goal.Status != model.TaskDone {
				t.Fatalf("goal: %+v", goal)
			}
			if after.ParentID == nil || *after.ParentID != goalID {
				t.Fatalf("parent changed: %+v", after)
			}
			worker, err := taskproperty.Worker(after.Properties)
			mustOK(t, err)
			if endFirst {
				if after.Status != before.Status || after.Version != before.Version || worker != nil || !reflect.DeepEqual(after.Properties, before.Properties) {
					t.Fatalf("rejected claim mutated child: before=%+v after=%+v", before, after)
				}
			} else if after.Status != model.TaskInProgress || after.Version != before.Version+1 || worker == nil || worker.State != model.WorkerActive || worker.ClaimID != descriptor.ClaimID || !reflect.DeepEqual(after, claimed) {
				t.Fatalf("goal end changed claimed child: %+v worker=%+v", after, worker)
			}
		})
	}
}

func waitProjectLock(t *testing.T, ctx context.Context, db *postgres.Store) {
	t.Helper()
	for {
		var waiting bool
		err := db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE '%FROM projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE%')`).Scan(&waiting)
		mustOK(t, err)
		if waiting {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("second Project write did not wait for lock")
		case <-time.After(10 * time.Millisecond):
		}
	}
}
