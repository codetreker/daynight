package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestBuiltBinaryAcceptance(t *testing.T) {
	acceptanceCase(t, "three_state_read_projection", []string{"V1", "V5", "V6", "V7"}, acceptanceStatusReads)
	acceptanceCase(t, "workflow_restart_persistence", []string{"V1", "V4", "V5", "V6", "V10", "TP-V1", "TP-V3"}, acceptanceWorkflow)
	acceptanceCase(t, "refusals_scopes_filters_and_cursors", []string{"V2", "V4", "V5", "V6", "V10"}, acceptanceRefusals)
	acceptanceCase(t, "concurrent_reverse_dependencies", []string{"V3"}, acceptanceReverseDependencies)
	acceptanceCase(t, "concurrent_status_same_version", []string{"V4", "V5"}, acceptanceStatusRace)
	acceptanceCase(t, "concurrent_dependency_update_and_status", []string{"V3", "V4", "V5"}, acceptanceDependencyStatusRace)
	acceptanceCase(t, "concurrent_reopen_and_successor_status", []string{"V3", "V4", "V5"}, acceptanceReopenStatusRace)
	acceptanceCase(t, "concurrent_same_version", []string{"V5", "TP-V4"}, acceptanceVersionRace)
	acceptanceCase(t, "partial_write_http_failure_rolls_back", []string{"V2", "V7", "V10", "TP-V4"}, acceptancePartialFailure)
	acceptanceCase(t, "canceled_request_and_independent_project", []string{"V3", "V7", "V10", "TP-V4"}, acceptanceCancellation)
	acceptanceCase(t, "graceful_sigterm_drains_committed_request", []string{"V1", "V7"}, acceptanceGracefulShutdown)
	acceptanceCase(t, "forced_sigterm_cancels_without_late_write", []string{"V1", "V7", "V10"}, acceptanceForcedShutdown)
	acceptanceCase(t, "unsupported_migration_history_fails_before_listening", []string{"V7", "V10"}, acceptanceUnknownMigration)
	acceptanceCase(t, "failed_migration_retains_prior_and_releases_resources", []string{"V7", "V10"}, acceptanceFailedMigration)
	acceptanceCase(t, "concurrent_process_migrations_share_one_ledger", []string{"V1", "V7"}, acceptanceConcurrentStartup)
}

func acceptanceWorkflow(t *testing.T, scenario *acceptanceScenario) {
	fixture := newAcceptanceFixture(t, scenario)
	process := fixture.launch(t, nil).started(t)
	empty := acceptanceDecode[api.ProjectPage](t, process.request(context.Background(), http.MethodGet, "/api/v1/projects", nil, ""), http.StatusOK)
	if empty.Items == nil || len(empty.Items) != 0 || empty.NextCursor != nil {
		t.Fatal("fresh process project list is not an initialized empty page")
	}
	project := process.project(t, "acceptance-secret-project")
	first := process.task(t, project, "acceptance-secret-prerequisite")
	second := process.task(t, project, "Second prerequisite")
	dependencies := []string{first.ID, second.ID}
	slices.Sort(dependencies)
	references := api.TaskProperties{PullRequests: []api.PullRequestProperty{
		{URL: "", Title: ""},
		{URL: "  acceptance-secret arbitrary\x00\n地址  ", Title: "\t标题\x00"},
		{URL: "  acceptance-secret arbitrary\x00\n地址  ", Title: "\t标题\x00"},
	}}
	target := acceptanceDecode[api.Task](t, process.request(context.Background(), http.MethodPost, acceptanceTasksPath(project.ID), map[string]any{
		"title": "Target", "dependsOn": []string{second.ID, first.ID}, "properties": references,
	}, "create-references"), http.StatusCreated)
	if !reflect.DeepEqual(target.Properties, references) || first.Properties.PullRequests == nil || len(first.Properties.PullRequests) != 0 {
		t.Fatal("created properties changed caller strings or default list")
	}
	if first.Description != "" || first.Status != "todo" || !first.Ready || first.DependsOn == nil || first.BlockedBy == nil || target.Ready || !slices.Equal(target.DependsOn, dependencies) || !slices.Equal(target.BlockedBy, dependencies) {
		t.Fatal("created task defaults or dependency projection are invalid")
	}
	noChange := process.update(t, target, map[string]any{"title": target.Title, "dependsOn": dependencies, "properties": references})
	if !reflect.DeepEqual(noChange, target) {
		t.Fatal("semantic no-op changed task version or update time")
	}
	if same := process.setStatus(t, target, "todo"); !reflect.DeepEqual(same, target) {
		t.Fatal("same-status request changed the task")
	}
	refusal := process.request(context.Background(), http.MethodPut, acceptanceTaskPath(target)+"/status", map[string]any{"version": target.Version, "status": "in_progress"}, "blocked-start")
	fault := acceptanceError(t, refusal, http.StatusConflict, "dependency_unsatisfied")
	if fault.Details == nil || !slices.Equal(fault.Details.TaskIDs, dependencies) {
		t.Fatal("blocked status update omitted sorted task IDs")
	}
	first = process.setStatus(t, first, "in_progress")
	first = process.setStatus(t, first, "done")
	second = process.setStatus(t, second, "done")
	ready := process.readTask(t, target)
	if !ready.Ready || len(ready.BlockedBy) != 0 || ready.Version != target.Version || !ready.UpdatedAt.Equal(target.UpdatedAt) {
		t.Fatal("prerequisite completion mutated downstream metadata or left it blocked")
	}
	target = process.update(t, ready, map[string]any{"description": "acceptance-secret-description", "properties": references})
	target = process.setStatus(t, target, "in_progress")
	if target.Version != 3 || target.Status != "in_progress" || target.Ready {
		t.Fatal("status update did not advance the task once")
	}
	target = process.setStatus(t, target, "done")
	target = process.update(t, target, map[string]any{"description": ""})
	if target.Description != "" || target.Version != 5 {
		t.Fatal("description clear or completion version differs from the contract")
	}
	readProject := acceptanceDecode[api.Project](t, process.request(context.Background(), http.MethodGet, "/api/v1/projects/"+project.ID, nil, "project-read"), http.StatusOK)
	if !reflect.DeepEqual(readProject, project) {
		t.Fatal("project read differs from its persisted creation")
	}
	before := process.readTask(t, target)
	process.signal(t)
	process.stopped(t, 0)
	restarted := fixture.launch(t, map[string]string{"DAYNIGHT_LISTEN_ADDR": process.address}).started(t)
	if restarted.address != process.address {
		t.Fatal("restarted process did not reuse its released listener")
	}
	if after := restarted.readTask(t, target); !reflect.DeepEqual(after, before) {
		t.Fatal("task metadata, dependencies, properties or derived state changed across process restart")
	}
	projectAfter := acceptanceDecode[api.Project](t, restarted.request(context.Background(), http.MethodGet, "/api/v1/projects/"+project.ID, nil, ""), http.StatusOK)
	if !reflect.DeepEqual(projectAfter, project) {
		t.Fatal("project did not persist across actual process restart")
	}
	page := acceptanceDecode[api.TaskPage](t, restarted.request(context.Background(), http.MethodGet, acceptanceTasksPath(project.ID)+"?status=done&ready=false", nil, ""), http.StatusOK)
	if len(page.Items) != 3 || page.NextCursor != nil {
		t.Fatal("persisted completed tasks were not returned by their filtered list")
	}
	process.logs.safe(t, "acceptance-secret")
	if !process.logs.matches(map[string]any{"request_id": "blocked-start", "type": "operation_error", "cause": "dependency_unsatisfied", "component": "task", "phase": "set_status", "error_code": "dependency_unsatisfied"}) {
		t.Fatal("business refusal log cannot be correlated with its HTTP error")
	}
	restarted.signal(t)
	restarted.stopped(t, 0)
}

