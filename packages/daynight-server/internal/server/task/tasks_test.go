package task_test

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	"github.com/google/uuid"
)

func TestExternalDependencyHTTPReadsAndWritePreservation(t *testing.T) {
	f := newExternalHTTPFixture(t)
	done := externalHTTPRecord(f.project.ID, externalHTTPID('a'), "Completed prerequisite")
	done.Status, done.Ready = model.TaskDone, false
	started, completed := done.CreatedAt.Add(time.Second), done.CreatedAt.Add(2*time.Second)
	done.StartedAt, done.CompletedAt = &started, &completed
	pending := externalHTTPRecord(f.project.ID, externalHTTPID('b'), "Unfinished prerequisite")
	current := externalHTTPRecord(f.project.ID, "", "External dependencies")
	current.Description = "initial description"
	current.DependsOn, current.BlockedBy, current.Ready = []string{done.ID, pending.ID}, []string{pending.ID}, false
	values := externalHTTPWrite(current)
	f.mutation(nil, &values, &current, []model.Task{done, pending}, true, store.TransactionCommitted)
	target := createHTTPTask(t, f.handler, f.project.ID, current.Title, pending.ID, done.ID)
	externalHTTPCheck(t, target, externalHTTPAPI(current))
	if target.ExternalDependsOn == nil || len(target.ExternalDependsOn) != 0 {
		t.Fatalf("new HTTP dependency is not normal: %#v", target)
	}
	enabled := externalHTTPChanged(current)
	enabled.AllowAgents = true
	target = f.update(current, enabled, map[string]any{"allowAgents": true}, []model.Task{done, pending}, true)
	current = enabled
	expected := []string{done.ID, pending.ID}
	current.ExternalDependsOn = slices.Clone(expected)
	f.read(current)
	target = readHTTPTask(t, f.handler, target)
	if !slices.Equal(target.ExternalDependsOn, expected) || !slices.Equal(target.BlockedBy, []string{pending.ID}) || target.Ready {
		t.Fatalf("HTTP full read lost external scheduling semantics: %#v", target)
	}
	for _, allowed := range []bool{false, true} {
		before := target
		after := externalHTTPChanged(current)
		after.AllowAgents = allowed
		target = f.update(current, after, map[string]any{"allowAgents": allowed}, []model.Task{done, pending}, true)
		current = after
		preserved := target
		preserved.AllowAgents, preserved.Version, preserved.UpdatedAt = before.AllowAgents, before.Version, before.UpdatedAt
		if target.AllowAgents != allowed || target.Version != before.Version+1 || !target.UpdatedAt.After(before.UpdatedAt) || !reflect.DeepEqual(preserved, before) {
			t.Fatalf("permission update changed classified task: before=%#v after=%#v", before, target)
		}
		f.read(current)
		if actual := readHTTPTask(t, f.handler, target); !reflect.DeepEqual(actual, target) {
			t.Fatal("permission read projection lost classified task")
		}
	}
	before := target
	references := []api.PullRequestProperty{{URL: "https://example.test/pr", Title: "Evidence"}}
	after := externalHTTPChanged(current)
	after.Properties = model.TaskProperties{"pullRequests": rawProperty(t, references)}
	target = f.update(current, after, map[string]any{"properties": api.TaskWritableProperties{"pullRequests": rawProperty(t, references)}}, []model.Task{done, pending}, true)
	current = after
	preserved := target
	preserved.Properties, preserved.Version, preserved.UpdatedAt = before.Properties, before.Version, before.UpdatedAt
	if target.Version != before.Version+1 || !target.UpdatedAt.After(before.UpdatedAt) || !slices.Equal(apiPullRequests(t, target.Properties), references) || !reflect.DeepEqual(preserved, before) {
		t.Fatalf("property update changed classified task: before=%#v after=%#v", before, target)
	}
	f.read(current)
	if actual := readHTTPTask(t, f.handler, target); !reflect.DeepEqual(actual, target) {
		t.Fatal("property read projection lost classified task")
	}
	for _, value := range []any{nil, false, []string{target.ID}, []string{done.ID, strings.ToUpper(done.ID)}} {
		f.noStorage()
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), jsonBody(t, map[string]any{"title": "Invalid external subset", "dependsOn": []string{done.ID}, "externalDependsOn": value})), http.StatusBadRequest, "invalid_input")
		_, semantic := value.([]string)
		f.rejectedPatch(current, jsonBody(t, map[string]any{"version": target.Version, "externalDependsOn": value}), semantic, "invalid_input")
	}
	f.read(current)
	if after := readHTTPTask(t, f.handler, target); !reflect.DeepEqual(after, target) {
		t.Fatal("invalid external subset changed task projection")
	}
	renamed := externalHTTPChanged(current)
	renamed.Title = "Preserved classification"
	target = f.update(current, renamed, map[string]any{"title": "Preserved classification"}, []model.Task{done, pending}, true)
	current = renamed
	if !slices.Equal(target.ExternalDependsOn, expected) {
		t.Fatal("HTTP mutation response lost supplied classification")
	}
	target = f.status(current, current)
	if !target.AllowAgents || !slices.Equal(target.ExternalDependsOn, expected) {
		t.Fatal("todo response lost classification")
	}
	f.mutation(&current, nil, nil, nil, false, store.TransactionCommitted)
	assertProjectError(t, projectRequest(f.handler, http.MethodPut, taskPath(target)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: target.Version, Status: "in_progress"})), http.StatusConflict, "dependency_unsatisfied")
	f.page([]model.Task{done, pending, current}, nil, nil)
	page := decodeResponse[api.TaskPage](t, projectRequest(f.handler, http.MethodGet, taskCollection(f.project.ID), ""), http.StatusOK)
	f.graph(current.ID, []model.Task{done, pending, current})
	graph := decodeResponse[api.TaskGraph](t, projectRequest(f.handler, http.MethodGet, graphPath(f.project.ID, current.ID), ""), http.StatusOK)
	if len(page.Items) != 3 || !reflect.DeepEqual(page.Items[2], target) || len(graph.Tasks) != 3 || !slices.Equal(graph.Tasks[2].ExternalDependsOn, expected) || graph.ObservedAt.IsZero() {
		t.Fatalf("HTTP list/graph lost classification or observation: %#v %#v", page, graph)
	}
	pendingStarted := externalHTTPChanged(pending)
	pendingStarted.Status, pendingStarted.Ready = model.TaskInProgress, false
	pendingStartedAt := pendingStarted.UpdatedAt
	pendingStarted.StartedAt = &pendingStartedAt
	f.status(pending, pendingStarted)
	pendingDone := externalHTTPChanged(pendingStarted)
	pendingDone.Status = model.TaskDone
	pendingDoneAt := pendingDone.UpdatedAt
	pendingDone.CompletedAt = &pendingDoneAt
	f.status(pendingStarted, pendingDone)
	readyRow := current
	readyRow.BlockedBy, readyRow.Ready = []string{}, true
	status, ready := model.TaskTodo, true
	f.page([]model.Task{readyRow}, &status, &ready)
	readyPage := decodeResponse[api.TaskPage](t, projectRequest(f.handler, http.MethodGet, taskCollection(f.project.ID)+"?status=todo&ready=true", ""), http.StatusOK)
	if len(readyPage.Items) != 1 || readyPage.Items[0].ID != target.ID || !slices.Equal(readyPage.Items[0].ExternalDependsOn, expected) {
		t.Fatalf("HTTP ready projection lost classification: %#v", readyPage)
	}
	startedRow := externalHTTPChanged(readyRow)
	startedRow.Status, startedRow.Ready = model.TaskInProgress, false
	targetStartedAt := startedRow.UpdatedAt
	startedRow.StartedAt = &targetStartedAt
	target = f.status(readyRow, startedRow)
	completedRow := externalHTTPChanged(startedRow)
	completedRow.Status = model.TaskDone
	targetCompletedAt := completedRow.UpdatedAt
	completedRow.CompletedAt = &targetCompletedAt
	target = f.status(startedRow, completedRow)
	if !target.AllowAgents || !slices.Equal(target.ExternalDependsOn, expected) || target.StartedAt == nil || target.CompletedAt == nil {
		t.Fatalf("HTTP execution response lost classification or timing: %#v", target)
	}
}

