package task_test

import (
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"reflect"
	"slices"
	"testing"
	"time"
)

func platformChange(value *model.TaskPlatform) **model.TaskPlatform { return &value }
func TestTaskPlatformUpdatesPreserveStatusAndLockExecution(t *testing.T) {
	_, base, actor := assignmentTaskModels()
	for _, platform := range []*model.TaskPlatform{nil, pointer(model.PlatformWindows), pointer(model.PlatformLinux), pointer(model.PlatformMacOS)} {
		before := base
		before.RequiredPlatform = platform
		before.AllowAgents = true
		f := newAssignmentFixture(t, before, nil)
		v := taskcore.CurrentWrite(before)
		v.Description = "Preserved metadata"
		after := assignmentResult(before, v)
		f.expectUpdate(v, after)
		got, err := f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, Description: &v.Description})
		if err != nil || !reflect.DeepEqual(got, after) {
			t.Fatalf("omitted platform: %#v %v", got, err)
		}
		before = after
		f = newAssignmentFixture(t, before, nil)
		got, err = f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, RequiredPlatform: platformChange(platform)})
		if err != nil || !reflect.DeepEqual(got, before) {
			t.Fatalf("same platform: %#v %v", got, err)
		}
		f = newAssignmentFixture(t, before, nil)
		_, err = f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version + 1, RequiredPlatform: platformChange(platform)})
		requireFault(t, err, "version_conflict")
		before = assignmentStatus(t, before, model.TaskInProgress)
		f = newAssignmentFixture(t, before, nil)
		got, err = f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, RequiredPlatform: platformChange(platform)})
		if err != nil || !reflect.DeepEqual(got, before) {
			t.Fatalf("active same platform: %#v %v", got, err)
		}
		changed := pointer(model.PlatformWindows)
		if platform != nil {
			changed = nil
		}
		f = newAssignmentFixture(t, before, nil)
		_, err = f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, RequiredPlatform: platformChange(changed), Title: pointer("Must not partly save")})
		requireFault(t, err, "invalid_transition")
		v = taskcore.CurrentWrite(before)
		v.Description = "Running metadata"
		after = assignmentResult(before, v)
		f = newAssignmentFixture(t, before, nil)
		f.expectUpdate(v, after)
		got, err = f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, Description: &v.Description})
		if err != nil || !reflect.DeepEqual(got, after) {
			t.Fatalf("running metadata: %#v %v", got, err)
		}
		before = assignmentStatus(t, after, model.TaskDone)
		v = taskcore.CurrentWrite(before)
		v.RequiredPlatform = changed
		after = assignmentResult(before, v)
		f = newAssignmentFixture(t, before, nil)
		f.expectUpdate(v, after)
		got, err = f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, RequiredPlatform: platformChange(changed)})
		if err != nil || !reflect.DeepEqual(got, after) || !reflect.DeepEqual(got.StartedAt, before.StartedAt) || !reflect.DeepEqual(got.CompletedAt, before.CompletedAt) {
			t.Fatalf("completed platform: %#v %v", got, err)
		}
	}
	invalid := model.TaskPlatform("darwin")
	f := newAssignmentFixture(t, base, nil)
	_, err := f.tasks.Create(f.ctx, actor, f.project.ID, taskcore.CreateTask{Title: "Invalid platform", RequiredPlatform: &invalid})
	requireFault(t, err, "invalid_input")
	f = newAssignmentFixture(t, base, nil)
	_, err = f.tasks.Update(f.ctx, actor, f.project.ID, base.ID, taskcore.UpdateTask{Version: base.Version, RequiredPlatform: platformChange(&invalid), Title: pointer("Must not save")})
	requireFault(t, err, "invalid_input")
	f = newAssignmentFixture(t, base, nil)
	_, err = f.tasks.List(f.ctx, actor, f.project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 10}, CompatiblePlatform: &invalid})
	requireFault(t, err, "invalid_input")
}
func TestTaskPlatformCandidateMatrixAndGraph(t *testing.T) {
	_, base, _ := assignmentTaskModels()
	var inventory []model.Task
	for _, required := range []*model.TaskPlatform{nil, pointer(model.PlatformWindows), pointer(model.PlatformLinux), pointer(model.PlatformMacOS)} {
		for _, allowed := range []bool{false, true} {
			for _, state := range []string{"blocked", "ready", "in_progress", "done"} {
				row := base
				row.ID = fmt.Sprintf("%08x-aaaa-4aaa-8aaa-aaaaaaaaaaaa", len(inventory)+1)
				row.CreatedAt = base.CreatedAt.Add(time.Duration(len(inventory)))
				row.RequiredPlatform = required
				row.AllowAgents = allowed
				row.Ready = state == "ready"
				if state == "in_progress" {
					row.Status = model.TaskInProgress
				}
				if state == "done" {
					row.Status = model.TaskDone
				}
				if state == "blocked" {
					row.BlockedBy = []string{"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}
				}
				inventory = append(inventory, row)
			}
		}
	}
	for _, actual := range []*model.TaskPlatform{nil, pointer(model.PlatformWindows), pointer(model.PlatformLinux), pointer(model.PlatformMacOS)} {
		for _, allowed := range []*bool{nil, pointer(false), pointer(true)} {
			for _, ready := range []*bool{nil, pointer(false), pointer(true)} {
				var rows []model.Task
				for _, row := range inventory {
					if (actual == nil || row.RequiredPlatform == nil || *row.RequiredPlatform == *actual) && (allowed == nil || row.AllowAgents == *allowed) && (ready == nil || row.Ready == *ready) {
						rows = append(rows, row)
					}
				}
				tasks, _, project, principal := assignmentListFixture(t, store.TaskQuery{CompatiblePlatform: actual, AllowAgents: allowed, Ready: ready}, rows)
				page, err := tasks.List(t.Context(), principal, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}, CompatiblePlatform: actual, AllowAgents: allowed, Ready: ready})
				if err != nil || !slices.Equal(assignmentTaskIDs(page.Items), assignmentTaskIDs(rows)) || page.NextCursor != nil {
					t.Fatalf("platform matrix: %#v %v", page, err)
				}
			}
		}
	}
	for _, row := range inventory {
		assignmentGraph(t, row)
	}
}
func TestTaskPlatformFilterPrecedesLimitAndBindsCursor(t *testing.T) {
	_, base, _ := assignmentTaskModels()
	rows := []model.Task{base, base, base}
	for i := range rows {
		rows[i].ID = fmt.Sprintf("%08x-aaaa-4aaa-8aaa-aaaaaaaaaaaa", i+1)
		rows[i].CreatedAt = base.CreatedAt.Add(time.Duration(i))
		rows[i].RequiredPlatform = []*model.TaskPlatform{pointer(model.PlatformLinux), nil, pointer(model.PlatformLinux)}[i]
		rows[i].AllowAgents = true
	}
	tasks, _, project, principal := assignmentListFixture(t, store.TaskQuery{Ready: pointer(true), AllowAgents: pointer(true), CompatiblePlatform: pointer(model.PlatformLinux)}, rows)
	request := taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, Ready: pointer(true), AllowAgents: pointer(true), CompatiblePlatform: pointer(model.PlatformLinux)}
	var ids []string
	for {
		page, err := tasks.List(t.Context(), principal, project.ID, request)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, assignmentTaskIDs(page.Items)...)
		if page.NextCursor == nil {
			break
		}
		for _, platform := range []*model.TaskPlatform{nil, pointer(model.PlatformWindows), pointer(model.PlatformMacOS)} {
			changed := request
			changed.Cursor = page.NextCursor
			changed.CompatiblePlatform = platform
			_, err = tasks.List(t.Context(), principal, project.ID, changed)
			requireFault(t, err, "invalid_input")
		}
		request.Cursor = page.NextCursor
	}
	if !slices.Equal(ids, assignmentTaskIDs(rows)) {
		t.Fatalf("compatible page: %v", ids)
	}
}
func TestTaskPlatformAndManualStartRaceHasOneMutationWinner(t *testing.T) {
	_, before, actor := assignmentTaskModels()
	for _, started := range []bool{false, true} {
		current := before
		current.Version++
		if started {
			current.Status = model.TaskInProgress
		} else {
			current.RequiredPlatform = pointer(model.PlatformWindows)
		}
		f := newAssignmentFixture(t, current, nil)
		var err error
		if started {
			_, err = f.tasks.Update(f.ctx, actor, f.project.ID, current.ID, taskcore.UpdateTask{Version: before.Version, RequiredPlatform: platformChange(pointer(model.PlatformWindows))})
		} else {
			_, err = f.tasks.SetStatus(f.ctx, actor, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: before.Version, Status: model.TaskInProgress})
		}
		requireFault(t, err, "version_conflict")
	}
}
func TestTaskPlatformSurvivesEveryStatusAssignment(t *testing.T) {
	_, base, _ := assignmentTaskModels()
	base.AllowAgents = true
	base.Description = "Preserved materials"
	base.Properties = model.TaskProperties{"pullRequests": []byte(`[{"url":"https://example.com/pr/1","title":"Evidence"}]`)}
	base.DependsOn = []string{"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}
	base.ExternalDependsOn = slices.Clone(base.DependsOn)
	for _, platform := range []*model.TaskPlatform{nil, pointer(model.PlatformWindows), pointer(model.PlatformLinux), pointer(model.PlatformMacOS)} {
		for _, from := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
			for _, to := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
				before := base
				before.RequiredPlatform = platform
				before.Status = from
				before.Ready = from == model.TaskTodo
				got := assignmentStatus(t, before, to)
				if !model.EqualOptional(got.RequiredPlatform, platform) {
					t.Fatalf("status %s->%s changed platform", from, to)
				}
				if from == to {
					if !reflect.DeepEqual(got, before) {
						t.Fatal("same status changed materials")
					}
				} else {
					preserved := got
					preserved.Status, preserved.Version, preserved.UpdatedAt, preserved.StartedAt, preserved.CompletedAt, preserved.Ready = before.Status, before.Version, before.UpdatedAt, before.StartedAt, before.CompletedAt, before.Ready
					if !reflect.DeepEqual(preserved, before) {
						t.Fatalf("status changed materials: %#v", got)
					}
				}
			}
		}
	}
}
