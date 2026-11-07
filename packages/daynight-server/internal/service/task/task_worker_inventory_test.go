package task_test

import (
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestTaskWorkerInventoryFiltersBeforeLimitAndBindsWorkerAndUser(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	owner, other := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	workerID := uuid.NewString()
	add := func(principal model.Principal, id string) model.Task {
		descriptor := workerDescriptor()
		descriptor.WorkerID = id
		return claimWorkerTask(t, tasks, principal, claimableTask(t, tasks, principal, project.ID), descriptor)
	}

	createTask(t, tasks, admin, project.ID, "Unclaimed first")
	add(owner, uuid.NewString())
	add(other, workerID)
	released := add(owner, workerID)
	var err error
	released, err = tasks.ReleaseWorker(ctx, owner, project.ID, released.ID, taskcore.ReleaseWorker{Version: released.Version, ClaimID: testWorker(t, released.Properties).ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	completed := add(owner, workerID)
	_, err = tasks.SetStatus(ctx, owner, project.ID, completed.ID, taskcore.SetTaskStatus{Version: completed.Version, Status: model.TaskDone, ClaimID: &testWorker(t, completed.Properties).ClaimID})
	if err != nil {
		t.Fatal(err)
	}

	first := add(owner, workerID)
	add(other, workerID)
	second := add(owner, workerID)
	manual := add(owner, workerID)
	previous := *testWorker(t, manual.Properties)
	manual, err = tasks.ReleaseWorker(ctx, owner, project.ID, manual.ID, taskcore.ReleaseWorker{Version: manual.Version, ClaimID: previous.ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	manual = updateTask(t, tasks, admin, manual, taskcore.UpdateTask{AllowAgents: pointer(false), RequiredPlatform: platformChange(pointer(model.PlatformWindows))})
	descriptor := workerDescriptor()
	descriptor.WorkerID = workerID
	manual, err = tasks.ResumeWorker(ctx, owner, project.ID, manual.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: manual.Version, WorkerDescriptor: descriptor}, PreviousClaimID: previous.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{first.ID, second.ID, manual.ID}
	uppercase := strings.ToUpper(workerID)
	request := taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, WorkerID: &uppercase}
	var got []string
	for {
		page, err := tasks.List(ctx, owner, project.ID, request)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Items) != 1 {
			t.Fatalf("filtered page contains %d tasks", len(page.Items))
		}
		got = append(got, page.Items[0].ID)
		if page.NextCursor == nil {
			break
		}
		for _, changed := range []*string{nil, pointer(uuid.NewString())} {
			invalid := request
			invalid.Cursor, invalid.WorkerID = page.NextCursor, changed
			_, err := tasks.List(ctx, owner, project.ID, invalid)
			requireFault(t, err, "invalid_input")
		}
		invalid := request
		invalid.Cursor = page.NextCursor
		_, err = tasks.List(ctx, other, project.ID, invalid)
		requireFault(t, err, "invalid_input")
		request.Cursor, request.WorkerID = page.NextCursor, &workerID
	}
	if !slices.Equal(got, want) {
		t.Fatalf("worker filtering hid owned tasks or included history: got %v want %v", got, want)
	}

	for _, test := range []struct {
		request taskservice.TaskListRequest
		want    []string
	}{
		{taskservice.TaskListRequest{Ready: pointer(false)}, want},
		{taskservice.TaskListRequest{Ready: pointer(true)}, nil},
		{taskservice.TaskListRequest{AllowAgents: pointer(true)}, want[:2]},
		{taskservice.TaskListRequest{AllowAgents: pointer(false)}, want[2:]},
		{taskservice.TaskListRequest{CompatiblePlatform: pointer(model.PlatformLinux)}, want[:2]},
		{taskservice.TaskListRequest{Status: pointer(model.TaskInProgress)}, want},
		{taskservice.TaskListRequest{Status: pointer(model.TaskTodo)}, nil},
	} {
		test.request.PageRequest, test.request.WorkerID = model.PageRequest{Limit: 100}, &workerID
		page, err := tasks.List(ctx, owner, project.ID, test.request)
		if err != nil {
			t.Fatal(err)
		}
		var ids []string
		for _, task := range page.Items {
			ids = append(ids, task.ID)
		}
		if !slices.Equal(ids, test.want) || page.NextCursor != nil {
			t.Fatalf("combined filters: got %v want %v, cursor %v", ids, test.want, page.NextCursor)
		}
	}
}

func TestTaskWorkerInventoryTracksCurrentClaimAcrossOwnershipChanges(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	owner := workerMember(t, database, project.ID)
	descriptor := workerDescriptor()
	task := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), descriptor)
	inventory := func(principal model.Principal, wantClaim string) {
		t.Helper()
		page, err := tasks.List(ctx, principal, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}, WorkerID: &descriptor.WorkerID})
		if err != nil {
			t.Fatal(err)
		}
		if wantClaim == "" {
			if len(page.Items) != 0 || page.NextCursor != nil {
				t.Fatalf("old ownership remains in inventory: %#v", page)
			}
		} else if len(page.Items) != 1 || page.Items[0].ID != task.ID || testWorker(t, page.Items[0].Properties).ClaimID != wantClaim || page.NextCursor != nil {
			t.Fatalf("wrong current claim: %#v", page)
		}
	}
	inventory(owner, descriptor.ClaimID)
	released, err := tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, taskcore.ReleaseWorker{Version: task.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	inventory(owner, "")
	next := descriptor
	next.ClaimID, next.WorktreeID = uuid.NewString(), uuid.NewString()
	task, err = tasks.ResumeWorker(ctx, owner, project.ID, task.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: released.Version, WorkerDescriptor: next}, PreviousClaimID: descriptor.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	inventory(owner, next.ClaimID)
	task, err = tasks.WithdrawWorker(ctx, admin, project.ID, task.ID, taskcore.WithdrawWorker{Version: task.Version, ClaimID: next.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	inventory(owner, "")
	if testWorker(t, task.Properties) != nil || task.AllowAgents {
		t.Fatal("withdrawn claim remained eligible or retained ownership")
	}
	task = updateTask(t, tasks, admin, task, taskcore.UpdateTask{AllowAgents: pointer(true)})
	next.ClaimID, next.WorktreeID = uuid.NewString(), uuid.NewString()
	task = claimWorkerTask(t, tasks, owner, task, next)
	inventory(owner, next.ClaimID)
	task, err = tasks.SetStatus(ctx, owner, project.ID, task.ID, taskcore.SetTaskStatus{Version: task.Version, Status: model.TaskDone, ClaimID: &next.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	inventory(owner, "")
	task = setStatusTask(t, tasks, admin, task, model.TaskTodo)
	fresh := workerDescriptor()
	fresh.WorkerID = descriptor.WorkerID
	task = claimWorkerTask(t, tasks, owner, task, fresh)
	inventory(owner, fresh.ClaimID)
}

func TestTaskWorkerInventoryRejectsInvalidFilterAndPreservesReadFailures(t *testing.T) {
	tasks, database, project, _, owner := taskService(t)
	ctx := context.Background()
	for _, workerID := range []string{"", "invalid", "00000000000000000000000000000000"} {
		_, err := tasks.List(ctx, owner, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, WorkerID: &workerID})
		requireFault(t, err, "invalid_input")
	}
	workerID := uuid.NewString()
	_, err := tasks.List(ctx, servicePrincipal(t, database), project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, WorkerID: &workerID})
	requireFault(t, err, "not_found")
	task := createTask(t, tasks, owner, project.ID, "Invalid stored worker")
	if _, err := database.Pool.Exec(ctx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker','{}')`, task.ID); err != nil {
		t.Fatal(err)
	}
	_, err = tasks.List(ctx, owner, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, WorkerID: &workerID})
	requireFault(t, err, "invalid_input")
	var stored *store.Error
	if !errors.As(err, &stored) || errors.Unwrap(err) == nil {
		t.Fatalf("invalid stored ownership became a successful empty inventory: %v", err)
	}
}

func TestWorkerInventorySkipsOversizedUnrelatedClaim(t *testing.T) {
	tasks, database, project, _, owner := taskService(t)
	workerID := uuid.NewString()
	add := func(id string) model.Task {
		descriptor := workerDescriptor()
		descriptor.WorkerID = id
		return claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), descriptor)
	}
	first := add(workerID)
	unrelated := add(uuid.NewString())
	second := add(workerID)
	var worker map[string]any
	if err := json.Unmarshal(unrelated.Properties["worker"], &worker); err != nil {
		t.Fatal(err)
	}
	worker["machine"].(map[string]any)["name"] = strings.Repeat("w", 5<<20)
	raw, err := json.Marshal(worker)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE task_properties SET value=$2 WHERE task_id=$1 AND name='worker'`, unrelated.ID, string(raw)); err != nil {
		t.Fatal(err)
	}
	request := taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, WorkerID: &workerID}
	page, err := tasks.List(context.Background(), owner, project.ID, request)
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != first.ID || page.NextCursor == nil {
		t.Fatalf("first page: %+v %v", page.NextCursor, err)
	}
	request.Cursor = page.NextCursor
	page, err = tasks.List(context.Background(), owner, project.ID, request)
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != second.ID || page.NextCursor != nil {
		t.Fatalf("second page: %+v %v", page.NextCursor, err)
	}
}
