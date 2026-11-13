package task_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func workerInventoryFixture(t *testing.T, principal model.Principal, projectID string) (*taskservice.Tasks, *taskReaderMock, *projectReaderMock) {
	t.Helper()
	base := newTaskMockBase(t, "inventory")
	reader := &taskReaderMock{taskMockBase: base.withLabel("task")}
	projects := &projectReaderMock{taskMockBase: base.withLabel("project")}
	snapshot := &taskSnapshotScopeMock{taskMockBase: base.withLabel("snapshot"),
		ProjectDAOFn: func() store.ProjectReader { return projects },
		TaskDAOFn:    func() store.TaskReader { return reader },
	}
	database := &taskStoreMock{taskMockBase: base.withLabel("store")}
	projects.ProjectAccessFn = func(ctx context.Context, actual model.Principal, id string) (model.ProjectAccess, error) {
		if ctx != t.Context() || !reflect.DeepEqual(actual, principal) || id != projectID {
			t.Fatal("inventory authorization changed context, principal or Project")
		}
		return model.ProjectAccess{ProjectID: projectID, UserID: principal.UserID, Role: model.ProjectMemberRole}, nil
	}
	database.ReadSnapshotFn = func(ctx context.Context, work func(store.SnapshotScope) error) error {
		if ctx != t.Context() || work == nil {
			t.Fatal("inventory changed snapshot context")
		}
		return work(snapshot)
	}
	return taskservice.NewTasks(database), reader, projects
}

func workerInventoryTask(t *testing.T, principal model.Principal, workerID string, ordinal int) model.Task {
	t.Helper()
	task := workerServiceTask(t, principal)
	task.ID = fmt.Sprintf("21000000-0000-4000-8000-%012x", ordinal)
	task.CreatedAt = task.CreatedAt.Add(time.Duration(ordinal) * time.Second)
	task.UpdatedAt, task.Status, task.Ready = task.CreatedAt, model.TaskInProgress, false
	descriptor := workerDescriptor()
	worker := &model.WorkerClaim{ClaimID: descriptor.ClaimID, WorkerID: workerID, UserID: principal.UserID, Machine: descriptor.Machine, Platform: descriptor.Platform, Agent: descriptor.Agent, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: descriptor.WorktreeID, State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: task.CreatedAt}
	task.Properties = testWithWorker(t, task.Properties, worker)
	return task
}

func workerInventoryQuery(principal model.Principal, workerID string) store.TaskQuery {
	return store.TaskQuery{TagFilter: store.TagFilter{TagIDs: []string{}, TagMatch: "all"}, Page: store.Page{Limit: 1}, Worker: &store.WorkerQuery{UserID: principal.UserID, WorkerID: workerID}}
}

