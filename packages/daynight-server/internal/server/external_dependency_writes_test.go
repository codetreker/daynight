package server

import (
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestExternalDependencyHTTPWriteReplacementAndNoop(t *testing.T) {
	f := newExternalHTTPFixture(t)
	a := externalHTTPRecord(f.project.ID, externalHTTPID('a'), "A")
	b := externalHTTPRecord(f.project.ID, externalHTTPID('b'), "B")
	c := externalHTTPRecord(f.project.ID, externalHTTPID('c'), "C")
	current := externalHTTPRecord(f.project.ID, "", "Classified target")
	current.DependsOn, current.ExternalDependsOn, current.BlockedBy, current.Ready = []string{a.ID, b.ID}, []string{b.ID}, []string{a.ID, b.ID}, false
	current = *expectMutationHTTPCreate(f.taskHTTPFixture, taskcore.CreateTask{Title: "Classified target", Status: platformHTTPPointer(model.TaskTodo), DependsOn: []string{b.ID, strings.ToUpper(a.ID)}, ExternalDependsOn: []string{strings.ToUpper(b.ID)}, Properties: model.TaskProperties{}}, current, nil)
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
		expected               taskcore.UpdateTask
	}{
		{map[string]any{"description": "Both omitted"}, []string{a.ID, b.ID}, []string{b.ID}, []model.Task{a, b}, "Both omitted", taskcore.UpdateTask{Description: platformHTTPPointer("Both omitted")}},
		{map[string]any{"dependsOn": []string{b.ID, c.ID}}, []string{b.ID, c.ID}, []string{b.ID}, []model.Task{b, c}, "Both omitted", taskcore.UpdateTask{DependsOn: platformHTTPPointer([]string{b.ID, c.ID})}},
		{map[string]any{"externalDependsOn": []string{c.ID}}, []string{b.ID, c.ID}, []string{c.ID}, []model.Task{b, c}, "Both omitted", taskcore.UpdateTask{ExternalDependsOn: platformHTTPPointer([]string{c.ID})}},
		{map[string]any{"dependsOn": []string{a.ID}, "externalDependsOn": []string{a.ID}}, []string{a.ID}, []string{a.ID}, []model.Task{a}, "Both omitted", taskcore.UpdateTask{DependsOn: platformHTTPPointer([]string{a.ID}), ExternalDependsOn: platformHTTPPointer([]string{a.ID})}},
		{map[string]any{"externalDependsOn": []string{}}, []string{a.ID}, []string{}, []model.Task{a}, "Both omitted", taskcore.UpdateTask{ExternalDependsOn: platformHTTPPointer([]string{})}},
		{map[string]any{"externalDependsOn": []string{a.ID}}, []string{a.ID}, []string{a.ID}, []model.Task{a}, "Both omitted", taskcore.UpdateTask{ExternalDependsOn: platformHTTPPointer([]string{a.ID})}},
		{map[string]any{"dependsOn": []string{}}, []string{}, []string{}, []model.Task{}, "Both omitted", taskcore.UpdateTask{DependsOn: platformHTTPPointer([]string{})}},
		{map[string]any{"dependsOn": []string{a.ID, b.ID}, "externalDependsOn": []string{}}, []string{a.ID, b.ID}, []string{}, []model.Task{a, b}, "Both omitted", taskcore.UpdateTask{DependsOn: platformHTTPPointer([]string{a.ID, b.ID}), ExternalDependsOn: platformHTTPPointer([]string{})}},
	} {
		before := target
		after := externalHTTPChanged(current)
		after.Description, after.DependsOn, after.ExternalDependsOn = step.description, slices.Clone(step.dependencies), slices.Clone(step.external)
		after.BlockedBy, after.Ready = slices.Clone(step.dependencies), len(step.dependencies) == 0
		target = f.update(current, after, step.patch, step.expected)
		current = after
		if !slices.Equal(target.DependsOn, step.dependencies) || !slices.Equal(target.ExternalDependsOn, step.external) || target.Version != before.Version+1 || !target.UpdatedAt.After(before.UpdatedAt) {
			t.Fatalf("HTTP patch contract failed: patch=%#v task=%#v", step.patch, target)
		}
	}
	noop := f.update(current, current, map[string]any{"dependsOn": []string{strings.ToUpper(b.ID), a.ID}, "externalDependsOn": []string{}}, taskcore.UpdateTask{DependsOn: platformHTTPPointer([]string{strings.ToUpper(b.ID), a.ID}), ExternalDependsOn: platformHTTPPointer([]string{})})
	if !reflect.DeepEqual(noop, target) {
		t.Fatal("HTTP canonical no-op changed the task")
	}
	f.rejectedPatch(current, jsonBody(t, map[string]any{"version": target.Version - 1, "externalDependsOn": target.ExternalDependsOn}), &taskcore.UpdateTask{Version: target.Version - 1, ExternalDependsOn: platformHTTPPointer(copyTaskHTTPSlice(target.ExternalDependsOn))}, "version_conflict")
	f.read(current)
	if after := readHTTPTask(t, f.handler, target); !reflect.DeepEqual(after, target) {
		t.Fatal("HTTP stale classification changed task projection")
	}
	after := externalHTTPChanged(current)
	after.ExternalDependsOn = []string{b.ID}
	target = f.update(current, after, map[string]any{"externalDependsOn": []string{b.ID}}, taskcore.UpdateTask{ExternalDependsOn: platformHTTPPointer([]string{b.ID})})
	current = after
	f.graph(current.ID, []model.Task{a, b, current}, model.TaskGraphSummary{Total: 3, Todo: 3, Ready: 2, Blocked: 1})
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
	for _, test := range []struct {
		raw      string
		external []string
	}{
		{"null", nil}, {"false", nil}, {`{}`, nil}, {`"id"`, nil}, {`[null]`, nil}, {`[1]`, nil},
		{`["invalid"]`, []string{"invalid"}}, {`["` + a.ID + `","` + strings.ToUpper(a.ID) + `"]`, []string{a.ID, strings.ToUpper(a.ID)}}, {`["` + target.ID + `"]`, []string{target.ID}},
	} {
		raw := test.raw
		f.clearOperations()
		var expected *taskcore.UpdateTask
		if test.external != nil {
			expectMutationHTTPCreate(f.taskHTTPFixture, taskcore.CreateTask{Title: "Invalid", DependsOn: []string{a.ID}, ExternalDependsOn: copyTaskHTTPSlice(test.external), Properties: model.TaskProperties{}}, model.Task{}, mutationHTTPFault("invalid_input"))
			expected = &taskcore.UpdateTask{Version: 1, ExternalDependsOn: platformHTTPPointer(copyTaskHTTPSlice(test.external))}
		}
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), `{"title":"Invalid","dependsOn":["`+a.ID+`"],"externalDependsOn":`+raw+`}`), http.StatusBadRequest, "invalid_input")
		f.rejectedPatch(current, `{"version":1,"externalDependsOn":`+raw+`}`, expected, "invalid_input")
	}
	for index, body := range []string{
		`{"title":"Invalid","externalDependsOn":["` + a.ID + `"]}`,
		`{"title":"Invalid","externalDependsOn":[],"externalDependsOn":[]}`,
		`{"title":"Invalid","externalDependsOn":[],"external\u0044ependsOn":[]}`,
		`{"title":"Invalid","externalDependsOn":[],"unknown":true}`,
	} {
		f.clearOperations()
		if index == 0 {
			expectMutationHTTPCreate(f.taskHTTPFixture, taskcore.CreateTask{Title: "Invalid", DependsOn: []string{}, ExternalDependsOn: []string{a.ID}, Properties: model.TaskProperties{}}, model.Task{}, mutationHTTPFault("invalid_input"))
		}
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), body), http.StatusBadRequest, "invalid_input")
	}
	for index, body := range []string{
		`{"version":1,"dependsOn":[],"externalDependsOn":["` + a.ID + `"]}`,
		`{"version":1,"externalDependsOn":[],"externalDependsOn":[]}`,
		`{"version":1,"externalDependsOn":[],"external\u0044ependsOn":[]}`,
		`{"version":1,"externalDependsOn":[],"unknown":true}`,
	} {
		var expected *taskcore.UpdateTask
		if index == 0 {
			expected = &taskcore.UpdateTask{Version: 1, DependsOn: platformHTTPPointer([]string{}), ExternalDependsOn: platformHTTPPointer([]string{a.ID})}
		}
		f.rejectedPatch(current, body, expected, "invalid_input")
	}
	f.read(current)
	if after := readHTTPTask(t, f.handler, target); !reflect.DeepEqual(after, target) {
		t.Fatal("strict classification failures changed the Task read projection")
	}
	emptyRow := externalHTTPRecord(f.project.ID, "", "Explicit empty external set")
	emptyRow = *expectMutationHTTPCreate(f.taskHTTPFixture, taskcore.CreateTask{Title: "Explicit empty external set", Status: platformHTTPPointer(model.TaskTodo), DependsOn: []string{}, ExternalDependsOn: []string{}, Properties: model.TaskProperties{}}, emptyRow, nil)
	empty := decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), `{"title":"Explicit empty external set","status":"todo","externalDependsOn":[]}`), http.StatusCreated)
	externalHTTPCheck(t, empty, externalHTTPAPI(emptyRow))
	if len(empty.DependsOn) != 0 || empty.ExternalDependsOn == nil || len(empty.ExternalDependsOn) != 0 {
		t.Fatalf("empty external creation invented dependencies: %#v", empty)
	}
}
