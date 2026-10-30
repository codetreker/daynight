package service

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestTaskWorkerInventoryFiltersBeforeLimitAndBindsWorkerAndUser(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	owner, other := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	workerID := uuid.NewString()
	add := func(principal core.Principal, id string) core.Task {
		descriptor := workerDescriptor()
		descriptor.WorkerID = id
		return claimWorkerTask(t, tasks, principal, claimableTask(t, tasks, admin, project.ID), descriptor)
	}

	createTask(t, tasks, admin, project.ID, "Unclaimed first")
	add(owner, uuid.NewString())
	add(other, workerID)
	released := add(owner, workerID)
	var err error
	released, err = tasks.ReleaseWorker(ctx, owner, project.ID, released.ID, ReleaseWorker{Version: released.Version, ClaimID: testWorker(t, released.Properties).ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	completed := add(owner, workerID)
	_, err = tasks.SetStatus(ctx, owner, project.ID, completed.ID, SetTaskStatus{Version: completed.Version, Status: core.TaskDone, ClaimID: &testWorker(t, completed.Properties).ClaimID})
	if err != nil {
		t.Fatal(err)
	}

	first := add(owner, workerID)
	add(other, workerID)
	second := add(owner, workerID)
	manual := add(owner, workerID)
	previous := *testWorker(t, manual.Properties)
	manual, err = tasks.ReleaseWorker(ctx, owner, project.ID, manual.ID, ReleaseWorker{Version: manual.Version, ClaimID: previous.ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	manual = updateTask(t, tasks, admin, manual, UpdateTask{AllowAgents: pointer(false), RequiredPlatform: platformChange(pointer(core.PlatformWindows))})
	descriptor := workerDescriptor()
	descriptor.WorkerID = workerID
	manual, err = tasks.ResumeWorker(ctx, owner, project.ID, manual.ID, ResumeWorker{ClaimWorker: ClaimWorker{Version: manual.Version, WorkerDescriptor: descriptor}, PreviousClaimID: previous.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{first.ID, second.ID, manual.ID}
	uppercase := strings.ToUpper(workerID)
	request := TaskListRequest{PageRequest: PageRequest{Limit: 1}, WorkerID: &uppercase}
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
		request TaskListRequest
		want    []string
	}{
		{TaskListRequest{Ready: pointer(false)}, want},
		{TaskListRequest{Ready: pointer(true)}, nil},
		{TaskListRequest{AllowAgents: pointer(true)}, want[:2]},
		{TaskListRequest{AllowAgents: pointer(false)}, want[2:]},
		{TaskListRequest{CompatiblePlatform: pointer(core.PlatformLinux)}, want[:2]},
		{TaskListRequest{Status: pointer(core.TaskInProgress)}, want},
		{TaskListRequest{Status: pointer(core.TaskTodo)}, nil},
	} {
		test.request.PageRequest, test.request.WorkerID = PageRequest{Limit: 100}, &workerID
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
	task := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, admin, project.ID), descriptor)
	inventory := func(principal core.Principal, wantClaim string) {
		t.Helper()
		page, err := tasks.List(ctx, principal, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 100}, WorkerID: &descriptor.WorkerID})
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
	released, err := tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, ReleaseWorker{Version: task.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	inventory(owner, "")
	next := descriptor
	next.ClaimID, next.WorktreeID = uuid.NewString(), uuid.NewString()
	task, err = tasks.ResumeWorker(ctx, owner, project.ID, task.ID, ResumeWorker{ClaimWorker: ClaimWorker{Version: released.Version, WorkerDescriptor: next}, PreviousClaimID: descriptor.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	inventory(owner, next.ClaimID)
	task, err = tasks.WithdrawWorker(ctx, admin, project.ID, task.ID, WithdrawWorker{Version: task.Version, ClaimID: next.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	inventory(owner, "")
	if testWorker(t, task.Properties) != nil || task.AllowAgents {
		t.Fatal("withdrawn claim remained eligible or retained ownership")
	}
	task = updateTask(t, tasks, admin, task, UpdateTask{AllowAgents: pointer(true)})
	next.ClaimID, next.WorktreeID = uuid.NewString(), uuid.NewString()
	task = claimWorkerTask(t, tasks, owner, task, next)
	inventory(owner, next.ClaimID)
	task, err = tasks.SetStatus(ctx, owner, project.ID, task.ID, SetTaskStatus{Version: task.Version, Status: core.TaskDone, ClaimID: &next.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	inventory(owner, "")
	task = setStatusTask(t, tasks, admin, task, core.TaskTodo)
	fresh := workerDescriptor()
	fresh.WorkerID = descriptor.WorkerID
	task = claimWorkerTask(t, tasks, owner, task, fresh)
	inventory(owner, fresh.ClaimID)
}

func TestTaskWorkerInventoryRejectsInvalidFilterAndPreservesReadFailures(t *testing.T) {
	tasks, database, project, _, owner := taskService(t)
	ctx := context.Background()
	for _, workerID := range []string{"", "invalid", "00000000000000000000000000000000"} {
		_, err := tasks.List(ctx, owner, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 1}, WorkerID: &workerID})
		requireFault(t, err, "invalid_input")
	}
	workerID := uuid.NewString()
	_, err := tasks.List(ctx, servicePrincipal(t, database), project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 1}, WorkerID: &workerID})
	requireFault(t, err, "not_found")
	task := createTask(t, tasks, owner, project.ID, "Invalid stored worker")
	if _, err := database.Pool.Exec(ctx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker','{}')`, task.ID); err != nil {
		t.Fatal(err)
	}
	_, err = tasks.List(ctx, owner, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 1}, WorkerID: &workerID})
	requireFault(t, err, "invalid_input")
	var stored *store.Error
	if !errors.As(err, &stored) || errors.Unwrap(err) == nil {
		t.Fatalf("invalid stored ownership became a successful empty inventory: %v", err)
	}
}
