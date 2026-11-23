//go:build integration

package main

import (
	"net/http"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	protocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/goaldependencies"
)

func serverAPIGoalDependenciesNormalFlow(t *testing.T, f *fixture) {
	project := createProject(t, f, "API Goal relationships")
	upstream := createTask(t, f, project, "Upstream Goal", map[string]any{"type": "goal", "status": "done"})
	downstream := createTask(t, f, project, "Downstream Goal", map[string]any{"type": "goal"})
	path := taskPath(downstream) + "/goal-dependencies"
	initial := requestJSON[protocol.Relationships](t, f, http.MethodGet, path, nil, http.StatusOK)
	if initial.GoalID != downstream.ID || !initial.CanEdit || initial.Revision == nil || *initial.Revision != "1" || initial.CompletionBlocked || len(initial.Prerequisites) != 0 || len(initial.Successors) != 0 || initial.NextCursor != nil {
		t.Fatalf("initial relationships: %+v", initial)
	}
	baseline := requestJSON[api.TaskSync](t, f, http.MethodGet, syncPath(project.ID), nil, http.StatusOK)
	if baseline.Mode != "snapshot" {
		t.Fatalf("initial Goal sync mode: %s", baseline.Mode)
	}
	deltaSince := func(since time.Time) api.TaskSync {
		query := url.Values{"epoch": {baseline.Epoch}, "since": {since.Format(time.RFC3339Nano)}}
		result := requestJSON[api.TaskSync](t, f, http.MethodGet, syncPath(project.ID)+"?"+query.Encode(), nil, http.StatusOK)
		if result.Mode != "delta" || result.Epoch != baseline.Epoch {
			t.Fatalf("Goal delta changed mode or epoch: %+v", result)
		}
		return result
	}
	added := requestJSON[protocol.Receipt](t, f, http.MethodPatch, path, map[string]any{"ifRevision": *initial.Revision, "mode": "edit", "add": []map[string]string{{"projectId": project.ID, "goalId": upstream.ID}}}, http.StatusOK)
	if added.GoalID != downstream.ID || added.Revision != "2" || !added.Changed {
		t.Fatalf("add receipt: %+v", added)
	}
	read := requestJSON[protocol.Relationships](t, f, http.MethodGet, path, nil, http.StatusOK)
	if read.Revision == nil || *read.Revision != added.Revision || len(read.Prerequisites) != 1 || read.Prerequisites[0].EdgeID == nil || read.Prerequisites[0].Target == nil || read.CompletionBlocked {
		t.Fatalf("added relationship readback: %+v", read)
	}
	target := read.Prerequisites[0].Target
	if target.ProjectID != project.ID || target.ProjectName != project.Name || target.GoalID != upstream.ID || target.Title != upstream.Title || target.Status != "done" || target.Kind != "internal" {
		t.Fatalf("prerequisite identity: %+v", target)
	}
	reverse := requestJSON[protocol.Relationships](t, f, http.MethodGet, taskPath(upstream)+"/goal-dependencies", nil, http.StatusOK)
	if len(reverse.Successors) != 1 || reverse.Successors[0].GoalID != downstream.ID || reverse.Successors[0].Title != downstream.Title || reverse.Successors[0].Kind != "internal" {
		t.Fatalf("reverse relationship: %+v", reverse)
	}
	legacy := requestJSON[api.Task](t, f, http.MethodGet, taskPath(downstream), nil, http.StatusOK)
	if legacy.ID != downstream.ID || legacy.Version != downstream.Version+1 || legacy.Ready || len(legacy.DependsOn) != 0 || len(legacy.ExternalDependsOn) != 0 || len(legacy.BlockedBy) != 0 {
		t.Fatalf("legacy Goal projection: %+v", legacy)
	}
	sync := requestJSON[api.TaskSync](t, f, http.MethodGet, syncPath(project.ID), nil, http.StatusOK)
	summary := expectID(t, sync.Tasks, downstream.ID, func(item api.TaskViewRecord) string { return item.ID })
	_, hasGoalState := sync.DependencyStates[downstream.ID]
	if sync.Mode != "snapshot" || summary.Version != resourceVersion(legacy.Version) || !slices.Equal(summary.DependsOn, []string{upstream.ID}) || len(summary.ExternalDependsOn) != 0 || hasGoalState {
		t.Fatalf("Goal sync snapshot: summary=%+v states=%+v", summary, sync.DependencyStates)
	}
	delta := deltaSince(baseline.ObservedAt)
	changed := expectID(t, delta.Tasks, downstream.ID, func(item api.TaskViewRecord) string { return item.ID })
	if changed.Version != summary.Version || !slices.Equal(changed.DependsOn, summary.DependsOn) || len(changed.ExternalDependsOn) != 0 {
		t.Fatalf("Goal edge addition delta: %+v", changed)
	}
	unchanged := requestJSON[protocol.Receipt](t, f, http.MethodPatch, path, map[string]any{"ifRevision": added.Revision, "mode": "replace", "prerequisites": []map[string]string{{"edgeId": *read.Prerequisites[0].EdgeID}}}, http.StatusOK)
	if unchanged.Changed || unchanged.Revision != added.Revision || unchanged.GoalID != downstream.ID {
		t.Fatalf("retained relationship receipt: %+v", unchanged)
	}
	unchangedTask := requestJSON[api.Task](t, f, http.MethodGet, taskPath(downstream), nil, http.StatusOK)
	if unchangedTask.Version != legacy.Version || unchangedTask.UpdatedAt != legacy.UpdatedAt {
		t.Fatalf("no-op changed Goal: %+v", unchangedTask)
	}
	cleared := requestJSON[protocol.Receipt](t, f, http.MethodPatch, path, map[string]any{"ifRevision": unchanged.Revision, "mode": "replace", "prerequisites": []any{}}, http.StatusOK)
	final := requestJSON[protocol.Relationships](t, f, http.MethodGet, path, nil, http.StatusOK)
	if !cleared.Changed || cleared.Revision != "3" || final.Revision == nil || *final.Revision != cleared.Revision || len(final.Prerequisites) != 0 || final.CompletionBlocked {
		t.Fatalf("cleared relationship: receipt=%+v read=%+v", cleared, final)
	}
	clearedTask := requestJSON[api.Task](t, f, http.MethodGet, taskPath(downstream), nil, http.StatusOK)
	if clearedTask.Version != legacy.Version+1 {
		t.Fatalf("clear did not advance Goal: %+v", clearedTask)
	}
	clearedDelta := deltaSince(sync.ObservedAt)
	clearedSummary := expectID(t, clearedDelta.Tasks, downstream.ID, func(item api.TaskViewRecord) string { return item.ID })
	if clearedSummary.Version != resourceVersion(clearedTask.Version) || clearedSummary.DependsOn == nil || len(clearedSummary.DependsOn) != 0 || len(clearedSummary.ExternalDependsOn) != 0 {
		t.Fatalf("Goal edge removal delta: %+v", clearedSummary)
	}
	// A watermark beyond the overlap exercises an empty delta without waiting.
	empty := deltaSince(clearedDelta.ObservedAt.Add(11 * time.Second))
	if empty.Tasks == nil || len(empty.Tasks) != 0 || empty.DependencyStates == nil || len(empty.DependencyStates) != 0 {
		t.Fatalf("empty Goal delta: %+v", empty)
	}
	t.Logf("Goal sync responses: snapshot=%+v addition=%+v cleared=%+v emptyTasks=%d", summary, changed, clearedSummary, len(empty.Tasks))
	serverAPIMCPGoalDependenciesNormalFlow(t, f, project, upstream, downstream, cleared.Revision)
}