func TestTaskDependencyLimitHTTPRefusals(t *testing.T) {
	f := newExternalHTTPFixture(t)
	dependencies := make([]string, 31)
	for i := range dependencies {
		dependencies[i] = fmt.Sprintf("00000000-0000-4000-8000-%012d", i+1)
	}
	f.noStorage()
	create := projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), jsonBody(t, map[string]any{"title": "Too many", "dependsOn": dependencies}))
	assertProjectError(t, create, http.StatusBadRequest, "invalid_input")
	if !strings.Contains(create.Body.String(), "31") || !strings.Contains(create.Body.String(), "30") {
		t.Fatalf("missing count and limit: %s", create.Body.String())
	}
	current := externalHTTPRecord(f.project.ID, externalHTTPID('f'), "Existing")
	f.mutation(&current, nil, nil, nil, false, store.TransactionCommitted)
	update := projectRequest(f.handler, http.MethodPatch, taskPath(externalHTTPAPI(current)), jsonBody(t, map[string]any{"version": current.Version, "dependsOn": dependencies}))
	assertProjectError(t, update, http.StatusBadRequest, "invalid_input")
	if !strings.Contains(update.Body.String(), "31") || !strings.Contains(update.Body.String(), "30") {
		t.Fatalf("missing count and limit: %s", update.Body.String())
	}
}

func TestExternalDependencyHTTPWriteReplacementAndNoop(t *testing.T) {
	f := newExternalHTTPFixture(t)
	a := externalHTTPRecord(f.project.ID, externalHTTPID('a'), "A")
	b := externalHTTPRecord(f.project.ID, externalHTTPID('b'), "B")
	c := externalHTTPRecord(f.project.ID, externalHTTPID('c'), "C")
	current := externalHTTPRecord(f.project.ID, "", "Classified target")
	current.DependsOn, current.ExternalDependsOn, current.BlockedBy, current.Ready = []string{a.ID, b.ID}, []string{b.ID}, []string{a.ID, b.ID}, false
	values := externalHTTPWrite(current)
	f.mutation(nil, &values, &current, []model.Task{a, b}, true, store.TransactionCommitted)
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
	f.mutation(nil, &values, &emptyRow, []model.Task{}, true, store.TransactionCommitted)
	empty := decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), `{"title":"Explicit empty external set","status":"todo","externalDependsOn":[]}`), http.StatusCreated)
	externalHTTPCheck(t, empty, externalHTTPAPI(emptyRow))
	if len(empty.DependsOn) != 0 || empty.ExternalDependsOn == nil || len(empty.ExternalDependsOn) != 0 {
		t.Fatalf("empty external creation invented dependencies: %#v", empty)
	}
}

