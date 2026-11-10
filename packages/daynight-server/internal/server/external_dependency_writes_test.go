package server

import (
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestExternalDependencyHTTPWriteReplacementAndNoop(t *testing.T) {
	f := newExternalHTTPFixture(t)
	a := externalHTTPRecord(f.project.ID, externalHTTPID('a'), "A")
	b := externalHTTPRecord(f.project.ID, externalHTTPID('b'), "B")
	c := externalHTTPRecord(f.project.ID, externalHTTPID('c'), "C")
	current := externalHTTPRecord(f.project.ID, "", "Classified target")
	current.DependsOn, current.ExternalDependsOn, current.BlockedBy, current.Ready = []string{a.ID, b.ID}, []string{b.ID}, []string{a.ID, b.ID}, false
	values := externalHTTPWrite(current)
	f.mutation(nil, &values, &current, []model.Task{a, b}, true)
	target := decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), jsonBody(t, map[string]any{"title": "Classified target", "status": "todo", "dependsOn": []string{b.ID, strings.ToUpper(a.ID)}, "externalDependsOn": []string{strings.ToUpper(b.ID)}})), http.StatusCreated)
	externalHTTPCheck(t, target, externalHTTPAPI(current))
	if !slices.Equal(target.ExternalDependsOn, []string{b.ID}) || target.Version != 1 {
		t.Fatalf("HTTP creation lost explicit classification: %#v", target)
	}
	for _, step := range []struct {
		patch                  map[string]any
		dependencies, external []string
		prerequisites          []model.Task
		description            string
	}{
		{map[string]any{"description": "Both omitted"}, []string{a.ID, b.ID}, []string{b.ID}, []model.Task{a, b}, "Both omitted"},
		{map[string]any{"dependsOn": []string{b.ID, c.ID}}, []string{b.ID, c.ID}, []string{b.ID}, []model.Task{b, c}, "Both omitted"},
		{map[string]any{"externalDependsOn": []string{c.ID}}, []string{b.ID, c.ID}, []string{c.ID}, []model.Task{b, c}, "Both omitted"},
		{map[string]any{"dependsOn": []string{a.ID}, "externalDependsOn": []string{a.ID}}, []string{a.ID}, []string{a.ID}, []model.Task{a}, "Both omitted"},
		{map[string]any{"externalDependsOn": []string{}}, []string{a.ID}, []string{}, []model.Task{a}, "Both omitted"},
		{map[string]any{"externalDependsOn": []string{a.ID}}, []string{a.ID}, []string{a.ID}, []model.Task{a}, "Both omitted"},
		{map[string]any{"dependsOn": []string{}}, []string{}, []string{}, []model.Task{}, "Both omitted"},
		{map[string]any{"dependsOn": []string{a.ID, b.ID}, "externalDependsOn": []string{}}, []string{a.ID, b.ID}, []string{}, []model.Task{a, b}, "Both omitted"},
	} {
		before := target
		after := externalHTTPChanged(current)
		after.Description, after.DependsOn, after.ExternalDependsOn = step.description, slices.Clone(step.dependencies), slices.Clone(step.external)
		after.BlockedBy, after.Ready = slices.Clone(step.dependencies), len(step.dependencies) == 0
		target = f.update(current, after, step.patch, step.prerequisites, true)
		current = after
		if !slices.Equal(target.DependsOn, step.dependencies) || !slices.Equal(target.ExternalDependsOn, step.external) || target.Version != before.Version+1 || !target.UpdatedAt.After(before.UpdatedAt) {
			t.Fatalf("HTTP patch contract failed: patch=%#v task=%#v", step.patch, target)
		}
	}
	noop := f.update(current, current, map[string]any{"dependsOn": []string{strings.ToUpper(b.ID), a.ID}, "externalDependsOn": []string{}}, []model.Task{a, b}, false)
	if !reflect.DeepEqual(noop, target) {
		t.Fatal("HTTP canonical no-op changed the task")
	}
	f.rejectedPatch(current, jsonBody(t, map[string]any{"version": target.Version - 1, "externalDependsOn": target.ExternalDependsOn}), true, "version_conflict")
	f.read(current)
	if after := readHTTPTask(t, f.handler, target); !reflect.DeepEqual(after, target) {
		t.Fatal("HTTP stale classification changed task projection")
	}
	after := externalHTTPChanged(current)
	after.ExternalDependsOn = []string{b.ID}
	target = f.update(current, after, map[string]any{"externalDependsOn": []string{b.ID}}, []model.Task{a, b}, true)
	current = after
	f.graph(current.ID, []model.Task{a, b, current})
	graph := decodeResponse[api.TaskGraph](t, projectRequest(f.handler, http.MethodGet, graphPath(f.project.ID, target.ID), ""), http.StatusOK)
	if len(graph.Tasks) != 3 || graph.Tasks[0].ID != a.ID || graph.Tasks[1].ID != b.ID || graph.Tasks[2].ID != target.ID || !slices.Equal(graph.Tasks[2].DependsOn, target.DependsOn) || !slices.Equal(graph.Tasks[2].ExternalDependsOn, []string{b.ID}) || !slices.Equal(graph.Tasks[2].BlockedBy, target.BlockedBy) {
		t.Fatalf("graph lost patched external classification: target=%#v graph=%#v", target, graph)
	}
}

