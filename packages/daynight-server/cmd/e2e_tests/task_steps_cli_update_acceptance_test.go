package e2e_tests

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func taskStepsUpdatePreserved(t *testing.T, before, after api.StepsResource, parentBefore, parentAfter api.Task, targetID string, changed bool) {
	t.Helper()
	if before.ProjectID != after.ProjectID || before.TaskID != after.TaskID || len(before.Steps) != len(after.Steps) {
		t.Fatal("installed Step change altered scope or collection membership")
	}
	expectedVersion := before.Version
	if changed {
		expectedVersion++
	}
	if after.Version != expectedVersion || parentAfter.Version != expectedVersion {
		t.Fatal("installed Step change returned the wrong exact no-op/+1 parent version")
	}
	for index, old := range before.Steps {
		current := after.Steps[index]
		if old.ID != targetID {
			if current != old {
				t.Fatal("installed Step change altered a non-target field, timestamp or position")
			}
			continue
		}
		if current.ID != old.ID || current.CreatedAt != old.CreatedAt || changed && current.UpdatedAt == old.UpdatedAt || !changed && current != old {
			t.Fatal("installed Step change altered target identity/creation time or used the wrong content-time branch")
		}
		if changed && !parentAfter.UpdatedAt.Equal(current.UpdatedAt) {
			t.Fatal("changed target and parent do not share the stored content timestamp")
		}
	}
	preserved := parentAfter
	preserved.Version, preserved.UpdatedAt = parentBefore.Version, parentBefore.UpdatedAt
	if !reflect.DeepEqual(preserved, parentBefore) || !changed && !reflect.DeepEqual(parentAfter, parentBefore) {
		t.Fatal("installed Step change altered unrelated parent fields or no-op parent time")
	}
}

func TestInstalledCLITaskStepsUpdateAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_task_steps_update", []string{"ST-V3", "ST-V4", "ST-V5", "ST-V9", "ST-V12", "ST-V13", "ST-V15"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		cli.configure(t, process)
		project := process.project(t, "Installed Steps updates")
		predecessor := process.task(t, project, "Retained prerequisite")
		predecessor = process.setStatus(t, predecessor, "done")
		task := process.task(t, project, "Parent metadata remains independent", predecessor.ID)
		task = process.update(t, task, map[string]any{
			"description": "Parent Markdown remains unchanged", "requiredPlatform": "linux",
			"properties": map[string]any{"pullRequests": []map[string]string{{"url": "https://github.com/example/repo/pull/42", "title": "Retained result"}}},
		})
		path := acceptanceTaskPath(task) + "/steps"
		var current api.StepsResource
		for _, id := range []string{"00abcdef", "00000000"} {
			version := task.Version
			if current.Version != 0 {
				version = current.Version
			}
			current = acceptanceDecode[api.StepsResource](t, process.request(context.Background(), http.MethodPost, path, map[string]any{"version": version, "id": id, "title": "same", "description": "Retained initial Markdown", "status": "in_progress"}, ""), http.StatusCreated)
		}
		task = process.setStatus(t, process.readTask(t, task), "in_progress")
		task = process.setStatus(t, task, "done")
		current = acceptanceDecode[api.StepsResource](t, process.request(context.Background(), http.MethodGet, path, nil, ""), http.StatusOK)
		if task.Status != "done" || task.AllowAgents || current.Steps[0].Status != model.TaskStepInProgress || current.Steps[1].Status != model.TaskStepInProgress {
			t.Fatal("update fixture lacks done parent, disabled execution and multiple in-progress Steps")
		}
		targetID := "00abcdef"
		run := func(name string, arguments []string, explicit bool, expected api.TaskStep) string {
			t.Helper()
			before := current
			parentBefore := process.readTask(t, task)
			args := []string{"task", "step", name, task.ID, strings.ToUpper(targetID)}
			args = append(args, arguments...)
			args = append(args, "--project", project.ID, "--json")
			if explicit {
				args = append(args, "--if-version", strconv.FormatInt(before.Version, 10))
			}
			mark := acceptanceAssignmentMark(t, process, project)
			output := taskStepsRunSuccess(t, cli, args...)
			current = acceptanceCLIJSON[api.StepsResource](t, output)
			taskStepsCompleteJSON(t, output, false)
			writeRoute := "PATCH /api/v1/projects/{projectId}/tasks/{taskId}/steps/{stepId}"
			if name == "set-status" {
				writeRoute = "PUT /api/v1/projects/{projectId}/tasks/{taskId}/steps/{stepId}/status"
			}
			routes := []string{writeRoute}
			if !explicit {
				routes = append([]string{"GET " + taskStepsCollectionRoute}, routes...)
			}
			taskStepsAddRequestBudget(t, process, project, mark, routes...)
			parentAfter := process.readTask(t, task)
			actual := current.Steps[0]
			changed := before.Steps[0].Title != expected.Title || before.Steps[0].Description != expected.Description || before.Steps[0].Status != expected.Status
			if actual.Title != expected.Title || actual.Description != expected.Description || actual.Status != expected.Status {
				t.Fatal("installed update lost requested raw text/status or replaced an omitted field")
			}
			taskStepsUpdatePreserved(t, before, current, parentBefore, parentAfter, targetID, changed)
			return output
		}
		title := "  <原值&> 😀 \uFEFF \x1b[31m\nFull title\r\u2028\u2029  "
		description := "  # 原始 Markdown\n\t<>& \\\"\r\n\x1b[32m\u2028\u2029  "
		expected := current.Steps[0]
		expected.Title = title
		run("update", []string{"--title", title}, true, expected)
		expected.Description = description
		run("update", []string{"--description", description}, false, expected)
		expected.Description = ""
		run("update", []string{"--description", ""}, false, expected)
		expected.Title, expected.Description = "\uFEFF", description
		run("update", []string{"--title", expected.Title, "--description", description}, true, expected)
		run("update", []string{"--title", expected.Title, "--description", description}, false, expected)
		states := []model.TaskStepStatus{model.TaskStepTodo, model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped}
		for _, from := range states {
			for _, to := range states {
				expected.Status = from
				run("set-status", []string{string(from)}, true, expected)
				expected.Status = to
				run("set-status", []string{string(to)}, false, expected)
			}
		}
		beforeRefusals := current
		for _, tc := range []struct {
			name, id, code string
			arguments      []string
		}{
			{"update", targetID, "version_conflict", []string{"--title", expected.Title}},
			{"set-status", targetID, "version_conflict", []string{string(expected.Status)}},
			{"update", "eeeeeeee", "version_conflict", []string{"--description", ""}},
		} {
			mark := acceptanceAssignmentMark(t, process, project)
			args := append([]string{"task", "step", tc.name, task.ID, tc.id}, tc.arguments...)
			args = append(args, "--project", project.ID, "--if-version", strconv.FormatInt(current.Version-1, 10), "--json")
			result := taskStepsRunRead(t, cli, args...)
			if result.status != 1 || result.stdout != "" || !strings.Contains(result.stderr, "code="+tc.code) || strings.Contains(strings.ToLower(result.stderr), "outcome is unknown") {
				t.Fatal("stale same-value update was retried, concealed or reported unknown")
			}
			route := "PATCH /api/v1/projects/{projectId}/tasks/{taskId}/steps/{stepId}"
			if tc.name == "set-status" {
				route = "PUT /api/v1/projects/{projectId}/tasks/{taskId}/steps/{stepId}/status"
			}
			taskStepsAddRequestBudget(t, process, project, mark, route)
		}
		afterRefusals := acceptanceDecode[api.StepsResource](t, process.request(context.Background(), http.MethodGet, path, nil, ""), http.StatusOK)
		if !reflect.DeepEqual(beforeRefusals, afterRefusals) {
			t.Fatal("stale updates changed persisted Steps")
		}
		for _, name := range []string{"update", "set-status"} {
			args := []string{"task", "step", name, uuid.NewString(), targetID}
			if name == "update" {
				args = append(args, "--title", "No write after failed baseline")
			} else {
				args = append(args, "done")
			}
			args = append(args, "--project", project.ID, "--json")
			mark := acceptanceAssignmentMark(t, process, project)
			result := taskStepsRunRead(t, cli, args...)
			if result.status != 1 || result.stdout != "" || !strings.Contains(result.stderr, "code=not_found") {
				t.Fatal("failed update baseline became a successful write")
			}
			taskStepsAddRequestBudget(t, process, project, mark, "GET "+taskStepsCollectionRoute)
		}
		fixture.exec(t, `UPDATE tasks SET version=9007199254740993 WHERE id=$1`, task.ID)
		current.Version = 9007199254740993
		expected.Title = title
		run("update", []string{"--title", title}, true, expected)
		readable := taskStepsRunSuccess(t, cli, "task", "step", "set-status", task.ID, targetID, string(expected.Status), "--project", project.ID, "--if-version", strconv.FormatInt(current.Version, 10))
		if !strings.Contains(readable, strconv.FormatInt(current.Version, 10)) || !strings.Contains(readable, `\u001b[31m\nFull title`) || strings.Contains(readable, "\x1b") || !strings.Contains(readable, "00000000") {
			t.Fatal("readable update lost exact version/full collection or exposed terminal control text")
		}
		fixture.exec(t, `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, int64(math.MaxInt64))
		current.Version = math.MaxInt64
		run("update", []string{"--description", expected.Description}, true, expected)
		run("set-status", []string{string(expected.Status)}, false, expected)
		parentAtMaximum := process.readTask(t, task)
		for _, tc := range []struct {
			name, id, code, version string
			arguments               []string
		}{
			{"update", targetID, "version_exhausted", "9223372036854775807", []string{"--title", "Changed at exhausted version"}},
			{"set-status", targetID, "version_exhausted", "9223372036854775807", []string{"todo"}},
			{"update", "eeeeeeee", "not_found", "9223372036854775807", []string{"--description", ""}},
			{"set-status", targetID, "version_conflict", "9223372036854775806", []string{string(expected.Status)}},
		} {
			args := append([]string{"task", "step", tc.name, task.ID, tc.id}, tc.arguments...)
			args = append(args, "--project", project.ID, "--if-version", tc.version, "--json")
			mark := acceptanceAssignmentMark(t, process, project)
			result := taskStepsRunRead(t, cli, args...)
			if result.status != 1 || result.stdout != "" || !strings.Contains(result.stderr, "code="+tc.code) || strings.Contains(strings.ToLower(result.stderr), "outcome is unknown") {
				t.Fatal("maximum-version rejection lost missing/stale/exhausted priority")
			}
			route := "PATCH /api/v1/projects/{projectId}/tasks/{taskId}/steps/{stepId}"
			if tc.name == "set-status" {
				route = "PUT /api/v1/projects/{projectId}/tasks/{taskId}/steps/{stepId}/status"
			}
			taskStepsAddRequestBudget(t, process, project, mark, route)
		}
		persistedAtMaximum := acceptanceDecode[api.StepsResource](t, process.request(context.Background(), http.MethodGet, path, nil, ""), http.StatusOK)
		if !reflect.DeepEqual(current, persistedAtMaximum) || !reflect.DeepEqual(parentAtMaximum, process.readTask(t, task)) {
			t.Fatal("maximum-version refusal changed Steps or parent data")
		}
		process.signal(t)
		process.stopped(t, 0)
	})
}

func TestInstalledCLITaskStepsUpdateUnknownAfterRealCommit(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	for _, name := range []string{"update", "set-status"} {
		t.Run(name, func(t *testing.T) {
			acceptanceCase(t, "installed_cli_task_steps_"+name+"_unknown", []string{"ST-V9", "ST-V10", "ST-V12", "ST-V13"}, func(t *testing.T, scenario *acceptanceScenario) {
				fixture := newAcceptanceFixture(t, scenario)
				process := fixture.launch(t, nil).started(t)
				cli := newAcceptanceCLI(t, receipt, scenario)
				project := process.project(t, "Unknown Step change")
				task := process.task(t, project, "Original identity only")
				path := acceptanceTaskPath(task) + "/steps"
				before := acceptanceDecode[api.StepsResource](t, process.request(context.Background(), http.MethodPost, path, map[string]any{"version": 1, "id": "00abcdef", "title": "Original title", "description": "Original Markdown", "status": "todo"}, ""), http.StatusCreated)
				target, err := url.Parse(process.origin)
				if err != nil {
					t.Fatal(err)
				}
				method, writePath := http.MethodPatch, path+"/00abcdef"
				arguments := []string{"--title", "unknown-title-sentinel", "--description", "unknown-markdown-sentinel"}
				if name == "set-status" {
					method, writePath, arguments = http.MethodPut, writePath+"/status", []string{"skipped"}
				}
				type observedRequest struct{ method, path, id, authorization string }
				var mutex sync.Mutex
				var observed []observedRequest
				proxy := httputil.NewSingleHostReverseProxy(target)
				director := proxy.Director
				proxy.Director = func(request *http.Request) {
					director(request)
					mutex.Lock()
					observed = append(observed, observedRequest{request.Method, request.URL.Path, request.Header.Get("X-Request-ID"), request.Header.Get("Authorization")})
					mutex.Unlock()
				}
				proxy.ModifyResponse = func(response *http.Response) error {
					if response.Request.Method == method && response.StatusCode == http.StatusOK {
						if err := response.Body.Close(); err != nil {
							t.Error("cannot close lost Step response")
						}
						return errors.New("private proxy loss after actual Step commit")
					}
					return nil
				}
				proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) { w.WriteHeader(http.StatusBadGateway) }
				server := httptest.NewServer(proxy)
				t.Cleanup(server.Close)
				cli.configure(t, &acceptanceProcess{origin: server.URL, token: process.token})
				args := append([]string{"task", "step", name, task.ID, "00ABCDEF"}, arguments...)
				args = append(args, "--project", project.ID, "--if-version", "2", "--json")
				result := taskStepsRunRead(t, cli, args...)
				mutex.Lock()
				requests := append([]observedRequest{}, observed...)
				mutex.Unlock()
				if result.status != 1 || result.stdout != "" || !strings.Contains(strings.ToLower(result.stderr), "unknown") || len(requests) != 2 || requests[0].method != method || requests[0].path != writePath || requests[1].method != http.MethodGet || requests[1].path != path {
					t.Fatalf("unknown Step change lost single-write/current-read lifecycle: status=%d request_count=%d diagnostic_bytes=%d", result.status, len(requests), len(result.stderr))
				}
				original := requests[0]
				if _, err := uuid.Parse(original.id); err != nil || requests[1].id != original.id+".r1" || original.authorization != "Bearer "+process.token || requests[1].authorization != original.authorization {
					t.Fatal("unknown Step change regenerated request identity or changed principal")
				}
				if !strings.Contains(result.stderr, original.id) || !strings.Contains(result.stderr, "00abcdef") || !strings.Contains(strings.ToLower(result.stderr), "found") || strings.Contains(result.stderr, "unknown-title-sentinel") || strings.Contains(result.stderr, "unknown-markdown-sentinel") || strings.Contains(result.stderr, "private proxy loss") || strings.Contains(result.stderr, process.token) {
					t.Fatal("unknown Step change lost diagnostic identity/current facts or exposed private payload/cause")
				}
				current := acceptanceDecode[api.StepsResource](t, process.request(context.Background(), http.MethodGet, path, nil, "steps-update-after-loss"), http.StatusOK)
				if current.Version != before.Version+1 || len(current.Steps) != 1 || current.Steps[0].ID != "00abcdef" || current.Steps[0].CreatedAt != before.Steps[0].CreatedAt {
					t.Fatal("lost Step receipt changed original identity or repeated the write")
				}
				if name == "update" && (current.Steps[0].Title != "unknown-title-sentinel" || current.Steps[0].Description != "unknown-markdown-sentinel" || current.Steps[0].Status != before.Steps[0].Status) || name == "set-status" && (current.Steps[0].Status != model.TaskStepSkipped || current.Steps[0].Title != before.Steps[0].Title || current.Steps[0].Description != before.Steps[0].Description) {
					t.Fatal("real unknown commit lost requested fields or changed omitted fields")
				}
				process.signal(t)
				process.stopped(t, 0)
			})
		})
	}
}