func acceptanceRefusals(t *testing.T, scenario *acceptanceScenario) {
	fixture := newAcceptanceFixture(t, scenario)
	process := fixture.launch(t, nil).started(t)
	project, other := process.project(t, "Primary"), process.project(t, "Other")
	first := process.task(t, project, "First")
	second := process.task(t, project, "Second", first.ID)
	third := process.task(t, project, "Third", second.ID)
	foreign := process.task(t, other, "acceptance-secret-foreign")
	missing := "00000000-0000-4000-8000-000000000099"
	for _, refs := range [][]string{{first.ID}, {second.ID, second.ID}, {foreign.ID}, {missing}} {
		response := process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(first), map[string]any{"version": first.Version, "dependsOn": refs}, "dependency-invalid")
		acceptanceError(t, response, http.StatusBadRequest, "invalid_input")
		if !reflect.DeepEqual(process.readTask(t, first), first) {
			t.Fatal("invalid dependency input partially changed task state")
		}
	}
	acceptanceError(t, process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(first), map[string]any{"version": first.Version, "dependsOn": []string{third.ID}}, "cycle-refused"), http.StatusConflict, "dependency_cycle")
	if !reflect.DeepEqual(process.readTask(t, first), first) {
		t.Fatal("indirect cycle refusal changed task state")
	}
	acceptanceError(t, process.request(context.Background(), http.MethodGet, acceptanceTasksPath(other.ID)+"/"+first.ID, nil, ""), http.StatusNotFound, "not_found")
	acceptanceError(t, process.request(context.Background(), http.MethodGet, acceptanceTasksPath(missing), nil, ""), http.StatusNotFound, "not_found")
	acceptanceError(t, process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(first), map[string]any{"version": first.Version, "title": nil}, ""), http.StatusBadRequest, "invalid_input")
	acceptanceError(t, process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(first), map[string]any{"version": first.Version}, ""), http.StatusBadRequest, "invalid_input")
	for _, status := range []string{"proposed", "todo", "in_progress", "done"} {
		acceptanceError(t, process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(first), map[string]any{"version": first.Version, "status": status, "title": "Must not persist"}, "status-bypass"), http.StatusBadRequest, "invalid_input")
		acceptanceError(t, process.request(context.Background(), http.MethodPost, acceptanceTasksPath(project.ID), map[string]any{"title": "Must not create", "status": status}, "creation-bypass"), http.StatusBadRequest, "invalid_input")
	}
	statusPath := acceptanceTaskPath(first) + "/status"
	for _, version := range []any{nil, 0, -1, 1.5, "1", json.RawMessage("9223372036854775808")} {
		acceptanceError(t, process.request(context.Background(), http.MethodPut, statusPath, map[string]any{"version": version, "status": "in_progress"}, "invalid-status-version"), http.StatusBadRequest, "invalid_input")
	}
	for _, input := range []map[string]any{{}, {"version": first.Version}, {"version": first.Version, "status": nil}, {"version": first.Version, "status": "proposed"}, {"version": first.Version, "status": "TODO"}, {"version": first.Version, "status": "todo", "title": "Must not save"}} {
		acceptanceError(t, process.request(context.Background(), http.MethodPut, statusPath, input, "invalid-status-body"), http.StatusBadRequest, "invalid_input")
	}
	wrongMethod := process.request(context.Background(), http.MethodPatch, statusPath, map[string]any{"version": first.Version, "status": "todo"}, "")
	acceptanceError(t, wrongMethod, http.StatusMethodNotAllowed, "method_not_allowed")
	if wrongMethod.header.Get("Allow") != "PUT" {
		t.Fatal("status route omitted its exact PUT Allow contract")
	}
	acceptanceError(t, process.request(context.Background(), http.MethodPut, acceptanceTasksPath(other.ID)+"/"+first.ID+"/status", map[string]any{"version": first.Version, "status": "todo"}, ""), http.StatusNotFound, "not_found")
	acceptanceError(t, process.request(context.Background(), http.MethodGet, acceptanceTasksPath(project.ID)+"?status=proposed", nil, ""), http.StatusBadRequest, "invalid_input")
	if !reflect.DeepEqual(process.readTask(t, first), first) {
		t.Fatal("invalid status or metadata bypass input changed task state")
	}

	method := process.request(context.Background(), http.MethodDelete, acceptanceTaskPath(first), nil, "")
	acceptanceError(t, method, http.StatusMethodNotAllowed, "method_not_allowed")
	if method.header.Get("Allow") != "GET, HEAD, PATCH" {
		t.Fatal("unsupported method omitted its exact Allow contract")
	}
	first = process.update(t, first, map[string]any{"title": "Changed"})
	acceptanceError(t, process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(first), map[string]any{"version": 1, "title": first.Title}, ""), http.StatusConflict, "version_conflict")
	if !reflect.DeepEqual(process.readTask(t, first), first) {
		t.Fatal("stale no-op changed task state")
	}
	fixture.exec(t, "UPDATE tasks SET created_at='2026-01-01T00:00:00Z' WHERE project_id=$1", project.ID)
	readySecond := process.task(t, project, "Another ready task")
	fixture.exec(t, "UPDATE tasks SET created_at='2026-01-01T00:00:00Z' WHERE id=$1", readySecond.ID)
	expected := []string{first.ID, readySecond.ID}
	slices.Sort(expected)
	path := acceptanceTasksPath(project.ID) + "?status=todo&ready=true&limit=1"
	page := acceptanceDecode[api.TaskPage](t, process.request(context.Background(), http.MethodGet, path, nil, ""), http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].ID != expected[0] || page.NextCursor == nil {
		t.Fatal("filtered first keyset page differs from tied-timestamp order")
	}
	cursor := url.QueryEscape(*page.NextCursor)
	last := acceptanceDecode[api.TaskPage](t, process.request(context.Background(), http.MethodGet, path+"&cursor="+cursor, nil, ""), http.StatusOK)
	if len(last.Items) != 1 || last.Items[0].ID != expected[1] || last.NextCursor != nil {
		t.Fatal("filtered final keyset page or terminal cursor is invalid")
	}
	for index, path := range []string{acceptanceTasksPath(other.ID) + "?status=todo&ready=true&cursor=" + cursor, acceptanceTasksPath(project.ID) + "?status=todo&ready=false&cursor=" + cursor, "/api/v1/projects?cursor=" + cursor} {
		requestID := ""
		if index == 0 {
			requestID = acceptanceSQLRequestID
		}
		fault := acceptanceError(t, process.request(context.Background(), http.MethodGet, path, nil, requestID), http.StatusBadRequest, "invalid_input")
		if requestID != "" && fault.RequestID != requestID {
			t.Fatal("cursor refusal did not preserve its supplied request ID")
		}
	}
	blocked := acceptanceDecode[api.TaskPage](t, process.request(context.Background(), http.MethodGet, acceptanceTasksPath(project.ID)+"?status=todo&ready=false", nil, ""), http.StatusOK)
	if len(blocked.Items) != 2 || blocked.Items[0].Ready || blocked.Items[1].Ready {
		t.Fatal("ready and status filters did not intersect before pagination")
	}
	projectPage := acceptanceDecode[api.ProjectPage](t, process.request(context.Background(), http.MethodGet, "/api/v1/projects?limit=1", nil, ""), http.StatusOK)
	if len(projectPage.Items) != 1 || projectPage.NextCursor == nil {
		t.Fatal("project pagination omitted its continuation")
	}
	projectLast := acceptanceDecode[api.ProjectPage](t, process.request(context.Background(), http.MethodGet, "/api/v1/projects?limit=1&cursor="+url.QueryEscape(*projectPage.NextCursor), nil, ""), http.StatusOK)
	if len(projectLast.Items) != 1 || projectLast.NextCursor != nil || projectLast.Items[0].ID == projectPage.Items[0].ID {
		t.Fatal("project pagination repeated a resource or invented a remaining page")
	}
	process.signal(t)
	process.stopped(t, 0)
}