type externalHTTPFixture struct{ *taskHTTPFixture }

func newExternalHTTPFixture(t *testing.T) *externalHTTPFixture {
	t.Helper()
	return &externalHTTPFixture{newTaskHTTPFixture(t)}
}
func externalHTTPRecord(projectID, id, title string) model.Task {
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	return model.Task{ID: id, Type: model.TaskTypeTask, ProjectID: projectID, Title: title, Properties: model.TaskProperties{}, Status: model.TaskTodo, Version: 1, CreatedAt: at, UpdatedAt: at, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true}
}
func externalHTTPChanged(before model.Task) model.Task {
	after := copyTaskHTTPTask(before)
	after.Version, after.UpdatedAt = before.Version+1, before.UpdatedAt.Add(time.Microsecond)
	return after
}
func externalHTTPWrite(row model.Task) store.TaskWrite {
	row = copyTaskHTTPTask(row)
	return store.TaskWrite{Type: row.Type, ParentID: row.ParentID, AssignedTo: row.AssignedTo, RequiredPlatform: row.RequiredPlatform, AllowAgents: row.AllowAgents, Title: row.Title, Description: row.Description, Properties: row.Properties, Status: row.Status, DependsOn: row.DependsOn, ExternalDependsOn: row.ExternalDependsOn}
}
func tagHTTPReferences(tags []model.TagReference) []taskprotocol.RESTTagReference {
	result := make([]taskprotocol.RESTTagReference, 0, len(tags))
	for _, tag := range tags {
		result = append(result, taskprotocol.RESTTagReference{ID: tag.ID, Name: tag.Name})
	}
	return result
}

func externalHTTPAPI(row model.Task) api.Task {
	row = copyTaskHTTPTask(row)
	return api.Task{ID: row.ID, Type: row.Type, ParentID: row.ParentID, ProjectID: row.ProjectID, Title: row.Title, Description: row.Description, Properties: row.Properties, Tags: tagHTTPReferences(row.Tags), Status: string(row.Status), Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, StartedAt: row.StartedAt, CompletedAt: row.CompletedAt, CancelledAt: row.CancelledAt, DependsOn: row.DependsOn, ExternalDependsOn: row.ExternalDependsOn, BlockedBy: row.BlockedBy, AssignedTo: row.AssignedTo, AllowAgents: row.AllowAgents, Ready: row.Ready}
}
func externalHTTPCheck(t *testing.T, actual, expected any) {
	t.Helper()
	if !reflect.DeepEqual(actual, expected) {
		t.Errorf("external dependency DAO argument: got %#v, want %#v", actual, expected)
		panic("external dependency DAO argument mismatch")
	}
}
func (f *externalHTTPFixture) noStorage() {
	f.store.ReadSnapshotCall, f.store.WriteProjectCall = nil, nil
}
func (f *externalHTTPFixture) read(row model.Task) { f.noStorage(); f.expectRead(row) }

