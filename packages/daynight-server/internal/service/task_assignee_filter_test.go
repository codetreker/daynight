package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func assignmentCursorFields(t *testing.T, cursor string) map[string]any {
	t.Helper()
	data, err := base64.RawURLEncoding.Strict().DecodeString(cursor)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func assignmentCursorMutation(t *testing.T, cursor string, mutate func(map[string]any)) string {
	t.Helper()
	value := assignmentCursorFields(t, cursor)
	mutate(value)
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(data)
}

func assignmentTaskIDs(tasks []core.Task) []string {
	ids := make([]string, len(tasks))
	for index, task := range tasks {
		ids[index] = task.ID
	}
	return ids
}

func TestTaskAssignedToFilterComposesBeforePagination(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	alice, bob := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	prerequisite := createAssignedTask(t, tasks, admin, project.ID, &bob.UserID)
	inventory := []core.Task{prerequisite}
	for _, assigned := range []*string{nil, &alice.UserID, &admin.UserID} {
		for _, required := range []*core.TaskPlatform{nil, pointer(core.PlatformLinux), pointer(core.PlatformWindows)} {
			for _, allowed := range []bool{false, true} {
				for _, status := range []string{"todo", "blocked", "in_progress", "done"} {
					input := CreateTask{Title: "Assignment filter candidate", AssignedTo: assigned, RequiredPlatform: required}
					if status == "blocked" {
						input.DependsOn = []string{prerequisite.ID}
					}
					current, err := tasks.Create(ctx, admin, project.ID, input)
					if err != nil {
						t.Fatal(err)
					}
					current = updateTask(t, tasks, admin, current, UpdateTask{AllowAgents: &allowed})
					if status == "in_progress" || status == "done" {
						current = setStatusTask(t, tasks, admin, current, core.TaskStatus(status))
					}
					inventory = append(inventory, current)
				}
			}
		}
	}
	for _, selector := range []*string{nil, pointer("unassigned"), pointer("me"), pointer(strings.ToUpper(alice.UserID)), &bob.UserID} {
		for _, status := range []*core.TaskStatus{nil, pointer(core.TaskTodo), pointer(core.TaskInProgress), pointer(core.TaskDone)} {
			for _, allowed := range []*bool{nil, pointer(false), pointer(true)} {
				for _, ready := range []*bool{nil, pointer(false), pointer(true)} {
					for _, platform := range []*core.TaskPlatform{nil, pointer(core.PlatformLinux)} {
						request := TaskListRequest{PageRequest: PageRequest{Limit: 100}, AssignedTo: selector, Status: status, Ready: ready, AllowAgents: allowed, CompatiblePlatform: platform}
						page, err := tasks.List(ctx, admin, project.ID, request)
						if err != nil {
							t.Fatal(err)
						}
						want := []string{}
						for _, task := range inventory {
							matchesAssignment := selector == nil
							if selector != nil {
								switch *selector {
								case "unassigned":
									matchesAssignment = task.AssignedTo == nil
								case "me":
									matchesAssignment = equalOptional(task.AssignedTo, &admin.UserID)
								default:
									matchesAssignment = task.AssignedTo != nil && *task.AssignedTo == strings.ToLower(*selector)
								}
							}
							if matchesAssignment && (status == nil || task.Status == *status) && (allowed == nil || task.AllowAgents == *allowed) && (ready == nil || task.Ready == *ready) &&
								(platform == nil || task.RequiredPlatform == nil || *task.RequiredPlatform == *platform) {
								want = append(want, task.ID)
							}
						}
						if !slices.Equal(assignmentTaskIDs(page.Items), want) || page.NextCursor != nil {
							t.Fatalf("combined assignment filters: got %v want %v", assignmentTaskIDs(page.Items), want)
						}
					}
				}
			}
		}
	}
	request := TaskListRequest{PageRequest: PageRequest{Limit: 1}, AssignedTo: &alice.UserID, Status: pointer(core.TaskTodo), Ready: pointer(true), AllowAgents: pointer(true), CompatiblePlatform: pointer(core.PlatformLinux)}
	var got []string
	for {
		page, err := tasks.List(ctx, admin, project.ID, request)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, assignmentTaskIDs(page.Items)...)
		if page.NextCursor == nil {
			break
		}
		if len(page.Items) != 1 {
			t.Fatal("an early nonmatching task consumed the filtered page")
		}
		request.Cursor = page.NextCursor
	}
	if len(got) != 2 {
		t.Fatalf("filtered pagination hid matching tasks: %v", got)
	}
	if err := database.WriteProject(ctx, project.ID, func(tx *store.ProjectTx) error { return tx.RemoveMember(ctx, alice.UserID) }); err != nil {
		t.Fatal(err)
	}
	former, err := tasks.List(ctx, admin, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 100}, AssignedTo: &alice.UserID})
	if err != nil || len(former.Items) != 24 {
		t.Fatalf("former assignee could not be queried: %d %v", len(former.Items), err)
	}
}