func TestExternalDependencyHTTPWriteStrictBodies(t *testing.T) {
	f := newExternalHTTPFixture(t)
	a := externalHTTPRecord(f.project.ID, externalHTTPID('a'), "A")
	current := externalHTTPRecord(f.project.ID, externalHTTPID('b'), "Target")
	current.DependsOn, current.BlockedBy, current.Ready = []string{a.ID}, []string{a.ID}, false
	target := externalHTTPAPI(current)
	for _, raw := range []string{"null", "false", `{}`, `"id"`, `[null]`, `[1]`, `["invalid"]`, `["` + a.ID + `","` + strings.ToUpper(a.ID) + `"]`, `["` + target.ID + `"]`} {
		f.noStorage()
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), `{"title":"Invalid","dependsOn":["`+a.ID+`"],"externalDependsOn":`+raw+`}`), http.StatusBadRequest, "invalid_input")
		semantic := raw == `["invalid"]` || raw == `["`+a.ID+`","`+strings.ToUpper(a.ID)+`"]` || raw == `["`+target.ID+`"]`
		f.rejectedPatch(current, `{"version":1,"externalDependsOn":`+raw+`}`, semantic, "invalid_input")
	}
	for _, body := range []string{
		`{"title":"Invalid","externalDependsOn":["` + a.ID + `"]}`,
		`{"title":"Invalid","externalDependsOn":[],"externalDependsOn":[]}`,
		`{"title":"Invalid","externalDependsOn":[],"external\u0044ependsOn":[]}`,
		`{"title":"Invalid","externalDependsOn":[],"unknown":true}`,
	} {
		f.noStorage()
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), body), http.StatusBadRequest, "invalid_input")
	}
	for index, body := range []string{
		`{"version":1,"dependsOn":[],"externalDependsOn":["` + a.ID + `"]}`,
		`{"version":1,"externalDependsOn":[],"externalDependsOn":[]}`,
		`{"version":1,"externalDependsOn":[],"external\u0044ependsOn":[]}`,
		`{"version":1,"externalDependsOn":[],"unknown":true}`,
	} {
		f.rejectedPatch(current, body, index == 0, "invalid_input")
	}
	f.read(current)
	if after := readHTTPTask(t, f.handler, target); !reflect.DeepEqual(after, target) {
		t.Fatal("strict classification failures changed the Task read projection")
	}
	emptyRow := externalHTTPRecord(f.project.ID, "", "Explicit empty external set")
	values := externalHTTPWrite(emptyRow)
	f.mutation(nil, &values, &emptyRow, []model.Task{}, true)
	empty := decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), `{"title":"Explicit empty external set","status":"todo","externalDependsOn":[]}`), http.StatusCreated)
	externalHTTPCheck(t, empty, externalHTTPAPI(emptyRow))
	if len(empty.DependsOn) != 0 || empty.ExternalDependsOn == nil || len(empty.ExternalDependsOn) != 0 {
		t.Fatalf("empty external creation invented dependencies: %#v", empty)
	}
}
