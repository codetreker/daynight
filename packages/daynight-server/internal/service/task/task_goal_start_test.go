package task_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/google/uuid"
)

func TestChildStartCoordinatesGoalInSameTransaction(t *testing.T) {
	for _, entry := range []struct{ operation, failure string }{
		{"status", ""}, {"claim", ""}, {"status", "parent read"}, {"claim", "parent write"},
	} {
		t.Run(entry.operation+"/"+entry.failure, func(t *testing.T) {
			child, owner, descriptor := workerTestCurrent(t, "")
			child.Type = model.TaskTypeTask
			parentID := uuid.NewString()
			child.ParentID = &parentID
			parent := model.Task{ID: parentID, ProjectID: child.ProjectID, Type: model.TaskTypeGoal, Status: model.TaskTodo, Version: 4, Title: "Goal", Properties: model.TaskProperties{}, DependsOn: []string{}, ExternalDependsOn: []string{}}
			f := workerMockWrite(t, child, owner)
			clock := child.UpdatedAt.Add(time.Second)
			failure := errors.New("parent failure")
			reads, writes := 0, 0
			f.Task.ParentTaskFn = func(ctx context.Context, id string) (model.Task, error) {
				reads++
				if ctx != f.Context || id != parentID {
					t.Fatal("wrong parent lookup")
				}
				if entry.failure == "parent read" {
					return model.Task{}, failure
				}
				return parent, nil
			}
			f.Task.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
				if ctx != f.Context {
					t.Fatal("wrong clock context")
				}
				return clock, nil
			}
			values := taskcore.CurrentWrite(child)
			values.Status = model.TaskInProgress
			if entry.operation == "claim" {
				worker := &model.WorkerClaim{ClaimID: descriptor.ClaimID, UserID: owner.UserID, WorkerID: descriptor.WorkerID, Machine: descriptor.Machine, Platform: descriptor.Platform, Agent: descriptor.Agent, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: descriptor.WorktreeID, State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: clock}
				values.Properties = testWithWorker(t, child.Properties, worker)
			}
			result := child
			result.Status, result.Ready, result.Version, result.UpdatedAt, result.StartedAt, result.Properties = model.TaskInProgress, false, child.Version+1, clock, &clock, values.Properties
			if entry.failure == "" {
				f.ExpectUpdate(values, result)
				f.ExpectCapture([]protocol.Fact{{Type: protocol.StatusChanged, ProjectID: child.ProjectID, TaskID: child.ID, TaskVersion: result.Version, OccurredAt: clock, PreviousStatus: string(child.Status), Status: string(result.Status)}})
			}
			childWrite := f.Task.UpdateTaskFn
			f.Task.UpdateTaskFn = func(ctx context.Context, id string, actual store.TaskWrite) (model.Task, error) {
				writes++
				if ctx != f.Context {
					t.Fatal("wrong write context")
				}
				if id == child.ID && writes == 1 {
					if childWrite != nil {
						return childWrite(ctx, id, actual)
					}
					if !reflect.DeepEqual(actual, values) {
						t.Fatalf("child values: %#v", actual)
					}
					return result, nil
				}
				if id != parentID || writes != 2 || actual.Status != model.TaskInProgress || actual.GoalTiming == nil || !actual.GoalTiming.ObservedAt.Equal(clock) || actual.GoalTiming.StartedAt == nil || !actual.GoalTiming.StartedAt.Equal(clock) || actual.GoalTiming.CompletedAt != nil || actual.GoalTiming.CancelledAt != nil {
					t.Fatalf("parent values: %#v", actual)
				}
				if entry.failure == "parent write" {
					return model.Task{}, failure
				}
				return parent, nil
			}
			var got model.Task
			var err error
			if entry.operation == "status" {
				got, err = f.Tasks.SetStatus(f.Context, owner, child.ProjectID, child.ID, taskcore.SetTaskStatus{Version: child.Version, Status: model.TaskInProgress})
			} else {
				got, err = f.Tasks.ClaimWorker(f.Context, owner, child.ProjectID, child.ID, taskcore.ClaimWorker{Version: child.Version, WorkerDescriptor: descriptor})
			}
			if entry.failure != "" {
				if !errors.Is(err, failure) || !reflect.DeepEqual(got, model.Task{}) {
					t.Fatalf("failure result: %#v %v", got, err)
				}
			} else if err != nil || !reflect.DeepEqual(got, result) {
				t.Fatalf("result: %#v %v", got, err)
			}
			wantReads := 1
			if entry.operation == "claim" {
				wantReads++
			}
			wantWrites := 2
			if entry.failure == "parent read" {
				wantWrites = 1
			}
			if reads != wantReads || writes != wantWrites {
				t.Fatalf("reads=%d writes=%d", reads, writes)
			}
		})
	}
}
