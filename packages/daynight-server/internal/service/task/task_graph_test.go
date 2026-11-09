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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func taskReadGraphTask(id, title string, status model.TaskStatus, dependencies ...string) model.GraphTask {
	instant := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	return model.GraphTask{ID: id, TitlePreview: title, Status: status, DependsOn: append([]string{}, dependencies...), ExternalDependsOn: []string{}, BlockedBy: append([]string{}, dependencies...), Ready: status == model.TaskTodo && len(dependencies) == 0, CreatedAt: instant, UpdatedAt: instant}
}

func (f *taskReadFixture) graph(root string, presence store.TaskPresence, size store.TaskGraphSize, tasks []model.GraphTask) *taskservice.Tasks {
	want := store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, IncludeExternalEdges: true, LiveOnly: true}
	f.reader.TaskPresenceFn = func(ctx context.Context, projectID, id string) (store.TaskPresence, error) {
		f.requireProject(ctx, projectID)
		if id != root {
			f.t.Fatalf("graph root changed: %s", id)
		}
		return presence, nil
	}
	if presence.Found && presence.DeletedAt == nil {
		f.reader.TaskGraphProjectionSizeFn = func(ctx context.Context, projectID, id string, selection store.TaskGraphSelection) (store.TaskGraphSize, error) {
			f.requireProject(ctx, projectID)
			if id != root || selection != want {
				f.t.Fatalf("graph count selection changed: %s %#v", id, selection)
			}
			return size, nil
		}
	} else {
		f.reader.TaskGraphProjectionSizeFn = nil
	}
	f.reader.TaskGraphTasksFn = nil
	if tasks != nil {
		f.reader.TaskGraphTasksFn = func(ctx context.Context, projectID, id string, selection store.TaskGraphSelection, characters int) ([]model.GraphTask, error) {
			f.requireProject(ctx, projectID)
			if id != root || selection != want || characters != projection.TitlePreviewCharacters {
				f.t.Fatal("graph projection selection changed")
			}
			return tasks, nil
		}
	}
	return taskservice.NewTasks(f.store)
}

func TestTaskGraphScopedProjectionAndSummary(t *testing.T) {
	f := newTaskReadFixture(t)
	_, err := f.graph(taskReadID(99), store.TaskPresence{}, store.TaskGraphSize{}, nil).Graph(f.ctx, f.principal, strings.ToUpper(f.project.ID), taskReadID(99))
	requireFault(t, err, "not_found")
	done := taskReadGraphTask(taskReadID(1), "Done", model.TaskDone)
	active := taskReadGraphTask(taskReadID(2), "Active", model.TaskInProgress, done.ID)
	active.BlockedBy = []string{}
	ready := taskReadGraphTask(taskReadID(3), "Ready", model.TaskTodo, done.ID)
	ready.Ready, ready.BlockedBy = true, []string{}
	blocked := taskReadGraphTask(taskReadID(4), "Blocked", model.TaskTodo, active.ID, ready.ID)
	queued := taskReadGraphTask(taskReadID(5), "Queued", model.TaskTodo, done.ID)
	queued.Ready, queued.BlockedBy = true, []string{}
	queuedBlocked := taskReadGraphTask(taskReadID(6), "Queued blocked", model.TaskTodo, active.ID)
	original := []model.GraphTask{done, active, ready, blocked, queued, queuedBlocked}
	tasks := f.graph(done.ID, store.TaskPresence{Found: true}, store.TaskGraphSize{NodeCount: 6, EdgeCount: 6}, original)
	graph, err := tasks.Graph(f.ctx, f.principal, strings.ToUpper(f.project.ID), strings.ToUpper(done.ID))
	want := model.TaskGraphSummary{Total: 6, Todo: 4, InProgress: 1, Done: 1, Ready: 2, Blocked: 2}
	if err != nil || graph.Summary != want || !reflect.DeepEqual(graph.Tasks, original) || !reflect.DeepEqual(graph.Project, f.project) || graph.ObservedAt != f.observed || f.reads != 2 {
		t.Fatalf("complete scoped graph: %#v, %v", graph, err)
	}
	_, err = tasks.Graph(f.ctx, f.principal, "invalid", done.ID)
	requireFault(t, err, "invalid_input")
	f.projectReader.ProjectAccessFn = func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		f.requireActive()
		if ctx != f.ctx || p != f.principal || id != "00000000-0000-0000-0000-000000000000" {
			t.Fatal("missing Project lookup changed")
		}
		return model.ProjectAccess{}, model.ErrNotFound
	}
	_, err = tasks.Graph(f.ctx, f.principal, "00000000-0000-0000-0000-000000000000", done.ID)
	fault := requireFault(t, err, "not_found")
	if !errors.Is(fault, model.ErrNotFound) || fault.GraphLimit != nil {
		t.Fatalf("missing graph cause: %#v", fault)
	}
}

