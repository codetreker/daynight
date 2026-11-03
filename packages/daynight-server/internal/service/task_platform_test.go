package service

import (
	"context"
	"reflect"
	"slices"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func platformChange(value *core.TaskPlatform) **core.TaskPlatform { return &value }

func TestTaskPlatformUpdatesPreserveStatusAndLockExecution(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	ctx := context.Background()
	prerequisite := finishTask(t, tasks, principal, startTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "Completed prerequisite")))
	for _, platform := range []*core.TaskPlatform{nil, pointer(core.PlatformWindows), pointer(core.PlatformLinux), pointer(core.PlatformMacOS)} {
		task, err := tasks.Create(ctx, principal, project.ID, CreateTask{Title: "Platform status", RequiredPlatform: platform, DependsOn: []string{prerequisite.ID}, ExternalDependsOn: []string{prerequisite.ID}})
		if err != nil || !equalOptional(task.RequiredPlatform, platform) || task.Status != core.TaskTodo || task.AllowAgents || !task.Ready {
			t.Fatalf("platform creation: %#v, %v", task, err)
		}
		task = updateTask(t, tasks, principal, task, UpdateTask{Description: pointer("Preserved metadata"), AllowAgents: pointer(true), Properties: propertyPatch([]core.PullRequestProperty{{URL: "https://example.com/pr/1", Title: "Evidence"}}...)})
		if !equalOptional(task.RequiredPlatform, platform) {
			t.Fatal("omitted platform changed requirement")
		}
		if got := updateTask(t, tasks, principal, task, UpdateTask{RequiredPlatform: platformChange(platform)}); !reflect.DeepEqual(got, task) {
			t.Fatal("same platform request changed resource")
		}
		_, err = tasks.Update(ctx, principal, project.ID, task.ID, UpdateTask{Version: task.Version - 1, RequiredPlatform: platformChange(platform)})
		requireFault(t, err, "version_conflict")
		task = startTask(t, tasks, principal, task)
		if !equalOptional(task.RequiredPlatform, platform) || !task.AllowAgents || task.StartedAt == nil {
			t.Fatal("manual status update lost platform, permission or timing")
		}
		if got := updateTask(t, tasks, principal, task, UpdateTask{RequiredPlatform: platformChange(platform)}); !reflect.DeepEqual(got, task) {
			t.Fatal("active same platform changed resource")
		}
		changed := pointer(core.PlatformWindows)
		if platform != nil {
			changed = nil
		}
		_, err = tasks.Update(ctx, principal, project.ID, task.ID, UpdateTask{Version: task.Version, RequiredPlatform: platformChange(changed), Title: pointer("Must not partly save")})
		requireFault(t, err, "invalid_transition")
		assertTaskUnchanged(t, tasks, principal, task)
		task = updateTask(t, tasks, principal, task, UpdateTask{Description: pointer("Running metadata")})
		task = finishTask(t, tasks, principal, task)
		after := updateTask(t, tasks, principal, task, UpdateTask{RequiredPlatform: platformChange(changed)})
		preserved := after
		preserved.RequiredPlatform, preserved.Version, preserved.UpdatedAt = task.RequiredPlatform, task.Version, task.UpdatedAt
		if !equalOptional(after.RequiredPlatform, changed) || after.Version != task.Version+1 || !after.UpdatedAt.After(task.UpdatedAt) || !reflect.DeepEqual(preserved, task) {
			t.Fatal("completed platform edit changed execution or unrelated fields")
		}
	}
	invalid := core.TaskPlatform("darwin")
	_, err := tasks.Create(ctx, principal, project.ID, CreateTask{Title: "Invalid platform", RequiredPlatform: &invalid})
	requireFault(t, err, "invalid_input")
	task := createTask(t, tasks, principal, project.ID, "Invalid update")
	_, err = tasks.Update(ctx, principal, project.ID, task.ID, UpdateTask{Version: task.Version, RequiredPlatform: platformChange(&invalid), Title: pointer("Must not partly save")})
	requireFault(t, err, "invalid_input")
	assertTaskUnchanged(t, tasks, principal, task)
	_, err = tasks.List(ctx, principal, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 10}, CompatiblePlatform: &invalid})
	requireFault(t, err, "invalid_input")
}