func acceptanceCompete(t *testing.T, fixture *acceptanceFixture, process *acceptanceProcess, project api.Project, operations ...func() acceptanceResponse) []acceptanceResponse {
	t.Helper()
	barrier := fixture.projectLock(t, project.ID)
	results := make(chan acceptanceResponse, len(operations))
	for _, operation := range operations {
		go func() { results <- operation() }()
	}
	fixture.waitWriters(t, process, len(operations))
	acceptanceRelease(t, barrier)
	responses := make([]acceptanceResponse, 0, len(operations))
	for range operations {
		responses = append(responses, acceptanceReceive(t, results))
	}
	return responses
}

func acceptanceOneWinner(t *testing.T, responses []acceptanceResponse, code string) {
	t.Helper()
	success, refused := 0, 0
	for _, response := range responses {
		if response.status == http.StatusOK && response.err == nil {
			acceptanceDecode[api.Task](t, response, http.StatusOK)
			success++
		} else {
			acceptanceError(t, response, http.StatusConflict, code)
			refused++
		}
	}
	if success != 1 || refused != 1 {
		t.Fatalf("concurrent writes produced %d winners and %d refusals", success, refused)
	}
}

func acceptanceReverseDependencies(t *testing.T, scenario *acceptanceScenario) {
	fixture := newAcceptanceFixture(t, scenario)
	process := fixture.launch(t, nil).started(t)
	project := process.project(t, "Reverse dependencies")
	first, second := process.task(t, project, "First"), process.task(t, project, "Second")
	responses := acceptanceCompete(t, fixture, process, project,
		func() acceptanceResponse {
			return process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(first), map[string]any{"version": first.Version, "dependsOn": []string{second.ID}}, "reverse-first")
		},
		func() acceptanceResponse {
			return process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(second), map[string]any{"version": second.Version, "dependsOn": []string{first.ID}}, "reverse-second")
		},
	)
	acceptanceOneWinner(t, responses, "dependency_cycle")
	first, second = process.readTask(t, first), process.readTask(t, second)
	if len(first.DependsOn)+len(second.DependsOn) != 1 || first.Version+second.Version != 3 {
		t.Fatal("HTTP reverse-edge race persisted an invalid graph or version")
	}
	process.signal(t)
	process.stopped(t, 0)
}

