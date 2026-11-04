package e2e_tests

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
)

const taskStepsCollectionRoute = "/api/v1/projects/{projectId}/tasks/{taskId}/steps"

func taskStepsAddRequestBudget(t *testing.T, process *acceptanceProcess, project api.Project, start int, want ...string) []acceptanceAssignmentRequest {
	t.Helper()
	end := acceptanceAssignmentMark(t, process, project) - 1
	requests := acceptanceAssignmentRequests(process)[start:end]
	if len(requests) != len(want) {
		t.Fatalf("installed Add request count=%d, expected=%d: %v", len(requests), len(want), requests)
	}
	for index, request := range requests {
		if request.Route != want[index] || request.RequestID == "" {
			t.Fatalf("installed Add request %d: %+v, expected %s", index, request, want[index])
		}
	}
	return requests
}

func taskStepsAddProducerTarget(t *testing.T, process *acceptanceProcess, requestID, stepID string) {
	t.Helper()
	if _, err := uuid.Parse(requestID); err != nil {
		t.Fatal("installed Add did not submit its original UUID request identity")
	}
	if !process.logs.matches(map[string]any{"component": "task_step", "operation": "add", "phase": "commit", "request_id": requestID, "step_id": stepID, "tx_outcome": "committed"}) {
		t.Fatal("installed Add receipt target differs from the pre-dispatch producer identity")
	}
}

func TestInstalledCLITaskStepsAddAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_task_steps_add", []string{"ST-V2", "ST-V3", "ST-V4", "ST-V9", "ST-V10", "ST-V11", "ST-V12"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		cli.configure(t, process)
		project := process.project(t, "Installed Steps Add")
		task := process.task(t, project, "Ordered independent records")
		parentBefore := process.readTask(t, task)
		title, description := "  <同名&> 😀 \uFEFF  ", "  # 完整 Markdown\n\t<>& \\\"\r\n\x1b[32m\u2028\u2029  "
		add := func(arguments ...string) string {
			return taskStepsRunSuccess(t, cli, append([]string{"task", "step", "add", task.ID, "--project", project.ID}, arguments...)...)
		}
		mark := acceptanceAssignmentMark(t, process, project)
		firstText := add("--if-version", "1", "--id", "00ABCDEF", "--title", title, "--json")
		first := acceptanceCLIJSON[api.StepsResource](t, firstText)
		taskStepsCompleteJSON(t, firstText, false)
		requests := taskStepsAddRequestBudget(t, process, project, mark, "POST "+taskStepsCollectionRoute)
		if first.ProjectID != project.ID || first.TaskID != task.ID || first.Version != 2 || len(first.Steps) != 1 || first.Steps[0].ID != "00abcdef" || first.Steps[0].Title != title || first.Steps[0].Description != "" || first.Steps[0].Status != core.TaskStepTodo || first.Steps[0].CreatedAt != first.Steps[0].UpdatedAt {
			t.Fatal("explicit Add lost defaults, canonical identity or complete +1 receipt")
		}
		taskStepsAddProducerTarget(t, process, requests[0].RequestID, "00abcdef")
		mark = acceptanceAssignmentMark(t, process, project)
		secondText := add("--id", "12345678", "--title", title, "--description", description, "--status", "done", "--before", "00ABCDEF", "--json")
		second := acceptanceCLIJSON[api.StepsResource](t, secondText)
		taskStepsCompleteJSON(t, secondText, false)
		requests = taskStepsAddRequestBudget(t, process, project, mark, "GET "+taskStepsCollectionRoute, "POST "+taskStepsCollectionRoute)
		if second.Version != 3 || len(second.Steps) != 2 || second.Steps[0].ID != "12345678" || second.Steps[0].Title != title || second.Steps[0].Description != description || second.Steps[0].Status != core.TaskStepDone || second.Steps[0].CreatedAt != second.Steps[0].UpdatedAt || second.Steps[1] != first.Steps[0] {
			t.Fatal("default-version before Add changed old fields/order or new text/state")
		}
		taskStepsAddProducerTarget(t, process, requests[1].RequestID, "12345678")
		mark = acceptanceAssignmentMark(t, process, project)
		thirdText := add("--if-version", "3", "--title", title, "--description", "", "--status", "in_progress", "--after", "12345678", "--json")
		third := acceptanceCLIJSON[api.StepsResource](t, thirdText)
		requests = taskStepsAddRequestBudget(t, process, project, mark, "POST "+taskStepsCollectionRoute)
		if len(third.Steps) != 3 {
			t.Fatal("generated Add did not return three complete records")
		}
		generated := third.Steps[1]
		if third.Version != 4 || len(third.Steps) != 3 || !regexp.MustCompile(`^[0-9a-f]{8}$`).MatchString(generated.ID) || generated.Title != title || generated.Description != "" || generated.Status != core.TaskStepInProgress || generated.CreatedAt != generated.UpdatedAt || third.Steps[0] != second.Steps[0] || third.Steps[2] != second.Steps[1] {
			t.Fatal("generated Add identity/after placement or unchanged rows lost")
		}
		taskStepsAddProducerTarget(t, process, requests[0].RequestID, generated.ID)
		fourthText := add("--if-version", "4", "--id", "fedcba98", "--title", "\uFEFF", "--status", "skipped", "--json")
		fourth := acceptanceCLIJSON[api.StepsResource](t, fourthText)
		if fourth.Version != 5 || len(fourth.Steps) != 4 || fourth.Steps[3].ID != "fedcba98" || fourth.Steps[3].Status != core.TaskStepSkipped {
			t.Fatal("append or independent skipped state was not confirmed")
		}
		if read := acceptanceDecode[api.StepsResource](t, process.request(context.Background(), http.MethodGet, acceptanceTaskPath(task)+"/steps", nil, "steps-add-readback"), http.StatusOK); len(read.Steps) != 4 || read.Steps[1].ID != generated.ID || read.Steps[0].Description != description {
			t.Fatal("installed Add did not persist actual ordered records")
		}
		for _, tc := range []struct {
			arguments []string
			code      string
			routes    []string
		}{
			{[]string{"--if-version", "5", "--id", "00ABCDEF", "--title", "duplicate"}, "step_id_conflict", []string{"POST " + taskStepsCollectionRoute}},
			{[]string{"--if-version", "4", "--id", "aaaaaaaa", "--title", "stale"}, "version_conflict", []string{"POST " + taskStepsCollectionRoute}},
			{[]string{"--if-version", "5", "--id", "aaaaaaaa", "--title", "anchor", "--after", "eeeeeeee"}, "not_found", []string{"POST " + taskStepsCollectionRoute}},
		} {
			mark = acceptanceAssignmentMark(t, process, project)
			result := taskStepsRunRead(t, cli, append([]string{"task", "step", "add", task.ID, "--project", project.ID, "--json"}, tc.arguments...)...)
			if result.status != 1 || result.stdout != "" || !strings.Contains(result.stderr, "code="+tc.code) || strings.Contains(strings.ToLower(result.stderr), "outcome is unknown") {
				t.Fatal("known Add refusal was concealed, retried or classified unknown")
			}
			taskStepsAddRequestBudget(t, process, project, mark, tc.routes...)
		}
		missing := uuid.NewString()
		mark = acceptanceAssignmentMark(t, process, project)
		failedRead := taskStepsRunRead(t, cli, "task", "step", "add", missing, "--project", project.ID, "--id", "aaaaaaaa", "--title", "No POST after missing baseline", "--json")
		if failedRead.status != 1 || failedRead.stdout != "" || !strings.Contains(failedRead.stderr, "code=not_found") || strings.Contains(strings.ToLower(failedRead.stderr), "outcome is unknown") {
			t.Fatal("failed default pre-read became an Add receipt")
		}
		taskStepsAddRequestBudget(t, process, project, mark, "GET "+taskStepsCollectionRoute)
		fixture.exec(t, `UPDATE tasks SET version=9007199254740993 WHERE id=$1`, task.ID)
		exact := acceptanceCLIJSON[api.StepsResource](t, add("--if-version", "9007199254740993", "--id", "aaaaaaaa", "--title", "Exact version", "--json"))
		if exact.Version != 9007199254740994 || len(exact.Steps) != 5 || exact.Steps[len(exact.Steps)-1].ID != "aaaaaaaa" {
			t.Fatal("installed Add rounded an explicit positive int64")
		}
		readable := add("--if-version", "9007199254740994", "--id", "bbbbbbbb", "--title", "Control\x1b[31m\nFull title")
		if !strings.Contains(readable, "9007199254740995") || !strings.Contains(readable, "bbbbbbbb") || !strings.Contains(readable, `Control\u001b[31m\nFull title`) || strings.Contains(readable, "\x1b") {
			t.Fatal("readable Add did not present confirmed full resource safely")
		}
		parentAfter := process.readTask(t, task)
		preserved := parentAfter
		preserved.Version, preserved.UpdatedAt = parentBefore.Version, parentBefore.UpdatedAt
		if !reflect.DeepEqual(preserved, parentBefore) {
			t.Fatal("installed Add changed unrelated parent fields")
		}
		process.signal(t)
		process.stopped(t, 0)
	})
}

