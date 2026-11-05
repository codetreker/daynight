package e2e_tests

import (
	"context"
	"encoding/json"
	"errors"
	"io"
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
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

const taskStepsMoveRoute = "PUT /api/v1/projects/{projectId}/tasks/{taskId}/steps/{stepId}/position"

func taskStepsMoveSeed(t *testing.T, fixture *acceptanceFixture, task api.Task) []api.TaskStep {
	t.Helper()
	stamp := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
	rows := []api.TaskStep{
		{ID: "00000000", Title: "  Same\x1b[31m\nFull title  ", Description: "# original Markdown\n\"\\\u2028\u2029", Status: model.TaskStepDone, CreatedAt: stamp, UpdatedAt: stamp.Add(time.Hour)},
		{ID: "abcdef01", Title: "same", Description: "second", Status: model.TaskStepTodo, CreatedAt: stamp.Add(time.Microsecond), UpdatedAt: stamp.Add(time.Microsecond)},
		{ID: "12345678", Title: "same", Description: "third", Status: model.TaskStepSkipped, CreatedAt: stamp.Add(time.Second), UpdatedAt: stamp.Add(2 * time.Second)},
		{ID: "fedcba98", Title: "\uFEFF", Description: "fourth", Status: model.TaskStepInProgress, CreatedAt: stamp.Add(3 * time.Second), UpdatedAt: stamp.Add(3 * time.Second)},
	}
	for index, step := range rows {
		fixture.exec(t, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, task.ID, step.ID, index, step.Title, step.Description, step.Status, step.CreatedAt, step.UpdatedAt)
	}
	return rows
}

func taskStepsMoveCheckResource(t *testing.T, resource api.StepsResource, task api.Task, version int64, originals []api.TaskStep, order []string) {
	t.Helper()
	if resource.ProjectID != task.ProjectID || resource.TaskID != task.ID || resource.Version != version || len(resource.Steps) != len(order) {
		t.Fatal("installed Move did not return the complete scoped resource and exact version")
	}
	byID := make(map[string]api.TaskStep, len(originals))
	for _, step := range originals {
		byID[step.ID] = step
	}
	for index, step := range resource.Steps {
		if step.ID != order[index] || step != byID[step.ID] {
			t.Fatal("installed Move changed identity, content, status, timestamps or expected order")
		}
	}
}

func TestInstalledCLITaskStepsMoveAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_task_steps_move", []string{"ST-V2", "ST-V3", "ST-V4", "ST-V7", "ST-V9", "ST-V10", "ST-V11", "ST-V12"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		cli.configure(t, process)
		project := process.project(t, "Installed Steps Move")
		task := process.task(t, project, "Stable identities and independent placement")
		rows := taskStepsMoveSeed(t, fixture, task)
		version := int64(9007199254740993)
		fixture.exec(t, `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, version)
		originalParent := process.readTask(t, task)
		for _, tc := range []struct {
			id        string
			placement []string
			order     []string
			changed   bool
			explicit  bool
		}{
			{"00000000", []string{"--after", "12345678"}, []string{"abcdef01", "12345678", "00000000", "fedcba98"}, true, true},
			{"FEDCBA98", []string{"--before", "ABCDEF01"}, []string{"fedcba98", "abcdef01", "12345678", "00000000"}, true, false},
			{"12345678", []string{"--first"}, []string{"12345678", "fedcba98", "abcdef01", "00000000"}, true, true},
			{"fedcba98", []string{"--last"}, []string{"12345678", "abcdef01", "00000000", "fedcba98"}, true, false},
			{"abcdef01", []string{"--before", "00000000"}, []string{"12345678", "abcdef01", "00000000", "fedcba98"}, false, true},
			{"00000000", []string{"--after", "ABCDEF01"}, []string{"12345678", "abcdef01", "00000000", "fedcba98"}, false, false},
			{"12345678", []string{"--first"}, []string{"12345678", "abcdef01", "00000000", "fedcba98"}, false, false},
			{"fedcba98", []string{"--last"}, []string{"12345678", "abcdef01", "00000000", "fedcba98"}, false, true},
		} {
			before := process.readTask(t, task)
			arguments := append([]string{"task", "step", "move", strings.ToUpper(task.ID), tc.id, "--project", strings.ToUpper(project.ID), "--json"}, tc.placement...)
			wantRoutes := []string{taskStepsMoveRoute}
			if tc.explicit {
				arguments = append(arguments, "--if-version", strconv.FormatInt(version, 10))
			} else {
				wantRoutes = append([]string{"GET " + taskStepsCollectionRoute}, wantRoutes...)
			}
			mark := acceptanceAssignmentMark(t, process, project)
			output := taskStepsRunSuccess(t, cli, arguments...)
			requests := taskStepsAddRequestBudget(t, process, project, mark, wantRoutes...)
			if _, err := uuid.Parse(requests[len(requests)-1].RequestID); err != nil {
				t.Fatal("installed Move did not preserve its pre-dispatch UUID request ID")
			}
			if tc.changed {
				version++
			}
			taskStepsCompleteJSON(t, output, false)
			resource := acceptanceCLIJSON[api.StepsResource](t, output)
			taskStepsMoveCheckResource(t, resource, task, version, rows, tc.order)
			current := acceptanceDecode[api.StepsResource](t, process.request(context.Background(), http.MethodGet, acceptanceTaskPath(task)+"/steps", nil, "steps-move-current"), http.StatusOK)
			if !reflect.DeepEqual(current, resource) {
				t.Fatal("installed Move resource differs from persisted complete collection")
			}
			after := process.readTask(t, task)
			if !tc.changed && !reflect.DeepEqual(before, after) {
				t.Fatal("installed no-op Move changed parent metadata or timestamps")
			}
			if tc.changed && (after.Version != before.Version+1 || !after.UpdatedAt.After(before.UpdatedAt)) {
				t.Fatal("installed real Move did not advance parent version/time exactly once")
			}
			preserved := after
			preserved.Version, preserved.UpdatedAt = originalParent.Version, originalParent.UpdatedAt
			if !reflect.DeepEqual(preserved, originalParent) {
				t.Fatal("installed Move changed unrelated parent fields or execution ownership")
			}
		}
		for _, tc := range []struct {
			id        string
			placement []string
			version   int64
			code      string
		}{
			{"12345678", []string{"--first"}, version - 1, "version_conflict"},
			{"00000000", []string{"--before", "eeeeeeee"}, version, "not_found"},
			{"eeeeeeee", []string{"--last"}, version, "not_found"},
		} {
			before := process.readTask(t, task)
			mark := acceptanceAssignmentMark(t, process, project)
			arguments := append([]string{"task", "step", "move", task.ID, tc.id, "--project", project.ID, "--if-version", strconv.FormatInt(tc.version, 10), "--json"}, tc.placement...)
			result := taskStepsRunRead(t, cli, arguments...)
			if result.status != 1 || result.stdout != "" || !strings.Contains(result.stderr, "code="+tc.code) || strings.Contains(result.stderr, "outcome=unknown") {
				t.Fatal("installed known Move refusal was concealed, retried or classified unknown")
			}
			taskStepsAddRequestBudget(t, process, project, mark, taskStepsMoveRoute)
			if after := process.readTask(t, task); !reflect.DeepEqual(before, after) {
				t.Fatal("refused installed Move changed parent metadata")
			}
		}
		mark := acceptanceAssignmentMark(t, process, project)
		missing := taskStepsRunRead(t, cli, "task", "step", "move", uuid.NewString(), "00000000", "--first", "--project", project.ID, "--json")
		if missing.status != 1 || missing.stdout != "" || !strings.Contains(missing.stderr, "code=not_found") {
			t.Fatal("failed default Move pre-read was concealed")
		}
		taskStepsAddRequestBudget(t, process, project, mark, "GET "+taskStepsCollectionRoute)
		readable := taskStepsRunSuccess(t, cli, "task", "step", "move", task.ID, "00000000", "--first", "--if-version", strconv.FormatInt(version, 10), "--project", project.ID)
		version++
		for _, part := range []string{task.ID, strconv.FormatInt(version, 10), "Steps: 4", "1. 00000000", "2. 12345678", "3. abcdef01", "4. fedcba98", `Same\u001b[31m\nFull title`} {
			if !strings.Contains(readable, part) {
				t.Fatalf("installed readable Move omitted %q", part)
			}
		}
		if strings.ContainsAny(readable, "\x1b\r\u2028\u2029") {
			t.Fatal("installed readable Move exposed terminal controls")
		}
		fixture.exec(t, `UPDATE tasks SET version=$2,status='done' WHERE id=$1`, task.ID, int64(math.MaxInt64))
		maxBefore := process.readTask(t, task)
		maximum := acceptanceCLIJSON[api.StepsResource](t, taskStepsRunSuccess(t, cli, "task", "step", "move", task.ID, "00000000", "--first", "--if-version", "9223372036854775807", "--project", project.ID, "--json"))
		taskStepsMoveCheckResource(t, maximum, task, math.MaxInt64, rows, []string{"00000000", "12345678", "abcdef01", "fedcba98"})
		if maxAfter := process.readTask(t, task); !reflect.DeepEqual(maxBefore, maxAfter) {
			t.Fatal("maximum-version no-op Move changed a completed Task")
		}
		exhausted := taskStepsRunRead(t, cli, "task", "step", "move", task.ID, "00000000", "--last", "--if-version", "9223372036854775807", "--project", project.ID, "--json")
		if exhausted.status != 1 || exhausted.stdout != "" || !strings.Contains(exhausted.stderr, "code=version_exhausted") {
			t.Fatal("maximum-version real Move did not expose version exhaustion")
		}
		process.signal(t)
		process.stopped(t, 0)
	})
}

func TestInstalledCLITaskStepsMoveUnknownAfterRealCommit(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_task_steps_move_unknown", []string{"ST-V11", "ST-V12"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		project := process.project(t, "Unknown Move")
		task := process.task(t, project, "Read original identity without replay")
		rows := taskStepsMoveSeed(t, fixture, task)
		target, err := url.Parse(process.origin)
		if err != nil {
			t.Fatal(err)
		}
		collection := acceptanceTaskPath(task) + "/steps"
		position := collection + "/00000000/position"
		type observedRequest struct{ method, id, path, authorization string }
		var mutex sync.Mutex
		var observed []observedRequest
		proxy := httputil.NewSingleHostReverseProxy(target)
		director := proxy.Director
		proxy.Director = func(request *http.Request) {
			director(request)
			if request.URL.Path != collection && request.URL.Path != position {
				t.Error("unknown Move crossed its original Task or Step scope")
			}
			if request.Method == http.MethodPut {
				data, readErr := io.ReadAll(io.LimitReader(request.Body, 1<<20+1))
				if readErr != nil {
					t.Error(readErr)
				}
				request.Body = io.NopCloser(strings.NewReader(string(data)))
				var payload struct {
					Version  int64  `json:"version"`
					Position string `json:"position"`
				}
				if json.Unmarshal(data, &payload) != nil || payload.Version != 1 || payload.Position != "last" {
					t.Error("unknown Move did not retain the original submitted payload")
				}
			}
			mutex.Lock()
			observed = append(observed, observedRequest{method: request.Method, id: request.Header.Get("X-Request-ID"), path: request.URL.Path, authorization: request.Header.Get("Authorization")})
			mutex.Unlock()
		}
		proxy.ModifyResponse = func(response *http.Response) error {
			if response.Request.Method == http.MethodPut && response.StatusCode == http.StatusOK {
				if err := response.Body.Close(); err != nil {
					t.Error("cannot close lost Move response")
				}
				return errors.New("private proxy loss after actual Move commit")
			}
			return nil
		}
		proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) { w.WriteHeader(http.StatusBadGateway) }
		server := httptest.NewServer(proxy)
		t.Cleanup(server.Close)
		cli.configure(t, &acceptanceProcess{origin: server.URL, token: process.token})
		result := taskStepsRunRead(t, cli, "task", "step", "move", task.ID, "00000000", "--last", "--if-version", "1", "--project", project.ID, "--json")
		mutex.Lock()
		requests := append([]observedRequest{}, observed...)
		mutex.Unlock()
		if result.status != 1 || result.stdout != "" || !strings.Contains(result.stderr, "outcome=unknown") || len(requests) != 2 || requests[0].method != http.MethodPut || requests[0].path != position || requests[1].method != http.MethodGet || requests[1].path != collection {
			t.Fatalf("unknown Move lost its one-PUT/one-current-GET lifecycle: status=%d request_count=%d diagnostic_bytes=%d", result.status, len(requests), len(result.stderr))
		}
		original := requests[0]
		if _, err := uuid.Parse(original.id); err != nil || requests[1].id != original.id+".r1" || original.authorization != "Bearer "+process.token || requests[1].authorization != original.authorization {
			t.Fatal("unknown Move changed its original request identity or principal")
		}
		for _, fact := range []string{project.ID, task.ID, "stepId=00000000", "requestId=" + original.id, "target=found", "version=2", "remains unknown"} {
			if !strings.Contains(result.stderr, fact) {
				t.Fatalf("unknown Move omitted original identity or current fact %q", fact)
			}
		}
		for _, private := range []string{rows[0].Title, rows[0].Description, "private proxy loss", process.token} {
			if strings.Contains(result.stderr, private) {
				t.Fatal("unknown Move exposed original content, private cause or credential")
			}
		}
		current := acceptanceDecode[api.StepsResource](t, process.request(context.Background(), http.MethodGet, collection, nil, "steps-move-after-loss"), http.StatusOK)
		taskStepsMoveCheckResource(t, current, task, 2, rows, []string{"abcdef01", "12345678", "fedcba98", "00000000"})
		cli.configure(t, process)
		process.signal(t)
		process.stopped(t, 0)
	})
}
