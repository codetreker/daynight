package server

import (
	"io"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestExternalDependencyHTTPWriteReplacementAndNoop(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	a := createHTTPTask(t, handler, project.ID, "A")
	b := createHTTPTask(t, handler, project.ID, "B")
	c := createHTTPTask(t, handler, project.ID, "C")
	target := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{
		"title": "Classified target", "dependsOn": []string{b.ID, strings.ToUpper(a.ID)}, "externalDependsOn": []string{strings.ToUpper(b.ID)},
	})), http.StatusCreated)
	if !slices.Equal(target.ExternalDependsOn, []string{b.ID}) || target.Version != 1 {
		t.Fatalf("HTTP creation lost explicit classification: %#v", target)
	}
	for _, step := range []struct {
		patch                  map[string]any
		dependencies, external []string
	}{
		{map[string]any{"description": "Both omitted"}, []string{a.ID, b.ID}, []string{b.ID}},
		{map[string]any{"dependsOn": []string{b.ID, c.ID}}, []string{b.ID, c.ID}, []string{b.ID}},
		{map[string]any{"externalDependsOn": []string{c.ID}}, []string{b.ID, c.ID}, []string{c.ID}},
		{map[string]any{"dependsOn": []string{a.ID}, "externalDependsOn": []string{a.ID}}, []string{a.ID}, []string{a.ID}},
		{map[string]any{"externalDependsOn": []string{}}, []string{a.ID}, []string{}},
		{map[string]any{"externalDependsOn": []string{a.ID}}, []string{a.ID}, []string{a.ID}},
		{map[string]any{"dependsOn": []string{}}, []string{}, []string{}},
		{map[string]any{"dependsOn": []string{a.ID, b.ID}, "externalDependsOn": []string{}}, []string{a.ID, b.ID}, []string{}},
	} {
		before := target
		target = updateHTTPTask(t, handler, target, step.patch)
		slices.Sort(step.dependencies)
		if !slices.Equal(target.DependsOn, step.dependencies) || !slices.Equal(target.ExternalDependsOn, step.external) || target.Version != before.Version+1 || !target.UpdatedAt.After(before.UpdatedAt) {
			t.Fatalf("HTTP patch contract failed: patch=%#v task=%#v", step.patch, target)
		}
	}
	noop := updateHTTPTask(t, handler, target, map[string]any{"dependsOn": []string{strings.ToUpper(b.ID), a.ID}, "externalDependsOn": []string{}})
	if !reflect.DeepEqual(noop, target) {
		t.Fatal("HTTP canonical no-op changed the task")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(target), jsonBody(t, map[string]any{"version": target.Version - 1, "externalDependsOn": target.ExternalDependsOn})), http.StatusConflict, "version_conflict")
	if after := readHTTPTask(t, handler, target); !reflect.DeepEqual(after, target) {
		t.Fatal("HTTP stale classification changed task metadata")
	}
	target = updateHTTPTask(t, handler, target, map[string]any{"externalDependsOn": []string{b.ID}})
	graph := decodeResponse[api.TaskGraph](t, projectRequest(handler, http.MethodGet, graphPath(project.ID, target.ID), ""), http.StatusOK)
	if len(graph.Tasks) != 3 || graph.Tasks[0].ID != a.ID || graph.Tasks[1].ID != b.ID || graph.Tasks[2].ID != target.ID ||
		!slices.Equal(graph.Tasks[2].DependsOn, target.DependsOn) || !slices.Equal(graph.Tasks[2].ExternalDependsOn, []string{b.ID}) || !slices.Equal(graph.Tasks[2].BlockedBy, target.BlockedBy) {
		t.Fatalf("graph lost patched external classification: target=%#v graph=%#v", target, graph)
	}
}

func TestExternalDependencyHTTPWriteStrictBodies(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	a := createHTTPTask(t, handler, project.ID, "A")
	target := createHTTPTask(t, handler, project.ID, "Target", a.ID)
	for _, raw := range []string{"null", "false", `{}`, `"id"`, `[null]`, `[1]`, `["invalid"]`, `["` + a.ID + `","` + strings.ToUpper(a.ID) + `"]`, `["` + target.ID + `"]`} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), `{"title":"Invalid","dependsOn":["`+a.ID+`"],"externalDependsOn":`+raw+`}`), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(target), `{"version":1,"externalDependsOn":`+raw+`}`), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{
		`{"title":"Invalid","externalDependsOn":["` + a.ID + `"]}`,
		`{"title":"Invalid","externalDependsOn":[],"externalDependsOn":[]}`,
		`{"title":"Invalid","externalDependsOn":[],"external\u0044ependsOn":[]}`,
		`{"title":"Invalid","externalDependsOn":[],"unknown":true}`,
	} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), body), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{
		`{"version":1,"dependsOn":[],"externalDependsOn":["` + a.ID + `"]}`,
		`{"version":1,"externalDependsOn":[],"externalDependsOn":[]}`,
		`{"version":1,"externalDependsOn":[],"external\u0044ependsOn":[]}`,
		`{"version":1,"externalDependsOn":[],"unknown":true}`,
	} {
		assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(target), body), http.StatusBadRequest, "invalid_input")
	}
	if after := readHTTPTask(t, handler, target); !reflect.DeepEqual(after, target) {
		t.Fatal("strict classification failures left partial writes")
	}
	empty := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), `{"title":"Explicit empty external set","externalDependsOn":[]}`), http.StatusCreated)
	if len(empty.DependsOn) != 0 || empty.ExternalDependsOn == nil || len(empty.ExternalDependsOn) != 0 {
		t.Fatalf("empty external creation invented dependencies: %#v", empty)
	}
}
