package task_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestCancellationAndWorkerOperationsUseScopedVersion(t *testing.T) {
	for _, operation := range []string{"claim", "withdraw"} {
		for _, decision := range []string{"cancel", operation} {
			t.Run(operation+"/"+decision, func(t *testing.T) {
				state := model.WorkerActive
				if operation == "claim" {
					state = ""
				}
				before, owner, descriptor := workerTestCurrent(t, state)
				current := before
				current.Version++
				f := workerMockWrite(t, current, owner)
				var err error
				if decision == "cancel" {
					_, err = f.Tasks.SetStatus(f.Context, owner, before.ProjectID, before.ID, taskcore.SetTaskStatus{Version: before.Version, Status: model.TaskCancelled})
				} else if decision == "claim" {
					_, err = f.Tasks.ClaimWorker(f.Context, owner, before.ProjectID, before.ID, taskcore.ClaimWorker{Version: before.Version, WorkerDescriptor: workerDescriptor()})
				} else {
					_, err = workerManagementInvoke(f, before, owner, decision, descriptor)
				}
				requireFault(t, err, "version_conflict")
			})
		}
	}
}

func TestCancellationCoordinatesSessionAndReceiptFreezeInOneScope(t *testing.T) {
	for _, stage := range []string{"session", "receipt", "none"} {
		t.Run(stage, func(t *testing.T) {
			current, principal, _ := workerTestCurrent(t, "")
			current.AllowAgents = false
			after := workerTestResult(current)
			after.Status, after.Ready, after.CancelledAt = model.TaskCancelled, false, pointer(after.UpdatedAt)
			values := workerTestValues(after)
			f := workerMockWrite(t, current, principal)
			failure := errors.New("freeze failed")
			updates, drains, receipts := 0, 0, 0
			if stage == "none" {
				workerExpectUpdate(t, f, values, after)
			} else {
				f.Task.UpdateTaskFn = func(ctx context.Context, id string, actual store.TaskWrite) (model.Task, error) {
					updates++
					if ctx != f.Context || id != current.ID || updates != 1 || !reflect.DeepEqual(actual, values) {
						t.Fatalf("cancellation proposed write: %#v", actual)
					}
					return after, nil
				}
				drain := store.TaskSessionDrain{SourceLifecycle: "active", GraceSeconds: 60, TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle", RemoveFields: []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"}, SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}}
				f.Session.DrainTaskSessionsFn = func(ctx context.Context, id string, actual store.TaskSessionDrain) error {
					drains++
					if ctx != f.Context || id != current.ID || updates != 1 || drains != 1 || !reflect.DeepEqual(actual, drain) {
						t.Fatalf("cancellation drain: %#v", actual)
					}
					if stage == "session" {
						return failure
					}
					return nil
				}
				if stage == "receipt" {
					f.Session.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, actual store.TaskSessionReceiptTransition) error {
						receipts++
						want := store.TaskSessionReceiptTransition{LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"}}
						if ctx != f.Context || id != current.ID || drains != 1 || receipts != 1 || !reflect.DeepEqual(actual, want) {
							t.Fatalf("cancellation receipt: %#v", actual)
						}
						return failure
					}
				}
			}
			got, err := f.Tasks.SetStatus(f.Context, principal, current.ProjectID, current.ID, taskcore.SetTaskStatus{Version: current.Version, Status: model.TaskCancelled})
			if stage == "none" {
				if err != nil || !reflect.DeepEqual(got, after) {
					t.Fatalf("cancellation result: %#v %v", got, err)
				}
			} else {
				wantReceipts := 0
				if stage == "receipt" {
					wantReceipts = 1
				}
				if updates != 1 || drains != 1 || receipts != wantReceipts || !errors.Is(err, failure) || !reflect.DeepEqual(got, model.Task{}) {
					t.Fatalf("freeze failure: updates=%d drains=%d receipts=%d task=%#v error=%v", updates, drains, receipts, got, err)
				}
			}
		})
	}
}
