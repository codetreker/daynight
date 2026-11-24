package task_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/google/uuid"
)

// The first operation holds the Project lock until PostgreSQL reports the
// competing operation waiting on that lock. Both use production admission.
func TestOrdinaryParentLifecycleSerializesCreationAndReopen(t *testing.T) {
	db := writerStore(t)
	for _, childOperation := range []string{"create", "reopen"} {
		for _, parentOperation := range []string{"complete", "cancel", "delete"} {
			for _, parentFirst := range []bool{false, true} {
				name := fmt.Sprintf("%s_%s_parentFirst_%v", childOperation, parentOperation, parentFirst)
				if !t.Run(name, func(t *testing.T) {
					ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
					var writes sync.WaitGroup
					defer func() {
						cancel()
						writes.Wait()
						if !t.Failed() {
							testutil.AssertPoolReusable(t, db.Pool)
						}
					}()
					projectID := uuid.NewString()
					parentID, childID := uuid.NewString(), uuid.NewString()
					project, err := testutil.CreateProject(ctx, db.Pool, db, projectID, "Project", "https://example.com/owner/"+projectID+".git")
					mustOK(t, err)
					_, err = db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'task','parent','todo')`, parentID, project.ID)
					mustOK(t, err)
					if childOperation == "reopen" {
						_, err = db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title,status,parent_id) VALUES($1,$2,'task','child','done',$3)`, childID, project.ID, parentID)
						mustOK(t, err)
					}
					child := func(scope store.ProjectWriteScope) error {
						dao := scope.TaskDAO()
						var mutation taskcore.Mutation
						var err error
						if childOperation == "create" {
							status := model.TaskTodo
							values, failure := taskcore.CreateCandidate(childID, taskcore.CreateTask{Title: "child", Status: &status, ParentTaskID: &parentID})
							if failure != nil {
								return failure
							}
							mutation, err = taskcore.PrepareCreate(ctx, dao, childID, values)
						} else {
							mutation, err = taskcore.PrepareStatus(ctx, dao, model.Principal{}, childID, taskcore.SetTaskStatus{Version: 1, Status: model.TaskTodo})
						}
						if err != nil {
							return err
						}
						_, err = taskcore.ApplyMutation(ctx, dao, mutation)
						return err
					}
					parent := func(scope store.ProjectWriteScope) error {
						dao := scope.TaskDAO()
						var mutation taskcore.Mutation
						var err error
						if parentOperation == "delete" {
							current, failure := dao.TaskForDeletion(ctx, parentID, false)
							if failure != nil {
								return failure
							}
							mutation, err = taskcore.PrepareDelete(ctx, dao, current, false)
						} else {
							status := model.TaskDone
							if parentOperation == "cancel" {
								status = model.TaskCancelled
							}
							mutation, err = taskcore.PrepareStatus(ctx, dao, model.Principal{}, parentID, taskcore.SetTaskStatus{Version: 1, Status: status})
						}
						if err != nil {
							return err
						}
						_, err = taskcore.ApplyMutation(ctx, dao, mutation)
						return err
					}
					first, second := child, parent
					if parentFirst {
						first, second = parent, child
					}
					firstReady, firstDone, secondDone := make(chan error, 1), make(chan error, 1), make(chan error, 1)
					release := make(chan struct{})
					writes.Go(func() {
						completion, err := db.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
							err := first(scope)
							firstReady <- err
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
							err = fmt.Errorf("first outcome: %s", completion.Outcome)
						}
						firstDone <- err
					})
					select {
					case err := <-firstReady:
						mustOK(t, err)
					case <-ctx.Done():
						t.Fatal("first write did not reach barrier")
					}
					writes.Go(func() {
						_, err := db.WriteProject(ctx, project.ID, second)
						secondDone <- err
					})
					waitProjectLock(t, ctx, db)
					close(release)
					select {
					case err := <-firstDone:
						mustOK(t, err)
					case <-ctx.Done():
						t.Fatal("first write did not finish")
					}
					select {
					case err := <-secondDone:
						var fault *model.Fault
						if !errors.As(err, &fault) {
							t.Fatalf("second operation did not refuse: %v", err)
						}
						want := "task_unfinished_children"
						if parentFirst && parentOperation != "delete" {
							want = "task_parent_terminal"
						}
						if parentFirst && parentOperation == "delete" {
							want = "task_deleted"
							if childOperation == "create" {
								want = "invalid_input"
							}
						}
						if fault.Code != want {
							t.Fatalf("fault=%s, want %s: %v", fault.Code, want, err)
						}
					case <-ctx.Done():
						t.Fatal("second write did not finish")
					}
					var status string
					var deleted bool
					mustOK(t, db.Pool.QueryRow(ctx, `SELECT status, deleted_at IS NOT NULL FROM tasks WHERE id=$1`, parentID).Scan(&status, &deleted))
					if parentFirst && ((parentOperation == "delete") != deleted || (parentOperation == "complete" && status != "done") || (parentOperation == "cancel" && status != "cancelled")) {
						t.Fatalf("parent status=%s deleted=%v", status, deleted)
					}
					if !parentFirst && (deleted || status != "todo") {
						t.Fatalf("refused parent changed: status=%s deleted=%v", status, deleted)
					}
					if !parentFirst {
						row := testutil.SnapshotTask(t, db, project.ID, childID)
						if row.Status != model.TaskTodo || row.ParentID == nil || *row.ParentID != parentID {
							t.Fatalf("committed child: %+v", row)
						}
					}
				}) {
					return
				}
			}
		}
	}
}