func TestTaskPlatformCandidateMatrixAndGraph(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	ctx := context.Background()
	prerequisite := createTask(t, tasks, principal, project.ID, "Pending prerequisite")
	var inventory []core.Task
	for _, required := range []*core.TaskPlatform{nil, pointer(core.PlatformWindows), pointer(core.PlatformLinux), pointer(core.PlatformMacOS)} {
		for _, allowed := range []bool{false, true} {
			for _, state := range []string{"blocked", "ready", "in_progress", "done"} {
				input := CreateTask{Title: "Platform candidate", RequiredPlatform: required}
				if state == "blocked" {
					input.DependsOn = []string{prerequisite.ID}
				}
				task, err := tasks.Create(ctx, principal, project.ID, input)
				if err != nil {
					t.Fatal(err)
				}
				task = updateTask(t, tasks, principal, task, UpdateTask{AllowAgents: &allowed})
				if state == "in_progress" || state == "done" {
					task = startTask(t, tasks, principal, task)
				}
				if state == "done" {
					task = finishTask(t, tasks, principal, task)
				}
				inventory = append(inventory, task)
			}
		}
	}
	for _, actual := range []core.TaskPlatform{core.PlatformWindows, core.PlatformLinux, core.PlatformMacOS} {
		for _, allowed := range []bool{false, true} {
			for _, ready := range []bool{false, true} {
				page, err := tasks.List(ctx, principal, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 100}, CompatiblePlatform: &actual, AllowAgents: &allowed, Ready: &ready})
				if err != nil {
					t.Fatal(err)
				}
				var want []string
				if !allowed && ready {
					want = append(want, prerequisite.ID)
				}
				for _, task := range inventory {
					if task.AllowAgents == allowed && task.Ready == ready && core.PlatformCompatible(task.RequiredPlatform, actual) {
						want = append(want, task.ID)
					}
				}
				var ids []string
				for _, task := range page.Items {
					ids = append(ids, task.ID)
				}
				if !slices.Equal(ids, want) {
					t.Fatalf("matrix actual=%q allowed=%v ready=%v: got %v, want %v", actual, allowed, ready, ids, want)
				}
			}
		}
	}
	for _, seed := range inventory {
		graph, err := tasks.Graph(ctx, principal, project.ID, seed.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, task := range graph.Tasks {
			for _, original := range inventory {
				if original.ID == task.ID && !equalOptional(task.RequiredPlatform, original.RequiredPlatform) {
					t.Fatal("graph omitted platform")
				}
			}
		}
	}
}

func TestTaskPlatformFilterPrecedesLimitAndBindsCursor(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	ctx := context.Background()
	var want []string
	for _, required := range []*core.TaskPlatform{pointer(core.PlatformWindows), pointer(core.PlatformMacOS), pointer(core.PlatformLinux), nil, pointer(core.PlatformLinux)} {
		task, err := tasks.Create(ctx, principal, project.ID, CreateTask{Title: "Paged candidate", RequiredPlatform: required})
		if err != nil {
			t.Fatal(err)
		}
		task = updateTask(t, tasks, principal, task, UpdateTask{AllowAgents: pointer(true)})
		if core.PlatformCompatible(required, core.PlatformLinux) {
			want = append(want, task.ID)
		}
	}
	request := TaskListRequest{PageRequest: PageRequest{Limit: 1}, Ready: pointer(true), AllowAgents: pointer(true), CompatiblePlatform: pointer(core.PlatformLinux)}
	var ids []string
	for {
		page, err := tasks.List(ctx, principal, project.ID, request)
		if err != nil {
			t.Fatal(err)
		}
		for _, task := range page.Items {
			ids = append(ids, task.ID)
		}
		if page.NextCursor == nil {
			break
		}
		for _, platform := range []*core.TaskPlatform{nil, pointer(core.PlatformWindows), pointer(core.PlatformMacOS)} {
			changed := request
			changed.Cursor, changed.CompatiblePlatform = page.NextCursor, platform
			_, err := tasks.List(ctx, principal, project.ID, changed)
			requireFault(t, err, "invalid_input")
		}
		request.Cursor = page.NextCursor
	}
	if !slices.Equal(ids, want) {
		t.Fatalf("bounded page hid compatible candidates: got %v want %v", ids, want)
	}
}