func TestTaskWorkerInventoryFiltersBeforeLimitAndBindsWorkerAndUser(t *testing.T) {
	owner := workerServicePrincipal()
	other := owner
	other.UserID = "20000000-0000-4000-8000-000000000005"
	workerID := "20000000-0000-4000-8000-000000000006"
	first, second, manual := workerInventoryTask(t, owner, workerID, 1), workerInventoryTask(t, owner, workerID, 2), workerInventoryTask(t, owner, workerID, 3)
	manual.AllowAgents, manual.RequiredPlatform = false, pointer(model.PlatformWindows)
	tasks, reader, _ := workerInventoryFixture(t, owner, first.ProjectID)
	expected := workerInventoryQuery(owner, workerID)
	response := store.TaskPage{}
	reads := 0
	reader.TasksFn = func(ctx context.Context, id string, q store.TaskQuery) (store.TaskPage, error) {
		reads++
		if ctx != t.Context() || id != first.ProjectID || !reflect.DeepEqual(q, expected) {
			t.Fatalf("worker inventory query: got %#v, want %#v", q, expected)
		}
		return response, nil
	}
	uppercase := strings.ToUpper(workerID)
	request := taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, WorkerID: &uppercase}
	var got []string
	for index, current := range []model.Task{first, second, manual} {
		response = store.TaskPage{Items: []model.Task{current}, HasMore: index < 2}
		before := reads
		page, err := tasks.List(t.Context(), owner, first.ProjectID, request)
		if err != nil || len(page.Items) != 1 || reads != before+1 {
			t.Fatalf("filtered page: %#v %v", page, err)
		}
		got = append(got, page.Items[0].ID)
		if index == 2 {
			if page.NextCursor != nil {
				t.Fatal("final page returned cursor")
			}
			break
		}
		if page.NextCursor == nil {
			t.Fatal("filtered page lost next cursor")
		}
		for _, changed := range []*string{nil, pointer("20000000-0000-4000-8000-000000000007")} {
			invalid := request
			invalid.Cursor, invalid.WorkerID = page.NextCursor, changed
			_, err := tasks.List(t.Context(), owner, first.ProjectID, invalid)
			requireFault(t, err, "invalid_input")
		}
		invalid := request
		invalid.Cursor = page.NextCursor
		_, err = tasks.List(t.Context(), other, first.ProjectID, invalid)
		requireFault(t, err, "invalid_input")
		if reads != before+1 {
			t.Fatal("invalid bound cursor accessed the DAO")
		}
		request.Cursor, request.WorkerID = page.NextCursor, &workerID
		expected.Page.After = &store.Position{CreatedAt: current.CreatedAt, ID: current.ID}
	}
	want := []string{first.ID, second.ID, manual.ID}
	if !slices.Equal(got, want) {
		t.Fatalf("inventory: got %v want %v", got, want)
	}
	for _, tc := range []struct {
		request taskservice.TaskListRequest
		items   []model.Task
	}{
		{taskservice.TaskListRequest{Ready: pointer(false)}, []model.Task{first, second, manual}},
		{taskservice.TaskListRequest{Ready: pointer(true)}, nil},
		{taskservice.TaskListRequest{AllowAgents: pointer(true)}, []model.Task{first, second}},
		{taskservice.TaskListRequest{AllowAgents: pointer(false)}, []model.Task{manual}},
		{taskservice.TaskListRequest{CompatiblePlatform: pointer(model.PlatformLinux)}, []model.Task{first, second}},
		{taskservice.TaskListRequest{Status: pointer(model.TaskInProgress)}, []model.Task{first, second, manual}},
		{taskservice.TaskListRequest{Status: pointer(model.TaskTodo)}, nil},
	} {
		tc.request.PageRequest, tc.request.WorkerID = model.PageRequest{Limit: 100}, &workerID
		expected = workerInventoryQuery(owner, workerID)
		expected.Page.Limit = 100
		expected.Ready, expected.AllowAgents, expected.CompatiblePlatform, expected.Status = tc.request.Ready, tc.request.AllowAgents, tc.request.CompatiblePlatform, tc.request.Status
		calls := 0
		reader.TasksFn = func(ctx context.Context, id string, q store.TaskQuery) (store.TaskPage, error) {
			calls++
			if ctx != t.Context() || id != first.ProjectID || !reflect.DeepEqual(q, expected) || calls != 1 {
				t.Fatalf("combined query: got %#v want %#v calls=%d", q, expected, calls)
			}
			return store.TaskPage{Items: append([]model.Task{}, tc.items...)}, nil
		}
		page, err := tasks.List(t.Context(), owner, first.ProjectID, tc.request)
		var ids, wantIDs []string
		for _, item := range page.Items {
			ids = append(ids, item.ID)
		}
		for _, item := range tc.items {
			wantIDs = append(wantIDs, item.ID)
		}
		if err != nil || !slices.Equal(ids, wantIDs) || page.NextCursor != nil {
			t.Fatalf("combined inventory: got %v want %v err %v", ids, wantIDs, err)
		}
	}
}