func TestTaskAssignedToCursorScopeAndOtherCursorVersions(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	alice := workerMember(t, database, project.ID)
	for range 3 {
		createAssignedTask(t, tasks, admin, project.ID, &admin.UserID)
	}
	request := TaskListRequest{PageRequest: PageRequest{Limit: 1}, AssignedTo: pointer("me")}
	page, err := tasks.List(ctx, admin, project.ID, request)
	if err != nil || page.NextCursor == nil || len(page.Items) != 1 {
		t.Fatalf("missing self-filtered cursor: %#v %v", page, err)
	}
	fields := assignmentCursorFields(t, *page.NextCursor)
	if fields["version"] != float64(2) || fields["kind"] != "tasks" {
		t.Fatalf("task cursor did not adopt its own version: %#v", fields)
	}
	request.Cursor, request.AssignedTo = page.NextCursor, pointer(strings.ToUpper(admin.UserID))
	continued, err := tasks.List(ctx, admin, project.ID, request)
	if err != nil || len(continued.Items) != 1 || continued.Items[0].ID == page.Items[0].ID {
		t.Fatal("me and its canonical UUID do not share cursor scope", err)
	}
	for _, changed := range []*string{nil, pointer("unassigned"), &alice.UserID} {
		invalid := request
		invalid.AssignedTo = changed
		_, err := tasks.List(ctx, admin, project.ID, invalid)
		requireFault(t, err, "invalid_input")
	}
	request.AssignedTo = pointer("me")
	_, err = tasks.List(ctx, alice, project.ID, request)
	requireFault(t, err, "invalid_input")
	old := assignmentCursorMutation(t, *page.NextCursor, func(value map[string]any) { value["version"] = 1 })
	request.Cursor = &old
	_, err = tasks.List(ctx, admin, project.ID, request)
	requireFault(t, err, "invalid_input")
	for _, invalid := range []string{"", "ME", "Unassigned", " me", "null", "bad", strings.Repeat("a", 36)} {
		_, err := tasks.List(ctx, admin, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 1}, AssignedTo: &invalid})
		requireFault(t, err, "invalid_input")
	}
	projectCursor, err := encodeProjectCursor(project)
	if err != nil {
		t.Fatal(err)
	}
	projectFields := assignmentCursorFields(t, projectCursor)
	if projectFields["version"] != float64(1) || projectFields["kind"] != "projects" {
		t.Fatalf("project cursor version changed with task cursor: %#v", projectFields)
	}
	workers := NewWorkers(database)
	for range 2 {
		if _, err := workers.Report(ctx, admin, uuid.NewString(), serviceWorkerReport()); err != nil {
			t.Fatal(err)
		}
	}
	workerPage, err := workers.List(ctx, admin, PageRequest{Limit: 1})
	if err != nil || workerPage.NextCursor == nil {
		t.Fatal("worker cursor missing", err)
	}
	if workerFields := assignmentCursorFields(t, *workerPage.NextCursor); workerFields["version"] != float64(1) {
		t.Fatalf("worker cursor version changed with task cursor: %#v", workerFields)
	}
}

func TestTaskAssignedToWorkerInventoryUsesExplicitSelectionOnly(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	alice, bob, owner := workerMember(t, database, project.ID), workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	workerID := uuid.NewString()
	var active []core.Task
	for _, assigned := range []*string{&bob.UserID, nil, &alice.UserID} {
		task := createAssignedTask(t, tasks, admin, project.ID, assigned)
		task = updateTask(t, tasks, admin, task, UpdateTask{AllowAgents: pointer(true)})
		descriptor := workerDescriptor()
		descriptor.WorkerID = workerID
		active = append(active, claimWorkerTask(t, tasks, owner, task, descriptor))
	}
	all, err := tasks.List(ctx, owner, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 100}, WorkerID: &workerID})
	if err != nil || !reflect.DeepEqual(assignmentTaskIDs(all.Items), assignmentTaskIDs(active)) {
		t.Fatal("default worker inventory imposed caller assignment", err)
	}
	filtered, err := tasks.List(ctx, owner, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 1}, WorkerID: &workerID, AssignedTo: &alice.UserID})
	if err != nil || len(filtered.Items) != 1 || filtered.Items[0].ID != active[2].ID || filtered.NextCursor != nil {
		t.Fatalf("worker lookahead preceded assignment selection: %#v %v", filtered, err)
	}
	for _, assigned := range []*string{&alice.UserID, &bob.UserID, nil} {
		task := createAssignedTask(t, tasks, admin, project.ID, assigned)
		updateTask(t, tasks, admin, task, UpdateTask{AllowAgents: pointer(true)})
	}
	candidates, err := tasks.List(ctx, owner, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 100}, Ready: pointer(true), AllowAgents: pointer(true)})
	if err != nil || len(candidates.Items) != 3 {
		t.Fatalf("automatic discovery implicitly filtered responsibility: %#v %v", candidates, err)
	}
}