// The supplied result is an independent fixture row, not a read derived from a captured write.
func (f *externalHTTPFixture) mutation(current *model.Task, values *store.TaskWrite, result *model.Task, dependencies []model.Task, validateDependencies bool, completion store.TransactionOutcome) {
	f.noStorage()
	if current != nil {
		declared := copyTaskHTTPTask(*current)
		current = &declared
	}
	if values != nil {
		declared := copyTaskHTTPWrite(*values)
		values = &declared
	}
	output := result
	if result != nil {
		declared := copyTaskHTTPTask(*result)
		result = &declared
	}
	dependencies = copyTaskHTTPRows(dependencies)
	want := map[string]int{"writeScope": 1, "access": 1}
	if current != nil {
		want["current"] = 1
	}
	var added []string
	if validateDependencies {
		want["prerequisites"] = 1
		for _, id := range values.DependsOn {
			if current == nil || !slices.Contains(current.DependsOn, id) {
				added = append(added, id)
			}
		}
		if len(added) > 0 {
			want["visible"] = 1
		}
		for _, id := range values.DependsOn {
			want["reachable:"+id] = 1
		}
	}
	if result != nil {
		want["mutation"] = 1
		if current != nil {
			want["drain"], want["receipts"] = 1, 1
		}
		if current == nil || current.Status != result.Status {
			want["audience"] = 1
		}
	}
	plan := newHTTPCallPlan(f.t, want)
	base := newTaskHTTPMockBase(f.t, "external write")
	writer := &taskHTTPWriterMock{taskHTTPMockBase: base}
	project := &taskHTTPProjectWriterMock{taskHTTPMockBase: base}
	sessions := &taskHTTPProjectSessionMock{taskHTTPMockBase: base}
	capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base}
	scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base, ProjectDAOFn: func() store.ProjectWriteDAO { return project }, TaskDAOFn: func() store.TaskWriteDAO { return writer }, SessionDAOFn: func() store.ProjectSessionDAO { return sessions }, CaptureDAOFn: func() store.WebhookCaptureDAO { return capture }}

	project.ProjectAccessFn = func(ctx context.Context, actor model.Principal) (model.ProjectAccess, error) {
		plan.Called("access")
		f.require(ctx, f.project.ID)
		externalHTTPCheck(f.t, actor, f.principal)
		return taskHTTPMockAccess(f.project, actor), nil
	}
	if current != nil {
		writer.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
			plan.Called("current")
			f.require(ctx, f.project.ID)
			externalHTTPCheck(f.t, id, current.ID)
			return copyTaskHTTPTask(*current), nil
		}
	}
	if validateDependencies {
		writer.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
			plan.Called("prerequisites")
			f.require(ctx, f.project.ID)
			externalHTTPCheck(f.t, ids, values.DependsOn)
			return copyTaskHTTPRows(dependencies), nil
		}
		writer.VisibleTaskIDsFn = func(ctx context.Context, ids []string) ([]string, error) {
			plan.Called("visible")
			f.require(ctx, f.project.ID)
			externalHTTPCheck(f.t, ids, added)
			return slices.Clone(ids), nil
		}
		writer.ReachableFn = func(ctx context.Context, start, target string, replacement store.DependencyReplacement) (bool, error) {
			plan.Called("reachable:" + start)
			f.require(ctx, f.project.ID)
			if !slices.Contains(values.DependsOn, start) || replacement.TaskID != target || !slices.Equal(replacement.DependsOn, values.DependsOn) || current != nil && target != current.ID {
				unexpectedHTTPCall(f.t, "external dependency cycle arguments")
			}
			return false, nil
		}
	}
	if result != nil {
		apply := func(ctx context.Context, id string, got store.TaskWrite) (model.Task, error) {
			plan.Called("mutation")
			f.require(ctx, f.project.ID)
			externalHTTPCheck(f.t, got, *values)
			if current == nil {
				if parsed, err := uuid.Parse(id); err != nil || parsed.Version() != 4 {
					unexpectedHTTPCall(f.t, "created Task UUIDv4")
				}
				result.ID = id
				output.ID = id
			} else {
				externalHTTPCheck(f.t, id, current.ID)
			}
			return copyTaskHTTPTask(*result), nil
		}
		if current == nil {
			writer.CreateTaskFn = apply
		} else {
			writer.UpdateTaskFn = apply
			sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, got store.TaskSessionDrain) error {
				plan.Called("drain")
				f.require(ctx, f.project.ID)
				externalHTTPCheck(f.t, id, current.ID)
				externalHTTPCheck(f.t, got, store.TaskSessionDrain{SourceLifecycle: "active", GraceSeconds: 60, TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle", RemoveFields: []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"}, SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}})
				return nil
			}
			sessions.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, got store.TaskSessionReceiptTransition) error {
				plan.Called("receipts")
				f.require(ctx, f.project.ID)
				externalHTTPCheck(f.t, id, current.ID)
				externalHTTPCheck(f.t, got, store.TaskSessionReceiptTransition{LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"}})
				return nil
			}
		}
		capture.FreezeAudienceFn = func(ctx context.Context, projectID string, types []string) ([]store.WebhookAudience, error) {
			plan.Called("audience")
			f.require(ctx, f.project.ID)
			externalHTTPCheck(f.t, projectID, f.project.ID)
			kind := protocol.StatusChanged
			if current == nil {
				kind = protocol.Created
			}
			externalHTTPCheck(f.t, types, []string{kind})
			return []store.WebhookAudience{}, nil
		}
	}
	f.store.WriteProjectCall = func(ctx context.Context, id string, fn func(store.ProjectWriteScope) error) (store.Completion, error) {
		plan.Called("writeScope")
		externalHTTPCheck(f.t, id, f.project.ID)
		if fn == nil || f.active {
			unexpectedHTTPCall(f.t, "external write callback")
		}
		f.ctx, f.active = ctx, true
		defer func() { f.active = false }()
		err := fn(scope)
		return store.Completion{Outcome: completion}, err
	}
}

func (f *externalHTTPFixture) page(rows []model.Task, status *model.TaskStatus, ready *bool) {
	f.noStorage()
	f.expectList([]store.TaskQuery{{Page: store.Page{Limit: 50}, Status: status, Ready: ready}}, []store.TaskPage{{Items: rows}})
}
func (f *externalHTTPFixture) graph(root string, rows []model.Task) {
	f.noStorage()
	result := make([]model.GraphTask, len(rows))
	for index, row := range rows {
		result[index] = model.GraphTask{ID: row.ID, Type: row.Type, ParentID: row.ParentID, TitlePreview: row.Title, Status: row.Status, DependsOn: row.DependsOn, ExternalDependsOn: row.ExternalDependsOn, BlockedBy: row.BlockedBy, AllowAgents: row.AllowAgents, Ready: row.Ready, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, StartedAt: row.StartedAt, CompletedAt: row.CompletedAt}
	}
	f.expectGraph(root, result)
}
func externalHTTPID(letter byte) string {
	return fmt.Sprintf("%s-%s-4%s-8%s-%s", string(slices.Repeat([]byte{letter}, 8)), string(slices.Repeat([]byte{letter}, 4)), string(slices.Repeat([]byte{letter}, 3)), string(slices.Repeat([]byte{letter}, 3)), string(slices.Repeat([]byte{letter}, 12)))
}

