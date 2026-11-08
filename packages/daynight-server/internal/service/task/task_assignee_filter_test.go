package task_test

import (
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"context"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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

func assignmentTaskIDs(tasks []model.Task) []string {
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
	inventory := []model.Task{prerequisite}
	for _, assigned := range []*string{nil, &alice.UserID, &admin.UserID} {
		for _, required := range []*model.TaskPlatform{nil, pointer(model.PlatformLinux), pointer(model.PlatformWindows)} {
			for _, allowed := range []bool{false, true} {
				for _, status := range []string{"todo", "blocked", "in_progress", "done"} {
					input := taskcore.CreateTask{Title: "Assignment filter candidate", AssignedTo: assigned, RequiredPlatform: required}
					if status == "blocked" {
						input.DependsOn = []string{prerequisite.ID}
					}
					current, err := tasks.Create(ctx, admin, project.ID, input)
					if err != nil {
						t.Fatal(err)
					}
					current = updateTask(t, tasks, admin, current, taskcore.UpdateTask{AllowAgents: &allowed})
					if status == "in_progress" || status == "done" {
						current = setStatusTask(t, tasks, admin, current, model.TaskStatus(status))
					}
					inventory = append(inventory, current)
				}
			}
		}
	}
	for _, selector := range []*string{nil, pointer("unassigned"), pointer("me"), pointer(strings.ToUpper(alice.UserID)), &bob.UserID} {
		for _, status := range []*model.TaskStatus{nil, pointer(model.TaskTodo), pointer(model.TaskInProgress), pointer(model.TaskDone)} {
			for _, allowed := range []*bool{nil, pointer(false), pointer(true)} {
				for _, ready := range []*bool{nil, pointer(false), pointer(true)} {
					for _, platform := range []*model.TaskPlatform{nil, pointer(model.PlatformLinux)} {
						request := taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}, AssignedTo: selector, Status: status, Ready: ready, AllowAgents: allowed, CompatiblePlatform: platform}
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
									matchesAssignment = model.EqualOptional(task.AssignedTo, &admin.UserID)
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
	request := taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, AssignedTo: &alice.UserID, Status: pointer(model.TaskTodo), Ready: pointer(true), AllowAgents: pointer(true), CompatiblePlatform: pointer(model.PlatformLinux)}
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
	if err := writeProjectForTest(database, ctx, project.ID, func(tx store.ProjectWriteScope) error { return tx.ProjectDAO().RemoveMember(ctx, alice.UserID) }); err != nil {
		t.Fatal(err)
	}
	former, err := tasks.List(ctx, admin, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}, AssignedTo: &alice.UserID})
	if err != nil || len(former.Items) != 24 {
		t.Fatalf("former assignee could not be queried: %d %v", len(former.Items), err)
	}
}

func TestTaskAssignedToWorkerInventoryUsesExplicitSelectionOnly(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	alice, bob, owner := workerMember(t, database, project.ID), workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	workerID := uuid.NewString()
	var active []model.Task
	for _, assigned := range []*string{&bob.UserID, nil, &alice.UserID} {
		task := claimableTask(t, tasks, owner, project.ID)
		descriptor := workerDescriptor()
		descriptor.WorkerID = workerID
		task = claimWorkerTask(t, tasks, owner, task, descriptor)
		task, err := tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, taskcore.ReleaseWorker{Version: task.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
		if err != nil {
			t.Fatal(err)
		}
		task = updateTask(t, tasks, admin, task, taskcore.UpdateTask{AssignedTo: assignmentChange(assigned)})
		next := workerDescriptor()
		next.WorkerID = workerID
		task, err = tasks.ResumeWorker(ctx, owner, project.ID, task.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: next}, PreviousClaimID: descriptor.ClaimID})
		if err != nil {
			t.Fatal(err)
		}
		active = append(active, task)
	}
	all, err := tasks.List(ctx, owner, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}, WorkerID: &workerID})
	if err != nil || !reflect.DeepEqual(assignmentTaskIDs(all.Items), assignmentTaskIDs(active)) {
		t.Fatal("default worker inventory imposed caller assignment", err)
	}
	filtered, err := tasks.List(ctx, owner, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, WorkerID: &workerID, AssignedTo: &alice.UserID})
	if err != nil || len(filtered.Items) != 1 || filtered.Items[0].ID != active[2].ID || filtered.NextCursor != nil {
		t.Fatalf("worker lookahead preceded assignment selection: %#v %v", filtered, err)
	}
	for _, assigned := range []*string{&alice.UserID, &bob.UserID, nil} {
		task := createAssignedTask(t, tasks, admin, project.ID, assigned)
		updateTask(t, tasks, admin, task, taskcore.UpdateTask{AllowAgents: pointer(true)})
	}
	candidates, err := tasks.List(ctx, owner, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}, Ready: pointer(true), AllowAgents: pointer(true)})
	if err != nil || len(candidates.Items) != 3 {
		t.Fatalf("unfiltered task list implicitly filtered responsibility: %#v %v", candidates, err)
	}
}