func acceptanceStatusRace(t *testing.T, scenario *acceptanceScenario) {
	fixture := newAcceptanceFixture(t, scenario)
	process := fixture.launch(t, nil).started(t)
	project := process.project(t, "Status race")
	task := process.task(t, project, "Concurrent work")
	for _, status := range []string{"in_progress", "todo", "done", "in_progress", "done", "todo"} {
		responses := acceptanceCompete(t, fixture, process, project,
			func() acceptanceResponse {
				return process.request(context.Background(), http.MethodPut, acceptanceTaskPath(task)+"/status", map[string]any{"version": task.Version, "status": status}, status+"-first")
			},
			func() acceptanceResponse {
				return process.request(context.Background(), http.MethodPut, acceptanceTaskPath(task)+"/status", map[string]any{"version": task.Version, "status": status}, status+"-second")
			},
		)
		acceptanceOneWinner(t, responses, "version_conflict")
		after := process.readTask(t, task)
		acceptanceTaskTimingTransition(t, task, after, status)
		preserved := after
		preserved.StartedAt, preserved.CompletedAt = task.StartedAt, task.CompletedAt
		preserved.Status, preserved.Ready, preserved.Version, preserved.UpdatedAt = task.Status, task.Ready, task.Version, task.UpdatedAt
		if after.Status != status || after.Version != task.Version+1 || !after.UpdatedAt.After(task.UpdatedAt) || !reflect.DeepEqual(preserved, task) {
			t.Fatal("concurrent status writes did not persist exactly one change")
		}
		task = after
	}
	confirmations := acceptanceCompete(t, fixture, process, project,
		func() acceptanceResponse {
			return process.request(context.Background(), http.MethodPut, acceptanceTaskPath(task)+"/status", map[string]any{"version": task.Version, "status": task.Status}, "same-status-first")
		},
		func() acceptanceResponse {
			return process.request(context.Background(), http.MethodPut, acceptanceTaskPath(task)+"/status", map[string]any{"version": task.Version, "status": task.Status}, "same-status-second")
		},
	)
	for _, response := range confirmations {
		if confirmed := acceptanceDecode[api.Task](t, response, http.StatusOK); !reflect.DeepEqual(confirmed, task) {
			t.Fatal("concurrent same-status confirmations changed the task")
		}
	}
	for _, source := range []string{"todo", "in_progress", "done"} {
		for _, target := range []string{"todo", "in_progress", "done"} {
			created := process.task(t, project, source+" to "+target)
			created = process.update(t, created, map[string]any{"description": "Reviewed status candidate"})
			before := process.setStatus(t, created, source)
			after := process.setStatus(t, before, target)
			if after.Status != target || after.Version != before.Version+boolIncrement(source != target) {
				t.Fatal("status pair returned the wrong version or target")
			}
			acceptanceError(t, process.request(context.Background(), http.MethodPut, acceptanceTaskPath(after)+"/status", map[string]any{"version": after.Version - 1, "status": target}, "stale-same-state"), http.StatusConflict, "version_conflict")
			if !reflect.DeepEqual(process.readTask(t, after), after) {
				t.Fatal("stale same-status request changed the task")
			}
		}
	}
	process.signal(t)
	process.stopped(t, 0)
}

func boolIncrement(value bool) int64 {
	if value {
		return 1
	}
	return 0
}

func acceptanceDependencyStatusRace(t *testing.T, scenario *acceptanceScenario) {
	fixture := newAcceptanceFixture(t, scenario)
	process := fixture.launch(t, nil).started(t)
	project := process.project(t, "Dependency edit and status")
	prerequisite := process.task(t, project, "Unfinished prerequisite")
	task := process.task(t, project, "Ready work")
	responses := acceptanceCompete(t, fixture, process, project,
		func() acceptanceResponse {
			return process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(task), map[string]any{"version": task.Version, "dependsOn": []string{prerequisite.ID}}, "dependency-edit")
		},
		func() acceptanceResponse {
			return process.request(context.Background(), http.MethodPut, acceptanceTaskPath(task)+"/status", map[string]any{"version": task.Version, "status": "in_progress"}, "dependency-status")
		},
	)
	acceptanceOneWinner(t, responses, "version_conflict")
	after := process.readTask(t, task)
	if after.Version != task.Version+1 ||
		after.Status == "in_progress" && (len(after.DependsOn) != 0 || len(after.BlockedBy) != 0) ||
		after.Status == "todo" && (!slices.Equal(after.DependsOn, []string{prerequisite.ID}) || !slices.Equal(after.BlockedBy, []string{prerequisite.ID})) ||
		after.Status != "todo" && after.Status != "in_progress" || after.Ready {
		t.Fatal("concurrent dependency editing and status write violated prerequisite invariants")
	}
	process.signal(t)
	process.stopped(t, 0)
}

