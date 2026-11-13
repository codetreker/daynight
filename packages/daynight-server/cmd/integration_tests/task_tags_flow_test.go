//go:build integration

package main

import (
	"net/http"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

func serverAPITaskTagsNormalFlow(t *testing.T, f *fixture) {
	project := createProject(t, f, "API task tags")
	task := createTask(t, f, project, "Tagged task", map[string]any{"status": "todo"})
	tag := requestJSON[catalogTag](t, f, http.MethodPost, "/api/v1/projects/"+project.ID+"/tags", map[string]any{"name": "Platform"}, http.StatusCreated)
	other := requestJSON[catalogTag](t, f, http.MethodPost, "/api/v1/projects/"+project.ID+"/tags", map[string]any{"name": "Backend"}, http.StatusCreated)
	goal := createTask(t, f, project, "Tagged goal", map[string]any{"type": "goal", "status": "todo", "tagIds": []string{tag.ID}})
	child := createTask(t, f, project, "Tagged child", map[string]any{"type": "task", "parentId": goal.ID, "status": "todo", "assignedTo": f.userID, "tagIds": []string{other.ID}})
	untagged := createTask(t, f, project, "Untagged child", map[string]any{"parentId": goal.ID, "status": "todo"})
	empty := createTask(t, f, project, "Empty tags", map[string]any{"tagIds": []string{}})
	for _, tc := range []struct {
		created api.Task
		want    []taskprotocol.RESTTagReference
	}{
		{goal, []taskprotocol.RESTTagReference{{ID: tag.ID, Name: tag.Name}}},
		{child, []taskprotocol.RESTTagReference{{ID: other.ID, Name: other.Name}}},
		{untagged, []taskprotocol.RESTTagReference{}},
		{empty, []taskprotocol.RESTTagReference{}},
	} {
		read := requestJSON[api.Task](t, f, http.MethodGet, taskPath(tc.created), nil, http.StatusOK)
		if tc.created.ID != read.ID || tc.created.ProjectID != read.ProjectID || tc.created.Type != read.Type || tc.created.Status != read.Status || tc.created.Version != read.Version || !reflect.DeepEqual(tc.created.ParentID, read.ParentID) || !reflect.DeepEqual(tc.created.AssignedTo, read.AssignedTo) || tc.created.AllowAgents != read.AllowAgents || !reflect.DeepEqual(tc.created.Tags, tc.want) || !reflect.DeepEqual(read.Tags, tc.want) {
			t.Fatalf("created task or readback differs: receipt=%+v read=%+v want tags=%+v", tc.created, read, tc.want)
		}
	}
	if goal.Type != "goal" || goal.ParentID != nil || goal.Status != "todo" || child.Type != "task" || child.Status != "todo" || child.ParentID == nil || *child.ParentID != goal.ID || untagged.ParentID == nil || *untagged.ParentID != goal.ID || goal.AssignedTo == nil || *goal.AssignedTo != f.userID || child.AssignedTo == nil || *child.AssignedTo != f.userID || goal.AllowAgents || child.AllowAgents {
		t.Fatalf("goal and child creation fields differ: goal=%+v child=%+v untagged=%+v", goal, child, untagged)
	}
	baseline := requestJSON[api.TaskSync](t, f, http.MethodGet, syncPath(project.ID), nil, http.StatusOK)
	updated := requestJSON[api.Task](t, f, http.MethodPatch, taskPath(task), map[string]any{"version": task.Version, "tagIds": []string{tag.ID}}, http.StatusOK)
	check := func(tags []taskprotocol.RESTTagReference) {
		t.Helper()
		if len(tags) != 1 || tags[0].ID != tag.ID || tags[0].Name != tag.Name {
			t.Fatalf("tag references differ: %+v", tags)
		}
	}
	if updated.ID != task.ID || updated.Version != task.Version+1 {
		t.Fatalf("updated task differs: %+v", updated)
	}
	check(updated.Tags)
	read := requestJSON[api.Task](t, f, http.MethodGet, taskPath(task), nil, http.StatusOK)
	check(read.Tags)
	page := requestJSON[api.TaskPage](t, f, http.MethodGet, taskCollection(project.ID), nil, http.StatusOK)
	check(expectID(t, page.Items, task.ID, func(item api.Task) string { return item.ID }).Tags)
	search := requestJSON[api.TaskSearchPage](t, f, http.MethodPost, taskCollection(project.ID)+"/search", map[string]any{"query": "id:" + task.ID}, http.StatusOK)
	check(expectID(t, search.Items, task.ID, func(item api.TaskSearchItem) string { return item.ID }).Tags)
	delta := requestJSON[api.TaskSync](t, f, http.MethodGet, deltaPath(project.ID, baseline), nil, http.StatusOK)
	summary := expectID(t, delta.Tasks, task.ID, func(item api.TaskViewRecord) string { return item.ID })
	check(summary.Tags)
	if delta.Epoch != baseline.Epoch || summary.Version != resourceVersion(updated.Version) || delta.DependencyStates[task.ID].TaskVersion != summary.Version {
		t.Fatalf("sync differs: %+v", delta)
	}
}
