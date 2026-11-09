package task_test

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"reflect"
	"slices"
	"testing"
	"time"
)

func assignmentStatus(t *testing.T, before model.Task, to model.TaskStatus) model.Task {
	t.Helper()
	f := newAssignmentFixture(t, before, nil)
	if before.Status == model.TaskDone && to != model.TaskDone {
		f.writer.ActiveDependentIDsFn = func(ctx context.Context, id string) ([]string, error) {
			if ctx != f.ctx || id != before.ID {
				t.Fatal("status dependent scope")
			}
			return []string{}, nil
		}
	}
	after := before
	if before.Status != to {
		v := taskcore.CurrentWrite(before)
		v.Status = to
		after = assignmentResult(before, v)
		switch to {
		case model.TaskTodo:
			after.StartedAt = nil
			after.CompletedAt = nil
		case model.TaskInProgress:
			after.StartedAt = &after.UpdatedAt
			after.CompletedAt = nil
		case model.TaskDone:
			after.CompletedAt = &after.UpdatedAt
		}
		f.expectUpdate(v, after)
	}
	got, err := f.tasks.SetStatus(f.ctx, f.principal, f.project.ID, before.ID, taskcore.SetTaskStatus{Version: before.Version, Status: to})
	if err != nil || !reflect.DeepEqual(got, after) {
		t.Fatalf("status preserved metadata: got %#v want %#v err %v", got, after, err)
	}
	return got
}
func assignmentGraph(t *testing.T, row model.Task) model.TaskGraph {
	t.Helper()
	project, _, principal := assignmentTaskModels()
	ctx := t.Context()
	base := newTaskMockBase(t, "metadata-graph")
	projects := &projectReaderMock{taskMockBase: base.withLabel("project"), ProjectAccessFn: func(actual context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		if actual != ctx || p != principal || id != project.ID {
			t.Fatal("graph authorization scope")
		}
		return taskMockAccess(project, principal), nil
	}, ProjectFn: func(actual context.Context, id string) (model.Project, error) {
		if actual != ctx || id != project.ID {
			t.Fatal("graph Project scope")
		}
		return project, nil
	}}
	selection := store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, LiveOnly: true}
	reader := &taskReaderMock{taskMockBase: base.withLabel("task"), TaskPresenceFn: func(actual context.Context, pid, id string) (store.TaskPresence, error) {
		if actual != ctx || pid != project.ID || id != row.ID {
			t.Fatal("graph root scope")
		}
		return store.TaskPresence{Found: true}, nil
	}, TaskGraphTasksFn: func(actual context.Context, pid, id string, s store.TaskGraphSelection, preview int) ([]model.GraphTask, error) {
		if actual != ctx || pid != project.ID || id != row.ID || s != selection || preview != 160 {
			t.Fatal("graph projection selection")
		}
		return []model.GraphTask{{ID: row.ID, Status: row.Status, AllowAgents: row.AllowAgents, RequiredPlatform: row.RequiredPlatform, AssignedTo: row.AssignedTo, Ready: row.Ready}}, nil
	}}
	scope := &taskSnapshotScopeMock{taskMockBase: base.withLabel("snapshot"), ProjectDAOFn: func() store.ProjectReader { return projects }, TaskDAOFn: func() store.TaskReader { return reader }, ObservedAtFn: func(actual context.Context) (time.Time, error) {
		if actual != ctx {
			t.Fatal("graph clock scope")
		}
		return row.UpdatedAt, nil
	}}
	database := &taskStoreMock{taskMockBase: base.withLabel("store"), ReadSnapshotFn: func(actual context.Context, work func(store.SnapshotScope) error) error {
		if actual != ctx {
			t.Fatal("graph snapshot scope")
		}
		return work(scope)
	}}
	graph, err := taskservice.NewTasks(database).Graph(ctx, principal, project.ID, row.ID)
	if err != nil || len(graph.Tasks) != 1 || graph.Tasks[0].ID != row.ID || graph.Tasks[0].AllowAgents != row.AllowAgents || !model.EqualOptional(graph.Tasks[0].RequiredPlatform, row.RequiredPlatform) {
		t.Fatalf("graph metadata: %#v %v", graph, err)
	}
	return graph
}
func TestTaskAgentPermissionUpdatesAndStatusRemainIndependent(t *testing.T) {
	_, base, actor := assignmentTaskModels()
	for _, allowed := range []bool{false, true} {
		t.Run(map[bool]string{false: "manual", true: "automatic"}[allowed], func(t *testing.T) {
			before := base
			before.AllowAgents = false
			if allowed {
				v := taskcore.CurrentWrite(before)
				v.AllowAgents = true
				after := assignmentResult(before, v)
				f := newAssignmentFixture(t, before, nil)
				f.expectUpdate(v, after)
				got, err := f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AllowAgents: &allowed})
				if err != nil || !reflect.DeepEqual(got, after) {
					t.Fatalf("permission update: %#v %v", got, err)
				}
				before = after
			}
			f := newAssignmentFixture(t, before, nil)
			got, err := f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AllowAgents: &allowed})
			if err != nil || !reflect.DeepEqual(got, before) {
				t.Fatalf("same permission: %#v %v", got, err)
			}
			f = newAssignmentFixture(t, before, nil)
			_, err = f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version + 1, AllowAgents: &allowed})
			requireFault(t, err, "version_conflict")
			v := taskcore.CurrentWrite(before)
			v.Description = "Preserved metadata"
			after := assignmentResult(before, v)
			f = newAssignmentFixture(t, before, nil)
			f.expectUpdate(v, after)
			got, err = f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, Description: &v.Description})
			if err != nil || !reflect.DeepEqual(got, after) {
				t.Fatalf("ordinary metadata: %#v %v", got, err)
			}
			before = assignmentStatus(t, after, model.TaskTodo)
			before = assignmentStatus(t, before, model.TaskInProgress)
			f = newAssignmentFixture(t, before, nil)
			got, err = f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AllowAgents: &allowed})
			if err != nil || !reflect.DeepEqual(got, before) {
				t.Fatalf("active same permission: %#v %v", got, err)
			}
			toggle := !allowed
			f = newAssignmentFixture(t, before, nil)
			_, err = f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AllowAgents: &toggle, Title: pointer("Must not partly save")})
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
			v.AllowAgents = toggle
			after = assignmentResult(before, v)
			f = newAssignmentFixture(t, before, nil)
			f.expectUpdate(v, after)
			got, err = f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AllowAgents: &toggle})
			if err != nil || !reflect.DeepEqual(got, after) || !reflect.DeepEqual(got.StartedAt, before.StartedAt) || !reflect.DeepEqual(got.CompletedAt, before.CompletedAt) {
				t.Fatalf("completed permission: %#v %v", got, err)
			}
		})
	}
}
func TestTaskAgentPermissionFilterPrecedesLimitAndBindsCursor(t *testing.T) {
	_, base, _ := assignmentTaskModels()
	var all []model.Task
	for _, allowed := range []bool{false, true} {
		rows := []model.Task{base, base, base}
		for i := range rows {
			rows[i].ID = []string{"55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"}[i]
			if allowed {
				rows[i].ID = []string{"88888888-8888-4888-8888-888888888888", "99999999-9999-4999-8999-999999999999", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}[i]
			}
			rows[i].CreatedAt = base.CreatedAt.Add(time.Duration(len(all) + i))
			rows[i].AllowAgents = allowed
		}
		all = append(all, rows...)
		tasks, _, project, principal := assignmentListFixture(t, store.TaskQuery{Ready: pointer(true), AllowAgents: &allowed}, rows)
		request := taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, Ready: pointer(true), AllowAgents: &allowed}
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
			changed := request
			changed.Cursor = page.NextCursor
			changed.AllowAgents = nil
			_, err = tasks.List(t.Context(), principal, project.ID, changed)
			requireFault(t, err, "invalid_input")
			changed.AllowAgents = pointer(!allowed)
			_, err = tasks.List(t.Context(), principal, project.ID, changed)
			requireFault(t, err, "invalid_input")
			request.Cursor = page.NextCursor
		}
		if !slices.Equal(ids, assignmentTaskIDs(rows)) {
			t.Fatalf("permission page: %v", ids)
		}
	}
	tasks, _, project, principal := assignmentListFixture(t, store.TaskQuery{}, all)
	page, err := tasks.List(t.Context(), principal, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 10}})
	if err != nil || len(page.Items) != 6 {
		t.Fatalf("omitted permission: %#v %v", page, err)
	}
	for _, row := range all {
		assignmentGraph(t, row)
	}
}
func TestTaskAgentPermissionAndStartRaceHasOneMutationWinner(t *testing.T) {
	_, before, actor := assignmentTaskModels()
	for _, started := range []bool{false, true} {
		current := before
		current.Version++
		if started {
			current.Status = model.TaskInProgress
		} else {
			current.AllowAgents = true
		}
		f := newAssignmentFixture(t, current, nil)
		var err error
		if started {
			_, err = f.tasks.Update(f.ctx, actor, f.project.ID, current.ID, taskcore.UpdateTask{Version: before.Version, AllowAgents: pointer(true)})
		} else {
			_, err = f.tasks.SetStatus(f.ctx, actor, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: before.Version, Status: model.TaskInProgress})
		}
		requireFault(t, err, "version_conflict")
	}
}