func acceptanceReopenStatusRace(t *testing.T, scenario *acceptanceScenario) {
	fixture := newAcceptanceFixture(t, scenario)
	process := fixture.launch(t, nil).started(t)
	project := process.project(t, "Reopen and successor status")
	for _, external := range []bool{false, true} {
		for _, status := range []string{"in_progress", "done"} {
			predecessor := process.setStatus(t, process.task(t, project, "Completed prerequisite"), "done")
			successor := process.task(t, project, "Ready successor", predecessor.ID)
			if external {
				successor = process.update(t, successor, map[string]any{"externalDependsOn": []string{predecessor.ID}})
			}
			responses := acceptanceCompete(t, fixture, process, project,
				func() acceptanceResponse {
					return process.request(context.Background(), http.MethodPut, acceptanceTaskPath(predecessor)+"/status", map[string]any{"version": predecessor.Version, "status": "todo"}, "reopen-prerequisite")
				},
				func() acceptanceResponse {
					return process.request(context.Background(), http.MethodPut, acceptanceTaskPath(successor)+"/status", map[string]any{"version": successor.Version, "status": status}, "successor-status")
				},
			)
			acceptanceOneWinner(t, responses, "dependency_unsatisfied")
			afterPredecessor, afterSuccessor := process.readTask(t, predecessor), process.readTask(t, successor)
			if afterPredecessor.Status == "todo" {
				if afterPredecessor.Version != predecessor.Version+1 || afterSuccessor.Status != "todo" || afterSuccessor.Version != successor.Version || afterSuccessor.Ready || !slices.Equal(afterSuccessor.BlockedBy, []string{predecessor.ID}) {
					t.Fatal("reopen winner changed successor data or left it ready")
				}
			} else if afterPredecessor.Status != "done" || !reflect.DeepEqual(afterPredecessor, predecessor) || afterSuccessor.Status != status || afterSuccessor.Version != successor.Version+1 || len(afterSuccessor.BlockedBy) != 0 {
				t.Fatal("successor winner lost its completed prerequisite")
			}
			if external != slices.Equal(afterSuccessor.ExternalDependsOn, []string{predecessor.ID}) {
				t.Fatal("status competition changed edge classification")
			}
		}
	}
	process.signal(t)
	process.stopped(t, 0)
}

func acceptanceVersionRace(t *testing.T, scenario *acceptanceScenario) {
	fixture := newAcceptanceFixture(t, scenario)
	process := fixture.launch(t, nil).started(t)
	project := process.project(t, "Version race")
	task := process.task(t, project, "Original")
	responses := acceptanceCompete(t, fixture, process, project,
		func() acceptanceResponse {
			return process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(task), map[string]any{"version": task.Version, "title": "First", "properties": api.TaskProperties{PullRequests: []api.PullRequestProperty{{URL: "first", Title: "First"}}}}, "version-first")
		},
		func() acceptanceResponse {
			return process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(task), map[string]any{"version": task.Version, "title": "Second", "properties": api.TaskProperties{PullRequests: []api.PullRequestProperty{{URL: "second", Title: "Second"}}}}, "version-second")
		},
	)
	acceptanceOneWinner(t, responses, "version_conflict")
	after := process.readTask(t, task)
	if after.Version != task.Version+1 || after.Title != "First" && after.Title != "Second" || len(after.Properties.PullRequests) != 1 || after.Properties.PullRequests[0].Title != after.Title {
		t.Fatal("HTTP version race did not commit exactly one update")
	}
	process.signal(t)
	process.stopped(t, 0)
}

func acceptancePartialFailure(t *testing.T, scenario *acceptanceScenario) {
	fixture := newAcceptanceFixture(t, scenario)
	process := fixture.launch(t, nil).started(t)
	project := process.project(t, "Rollback")
	first, second, old := process.task(t, project, "First"), process.task(t, project, "Second"), process.task(t, project, "Old")
	target := process.task(t, project, "Original", old.ID)
	dependencies := []string{first.ID, second.ID}
	slices.Sort(dependencies)
	fixture.exec(t, fmt.Sprintf(`CREATE SEQUENCE acceptance_partial_write_progress;
		CREATE FUNCTION acceptance_reject_second_edge() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
		IF NEW.task_id='%s'::uuid AND NEW.depends_on_task_id='%s'::uuid THEN
			IF NOT EXISTS (SELECT 1 FROM tasks WHERE id=NEW.task_id AND title='Changed' AND description='Changed' AND version=2 AND properties::jsonb = '{"pullRequests":[{"url":"changed","title":"Changed"}]}'::jsonb)
			OR NOT EXISTS (SELECT 1 FROM task_dependencies WHERE task_id=NEW.task_id AND depends_on_task_id='%s'::uuid) THEN
				RAISE EXCEPTION USING ERRCODE='P1002', MESSAGE='acceptance-secret barrier was not reached';
			END IF;
			PERFORM nextval('acceptance_partial_write_progress');
			RAISE EXCEPTION USING ERRCODE='P1001', MESSAGE='acceptance-secret SQL driver diagnostic';
		END IF;
		RETURN NEW; END $$;
		CREATE TRIGGER acceptance_reject_second_edge BEFORE INSERT ON task_dependencies FOR EACH ROW EXECUTE FUNCTION acceptance_reject_second_edge()`, target.ID, dependencies[1], dependencies[0]))
	response := process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(target), map[string]any{"version": target.Version, "title": "Changed", "description": "Changed", "dependsOn": dependencies, "properties": api.TaskProperties{PullRequests: []api.PullRequestProperty{{URL: "changed", Title: "Changed"}}}}, "partial-write")
	acceptanceError(t, response, http.StatusInternalServerError, "internal_error")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var progressed bool
	if err := fixture.admin.QueryRow(ctx, "SELECT is_called FROM acceptance_partial_write_progress").Scan(&progressed); err != nil || !progressed {
		t.Fatal("database failure was not reached after changed metadata and the first dependency edge")
	}
	if !reflect.DeepEqual(process.readTask(t, target), target) {
		t.Fatal("HTTP persistence failure left changed fields, edges, version, or timestamps")
	}
	if !process.logs.matches(map[string]any{"request_id": "partial-write", "cause": "database", "error_code": "internal_error", "component": "task", "phase": "update"}) {
		t.Fatal("storage failure lost its safe request-correlated cause")
	}
	fixture.exec(t, "DROP TRIGGER acceptance_reject_second_edge ON task_dependencies; DROP FUNCTION acceptance_reject_second_edge()")
	updated := process.update(t, target, map[string]any{"title": "Changed", "description": "Changed", "dependsOn": dependencies, "properties": api.TaskProperties{PullRequests: []api.PullRequestProperty{{URL: "changed", Title: "Changed"}}}})
	if updated.Version != 2 || !slices.Equal(updated.DependsOn, dependencies) {
		t.Fatal("transaction or lock was unusable after failure rollback")
	}
	process.signal(t)
	process.stopped(t, 0)
}