func (f *externalHTTPFixture) update(before, after model.Task, patch map[string]any, dependencies []model.Task, changed bool) api.Task {
	values := externalHTTPWrite(after)
	var result *model.Task
	if changed {
		result = &after
	}
	f.mutation(&before, &values, result, dependencies, true, store.TransactionCommitted)
	got := updateHTTPTask(f.t, f.handler, externalHTTPAPI(before), patch)
	externalHTTPCheck(f.t, got, externalHTTPAPI(after))
	return got
}

func (f *externalHTTPFixture) status(before, after model.Task) api.Task {
	values := externalHTTPWrite(after)
	var result *model.Task
	if before.Status != after.Status {
		result = &after
	}
	f.mutation(&before, &values, result, nil, false, store.TransactionCommitted)
	got := setHTTPTask(f.t, f.handler, externalHTTPAPI(before), string(after.Status))
	externalHTTPCheck(f.t, got, externalHTTPAPI(after))
	return got
}

func (f *externalHTTPFixture) rejectedPatch(current model.Task, body string, semantic bool, code string) {
	if semantic {
		f.mutation(&current, nil, nil, nil, false, store.TransactionCommitted)
	} else {
		f.noStorage()
	}
	status := http.StatusBadRequest
	if code == "version_conflict" || code == "dependency_unsatisfied" {
		status = http.StatusConflict
	}
	assertProjectError(f.t, projectRequest(f.handler, http.MethodPatch, taskPath(externalHTTPAPI(current)), body), status, code)
}

func TestTaskHTTPAgentPermissionResourcesAndStrictInputs(t *testing.T) {
	f := newTaskHTTPFixture(t)
	row := f.target
	row.AssignedTo, row.Title = nil, "Manual by default"
	created := platformHTTPWrite(f, nil, platformHTTPValues(row), row, false, store.TransactionCommitted)
	response := projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), `{"title":"Manual by default","status":"todo"}`)
	task := decodeResponse[api.Task](t, response, http.StatusCreated)
	platformHTTPCheck(t, task, platformHTTPAPI(*created))
	row = *created
	if task.AllowAgents || !strings.Contains(response.Body.String(), `"allowAgents":false`) {
		t.Fatalf("missing required false permission: %s", response.Body)
	}
	f.store.WriteProjectCall = nil
	for _, value := range []string{"true", "false", "null"} {
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), `{"title":"Cannot opt in during creation","allowAgents":`+value+`}`), http.StatusBadRequest, "invalid_input")
	}
	for _, value := range []string{"null", `"true"`, `0`, `[]`, `{}`} {
		assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(task), `{"version":1,"allowAgents":`+value+`}`), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(task), `{"version":1,"allowAgents":true,"allowAgents":false}`), http.StatusBadRequest, "invalid_input")
	f.expectRead(row)
	platformHTTPCheck(t, readHTTPTask(t, f.handler, task), task)
	platformHTTPWrite(f, &row, platformHTTPValues(row), row, false, store.TransactionCommitted)
	platformHTTPCheck(t, updateHTTPTask(t, f.handler, task, map[string]any{"allowAgents": false}), task)
	next := row
	next.AllowAgents = true
	next = platformHTTPResult(row, next)
	values := platformHTTPValues(row)
	values.AllowAgents = true
	platformHTTPWrite(f, &row, values, next, false, store.TransactionCommitted)
	task = updateHTTPTask(t, f.handler, task, map[string]any{"allowAgents": true})
	platformHTTPCheck(t, task, platformHTTPAPI(next))
	row = next
	if !task.AllowAgents || task.Status != "todo" || !task.Ready {
		t.Fatalf("permission changed task status: %#v", task)
	}
	row = platformHTTPStatus(f, row, model.TaskInProgress)
	task = platformHTTPAPI(row)
	platformHTTPRefusal(f, row, store.TransactionCommitted)
	assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": task.Version, "allowAgents": false, "description": "Must not save"})), http.StatusConflict, "invalid_transition")
	f.expectRead(row)
	platformHTTPCheck(t, readHTTPTask(t, f.handler, task), task)
	row = platformHTTPStatus(f, row, model.TaskDone)
	task = platformHTTPAPI(row)
	next = row
	next.AllowAgents = false
	next = platformHTTPResult(row, next)
	values = platformHTTPValues(row)
	values.AllowAgents = false
	platformHTTPWrite(f, &row, values, next, false, store.TransactionCommitted)
	task = updateHTTPTask(t, f.handler, task, map[string]any{"allowAgents": false})
	platformHTTPCheck(t, task, platformHTTPAPI(next))
	row = next
	for _, path := range []string{taskPath(task), taskCollection(f.project.ID), graphPath(f.project.ID, task.ID)} {
		switch path {
		case taskPath(task):
			f.expectRead(row)
		case taskCollection(f.project.ID):
			f.expectList([]store.TaskQuery{{Page: store.Page{Limit: 50}}}, []store.TaskPage{{Items: []model.Task{row}}})
		default:
			f.expectGraph(row.ID, []model.GraphTask{platformHTTPProjection(row)})
		}
		read := projectRequest(f.handler, http.MethodGet, path, "")
		if read.Code != http.StatusOK || !strings.Contains(read.Body.String(), `"allowAgents":false`) {
			t.Fatalf("resource omitted permission: %s %s", path, read.Body)
		}
	}
}

