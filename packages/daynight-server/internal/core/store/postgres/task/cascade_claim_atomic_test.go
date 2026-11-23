package task_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
)

// The first operation holds the actual Project transaction after applying its
// changes. The second pauses after acquiring that same lock, before its work.
type claimCancelBarrier struct {
	*postgres.Store
	ready   chan error
	release chan struct{}
	before  bool
}

func (b *claimCancelBarrier) WriteProject(ctx context.Context, project string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	return b.Store.WriteProject(ctx, project, func(scope store.ProjectWriteScope) error {
		if b.before {
			b.ready <- nil
			select {
			case <-b.release:
			case <-ctx.Done():
				return ctx.Err()
			}
			return work(scope)
		}
		err := work(scope)
		b.ready <- err
		if err != nil {
			return err
		}
		select {
		case <-b.release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
}

func TestCascadeCancelAndWorkerClaimSerialize(t *testing.T) {
	for _, cancelFirst := range []bool{false, true} {
		name := "claim_first"
		if cancelFirst {
			name = "cancel_first"
		}
		t.Run(name, func(t *testing.T) {
			f := newCascadeFixture(t, true)
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			leaf := f.ids[5]
			testutil.MustExec(t, f.db.Pool, `UPDATE tasks SET assigned_to=$1, allow_agents=true WHERE id=$2`, f.principal.UserID, leaf)
			workerID := uuid.NewString()
			testutil.PutWorkerSnapshot(t, f.db, testutil.WorkerSnapshotFixture(f.principal.UserID, workerID, time.Now().UTC()))
			testutil.MustExec(t, f.db.Pool, `INSERT INTO worker_lifecycle(user_id,worker_id,protocol_version,intent_version,desired,admission,instance_epoch,updated_at) VALUES($1,$2,1,1,'enabled','open',0,now())`, f.principal.UserID, workerID)
			descriptor := taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: workerID, Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString()}
			first := &claimCancelBarrier{Store: f.db, ready: make(chan error, 1), release: make(chan struct{})}
			second := &claimCancelBarrier{Store: f.db, ready: make(chan error, 1), release: make(chan struct{}), before: true}
			runCancel := func(db *claimCancelBarrier) error {
				_, err := taskservice.NewTasks(db, &webhookservice.Capturer{}).SetStatus(ctx, f.principal, f.project, f.ids[0], taskcore.SetTaskStatus{Version: 1, Status: model.TaskCancelled, CancelDescendants: true})
				return err
			}
			runClaim := func(db *claimCancelBarrier) error {
				version := int64(1)
				if cancelFirst {
					version = 2
				}
				_, err := taskservice.NewTasks(db, &webhookservice.Capturer{}).ClaimWorker(ctx, f.principal, f.project, leaf, taskcore.ClaimWorker{Version: version, WorkerDescriptor: descriptor})
				return err
			}
			firstOp, secondOp := runClaim, runCancel
			if cancelFirst {
				firstOp, secondOp = runCancel, runClaim
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
			afterFirst := f.snapshot(t)
			close(second.release)
			select {
			case err := <-secondDone:
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "invalid_transition" {
					t.Fatalf("second operation error: %v", err)
				}
				if !cancelFirst && !reflect.DeepEqual(fault.TaskIDs, []string{leaf}) {
					t.Fatalf("blocking claim identity: %+v", fault)
				}
			case <-ctx.Done():
				t.Fatal("second operation did not finish")
			}
			if after := f.snapshot(t); after != afterFirst {
				t.Fatalf("rejected operation changed persistent state: before=%s after=%s", afterFirst, after)
			}
			root := testutil.SnapshotTask(t, f.db, f.project, f.ids[0])
			got := testutil.SnapshotTask(t, f.db, f.project, leaf)
			claim, err := taskproperty.Worker(got.Properties)
			mustOK(t, err)
			if cancelFirst {
				if root.Status != model.TaskCancelled || root.Version != 2 || got.Status != model.TaskCancelled || got.Version != 2 || claim != nil {
					t.Fatalf("cancel result root=%+v leaf=%+v claim=%+v", root, got, claim)
				}
			} else if root.Status != model.TaskInProgress || root.Version != 1 || got.Status != model.TaskInProgress || got.Version != 2 || claim == nil || claim.ClaimID != descriptor.ClaimID || claim.State != model.WorkerActive {
				t.Fatalf("claim result root=%+v leaf=%+v claim=%+v", root, got, claim)
			}
		})
	}
}
