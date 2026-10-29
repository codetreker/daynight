package service

import (
	"context"
	"reflect"
	"slices"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func TestTaskAgentPermissionUpdatesAndStatusRemainIndependent(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	ctx := context.Background()
	for _, allowed := range []bool{false, true} {
		task := createTask(t, tasks, principal, project.ID, "Permission status")
		if task.AllowAgents {
			t.Fatal("new task permits automatic execution")
		}
		task = updateTask(t, tasks, principal, task, UpdateTask{AllowAgents: &allowed})
		if task.AllowAgents != allowed || task.Status != core.TaskTodo || !task.Ready {
			t.Fatalf("permission changed status: %#v", task)
		}
		noOp := updateTask(t, tasks, principal, task, UpdateTask{AllowAgents: &allowed})
		if !reflect.DeepEqual(noOp, task) {
			t.Fatal("same-value permission changed resource")
		}
		_, err := tasks.Update(ctx, principal, project.ID, task.ID, UpdateTask{Version: task.Version + 1, AllowAgents: &allowed})
		requireFault(t, err, "version_conflict")
		task = updateTask(t, tasks, principal, task, UpdateTask{Description: pointer("Preserved metadata"), Properties: core.TaskPropertiesPatch{PullRequests: pointer([]core.PullRequestProperty{{URL: "https://example.com/pr/1", Title: "Evidence"}})}})

		if !task.Ready || task.AllowAgents != allowed {
			t.Fatal("metadata edit changed permission or readiness")
		}
		task = setStatusTask(t, tasks, principal, task, core.TaskTodo)
		if task.AllowAgents != allowed {
			t.Fatal("same-status request changed permission")
		}
		task = startTask(t, tasks, principal, task)
		if task.AllowAgents != allowed || task.StartedAt == nil {
			t.Fatal("explicit manual start must preserve either permission")
		}
		if noOp := updateTask(t, tasks, principal, task, UpdateTask{AllowAgents: &allowed}); !reflect.DeepEqual(noOp, task) {
			t.Fatal("active same-value request changed resource")
		}
		toggle := !allowed
		_, err = tasks.Update(ctx, principal, project.ID, task.ID, UpdateTask{Version: task.Version, AllowAgents: &toggle, Title: pointer("Must not partly save")})
		requireFault(t, err, "invalid_transition")
		assertTaskUnchanged(t, tasks, principal, task)
		edited := updateTask(t, tasks, principal, task, UpdateTask{Description: pointer("Running metadata")})
		if edited.AllowAgents != allowed || !reflect.DeepEqual(edited.StartedAt, task.StartedAt) || edited.CompletedAt != nil {
			t.Fatal("ordinary metadata changed permission/timing")
		}
		task = finishTask(t, tasks, principal, edited)
		changed := updateTask(t, tasks, principal, task, UpdateTask{AllowAgents: &toggle})
		if changed.AllowAgents != toggle || !reflect.DeepEqual(changed.StartedAt, task.StartedAt) || !reflect.DeepEqual(changed.CompletedAt, task.CompletedAt) || !reflect.DeepEqual(changed.Properties, task.Properties) {
			t.Fatal("completed permission edit changed historical execution or properties")
		}
	}
}

func TestTaskAgentPermissionFilterPrecedesLimitAndBindsCursor(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	ctx := context.Background()
	var permitted, manual []string
	for index := range 6 {
		task := createTask(t, tasks, principal, project.ID, "Permission candidate")
		if index >= 3 {
			task = updateTask(t, tasks, principal, task, UpdateTask{AllowAgents: pointer(true)})
			permitted = append(permitted, task.ID)
		} else {
			manual = append(manual, task.ID)
		}
	}
	for _, allowed := range []bool{false, true} {
		request := TaskListRequest{PageRequest: PageRequest{Limit: 1}, Ready: pointer(true), AllowAgents: &allowed}
		var ids []string
		for {
			page, err := tasks.List(ctx, principal, project.ID, request)
			if err != nil {
				t.Fatal(err)
			}
			for _, task := range page.Items {
				if task.AllowAgents != allowed || !task.Ready {
					t.Fatalf("permission filter mismatch: %#v", task)
				}
				ids = append(ids, task.ID)
			}
			if page.NextCursor == nil {
				break
			}
			changed := request
			changed.Cursor = page.NextCursor
			changed.AllowAgents = nil
			_, err = tasks.List(ctx, principal, project.ID, changed)
			requireFault(t, err, "invalid_input")
			changed.AllowAgents = pointer(!allowed)
			_, err = tasks.List(ctx, principal, project.ID, changed)
			requireFault(t, err, "invalid_input")
			request.Cursor = page.NextCursor
		}
		want := manual
		if allowed {
			want = permitted
		}
		if !slices.Equal(ids, want) {
			t.Fatalf("bounded filter hid candidates: got %v want %v", ids, want)
		}
	}
	all, err := tasks.List(ctx, principal, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 10}})
	if err != nil || len(all.Items) != 6 {
		t.Fatalf("omitted permission filter changed full inventory: %v", err)
	}
	for _, original := range all.Items {
		graph, err := tasks.Graph(ctx, principal, project.ID, original.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(graph.Tasks) != 1 || graph.Tasks[0].ID != original.ID || graph.Tasks[0].AllowAgents != original.AllowAgents {
			t.Fatalf("graph lost permission: %#v", graph)
		}
	}

}

func TestTaskAgentPermissionAndStartRaceHasOneMutationWinner(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	before := createTask(t, tasks, principal, project.ID, "Permission race")
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (core.Task, error) {
			return tasks.Update(ctx, principal, project.ID, before.ID, UpdateTask{Version: before.Version, AllowAgents: pointer(true)})
		},
		func(ctx context.Context) (core.Task, error) {
			return tasks.SetStatus(ctx, principal, project.ID, before.ID, SetTaskStatus{Version: before.Version, Status: core.TaskInProgress})
		})
	assertOneTaskWinner(t, results, "version_conflict")
	after, err := tasks.Get(context.Background(), principal, project.ID, before.ID)
	if err != nil || after.Version != before.Version+1 {
		t.Fatalf("race committed incorrectly: %#v %v", after, err)
	}
	if after.Status == core.TaskInProgress {
		if after.AllowAgents || after.StartedAt == nil {
			t.Fatal("start winner changed permission or omitted timing")
		}
	} else if after.Status != core.TaskTodo || !after.AllowAgents || after.StartedAt != nil {
		t.Fatalf("permission winner changed status: %#v", after)
	}
}
