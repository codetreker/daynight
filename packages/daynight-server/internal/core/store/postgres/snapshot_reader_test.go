package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestSnapshotSessionReaderSharesTaskWorkerAndSessionView(t *testing.T) {
	parallelRootDatabaseTest(t)
	database, _, member, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	task := queryTask(t, database, project.ID, 91, model.TaskInProgress)
	mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, member.UserID)
	worker := model.WorkerClaim{
		ClaimID: queryID(101), State: model.WorkerActive, UserID: member.UserID, WorkerID: queryID(102),
		Machine:  model.WorkerMachine{ID: queryID(103), Name: "Snapshot machine"},
		Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb,
		WorktreeID: queryID(104), Phase: model.WorkerExecuting, ClaimedAt: time.Date(2026, 11, 8, 1, 2, 3, 0, time.UTC),
	}
	encodeWorker := func(worker model.WorkerClaim) string {
		value, err := taskproperties.EncodeWorker(&worker)
		if err != nil {
			t.Fatal(err)
		}
		return string(value)
	}
	encodeSession := func(id string, worker model.WorkerClaim) string {
		value, err := json.Marshal(sp.Snapshot{
			ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: worker.ClaimID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"},
			Identity:        sp.Identity{ProjectID: project.ID, TaskID: task.ID, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID, AgentControlMode: "web"}, Lifecycle: "active",
		})
		if err != nil {
			t.Fatal(err)
		}
		return string(value)
	}
	oldID, newID := queryID(105), queryID(106)
	lastSeen := time.Date(2026, 11, 8, 1, 2, 4, 123456000, time.UTC)
	mustQueryExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, task.ID, encodeWorker(worker))
	mustQueryExec(t, database, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,last_seen)
 VALUES($1,$2,$3,$4,$5,$1,'{}',$6::jsonb,$7)`, oldID, project.ID, task.ID, worker.ClaimID, member.UserID, encodeSession(oldID, worker), lastSeen)
	replacement := worker
	replacement.ClaimID, replacement.WorkerID = queryID(107), queryID(108)

	if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		if _, err := scope.ProjectDAO().ProjectAccess(ctx, member, project.ID); err != nil {
			return err
		}
		before, err := scope.SessionDAO().CurrentTaskSessionSources(ctx, project.ID)
		if err != nil {
			return err
		}
		if len(before) != 1 || before[0].Session == nil {
			return fmt.Errorf("initial source: %#v", before)
		}
		write, err := database.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer write.Rollback(context.Background())
		if _, err = write.Exec(ctx, `UPDATE tasks SET title='Replacement execution' WHERE id=$1`, task.ID); err != nil {
			return err
		}
		if _, err = write.Exec(ctx, `UPDATE task_properties SET value=$2 WHERE task_id=$1 AND name='worker'`, task.ID, encodeWorker(replacement)); err != nil {
			return err
		}
		if _, err = write.Exec(ctx, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{lifecycle}','"archived"'),last_seen=$2,draining_until=$3 WHERE id=$1`, oldID, lastSeen.Add(time.Second), lastSeen.Add(30*time.Second)); err != nil {
			return err
		}
		if _, err = write.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,last_seen)
 VALUES($1,$2,$3,$4,$5,$1,'{}',$6::jsonb,$7)`, newID, project.ID, task.ID, replacement.ClaimID, member.UserID, encodeSession(newID, replacement), lastSeen.Add(time.Second)); err != nil {
			return err
		}
		if err = write.Commit(ctx); err != nil {
			return err
		}
		after, err := scope.SessionDAO().CurrentTaskSessionSources(ctx, project.ID)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(after, before) {
			return fmt.Errorf("committed replacement changed Session/Worker view inside snapshot: before=%#v after=%#v", before, after)
		}
		stored, err := scope.TaskDAO().Task(ctx, project.ID, task.ID)
		if err != nil {
			return err
		}
		storedWorker, err := taskproperties.Worker(stored.Properties)
		if err != nil {
			return err
		}
		if stored.Title != task.Title || !reflect.DeepEqual(storedWorker, &worker) {
			return fmt.Errorf("Task/Worker and Session snapshots diverged: task=%#v worker=%#v", stored, storedWorker)
		}
		future := time.Now().UTC().Add(time.Hour)
		delta, err := scope.TaskDAO().TaskSyncTasks(ctx, project.ID, &future, 160)
		if err != nil {
			return err
		}
		if len(delta) != 0 || len(after) != 1 {
			return fmt.Errorf("Session snapshot restricted by empty Task delta: tasks=%d sessions=%d", len(delta), len(after))
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		sources, err := scope.SessionDAO().CurrentTaskSessionSources(ctx, project.ID)
		if err != nil {
			return err
		}
		if len(sources) != 1 || !reflect.DeepEqual(sources[0].Worker, &replacement) || sources[0].Session == nil || sources[0].Session.SessionID != newID ||
			sources[0].Session.LastSeen == nil || !sources[0].Session.LastSeen.Equal(lastSeen.Add(time.Second)) {
			return fmt.Errorf("new snapshot failed to observe replacement: %#v", sources)
		}
		stored, err := scope.TaskDAO().Task(ctx, project.ID, task.ID)
		if err != nil {
			return err
		}
		if stored.Title != "Replacement execution" {
			return fmt.Errorf("new snapshot failed to observe Task change: %q", stored.Title)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestSnapshotReadersShareAuthorizationAndDataView(t *testing.T) {
	parallelRootDatabaseTest(t)
	database, _, member, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	task := queryTask(t, database, project.ID, 91, model.TaskTodo)
	mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, member.UserID)

	err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		if _, err := scope.ProjectDAO().ProjectAccess(ctx, member, project.ID); err != nil {
			return err
		}
		write, err := database.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer write.Rollback(context.Background())
		if _, err = write.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, member.UserID); err != nil {
			return err
		}
		if _, err = write.Exec(ctx, `UPDATE tasks SET title='Changed' WHERE id=$1`, task.ID); err != nil {
			return err
		}
		if err = write.Commit(ctx); err != nil {
			return err
		}
		if _, err = scope.ProjectDAO().ProjectAccess(ctx, member, project.ID); err != nil {
			return fmt.Errorf("authorization changed within snapshot: %w", err)
		}
		stored, err := scope.TaskDAO().Task(ctx, project.ID, task.ID)
		if err != nil {
			return err
		}
		if stored.Title != task.Title {
			return fmt.Errorf("task changed within snapshot: got %q, want %q", stored.Title, task.Title)
		}
		observedAt, err := scope.ObservedAt(ctx)
		if err != nil || observedAt.IsZero() || observedAt.Location() != time.UTC {
			return fmt.Errorf("invalid snapshot observation time %v: %w", observedAt, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		if _, err := scope.ProjectDAO().ProjectAccess(ctx, member, project.ID); !errors.Is(err, model.ErrNotFound) {
			return fmt.Errorf("new snapshot did not observe revoked access: %v", err)
		}
		stored, err := scope.TaskDAO().Task(ctx, project.ID, task.ID)
		if err != nil {
			return err
		}
		if stored.Title != "Changed" {
			return fmt.Errorf("new snapshot did not observe changed task: %q", stored.Title)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