func acceptanceCancellation(t *testing.T, scenario *acceptanceScenario) {
	fixture := newAcceptanceFixture(t, scenario)
	process := fixture.launch(t, nil).started(t)
	project, other := process.project(t, "Canceled project"), process.project(t, "Independent project")
	target, independent := process.task(t, project, "Original"), process.task(t, other, "Independent")
	barrier := fixture.projectLock(t, project.ID)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	results := make(chan acceptanceResponse, 1)
	go func() {
		results <- process.request(ctx, http.MethodPatch, acceptanceTaskPath(target), map[string]any{"version": target.Version, "title": "Late write", "properties": api.TaskProperties{PullRequests: []api.PullRequestProperty{{URL: "canceled", Title: "Canceled"}}}}, "canceled-update")
	}()
	fixture.waitWriters(t, process, 1)
	independent = process.update(t, independent, map[string]any{"title": "Progressed independently"})
	if independent.Title != "Progressed independently" {
		t.Fatal("unrelated project could not commit during a held project lock")
	}
	cancel()
	if response := acceptanceReceive(t, results); !errors.Is(response.err, context.Canceled) {
		t.Fatal("client cancellation did not end its actual HTTP request")
	}
	fixture.waitWriters(t, process, 0)
	acceptanceRelease(t, barrier)
	if !reflect.DeepEqual(process.readTask(t, target), target) {
		t.Fatal("canceled HTTP request performed a late write")
	}
	after := process.update(t, target, map[string]any{"title": "Reused lock"})
	if after.Version != target.Version+1 {
		t.Fatal("canceled transaction left its lock or version unusable")
	}
	ctx, done := context.WithTimeout(context.Background(), 3*time.Second)
	defer done()
	if err := acceptanceEventually(ctx, func() (bool, error) {
		return process.logs.matches(map[string]any{"request_id": "canceled-update", "cause": "canceled", "component": "task", "phase": "update"}), nil
	}); err != nil {
		t.Fatal("request cancellation was not observable with its request ID")
	}
	process.signal(t)
	process.stopped(t, 0)
}

func acceptanceGracefulShutdown(t *testing.T, scenario *acceptanceScenario) {
	fixture := newAcceptanceFixture(t, scenario)
	process := fixture.launch(t, map[string]string{"DAYNIGHT_SHUTDOWN_TIMEOUT": "3s"}).started(t)
	project := process.project(t, "Graceful process")
	target := process.task(t, project, "Original")
	barrier := fixture.projectLock(t, project.ID)
	results := make(chan acceptanceResponse, 1)
	go func() {
		results <- process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(target), map[string]any{"version": target.Version, "title": "Drained"}, "graceful-update")
	}()
	fixture.waitWriters(t, process, 1)
	process.signal(t)
	select {
	case <-process.done:
		t.Fatal("graceful signal terminated an active request before the drain deadline")
	case <-time.After(40 * time.Millisecond):
	}
	acceptanceRelease(t, barrier)
	after := acceptanceDecode[api.Task](t, acceptanceReceive(t, results), http.StatusOK)
	if after.Title != "Drained" || after.Version != target.Version+1 {
		t.Fatal("drained request did not finish its persistent update")
	}
	process.stopped(t, 0)
	if !process.logs.matches(map[string]any{"phase": "stopped"}) {
		t.Fatal("graceful process shutdown omitted completion evidence")
	}
	restarted := fixture.launch(t, map[string]string{"DAYNIGHT_LISTEN_ADDR": process.address}).started(t)
	if !reflect.DeepEqual(restarted.readTask(t, target), after) {
		t.Fatal("gracefully drained commit was not persistent")
	}
	restarted.signal(t)
	restarted.stopped(t, 0)
}

func acceptanceForcedShutdown(t *testing.T, scenario *acceptanceScenario) {
	fixture := newAcceptanceFixture(t, scenario)
	process := fixture.launch(t, map[string]string{"DAYNIGHT_SHUTDOWN_TIMEOUT": "80ms"}).started(t)
	project := process.project(t, "Forced process")
	target := process.task(t, project, "Original")
	barrier := fixture.projectLock(t, project.ID)
	results := make(chan acceptanceResponse, 1)
	go func() {
		results <- process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(target), map[string]any{"version": target.Version, "title": "Late forced write"}, "forced-update")
	}()
	fixture.waitWriters(t, process, 1)
	started := time.Now()
	process.signal(t)
	process.stopped(t, 1)
	if time.Since(started) > 4*time.Second {
		t.Fatal("forced shutdown exceeded its process bound")
	}
	response := acceptanceReceive(t, results)
	if response.err == nil {
		t.Fatal("expired drain returned an HTTP success instead of aborting the request")
	}
	fixture.waitWriters(t, process, 0)
	acceptanceRelease(t, barrier)
	if !process.logs.matches(map[string]any{"request_id": "forced-update", "cause": "canceled"}) || !process.logs.matches(map[string]any{"phase": "shutdown", "cause": "deadline"}) {
		t.Fatal("forced process shutdown lost cancellation or deadline classification")
	}
	restarted := fixture.launch(t, map[string]string{"DAYNIGHT_LISTEN_ADDR": process.address}).started(t)
	if !reflect.DeepEqual(restarted.readTask(t, target), target) {
		t.Fatal("expired process shutdown allowed a late persistent write")
	}
	restarted.signal(t)
	restarted.stopped(t, 0)
}

