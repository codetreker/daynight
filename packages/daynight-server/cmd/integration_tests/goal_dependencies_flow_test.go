//go:build integration

package main

import (
	"net/http"
	"testing"

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
	if legacy.ID != downstream.ID || legacy.Version != downstream.Version || legacy.Ready || len(legacy.DependsOn) != 0 || len(legacy.ExternalDependsOn) != 0 || len(legacy.BlockedBy) != 0 {
		t.Fatalf("legacy Goal projection: %+v", legacy)
	}
	sync := requestJSON[api.TaskSync](t, f, http.MethodGet, syncPath(project.ID), nil, http.StatusOK)
	summary := expectID(t, sync.Tasks, downstream.ID, func(item api.TaskViewRecord) string { return item.ID })
	state := sync.DependencyStates[downstream.ID]
	if state.Ready || len(summary.DependsOn) != 0 || len(summary.ExternalDependsOn) != 0 || len(state.BlockedBy) != 0 {
		t.Fatalf("legacy sync projection: %+v", summary)
	}
	unchanged := requestJSON[protocol.Receipt](t, f, http.MethodPatch, path, map[string]any{"ifRevision": added.Revision, "mode": "replace", "prerequisites": []map[string]string{{"edgeId": *read.Prerequisites[0].EdgeID}}}, http.StatusOK)
	if unchanged.Changed || unchanged.Revision != added.Revision || unchanged.GoalID != downstream.ID {
		t.Fatalf("retained relationship receipt: %+v", unchanged)
	}
	cleared := requestJSON[protocol.Receipt](t, f, http.MethodPatch, path, map[string]any{"ifRevision": unchanged.Revision, "mode": "replace", "prerequisites": []any{}}, http.StatusOK)
	final := requestJSON[protocol.Relationships](t, f, http.MethodGet, path, nil, http.StatusOK)
	if !cleared.Changed || cleared.Revision != "3" || final.Revision == nil || *final.Revision != cleared.Revision || len(final.Prerequisites) != 0 || final.CompletionBlocked {
		t.Fatalf("cleared relationship: receipt=%+v read=%+v", cleared, final)
	}
	serverAPIMCPGoalDependenciesNormalFlow(t, f, project, upstream, downstream, cleared.Revision)
}
