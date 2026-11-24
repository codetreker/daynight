package task_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
)

func TestOrdinaryCompletionAndDeletionSerializeWithWorkerClaim(t *testing.T) {
	for _, action := range []string{"complete", "delete"} {
		for _, parentFirst := range []bool{false, true} {
			name := action + "_claim_first"
			if parentFirst {
				name = action + "_parent_first"
			}
			t.Run(name, func(t *testing.T) {
				f := newCascadeFixture(t, true)
				ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
				defer cancel()
				root := f.ids[0]
				testutil.MustExec(t, f.db.Pool, `UPDATE tasks SET status='done',cancelled_at=NULL WHERE project_id=$1 AND id<>$2`, f.project, root)
				testutil.MustExec(t, f.db.Pool, `UPDATE tasks SET status='todo',assigned_to=$1,allow_agents=true WHERE id=$2`, f.principal.UserID, root)
				workerID := uuid.NewString()
				testutil.PutWorkerSnapshot(t, f.db, testutil.WorkerSnapshotFixture(f.principal.UserID, workerID, time.Now().UTC()))
				testutil.MustExec(t, f.db.Pool, `INSERT INTO worker_lifecycle(user_id,worker_id,protocol_version,intent_version,desired,admission,updated_at) VALUES($1,$2,1,1,'enabled','open',now())`, f.principal.UserID, workerID)
				descriptor := taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: workerID, Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString()}
				first := &claimCancelBarrier{Store: f.db, ready: make(chan error, 1), release: make(chan struct{})}
				second := &claimCancelBarrier{Store: f.db, ready: make(chan error, 1), release: make(chan struct{}), before: true}
				claim := func(db *claimCancelBarrier) error {
					version := int64(1)
					if parentFirst && action == "complete" {
						version = 2
					}
					_, err := taskservice.NewTasks(db, &webhookservice.Capturer{}).ClaimWorker(ctx, f.principal, f.project, root, taskcore.ClaimWorker{Version: version, WorkerDescriptor: descriptor})
					return err
				}
				end := func(db *claimCancelBarrier) error {
					version := int64(1)
					if !parentFirst {
						version = 2
					}
					tasks := taskservice.NewTasks(db, &webhookservice.Capturer{})
					if action == "delete" {
						return tasks.Delete(ctx, f.principal, f.project, root, taskcore.DeleteTask{Version: version})
					}
					_, err := tasks.SetStatus(ctx, f.principal, f.project, root, taskcore.SetTaskStatus{Version: version, Status: model.TaskDone})
					return err
				}
				firstOp, secondOp := claim, end
				if parentFirst {
					firstOp, secondOp = end, claim
				}
				firstDone, secondDone := make(chan error, 1), make(chan error, 1)
				go func() { firstDone <- firstOp(first) }()
				select {
				case err := <-first.ready:
					mustOK(t, err)
				case <-ctx.Done():
					t.Fatal("first operation did not reach transaction barrier")
				}
				go func() { secondDone <- secondOp(second) }()
				waitProjectLock(t, ctx, f.db)
				close(first.release)
				select {
				case err := <-firstDone:
					mustOK(t, err)
				case <-ctx.Done():
					t.Fatal("first operation did not commit")
				}
				select {
				case err := <-second.ready:
					mustOK(t, err)
				case <-ctx.Done():
					t.Fatal("second operation did not acquire project lock")
				}
				beforeSecond := f.snapshot(t)
				close(second.release)
				select {
				case err := <-secondDone:
					var fault *model.Fault
					if !errors.As(err, &fault) {
						t.Fatalf("second operation accepted or wrong error: %v", err)
					}
					want := "invalid_transition"
					if !parentFirst && action == "complete" {
						want = "claim_conflict"
					}
					if parentFirst && action == "delete" {
						want = "task_deleted"
					}
					if fault.Code != want {
						t.Fatalf("error code=%s want=%s: %v", fault.Code, want, err)
					}
				case <-ctx.Done():
					t.Fatal("second operation did not finish")
				}
				if after := f.snapshot(t); after != beforeSecond {
					t.Fatalf("rejected operation changed persistent state: before=%s after=%s", beforeSecond, after)
				}
				var status string
				var version int64
				var deleted bool
				mustOK(t, f.db.Pool.QueryRow(ctx, `SELECT status,version,deleted_at IS NOT NULL FROM tasks WHERE id=$1`, root).Scan(&status, &version, &deleted))
				if version != 2 {
					t.Fatalf("unexpected version=%d", version)
				}
				if !parentFirst {
					got := testutil.SnapshotTask(t, f.db, f.project, root)
					worker, err := taskproperty.Worker(got.Properties)
					mustOK(t, err)
					if deleted || got.Status != model.TaskInProgress || worker == nil || worker.ClaimID != descriptor.ClaimID || worker.State != model.WorkerActive {
						t.Fatalf("claim not preserved: task=%+v claim=%+v", got, worker)
					}
				} else if action == "complete" && (deleted || status != "done") || action == "delete" && !deleted {
					t.Fatalf("parent result status=%s deleted=%v", status, deleted)
				}
			})
		}
	}
}