func TestInstalledCLITaskStepsAddUnknownAfterRealCommit(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_task_steps_add_unknown", []string{"ST-V11", "ST-V12"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		project := process.project(t, "Unknown Add")
		task := process.task(t, project, "Original identity only")
		target, err := url.Parse(process.origin)
		if err != nil {
			t.Fatal(err)
		}
		path := acceptanceTaskPath(task) + "/steps"
		type observedRequest struct{ method, id, step, authorization string }
		var mutex sync.Mutex
		var observed []observedRequest
		proxy := httputil.NewSingleHostReverseProxy(target)
		director := proxy.Director
		proxy.Director = func(request *http.Request) {
			director(request)
			if request.URL.Path != path {
				t.Error("unknown Add crossed its original Task scope")
				return
			}
			item := observedRequest{method: request.Method, id: request.Header.Get("X-Request-ID"), authorization: request.Header.Get("Authorization")}
			if request.Method == http.MethodPost {
				data, readErr := io.ReadAll(io.LimitReader(request.Body, 1<<20+1))
				if readErr != nil {
					t.Error(readErr)
				}
				request.Body = io.NopCloser(bytes.NewReader(data))
				var body struct {
					ID string `json:"id"`
				}
				if json.Unmarshal(data, &body) != nil {
					t.Error("Add body is not readable")
				}
				item.step = body.ID
			}
			mutex.Lock()
			observed = append(observed, item)
			mutex.Unlock()
		}
		proxy.ModifyResponse = func(response *http.Response) error {
			if response.Request.Method == http.MethodPost && response.StatusCode == http.StatusCreated {
				if err := response.Body.Close(); err != nil {
					t.Error("cannot close lost Add response")
				}
				return errors.New("private proxy loss after actual Step commit")
			}
			return nil
		}
		proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) { w.WriteHeader(http.StatusBadGateway) }
		server := httptest.NewServer(proxy)
		t.Cleanup(server.Close)
		cli.configure(t, &acceptanceProcess{origin: server.URL, token: process.token})
		result := taskStepsRunRead(t, cli, "task", "step", "add", task.ID, "--project", project.ID, "--if-version", "1", "--title", "unknown-title-sentinel", "--description", "unknown-markdown-sentinel", "--json")
		mutex.Lock()
		requests := append([]observedRequest{}, observed...)
		mutex.Unlock()
		if result.status != 1 || result.stdout != "" || !strings.Contains(strings.ToLower(result.stderr), "unknown") || len(requests) != 2 || requests[0].method != http.MethodPost || requests[1].method != http.MethodGet {
			t.Fatalf("unknown Add lost one-POST/one-current-read lifecycle: status=%d request_count=%d diagnostic_bytes=%d", result.status, len(requests), len(result.stderr))
		}
		original := requests[0]
		if _, err := uuid.Parse(original.id); err != nil || !regexp.MustCompile(`^[0-9a-f]{8}$`).MatchString(original.step) || requests[1].id != original.id+".r1" || original.authorization != "Bearer "+process.token || requests[1].authorization != original.authorization {
			t.Fatal("unknown Add regenerated identity/request or changed principal")
		}
		if !strings.Contains(result.stderr, original.id) || !strings.Contains(result.stderr, original.step) || !strings.Contains(strings.ToLower(result.stderr), "found") || strings.Contains(result.stderr, "unknown-title-sentinel") || strings.Contains(result.stderr, "unknown-markdown-sentinel") || strings.Contains(result.stderr, "private proxy loss") || strings.Contains(result.stderr, process.token) {
			t.Fatal("unknown Add lost original diagnostic identity/current facts or exposed payload/cause")
		}
		current := acceptanceDecode[api.StepsResource](t, process.request(context.Background(), http.MethodGet, path, nil, "steps-add-after-loss"), http.StatusOK)
		if current.Version != 2 || len(current.Steps) != 1 || current.Steps[0].ID != original.step || current.Steps[0].Title != "unknown-title-sentinel" {
			t.Fatal("actual lost receipt did not retain exactly one original Step")
		}
		cli.configure(t, process)
		process.signal(t)
		process.stopped(t, 0)
	})
}