func TestTaskHTTPAgentPermissionFilteringAndCursorScopes(t *testing.T) {
	f := newTaskHTTPFixture(t)
	rows := make([]model.Task, 5)
	for i := range rows {
		rows[i] = f.target
		rows[i].ID = platformHTTPID(i + 20)
		rows[i].AssignedTo = nil
		rows[i].Title = "Permission filter"
		rows[i].AllowAgents = i >= 2
	}
	collection := taskCollection(f.project.ID)
	for _, allowed := range []bool{false, true} {
		selected := rows[:2]
		want := []string{rows[0].ID, rows[1].ID}
		if allowed {
			selected = rows[2:]
			want = []string{rows[2].ID, rows[3].ID, rows[4].ID}
		}
		query, cursor := fmt.Sprintf("?ready=true&allowAgents=%t&limit=1", allowed), ""
		var ids []string
		for index, row := range selected {
			expected := store.TaskQuery{Page: store.Page{Limit: 1}, Ready: platformHTTPPointer(true), AllowAgents: platformHTTPPointer(allowed)}
			if index > 0 {
				expected.Page.After = &store.Position{CreatedAt: selected[index-1].CreatedAt, ID: selected[index-1].ID}
			}
			f.expectList([]store.TaskQuery{expected}, []store.TaskPage{{Items: []model.Task{row}, HasMore: index < len(selected)-1}})
			suffix := query
			if cursor != "" {
				suffix += "&cursor=" + url.QueryEscape(cursor)
			}
			page := decodeResponse[api.TaskPage](t, projectRequest(f.handler, http.MethodGet, collection+suffix, ""), http.StatusOK)
			if len(page.Items) != 1 {
				t.Fatalf("unexpected permission page: %#v", page)
			}
			platformHTTPCheck(t, page.Items[0], platformHTTPAPI(row))
			if page.Items[0].AllowAgents != allowed || !page.Items[0].Ready {
				t.Fatalf("permission page mismatch: %#v", page.Items[0])
			}
			ids = append(ids, page.Items[0].ID)
			if index == len(selected)-1 {
				if page.NextCursor != nil {
					t.Fatal("last permission page has cursor")
				}
				break
			}
			if page.NextCursor == nil {
				t.Fatal("permission page lost cursor")
			}
			cursor = *page.NextCursor
			f.store.ReadSnapshotCall = nil
			assertProjectError(t, projectRequest(f.handler, http.MethodGet, collection+"?limit=1&ready=true&cursor="+url.QueryEscape(cursor), ""), http.StatusBadRequest, "invalid_input")
			assertProjectError(t, projectRequest(f.handler, http.MethodGet, fmt.Sprintf("%s?limit=1&ready=true&allowAgents=%t&cursor=%s", collection, !allowed, url.QueryEscape(cursor)), ""), http.StatusBadRequest, "invalid_input")
		}
		if !slices.Equal(ids, want) {
			t.Fatalf("permission response sequence: got %v want %v", ids, want)
		}
	}
	f.store.ReadSnapshotCall = nil
	for _, query := range []string{"allowAgents=", "allowAgents=True", "allowAgents=1", "allowAgents=null", "allowAgents=true&allowAgents=false", "AllowAgents=true"} {
		assertProjectError(t, projectRequest(f.handler, http.MethodGet, collection+"?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
}

func platformHTTPCheck(t *testing.T, actual, expected any) {
	t.Helper()
	if !reflect.DeepEqual(actual, expected) {
		t.Errorf("Task HTTP DAO value: got %#v, want %#v", actual, expected)
		panic("Task HTTP DAO contract violated")
	}
}

func platformHTTPValues(task model.Task) store.TaskWrite {
	task = copyTaskHTTPTask(task)
	return store.TaskWrite{Type: task.Type, ParentID: task.ParentID, AssignedTo: task.AssignedTo, RequiredPlatform: task.RequiredPlatform, AllowAgents: task.AllowAgents,
		Title: task.Title, Description: task.Description, Properties: task.Properties, Status: task.Status,
		DependsOn: task.DependsOn, ExternalDependsOn: task.ExternalDependsOn}
}

func platformHTTPAPI(task model.Task) api.Task {
	task = copyTaskHTTPTask(task)
	var platform *string
	if task.RequiredPlatform != nil {
		value := string(*task.RequiredPlatform)
		platform = &value
	}
	return api.Task{ID: task.ID, Type: task.Type, ParentID: task.ParentID, ProjectID: task.ProjectID, Title: task.Title, Description: task.Description,
		Status: string(task.Status), Properties: api.TaskProperties(task.Properties), Tags: tagHTTPReferences(task.Tags), Version: task.Version,
		CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt, StartedAt: task.StartedAt, CompletedAt: task.CompletedAt, CancelledAt: task.CancelledAt,
		DependsOn: task.DependsOn, ExternalDependsOn: task.ExternalDependsOn, BlockedBy: task.BlockedBy,
		RequiredPlatform: platform, AssignedTo: task.AssignedTo, AllowAgents: task.AllowAgents, Ready: task.Ready}
}

func platformHTTPResult(before model.Task, after model.Task) model.Task {
	after = copyTaskHTTPTask(after)
	after.Version = before.Version + 1
	after.UpdatedAt = before.UpdatedAt.Add(time.Microsecond)
	after.Ready = after.Status == model.TaskTodo
	return after
}

// The result is declared by the case; recording a write never changes a read plan.
func platformHTTPWrite(f *taskHTTPFixture, before *model.Task, values store.TaskWrite, result model.Task, status bool, completion store.TransactionOutcome) *model.Task {
	f.t.Helper()
	if before != nil {
		current := copyTaskHTTPTask(*before)
		before = &current
	}
	values, result = copyTaskHTTPWrite(values), copyTaskHTTPTask(result)
	want := map[string]int{"write": 1, "access": 1}
	changed := before == nil || !reflect.DeepEqual(*before, result)
	if before != nil {
		want["task"] = 1
	}
	if !status {
		want["prerequisites"] = 1
	}
	if status && before != nil && before.Status == model.TaskDone && result.Status != model.TaskDone {
		want["dependents"] = 1
	}
	if changed {
		want["save"] = 1
		if before != nil {
			want["drain"], want["receipts"] = 1, 1
		}
		if before == nil || before.Status != result.Status {
			want["capture"] = 1
		}
	}
	plan := newHTTPCallPlan(f.t, want)
	base := newTaskHTTPMockBase(f.t, "platform HTTP write")
	writer := &taskHTTPWriterMock{taskHTTPMockBase: base.withLabel("task")}
	projects := &taskHTTPProjectWriterMock{taskHTTPMockBase: base.withLabel("project")}
	sessions := &taskHTTPProjectSessionMock{taskHTTPMockBase: base.withLabel("session")}
	projects.ProjectAccessFn = func(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
		f.require(ctx, f.project.ID)
		plan.Called("access")
		platformHTTPCheck(f.t, principal, f.principal)
		return taskHTTPMockAccess(f.project, principal), nil
	}
	if before != nil {
		writer.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
			f.require(ctx, f.project.ID)
			plan.Called("task")
			platformHTTPCheck(f.t, id, before.ID)
			return copyTaskHTTPTask(*before), nil
		}
	}
	if !status {
		writer.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
			f.require(ctx, f.project.ID)
			plan.Called("prerequisites")
			platformHTTPCheck(f.t, ids, values.DependsOn)
			return []model.Task{}, nil
		}
	}
	if want["dependents"] != 0 {
		writer.ActiveDependentIDsFn = func(ctx context.Context, id string) ([]string, error) {
			f.require(ctx, f.project.ID)
			plan.Called("dependents")
			platformHTTPCheck(f.t, id, before.ID)
			return []string{}, nil
		}
	}
	output := &result
	if changed {
		save := func(ctx context.Context, id string, actual store.TaskWrite) (model.Task, error) {
			f.require(ctx, f.project.ID)
			plan.Called("save")
			platformHTTPCheck(f.t, actual, values)
			if before == nil {
				parsed, err := uuid.Parse(id)
				if err != nil || parsed.Version() != 4 || parsed.String() != id {
					unexpectedHTTPCall(f.t, "Task creation UUID")
				}
				output.ID = id
			} else {
				platformHTTPCheck(f.t, id, before.ID)
			}
			return copyTaskHTTPTask(*output), nil
		}
		if before == nil {
			writer.CreateTaskFn = save
		} else {
			writer.UpdateTaskFn = save
			sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, actual store.TaskSessionDrain) error {
				f.require(ctx, f.project.ID)
				plan.Called("drain")
				platformHTTPCheck(f.t, id, before.ID)
				platformHTTPCheck(f.t, actual, store.TaskSessionDrain{SourceLifecycle: "active", GraceSeconds: 60,
					TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle", RemoveFields: []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"},
					SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}})
				return nil
			}
			sessions.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, actual store.TaskSessionReceiptTransition) error {
				f.require(ctx, f.project.ID)
				plan.Called("receipts")
				platformHTTPCheck(f.t, id, before.ID)
				platformHTTPCheck(f.t, actual, store.TaskSessionReceiptTransition{LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"}})
				return nil
			}
		}
	}
	capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base.withLabel("capture")}
	if want["capture"] != 0 {
		capture.FreezeAudienceFn = func(ctx context.Context, project string, types []string) ([]store.WebhookAudience, error) {
			f.require(ctx, project)
			plan.Called("capture")
			expected := protocol.StatusChanged
			if before == nil {
				expected = protocol.Created
			}
			platformHTTPCheck(f.t, types, []string{expected})
			return []store.WebhookAudience{}, nil
		}
	}
	scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base.withLabel("scope"),
		ProjectDAOFn: func() store.ProjectWriteDAO { return projects }, TaskDAOFn: func() store.TaskWriteDAO { return writer },
		SessionDAOFn: func() store.ProjectSessionDAO { return sessions }, CaptureDAOFn: func() store.WebhookCaptureDAO { return capture }}
	f.store.WriteProjectCall = func(ctx context.Context, id string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
		plan.Called("write")
		platformHTTPCheck(f.t, id, f.project.ID)
		if run == nil || f.active {
			unexpectedHTTPCall(f.t, "Project write callback")
		}
		f.ctx, f.active = ctx, true
		defer func() { f.active = false }()
		err := run(scope)
		return store.Completion{Outcome: completion}, err
	}
	return output
}