func TestOrdinaryParentWorkerCompletionPreservesActiveClaimOnRefusal(t *testing.T) {
	db := writerStore(t)
	project := writerProject(t, db, 320)
	parentID, childID, userID := testutil.QueryID(321), testutil.QueryID(322), testutil.QueryID(323)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	_, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'task','parent','todo')`, parentID, project.ID)
	mustOK(t, err)
	descriptor := taskcore.WorkerDescriptor{ClaimID: testutil.QueryID(324), WorkerID: testutil.QueryID(325), Machine: model.WorkerMachine{ID: testutil.QueryID(326), Name: "machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: testutil.QueryID(327)}
	_, err = db.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
		dao := scope.TaskDAO()
		current, err := dao.Task(ctx, parentID)
		if err != nil {
			return err
		}
		values, err := taskcore.AcquireWorker(current, userID, descriptor, time.Now().UTC())
		if err != nil {
			return err
		}
		_, err = dao.UpdateTask(ctx, parentID, values)
		return err
	})
	mustOK(t, err)
	_, err = db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title,status,parent_id) VALUES($1,$2,'task','child','todo',$3)`, childID, project.ID, parentID)
	mustOK(t, err)
	before := testutil.SnapshotTask(t, db, project.ID, parentID)
	completion, err := db.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
		_, err := taskcore.PrepareStatus(ctx, scope.TaskDAO(), model.Principal{UserID: userID}, parentID, taskcore.SetTaskStatus{Version: before.Version, Status: model.TaskDone, ClaimID: &descriptor.ClaimID})
		return err
	})
	var fault *model.Fault
	if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &fault) || fault.Code != "task_unfinished_children" {
		t.Fatalf("completion=%+v error=%v", completion, err)
	}
	after := testutil.SnapshotTask(t, db, project.ID, parentID)
	worker, err := taskproperty.Worker(after.Properties)
	mustOK(t, err)
	if !reflect.DeepEqual(before, after) || worker == nil || worker.State != model.WorkerActive || worker.ClaimID != descriptor.ClaimID {
		t.Fatalf("refusal changed parent or claim: before=%+v after=%+v worker=%+v", before, after, worker)
	}
}