func TestTaskWorkerInventoryTracksCurrentClaimAcrossOwnershipChanges(t *testing.T) {
	owner := workerServicePrincipal()
	workerID := "20000000-0000-4000-8000-000000000006"
	current := workerInventoryTask(t, owner, workerID, 1)
	original := testWorker(t, current.Properties).ClaimID
	for _, stage := range []struct {
		name   string
		claim  string
		active bool
	}{
		{"claimed", original, true}, {"released", original, false}, {"resumed", "22000000-0000-4000-8000-000000000001", true},
		{"withdrawn", "", false}, {"reclaimed", "22000000-0000-4000-8000-000000000002", true}, {"completed", "22000000-0000-4000-8000-000000000002", false},
		{"reopened and claimed", "22000000-0000-4000-8000-000000000003", true},
	} {
		t.Run(stage.name, func(t *testing.T) {
			tasks, reader, _ := workerInventoryFixture(t, owner, current.ProjectID)
			expected := workerInventoryQuery(owner, workerID)
			expected.Page.Limit = 100
			calls := 0
			returned := current
			worker := *testWorker(t, returned.Properties)
			worker.ClaimID = stage.claim
			if stage.active {
				returned.Properties = testWithWorker(t, returned.Properties, &worker)
			}
			reader.TasksFn = func(ctx context.Context, id string, q store.TaskQuery) (store.TaskPage, error) {
				calls++
				if ctx != t.Context() || id != current.ProjectID || calls != 1 || !reflect.DeepEqual(q, expected) {
					t.Fatal("ownership inventory lost current caller/worker filter")
				}
				if !stage.active {
					return store.TaskPage{Items: []model.Task{}}, nil
				}
				return store.TaskPage{Items: []model.Task{returned}}, nil
			}
			page, err := tasks.List(t.Context(), owner, current.ProjectID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}, WorkerID: &workerID})
			if err != nil || calls != 1 || page.NextCursor != nil {
				t.Fatalf("ownership inventory: %#v %v", page, err)
			}
			if !stage.active {
				if len(page.Items) != 0 {
					t.Fatal("historical ownership exposed as active inventory")
				}
				return
			}
			if len(page.Items) != 1 || page.Items[0].ID != current.ID || testWorker(t, page.Items[0].Properties).ClaimID != stage.claim {
				t.Fatalf("wrong current claim: %#v", page)
			}
		})
	}
}

func TestTaskWorkerInventoryRejectsInvalidFilterAndPreservesReadFailures(t *testing.T) {
	owner := workerServicePrincipal()
	project := workerServiceTask(t, owner).ProjectID
	tasks, reader, projects := workerInventoryFixture(t, owner, project)
	for _, workerID := range []string{"", "invalid", "00000000000000000000000000000000"} {
		_, err := tasks.List(t.Context(), owner, project, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, WorkerID: &workerID})
		requireFault(t, err, "invalid_input")
	}
	workerID := "20000000-0000-4000-8000-000000000006"
	projects.ProjectAccessFn = func(ctx context.Context, actual model.Principal, id string) (model.ProjectAccess, error) {
		if ctx != t.Context() || actual != owner || id != project {
			t.Fatal("inventory denial scope mismatch")
		}
		return model.ProjectAccess{}, model.ErrNotFound
	}
	_, err := tasks.List(t.Context(), owner, project, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, WorkerID: &workerID})
	requireFault(t, err, "not_found")
	tasks, reader, _ = workerInventoryFixture(t, owner, project)
	cause := errors.New("worker decode failed")
	failure := &store.Error{Phase: "decode worker", Cause: cause}
	calls := 0
	reader.TasksFn = func(ctx context.Context, id string, q store.TaskQuery) (store.TaskPage, error) {
		calls++
		if ctx != t.Context() || id != project || !reflect.DeepEqual(q, workerInventoryQuery(owner, workerID)) {
			t.Fatal("invalid stored worker query mismatch")
		}
		return store.TaskPage{}, failure
	}
	page, err := tasks.List(t.Context(), owner, project, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, WorkerID: &workerID})
	var stored *store.Error
	if calls != 1 || !errors.As(err, &stored) || stored != failure || !errors.Is(err, cause) || page.Items != nil || page.NextCursor != nil {
		t.Fatalf("invalid stored ownership lost original read failure: %#v %v", page, err)
	}
}