func platformHTTPRefusal(f *taskHTTPFixture, before model.Task, completion store.TransactionOutcome) {
	f.t.Helper()
	before = copyTaskHTTPTask(before)
	plan := newHTTPCallPlan(f.t, map[string]int{"write": 1, "access": 1, "task": 1})
	base := newTaskHTTPMockBase(f.t, "platform HTTP refusal")
	projects := &taskHTTPProjectWriterMock{taskHTTPMockBase: base.withLabel("project"), ProjectAccessFn: func(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
		f.require(ctx, f.project.ID)
		plan.Called("access")
		platformHTTPCheck(f.t, principal, f.principal)
		return taskHTTPMockAccess(f.project, principal), nil
	}}
	writer := &taskHTTPWriterMock{taskHTTPMockBase: base.withLabel("task"), TaskFn: func(ctx context.Context, id string) (model.Task, error) {
		f.require(ctx, f.project.ID)
		plan.Called("task")
		platformHTTPCheck(f.t, id, before.ID)
		return copyTaskHTTPTask(before), nil
	}}
	scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base.withLabel("scope"), ProjectDAOFn: func() store.ProjectWriteDAO { return projects }, TaskDAOFn: func() store.TaskWriteDAO { return writer }}
	f.store.WriteProjectCall = func(ctx context.Context, id string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
		plan.Called("write")
		platformHTTPCheck(f.t, id, f.project.ID)
		f.ctx, f.active = ctx, true
		defer func() { f.active = false }()
		err := run(scope)
		return store.Completion{Outcome: completion}, err
	}
}