func acceptanceUnknownMigration(t *testing.T, scenario *acceptanceScenario) {
	fixture := newAcceptanceFixture(t, scenario)
	initial := fixture.launch(t, nil).started(t)
	initial.signal(t)
	initial.stopped(t, 0)
	fixture.exec(t, "INSERT INTO schema_migrations (version, checksum) VALUES (99, repeat('0', 64))")
	failed := fixture.launch(t, nil)
	failed.stopped(t, 1)
	if failed.logs.matches(map[string]any{"phase": "listening"}) || !failed.logs.matches(map[string]any{"phase": "startup", "diagnostic": "database migrate failed"}) {
		t.Fatal("unsupported migration history did not fail before accepting HTTP")
	}
	fixture.exec(t, "DELETE FROM schema_migrations WHERE version=99")
	recovered := fixture.launch(t, nil).started(t)
	recovered.project(t, "Recovered history")
	recovered.signal(t)
	recovered.stopped(t, 0)
}

func acceptanceFailedMigration(t *testing.T, scenario *acceptanceScenario) {
	fixture := newAcceptanceFixture(t, scenario)
	fixture.exec(t, "CREATE TABLE tasks (acceptance_marker boolean)")
	failed := fixture.launch(t, nil)
	failed.stopped(t, 1)
	if failed.logs.matches(map[string]any{"phase": "listening"}) || !failed.logs.matches(map[string]any{"phase": "startup", "diagnostic": "database migrate failed"}) {
		t.Fatal("migration SQL failure did not stop process startup")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var versions []int64
	if err := fixture.admin.QueryRow(ctx, "SELECT array_agg(version ORDER BY version) FROM schema_migrations").Scan(&versions); err != nil || !slices.Equal(versions, []int64{1}) {
		t.Fatal("failed migration did not retain exactly the earlier committed version")
	}
	if err := fixture.noSessions(ctx); err != nil {
		t.Fatal("failed migration process left database sessions or locks")
	}
	fixture.exec(t, "DROP TABLE tasks")
	recovered := fixture.launch(t, nil).started(t)
	project := recovered.project(t, "Recovered migration")
	recovered.task(t, project, "Recovered task")
	recovered.signal(t)
	recovered.stopped(t, 0)
}

func acceptanceConcurrentStartup(t *testing.T, scenario *acceptanceScenario) {
	fixture := newAcceptanceFixture(t, scenario)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	connection, err := fixture.admin.Acquire(ctx)
	if err != nil {
		t.Fatal("cannot acquire migration barrier connection")
	}
	defer connection.Release()
	const migrationLock int64 = 0x4441594e49474854
	if _, err := connection.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationLock); err != nil {
		t.Fatal("cannot acquire migration advisory barrier")
	}
	held := true
	defer func() {
		if held {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _ = connection.Exec(cleanup, "SELECT pg_advisory_unlock($1)", migrationLock)
		}
	}()
	first, second := fixture.launch(t, nil), fixture.launch(t, nil)
	err = acceptanceEventually(ctx, func() (bool, error) {
		var waiting int
		err := fixture.admin.QueryRow(ctx, `SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a USING (pid)
			WHERE a.application_name=ANY($1::text[]) AND l.locktype='advisory' AND NOT l.granted
			AND l.classid=$2::oid AND l.objid=$3::oid`, []string{first.application, second.application}, migrationLock>>32, migrationLock&0xffffffff).Scan(&waiting)
		return waiting == 2, err
	})
	if err != nil {
		t.Fatal("actual process startups did not both wait on the owned migration barrier")
	}
	if _, err := connection.Exec(ctx, "SELECT pg_advisory_unlock($1)", migrationLock); err != nil {
		t.Fatal("cannot release migration startup barrier")
	}
	held = false
	first = first.started(t)
	second = second.started(t)
	var versions []int64
	if err := fixture.admin.QueryRow(ctx, "SELECT array_agg(version ORDER BY version) FROM schema_migrations").Scan(&versions); err != nil || !slices.Equal(versions, []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}) {
		t.Fatal("concurrent processes did not share exactly one migration ledger")
	}
	project := first.project(t, "Shared process state")
	read := acceptanceDecode[api.Project](t, second.request(context.Background(), http.MethodGet, "/api/v1/projects/"+project.ID, nil, ""), http.StatusOK)
	if !reflect.DeepEqual(project, read) {
		t.Fatal("concurrently initialized processes do not share persisted resources")
	}
	path := "/api/v1/projects/" + project.ID + "/task-sync"
	syncContext, finishSync := context.WithTimeout(context.Background(), 8*time.Second)
	defer finishSync()
	firstSync := acceptanceDecode[api.TaskSync](t, first.request(syncContext, http.MethodGet, path, nil, ""), http.StatusOK)
	secondSync := acceptanceDecode[api.TaskSync](t, second.request(syncContext, http.MethodGet, path, nil, ""), http.StatusOK)
	if firstSync.Epoch == "" || firstSync.Epoch != secondSync.Epoch || firstSync.Mode != "snapshot" || secondSync.Mode != "snapshot" || firstSync.Project != project || secondSync.Project != project || firstSync.Tasks == nil || secondSync.Tasks == nil || len(firstSync.Tasks) != 0 || len(secondSync.Tasks) != 0 {
		t.Fatal("concurrently initialized processes do not share the persisted task cache epoch")
	}
	first.signal(t)
	second.signal(t)
	first.stopped(t, 0)
	second.stopped(t, 0)
}

