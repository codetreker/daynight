package server

import (
	"context"
	"io"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestExternalDependencyHTTPReadsAndWritePreservation(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	project := taskProject(t, handler)
	done := createHTTPTask(t, handler, project.ID, "Completed prerequisite")
	done = setHTTPTask(t, handler, setHTTPTask(t, handler, done, "in_progress"), "done")
	pending := createHTTPTask(t, handler, project.ID, "Unfinished prerequisite")
	target := createHTTPTask(t, handler, project.ID, "External dependencies", pending.ID, done.ID)
	target = updateHTTPTask(t, handler, target, map[string]any{"allowAgents": true})
	if target.ExternalDependsOn == nil || len(target.ExternalDependsOn) != 0 {
		t.Fatalf("new HTTP dependency is not normal: %#v", target)
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE task_dependencies SET external=true WHERE project_id=$1 AND task_id=$2`, project.ID, target.ID); err != nil {
		t.Fatal(err)
	}
	target = readHTTPTask(t, handler, target)
	expected := []string{done.ID, pending.ID}
	slices.Sort(expected)
	if !slices.Equal(target.ExternalDependsOn, expected) || !slices.Equal(target.BlockedBy, []string{pending.ID}) || target.Ready {
		t.Fatalf("HTTP full read lost external scheduling semantics: %#v", target)
	}
	for _, value := range []any{nil, false, []string{target.ID}, []string{done.ID, strings.ToUpper(done.ID)}} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Invalid external subset", "dependsOn": []string{done.ID}, "externalDependsOn": value})), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(target), jsonBody(t, map[string]any{"version": target.Version, "externalDependsOn": value})), http.StatusBadRequest, "invalid_input")
	}
	if after := readHTTPTask(t, handler, target); !reflect.DeepEqual(after, target) {
		t.Fatal("invalid external subset changed task or classification")
	}
	target = updateHTTPTask(t, handler, target, map[string]any{"title": "Preserved classification"})
	if !slices.Equal(target.ExternalDependsOn, expected) {
		t.Fatal("HTTP mutation response lost stored classification")
	}
	for _, action := range []string{"todo"} {
		target = setHTTPTask(t, handler, target, action)
		if !target.AllowAgents || !slices.Equal(target.ExternalDependsOn, expected) {
			t.Fatalf("%s response lost stored classification", action)
		}
	}
	assertProjectError(t, projectRequest(handler, http.MethodPut, taskPath(target)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: target.Version, Status: "in_progress"})), http.StatusConflict, "dependency_unsatisfied")
	page := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(project.ID), ""), http.StatusOK)
	graph := decodeResponse[api.TaskGraph](t, projectRequest(handler, http.MethodGet, graphPath(project.ID, target.ID), ""), http.StatusOK)
	if len(page.Items) != 3 || !reflect.DeepEqual(page.Items[2], target) || len(graph.Tasks) != 3 || !slices.Equal(graph.Tasks[2].ExternalDependsOn, expected) || graph.ObservedAt.IsZero() {
		t.Fatalf("HTTP list/graph lost classification or observation: %#v %#v", page, graph)
	}
	pending = setHTTPTask(t, handler, setHTTPTask(t, handler, pending, "in_progress"), "done")
	ready := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(project.ID)+"?status=todo&ready=true", ""), http.StatusOK)
	if len(ready.Items) != 1 || ready.Items[0].ID != target.ID || !slices.Equal(ready.Items[0].ExternalDependsOn, expected) {
		t.Fatalf("HTTP ready projection lost classification: %#v", ready)
	}
	target = setHTTPTask(t, handler, ready.Items[0], "in_progress")
	target = setHTTPTask(t, handler, target, "done")
	if !target.AllowAgents || !slices.Equal(target.ExternalDependsOn, expected) || target.StartedAt == nil || target.CompletedAt == nil {
		t.Fatalf("HTTP execution response lost classification or timing: %#v", target)
	}
}