func platformHTTPStatus(f *taskHTTPFixture, before model.Task, to model.TaskStatus) model.Task {
	f.t.Helper()
	before = copyTaskHTTPTask(before)
	after := copyTaskHTTPTask(before)
	if before.Status != to {
		after.Status = to
		after = platformHTTPResult(before, after)
		switch to {
		case model.TaskTodo:
			after.StartedAt, after.CompletedAt = nil, nil
		case model.TaskInProgress:
			after.StartedAt, after.CompletedAt = copyTaskHTTPPointer(&after.UpdatedAt), nil
		case model.TaskDone:
			after.CompletedAt = copyTaskHTTPPointer(&after.UpdatedAt)
		}
	}
	values := platformHTTPValues(before)
	values.Status = to
	platformHTTPWrite(f, &before, values, after, true, store.TransactionCommitted)
	got := setHTTPTask(f.t, f.handler, platformHTTPAPI(before), string(to))
	platformHTTPCheck(f.t, got, platformHTTPAPI(after))
	return after
}

func platformHTTPProjection(row model.Task) model.GraphTask {
	row = copyTaskHTTPTask(row)
	return model.GraphTask{ID: row.ID, Type: row.Type, ParentID: row.ParentID, TitlePreview: row.Title, Status: row.Status, DependsOn: row.DependsOn, ExternalDependsOn: row.ExternalDependsOn, BlockedBy: row.BlockedBy,
		AllowAgents: row.AllowAgents, RequiredPlatform: row.RequiredPlatform, AssignedTo: row.AssignedTo, Ready: row.Ready,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, StartedAt: row.StartedAt, CompletedAt: row.CompletedAt, CancelledAt: row.CancelledAt}
}

func createHTTPTask(t *testing.T, handler http.Handler, projectID, title string, dependencies ...string) api.Task {
	t.Helper()
	return decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(projectID), jsonBody(t, map[string]any{
		"title": title, "description": "initial description", "status": "todo", "dependsOn": append([]string{}, dependencies...),
	})), http.StatusCreated)
}

func updateHTTPTask(t *testing.T, handler http.Handler, task api.Task, values map[string]any) api.Task {
	t.Helper()
	values["version"] = task.Version
	return decodeResponse[api.Task](t, projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, values)), http.StatusOK)
}

func setHTTPTask(t *testing.T, handler http.Handler, task api.Task, status string) api.Task {
	t.Helper()
	return decodeResponse[api.Task](t, projectRequest(handler, http.MethodPut, taskPath(task)+"/status",
		jsonBody(t, api.TaskStatusUpdateRequest{Version: task.Version, Status: status})), http.StatusOK)
}

func readHTTPTask(t *testing.T, handler http.Handler, task api.Task) api.Task {
	t.Helper()
	return decodeResponse[api.Task](t, projectRequest(handler, http.MethodGet, taskPath(task), ""), http.StatusOK)
}

func platformHTTPPointer[T any](value T) *T { return &value }
func platformHTTPID(number int) string      { return fmt.Sprintf("ab000000-0000-4000-8000-%012d", number) }
