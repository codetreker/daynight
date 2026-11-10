package server

import (
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
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
	current = *expectMutationHTTPCreate(f.taskHTTPFixture, taskcore.CreateTask{Title: current.Title, Description: "initial description", Status: platformHTTPPointer(model.TaskTodo), DependsOn: []string{pending.ID, done.ID}, Properties: model.TaskProperties{}}, current, nil)
	target := createHTTPTask(t, f.handler, f.project.ID, current.Title, pending.ID, done.ID)
	externalHTTPCheck(t, target, externalHTTPAPI(current))
	if target.ExternalDependsOn == nil || len(target.ExternalDependsOn) != 0 {
		t.Fatalf("new HTTP dependency is not normal: %#v", target)
	}
	enabled := externalHTTPChanged(current)
	enabled.AllowAgents = true
	target = f.update(current, enabled, map[string]any{"allowAgents": true}, taskcore.UpdateTask{AllowAgents: platformHTTPPointer(true)})
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
		target = f.update(current, after, map[string]any{"allowAgents": allowed}, taskcore.UpdateTask{AllowAgents: platformHTTPPointer(allowed)})
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
	target = f.update(current, after, map[string]any{"properties": api.TaskWritableProperties{"pullRequests": rawProperty(t, references)}}, taskcore.UpdateTask{Properties: model.TaskPropertiesPatch{"pullRequests": rawProperty(t, references)}})
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
		f.clearOperations()
		var expected *taskcore.UpdateTask
		if stringsValue, semantic := value.([]string); semantic {
			expectMutationHTTPCreate(f.taskHTTPFixture, taskcore.CreateTask{Title: "Invalid external subset", DependsOn: []string{done.ID}, ExternalDependsOn: copyTaskHTTPSlice(stringsValue), Properties: model.TaskProperties{}}, model.Task{}, mutationHTTPFault("invalid_input"))
			expected = &taskcore.UpdateTask{Version: target.Version, ExternalDependsOn: platformHTTPPointer(copyTaskHTTPSlice(stringsValue))}
		}
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), jsonBody(t, map[string]any{"title": "Invalid external subset", "dependsOn": []string{done.ID}, "externalDependsOn": value})), http.StatusBadRequest, "invalid_input")
		f.rejectedPatch(current, jsonBody(t, map[string]any{"version": target.Version, "externalDependsOn": value}), expected, "invalid_input")
	}
	f.read(current)
	if after := readHTTPTask(t, f.handler, target); !reflect.DeepEqual(after, target) {
		t.Fatal("invalid external subset changed task projection")
	}
	renamed := externalHTTPChanged(current)
	renamed.Title = "Preserved classification"
	target = f.update(current, renamed, map[string]any{"title": "Preserved classification"}, taskcore.UpdateTask{Title: platformHTTPPointer("Preserved classification")})
	current = renamed
	if !slices.Equal(target.ExternalDependsOn, expected) {
		t.Fatal("HTTP mutation response lost supplied classification")
	}
	target = f.status(current, current)
	if !target.AllowAgents || !slices.Equal(target.ExternalDependsOn, expected) {
		t.Fatal("todo response lost classification")
	}
	expectMutationHTTPStatus(f.taskHTTPFixture, current.ID, taskcore.SetTaskStatus{Version: target.Version, Status: model.TaskInProgress}, model.Task{}, mutationHTTPFault("dependency_unsatisfied"))
	assertProjectError(t, projectRequest(f.handler, http.MethodPut, taskPath(target)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: target.Version, Status: "in_progress"})), http.StatusConflict, "dependency_unsatisfied")
	f.page([]model.Task{done, pending, current}, nil, nil)
	page := decodeResponse[api.TaskPage](t, projectRequest(f.handler, http.MethodGet, taskCollection(f.project.ID), ""), http.StatusOK)
	f.graph(current.ID, []model.Task{done, pending, current}, model.TaskGraphSummary{Total: 3, Todo: 2, Done: 1, Ready: 1, Blocked: 1})
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