func acceptanceStatusReads(t *testing.T, scenario *acceptanceScenario) {
	fixture := newAcceptanceFixture(t, scenario)
	process := fixture.launch(t, nil).started(t)
	project := process.project(t, "Three-state read projection")
	pending := process.task(t, project, "Pending prerequisite")
	done := process.setStatus(t, process.task(t, project, "Completed prerequisite"), "done")
	ready := api.Task{ID: "00000000-0000-4000-8000-000000000001", ProjectID: project.ID}
	blocked := api.Task{ID: "00000000-0000-4000-8000-000000000002", ProjectID: project.ID}
	fixture.exec(t, `INSERT INTO tasks (id, project_id, title, description, status, version)
		VALUES ($1, $3, 'Ready', 'Complete task description', 'todo', 17),
		($2, $3, 'Blocked', '', 'todo', 19)`, ready.ID, blocked.ID, project.ID)
	fixture.exec(t, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id)
		VALUES ($1, $2, $4), ($1, $3, $5)`, project.ID, ready.ID, blocked.ID, done.ID, pending.ID)
	ready = process.readTask(t, ready)
	blocked = process.readTask(t, blocked)
	if ready.Status != "todo" || !ready.Ready || ready.Version != 17 || ready.Description != "Complete task description" ||
		len(ready.BlockedBy) != 0 || blocked.Status != "todo" || blocked.Ready || blocked.Version != 19 ||
		!slices.Equal(blocked.BlockedBy, []string{pending.ID}) {
		t.Fatal("todo rows did not retain detail/readiness projection")
	}
	dependent := process.task(t, project, "Waiting for prerequisite", ready.ID)
	if dependent.Status != "todo" || dependent.Ready || !slices.Equal(dependent.BlockedBy, []string{ready.ID}) {
		t.Fatal("unfinished prerequisite did not block task creation")
	}
	var ids []string
	path := acceptanceTasksPath(project.ID) + "?limit=2"
	for {
		page := acceptanceDecode[api.TaskPage](t, process.request(context.Background(), http.MethodGet, path, nil, ""), http.StatusOK)
		for _, task := range page.Items {
			ids = append(ids, task.ID)
			if task.ID == ready.ID && (task.Status != "todo" || !task.Ready || task.Version != 17 || task.Description != ready.Description) {
				t.Fatal("paginated task lost its detail projection")
			}
		}
		if page.NextCursor == nil {
			break
		}
		path = acceptanceTasksPath(project.ID) + "?limit=2&cursor=" + url.QueryEscape(*page.NextCursor)
	}
	wantIDs := []string{pending.ID, done.ID, ready.ID, blocked.ID, dependent.ID}
	slices.Sort(ids)
	slices.Sort(wantIDs)
	if !slices.Equal(ids, wantIDs) {
		t.Fatal("paginated inventory omitted or repeated a row")
	}
	readyPage := acceptanceDecode[api.TaskPage](t, process.request(context.Background(), http.MethodGet, acceptanceTasksPath(project.ID)+"?ready=true", nil, ""), http.StatusOK)
	readyIDs := make([]string, 0, len(readyPage.Items))
	for _, task := range readyPage.Items {
		readyIDs = append(readyIDs, task.ID)
	}
	wantReadyIDs := []string{pending.ID, ready.ID}
	slices.Sort(readyIDs)
	slices.Sort(wantReadyIDs)
	if !slices.Equal(readyIDs, wantReadyIDs) {
		t.Fatal("ready inventory did not use all todo prerequisites")
	}
	graph := acceptanceDecode[api.TaskGraph](t, process.request(context.Background(), http.MethodGet, "/api/v1/projects/"+project.ID+"/task-graph", nil, ""), http.StatusOK)
	if graph.Summary != (api.TaskGraphSummary{Total: 5, Todo: 4, Done: 1, Ready: 2, Blocked: 2}) || len(graph.Tasks) != 5 {
		t.Fatal("built process did not project the complete three-state summary")
	}
	for _, task := range graph.Tasks {
		if task.ID == ready.ID && (task.Status != "todo" || !task.Ready || len(task.BlockedBy) != 0) ||
			task.ID == blocked.ID && (task.Status != "todo" || task.Ready || !slices.Equal(task.BlockedBy, blocked.BlockedBy)) {
			t.Fatal("built graph changed readiness or prerequisite projection")
		}
	}
	todos := acceptanceDecode[api.TaskPage](t, process.request(context.Background(), http.MethodGet, acceptanceTasksPath(project.ID)+"?status=todo", nil, ""), http.StatusOK)
	if len(todos.Items) != 4 {
		t.Fatal("todo filter omitted tasks or included another state")
	}
	acceptanceError(t, process.request(context.Background(), http.MethodGet, acceptanceTasksPath(project.ID)+"?status=proposed", nil, ""), http.StatusBadRequest, "invalid_input")
	acceptanceError(t, process.request(context.Background(), http.MethodPut, acceptanceTaskPath(pending)+"/status", map[string]any{"version": pending.Version, "status": "proposed"}, ""), http.StatusBadRequest, "invalid_input")
	if after := process.readTask(t, pending); !reflect.DeepEqual(after, pending) {
		t.Fatal("rejected old status changed the task")
	}
	process.signal(t)
	process.stopped(t, 0)
	restarted := fixture.launch(t, nil).started(t)
	if !reflect.DeepEqual(restarted.readTask(t, ready), ready) || !reflect.DeepEqual(restarted.readTask(t, blocked), blocked) {
		t.Fatal("detail projection changed across migration recheck and restart")
	}
	restarted.signal(t)
	restarted.stopped(t, 0)
}
