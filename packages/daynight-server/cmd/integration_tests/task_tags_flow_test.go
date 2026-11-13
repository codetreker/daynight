//go:build integration

package main

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

func serverAPITaskTagsNormalFlow(t *testing.T, f *fixture) {
	project := createProject(t, f, "API task tags")
	task := createTask(t, f, project, "Tagged task", map[string]any{"status": "todo"})
	tag := requestJSON[catalogTag](t, f, http.MethodPost, "/api/v1/projects/"+project.ID+"/tags", map[string]any{"name": "Platform"}, http.StatusCreated)
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
	second := createTask(t, f, project, "Another tagged task", map[string]any{"status": "todo"})
	requestJSON[api.Task](t, f, http.MethodPatch, taskPath(second), map[string]any{"version": second.Version, "tagIds": []string{tag.ID}}, http.StatusOK)
	createTask(t, f, project, "Untagged task", map[string]any{"status": "todo"})
	filter := url.Values{"tagIds": {tag.ID}, "ready": {"true"}, "limit": {"1"}}
	seen := map[string]bool{}
	for {
		page := requestJSON[api.TaskPage](t, f, http.MethodGet, taskCollection(project.ID)+"?"+filter.Encode(), nil, http.StatusOK)
		if len(page.Items) != 1 || seen[page.Items[0].ID] {
			t.Fatalf("filtered page differs: %+v", page)
		}
		check(page.Items[0].Tags)
		seen[page.Items[0].ID] = true
		if page.NextCursor == nil {
			break
		}
		if len(seen) >= 2 {
			t.Fatal("filtered pagination did not end")
		}
		filter.Set("cursor", *page.NextCursor)
	}
	if len(seen) != 2 || !seen[task.ID] || !seen[second.ID] {
		t.Fatalf("filtered task identities differ: %+v", seen)
	}
}