func taskReadConnectedGraph(nodes, edges int) []model.GraphTask {
	tasks := make([]model.GraphTask, nodes)
	for index := range tasks {
		tasks[index] = taskReadGraphTask(taskReadID(index+1), fmt.Sprintf("Task %d", index+1), model.TaskTodo)
	}
	count := 0
	for index := 1; index < nodes; index++ {
		tasks[index].DependsOn = append(tasks[index].DependsOn, tasks[index-1].ID)
		count++
	}
	for target := 2; target < nodes && count < edges; target++ {
		for predecessor := 0; predecessor < target-1 && count < edges; predecessor++ {
			tasks[target].DependsOn = append(tasks[target].DependsOn, tasks[predecessor].ID)
			count++
		}
	}
	for index := range tasks {
		tasks[index].BlockedBy = slices.Clone(tasks[index].DependsOn)
		tasks[index].Ready = len(tasks[index].DependsOn) == 0
	}
	return tasks
}

func TestTaskGraphExactLimitsAndIndependentRejections(t *testing.T) {
	for _, test := range []struct {
		nodes, edges int
		refused      bool
	}{{1000, 5000, false}, {1001, 1000, true}, {101, 5001, true}} {
		t.Run(fmt.Sprintf("%d_nodes_%d_edges", test.nodes, test.edges), func(t *testing.T) {
			f := newTaskReadFixture(t)
			var projected []model.GraphTask
			if !test.refused {
				projected = taskReadConnectedGraph(test.nodes, test.edges)
			}
			tasks := f.graph(taskReadID(1), store.TaskPresence{Found: true}, store.TaskGraphSize{NodeCount: int64(test.nodes), EdgeCount: int64(test.edges)}, projected)
			graph, err := tasks.Graph(f.ctx, f.principal, f.project.ID, taskReadID(1))
			if test.refused {
				fault := requireFault(t, err, "graph_limit_exceeded")
				want := &model.GraphLimitDetails{NodeCount: int64(test.nodes), EdgeCount: int64(test.edges), MaxNodes: 1000, MaxEdges: 5000}
				if !reflect.DeepEqual(fault.GraphLimit, want) || !reflect.DeepEqual(graph, model.TaskGraph{}) {
					t.Fatalf("inaccurate capacity refusal: %#v %#v", fault, graph)
				}
				return
			}
			edges := 0
			for _, task := range graph.Tasks {
				edges += len(task.DependsOn)
			}
			if err != nil || len(graph.Tasks) != 1000 || edges != 5000 || graph.Summary != (model.TaskGraphSummary{Total: 1000, Todo: 1000, Ready: 1, Blocked: 999}) {
				t.Fatalf("exact limit truncated: %#v edges=%d %v", graph.Summary, edges, err)
			}
		})
	}
}

func TestTaskGraphSnapshotResponsesRemainIndependent(t *testing.T) {
	f := newTaskReadFixture(t)
	predecessor := taskReadGraphTask(taskReadID(1), "Predecessor", model.TaskTodo)
	dependent := taskReadGraphTask(taskReadID(2), "Dependent", model.TaskTodo, predecessor.ID)
	oldTasks := []model.GraphTask{predecessor, dependent}
	tasks := f.graph(predecessor.ID, store.TaskPresence{Found: true}, store.TaskGraphSize{NodeCount: 2, EdgeCount: 1}, oldTasks)
	old, err := tasks.Graph(f.ctx, f.principal, f.project.ID, predecessor.ID)
	if err != nil || !reflect.DeepEqual(old.Tasks, oldTasks) || old.Summary != (model.TaskGraphSummary{Total: 2, Todo: 2, Ready: 1, Blocked: 1}) {
		t.Fatalf("old snapshot: %#v %v", old, err)
	}
	completed := predecessor
	completed.TitlePreview, completed.Status, completed.Ready = "Completed", model.TaskDone, false
	ready := dependent
	ready.Ready, ready.BlockedBy = true, []string{}
	freshTasks := []model.GraphTask{completed, ready, taskReadGraphTask(taskReadID(3), "New", model.TaskTodo, dependent.ID)}
	tasks = f.graph(predecessor.ID, store.TaskPresence{Found: true}, store.TaskGraphSize{NodeCount: 3, EdgeCount: 2}, freshTasks)
	fresh, err := tasks.Graph(f.ctx, f.principal, f.project.ID, predecessor.ID)
	if err != nil || !reflect.DeepEqual(fresh.Tasks, freshTasks) || fresh.Summary != (model.TaskGraphSummary{Total: 3, Todo: 2, Done: 1, Ready: 1, Blocked: 1}) || !reflect.DeepEqual(old.Tasks, oldTasks) || f.reads != 2 {
		t.Fatalf("independent fresh snapshot: %#v %v", fresh, err)
	}
}

