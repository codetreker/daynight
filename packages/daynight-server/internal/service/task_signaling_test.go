package service

import (
	"context"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func TestTaskSignalingPreservesClaimAndUsesTaskVersion(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	ctx := context.Background()
	task := claimableTask(t, tasks, principal, project.ID)
	task, err := tasks.ClaimWorker(ctx, principal, project.ID, task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: workerDescriptor()})
	if err != nil {
		t.Fatal(err)
	}
	original := task
	signal := " 需要处理\n\x00 "
	task, err = tasks.Update(ctx, principal, project.ID, task.ID, UpdateTask{Version: task.Version, Properties: core.TaskPropertiesPatch{WorkerSignaling: &signal}})
	if err != nil || task.Properties.Worker.Signaling != signal || task.Version != original.Version+1 || !task.UpdatedAt.After(original.UpdatedAt) {
		t.Fatalf("signaling update failed: %#v %v", task, err)
	}
	preserved := task
	worker := *task.Properties.Worker
	worker.Signaling = original.Properties.Worker.Signaling
	preserved.Properties.Worker = &worker
	preserved.Version, preserved.UpdatedAt = original.Version, original.UpdatedAt
	if !reflect.DeepEqual(preserved, original) {
		t.Fatalf("signaling changed other task facts: %#v", preserved)
	}
	noop, err := tasks.Update(ctx, principal, project.ID, task.ID, UpdateTask{Version: task.Version, Properties: core.TaskPropertiesPatch{WorkerSignaling: &signal}})
	if err != nil || !reflect.DeepEqual(noop, task) {
		t.Fatalf("signaling noop mutated task: %#v %v", noop, err)
	}
	_, err = tasks.Update(ctx, principal, project.ID, task.ID, UpdateTask{Version: original.Version, Properties: core.TaskPropertiesPatch{WorkerSignaling: &signal}})
	requireFault(t, err, "version_conflict")
	phase := core.WorkerExecuting
	task, err = tasks.UpdateWorker(ctx, principal, project.ID, task.ID, UpdateWorker{Version: task.Version, ClaimID: task.Properties.Worker.ClaimID, Phase: &phase})
	if err != nil || task.Properties.Worker.Signaling != signal {
		t.Fatalf("progress report erased signaling: %#v %v", task, err)
	}
	task = updateTask(t, tasks, principal, task, UpdateTask{Description: pointer("Updated material"), Properties: propertyPatch(core.PullRequestProperty{URL: "url", Title: "title"})})
	if task.Properties.Worker.Signaling != signal {
		t.Fatal("ordinary metadata update erased signaling")
	}
	task = updateTask(t, tasks, principal, task, UpdateTask{Properties: core.TaskPropertiesPatch{WorkerSignaling: pointer("")}})
	if task.Properties.Worker.Signaling != "" {
		t.Fatal("empty signaling did not clear attention")
	}
}

func TestTaskSignalingRequiresExistingClaimAndRollsBackMixedWrites(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Unclaimed")
	_, err := tasks.Update(context.Background(), principal, project.ID, task.ID, UpdateTask{Version: task.Version, Title: pointer("Rejected"), Properties: core.TaskPropertiesPatch{WorkerSignaling: pointer("xxx")}})
	requireFault(t, err, "invalid_input")
	assertTaskUnchanged(t, tasks, principal, task)
}
