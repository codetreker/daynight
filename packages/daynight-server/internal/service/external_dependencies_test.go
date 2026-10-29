package service

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func TestExternalDependenciesSurviveMetadataAndStatus(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	prerequisite := createTask(t, tasks, principal, project.ID, "Prerequisite")
	prerequisite = finishTask(t, tasks, principal, startTask(t, tasks, principal, prerequisite))
	target := createTask(t, tasks, principal, project.ID, "Target", prerequisite.ID)
	target = updateTask(t, tasks, principal, target, UpdateTask{AllowAgents: pointer(true)})
	if _, err := database.Pool.Exec(ctx, `UPDATE task_dependencies SET external=true WHERE project_id=$1 AND task_id=$2`, project.ID, target.ID); err != nil {
		t.Fatal(err)
	}
	target, err := tasks.Get(ctx, principal, project.ID, target.ID)
	if err != nil || !slices.Equal(target.ExternalDependsOn, []string{prerequisite.ID}) {
		t.Fatalf("seeded classification not readable: %#v, %v", target, err)
	}
	for _, input := range []UpdateTask{{Title: pointer("Renamed")}, {Description: pointer("Preserved classification")}, {Properties: propertyPatch(core.PullRequestProperty{URL: "https://example.com/pr/1", Title: "Preserved"})}} {
		before := target
		target = updateTask(t, tasks, principal, target, input)
		if !target.AllowAgents || !slices.Equal(target.ExternalDependsOn, before.ExternalDependsOn) || target.Version != before.Version+1 || !reflect.DeepEqual(target.StartedAt, before.StartedAt) || !reflect.DeepEqual(target.CompletedAt, before.CompletedAt) {
			t.Fatalf("ordinary edit lost classification or timing: %#v", target)
		}
	}
	noop := updateTask(t, tasks, principal, target, UpdateTask{DependsOn: pointer([]string{strings.ToUpper(prerequisite.ID)})})
	if !reflect.DeepEqual(noop, target) {
		t.Fatal("equivalent dependency replacement changed classification or version")
	}
	_, err = tasks.Update(ctx, principal, project.ID, target.ID, UpdateTask{Version: target.Version - 1, DependsOn: &target.DependsOn})
	requireFault(t, err, "version_conflict")
	for _, status := range []core.TaskStatus{core.TaskDone, core.TaskTodo, core.TaskInProgress} {
		target = setStatusTask(t, tasks, principal, target, status)
		if !target.AllowAgents || !slices.Equal(target.ExternalDependsOn, []string{prerequisite.ID}) {
			t.Fatalf("status update lost classification: %#v", target)
		}
	}
	started := target.StartedAt
	target = updateTask(t, tasks, principal, target, UpdateTask{Description: pointer("Active edit")})
	if started == nil || !reflect.DeepEqual(target.StartedAt, started) || target.CompletedAt != nil {
		t.Fatal("active metadata edit changed the execution interval")
	}
	target = finishTask(t, tasks, principal, target)
	if !target.AllowAgents || !slices.Equal(target.ExternalDependsOn, []string{prerequisite.ID}) || !reflect.DeepEqual(target.StartedAt, started) || target.CompletedAt == nil {
		t.Fatalf("completion lost classification or timing: %#v", target)
	}
	page, err := tasks.List(ctx, principal, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 10}})
	if err != nil || len(page.Items) != 2 || !reflect.DeepEqual(page.Items[1], target) {
		t.Fatalf("list lost completed classification: %#v, %v", page, err)
	}
	graph, err := tasks.Graph(ctx, principal, project.ID, target.ID)
	if err != nil || len(graph.Tasks) != 2 || !slices.Equal(graph.Tasks[1].ExternalDependsOn, target.ExternalDependsOn) || graph.ObservedAt.IsZero() {
		t.Fatalf("graph lost classification/observation: %#v, %v", graph, err)
	}
}

func TestExternalDependenciesReplacementRetainsSurvivorsAndScheduling(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	a := createTask(t, tasks, principal, project.ID, "A")
	b := createTask(t, tasks, principal, project.ID, "B")
	c := createTask(t, tasks, principal, project.ID, "C")
	target := createTask(t, tasks, principal, project.ID, "Target", a.ID, b.ID)
	if _, err := database.Pool.Exec(ctx, `UPDATE task_dependencies SET external=true WHERE project_id=$1 AND task_id=$2`, project.ID, target.ID); err != nil {
		t.Fatal(err)
	}
	target = updateTask(t, tasks, principal, target, UpdateTask{DependsOn: pointer([]string{b.ID, c.ID})})
	if !slices.Equal(target.ExternalDependsOn, []string{b.ID}) {
		t.Fatalf("replacement lost surviving flag or classified a new edge: %#v", target)
	}

	_, err := tasks.SetStatus(ctx, principal, project.ID, target.ID, SetTaskStatus{Version: target.Version, Status: core.TaskInProgress})
	requireFault(t, err, "dependency_unsatisfied")
	assertTaskUnchanged(t, tasks, principal, target)
	_, err = tasks.Update(ctx, principal, project.ID, b.ID, UpdateTask{Version: b.Version, DependsOn: pointer([]string{target.ID})})
	requireFault(t, err, "dependency_cycle")
	assertTaskUnchanged(t, tasks, principal, b)
	for _, predecessor := range []core.Task{b, c} {
		finishTask(t, tasks, principal, startTask(t, tasks, principal, predecessor))
	}
	ready := true
	page, err := tasks.List(ctx, principal, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 10}, Ready: &ready})
	if err != nil || len(page.Items) != 2 || page.Items[1].ID != target.ID || !slices.Equal(page.Items[1].ExternalDependsOn, []string{b.ID}) {
		t.Fatalf("ready read omitted external prerequisite: %#v, %v", page, err)
	}
	target = updateTask(t, tasks, principal, page.Items[1], UpdateTask{DependsOn: pointer([]string{})})
	if len(target.ExternalDependsOn) != 0 || target.ExternalDependsOn == nil || len(target.DependsOn) != 0 {
		t.Fatalf("removed edges retained external markers: %#v", target)
	}
	target = updateTask(t, tasks, principal, target, UpdateTask{DependsOn: pointer([]string{b.ID})})
	if len(target.ExternalDependsOn) != 0 {
		t.Fatal("re-added relationship retained a removed marker")
	}
}

func TestExternalDependencyPartialWriteCancellationRollsBack(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	ctx := context.Background()
	predecessor := createTask(t, tasks, principal, project.ID, "Prerequisite")
	target := createTask(t, tasks, principal, project.ID, "Target", predecessor.ID)
	if _, err := database.Pool.Exec(ctx, `UPDATE task_dependencies SET external=true WHERE task_id=$1`, target.ID); err != nil {
		t.Fatal(err)
	}
	target, err := tasks.Get(ctx, principal, project.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	canceled, cancel := context.WithCancel(ctx)
	defer cancel()
	traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "INSERT INTO task_dependencies") }, end: cancel})
	_, err = traced.Update(canceled, principal, project.ID, target.ID, UpdateTask{Version: target.Version, Title: pointer("Rolled back")})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("edge reinsertion lost cancellation: %v", err)
	}
	assertOperational(t, err)
	assertTaskUnchanged(t, tasks, principal, target)
}