func TestTaskGraphOneLayerExternalPrerequisitesAndOrdinaryBranches(t *testing.T) {
	x := taskReadGraphTask(taskReadID(2), "External context", model.TaskTodo, taskReadID(1))
	a := taskReadGraphTask(taskReadID(4), "Chain root", model.TaskTodo)
	b := taskReadGraphTask(taskReadID(5), "Chain branch B", model.TaskTodo, x.ID, a.ID)
	b.ExternalDependsOn = []string{x.ID}
	c := taskReadGraphTask(taskReadID(6), "Chain branch C", model.TaskTodo, a.ID)
	d := taskReadGraphTask(taskReadID(7), "Chain join", model.TaskTodo, b.ID, c.ID)
	component := []model.GraphTask{x, a, b, c, d}
	for _, root := range []string{a.ID, b.ID, c.ID, d.ID} {
		f := newTaskReadFixture(t)
		tasks := f.graph(root, store.TaskPresence{Found: true}, store.TaskGraphSize{NodeCount: 5, EdgeCount: 6}, component)
		graph, err := tasks.Graph(f.ctx, f.principal, strings.ToUpper(f.project.ID), strings.ToUpper(root))
		if err != nil || !reflect.DeepEqual(graph.Tasks, component) || graph.Summary != (model.TaskGraphSummary{Total: 5, Todo: 5, Ready: 1, Blocked: 4}) {
			t.Fatalf("component or external context altered: %#v %v", graph, err)
		}
	}
	for _, test := range []struct {
		root  string
		edges int64
		tasks []model.GraphTask
	}{
		{root: x.ID, edges: 2, tasks: []model.GraphTask{taskReadGraphTask(taskReadID(1), "External predecessor", model.TaskTodo), x, taskReadGraphTask(taskReadID(3), "External chain successor", model.TaskTodo, x.ID)}},
		{root: taskReadID(9), tasks: []model.GraphTask{taskReadGraphTask(taskReadID(9), "Isolated", model.TaskTodo)}},
	} {
		f := newTaskReadFixture(t)
		graph, err := f.graph(test.root, store.TaskPresence{Found: true}, store.TaskGraphSize{NodeCount: int64(len(test.tasks)), EdgeCount: test.edges}, test.tasks).Graph(f.ctx, f.principal, f.project.ID, test.root)
		if err != nil || !reflect.DeepEqual(graph.Tasks, test.tasks) {
			t.Fatalf("scoped component changed: %#v %v", graph, err)
		}
	}
}

func TestTaskGraphIgnoresUnrelatedProjectCapacityAndRefusesDeletedRoot(t *testing.T) {
	f := newTaskReadFixture(t)
	isolated := taskReadGraphTask(taskReadID(1), "Selected isolated task", model.TaskTodo)
	tasks := f.graph(isolated.ID, store.TaskPresence{Found: true}, store.TaskGraphSize{NodeCount: 1}, []model.GraphTask{isolated})
	graph, err := tasks.Graph(f.ctx, f.principal, f.project.ID, isolated.ID)
	if err != nil || !reflect.DeepEqual(graph.Tasks, []model.GraphTask{isolated}) {
		t.Fatalf("scoped graph: %#v %v", graph, err)
	}
	_, err = tasks.Graph(f.ctx, f.principal, f.project.ID, "invalid")
	requireFault(t, err, "invalid_input")
	deleted := f.observed
	tasks = f.graph(isolated.ID, store.TaskPresence{Found: true, DeletedAt: &deleted}, store.TaskGraphSize{}, nil)
	graph, err = tasks.Graph(f.ctx, f.principal, f.project.ID, isolated.ID)
	fault := requireFault(t, err, "task_deleted")
	if !errors.Is(fault, model.ErrTaskDeleted) || !reflect.DeepEqual(graph, model.TaskGraph{}) {
		t.Fatalf("deleted root leaked graph: %#v %v", graph, err)
	}
}