func TestTaskPlatformAndManualStartRaceHasOneMutationWinner(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	before := createTask(t, tasks, principal, project.ID, "Platform race")
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (core.Task, error) {
			return tasks.Update(ctx, principal, project.ID, before.ID, UpdateTask{Version: before.Version, RequiredPlatform: platformChange(pointer(core.PlatformWindows))})
		},
		func(ctx context.Context) (core.Task, error) {
			return tasks.SetStatus(ctx, principal, project.ID, before.ID, SetTaskStatus{Version: before.Version, Status: core.TaskInProgress})
		})
	assertOneTaskWinner(t, results, "version_conflict")
	after, err := tasks.Get(context.Background(), principal, project.ID, before.ID)
	if err != nil || after.Version != before.Version+1 {
		t.Fatalf("race committed incorrectly: %#v, %v", after, err)
	}
	if after.Status == core.TaskInProgress {
		if after.RequiredPlatform != nil || after.StartedAt == nil {
			t.Fatal("manual start changed platform or omitted timing")
		}
	} else if after.Status != core.TaskTodo || !equalOptional(after.RequiredPlatform, pointer(core.PlatformWindows)) || after.StartedAt != nil {
		t.Fatalf("platform winner changed status: %#v", after)
	}
}

func TestTaskPlatformSurvivesEveryStatusAssignment(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	ctx := context.Background()
	prerequisite := finishTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "Completed prerequisite"))
	for _, platform := range []*core.TaskPlatform{nil, pointer(core.PlatformWindows), pointer(core.PlatformLinux), pointer(core.PlatformMacOS)} {
		for _, from := range []core.TaskStatus{core.TaskTodo, core.TaskInProgress, core.TaskDone} {
			for _, to := range []core.TaskStatus{core.TaskTodo, core.TaskInProgress, core.TaskDone} {
				name := "any"
				if platform != nil {
					name = string(*platform)
				}
				t.Run(name+"_"+string(from)+"_to_"+string(to), func(t *testing.T) {
					task, err := tasks.Create(ctx, principal, project.ID, CreateTask{Title: "Preserved platform", Description: "Preserved materials", RequiredPlatform: platform, DependsOn: []string{prerequisite.ID}, ExternalDependsOn: []string{prerequisite.ID}, Properties: propertyPatch([]core.PullRequestProperty{{URL: "https://example.com/pr/1", Title: "Evidence"}}...)})
					if err != nil {
						t.Fatal(err)
					}
					task = updateTask(t, tasks, principal, task, UpdateTask{AllowAgents: pointer(true)})
					task = setStatusTask(t, tasks, principal, task, from)
					after := setStatusTask(t, tasks, principal, task, to)
					expectedVersion := task.Version
					if from != to {
						expectedVersion++
					}
					if after.Version != expectedVersion || after.Status != to || !equalOptional(after.RequiredPlatform, platform) {
						t.Fatalf("platform or status/version changed incorrectly: before %#v after %#v", task, after)
					}
					if from == to {
						if !reflect.DeepEqual(after, task) {
							t.Fatal("same-status request changed platform or materials")
						}
					} else {
						preserved := after
						preserved.Status, preserved.Version, preserved.UpdatedAt, preserved.StartedAt, preserved.CompletedAt, preserved.Ready = task.Status, task.Version, task.UpdatedAt, task.StartedAt, task.CompletedAt, task.Ready
						if !reflect.DeepEqual(preserved, task) {
							t.Fatalf("status update changed platform or materials: before %#v after %#v", task, after)
						}
					}
				})
			}
		}
	}
}
