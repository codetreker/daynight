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
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
)

const taskStepsItemRoute = "/api/v1/projects/{projectId}/tasks/{taskId}/steps/{stepId}"

func taskStepsDeleteRequestBudget(t *testing.T, process *acceptanceProcess, project api.Project, start int, want ...string) []acceptanceAssignmentRequest {
	t.Helper()
	end := acceptanceAssignmentMark(t, process, project) - 1
	requests := acceptanceAssignmentRequests(process)[start:end]
	if len(requests) != len(want) {
		t.Fatalf("installed Delete request count=%d, expected=%d: %v", len(requests), len(want), requests)
	}
	for index, request := range requests {
		if request.Route != want[index] || request.RequestID == "" {
			t.Fatalf("installed Delete request %d: %+v, expected %s", index, request, want[index])
		}
	}
	return requests
}

func TestInstalledCLITaskStepsDeleteAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_task_steps_delete", []string{"ST-V8", "ST-V9", "ST-V11", "ST-V12", "ST-V13", "ST-V15"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		cli.configure(t, process)
		project := process.project(t, "Installed Steps Delete")
		task := process.task(t, project, "Independent retained materials")
		path := acceptanceTaskPath(task) + "/steps"
		attachmentBody := []byte("# Artifact retained after Step deletion\n")
		attachment := acceptanceDecode[api.Attachment](t, process.attachmentRequest(http.MethodPut, acceptanceAttachmentPath(task, "evidence.md"), "text/markdown", attachmentBody), http.StatusCreated)
		stamp := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
		rows := []api.TaskStep{
			{ID: "00abcdef", Title: "todo", Description: "[Retained artifact](evidence.md)", Status: core.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp.Add(time.Hour)},
			{ID: "12345678", Title: "in progress", Description: "second", Status: core.TaskStepInProgress, CreatedAt: stamp.Add(time.Second), UpdatedAt: stamp.Add(time.Minute)},
			{ID: "fedcba98", Title: "done", Description: "third", Status: core.TaskStepDone, CreatedAt: stamp.Add(time.Second * 2), UpdatedAt: stamp.Add(time.Second * 3)},
			{ID: "11111111", Title: "skipped", Description: "fourth", Status: core.TaskStepSkipped, CreatedAt: stamp.Add(time.Second * 4), UpdatedAt: stamp.Add(time.Second * 4)},
			{ID: "00000000", Title: "Retained\x1b[31m\nFull title", Description: "# Retained Markdown\n[Artifact](evidence.md)", Status: core.TaskStepDone, CreatedAt: stamp.Add(time.Second * 5), UpdatedAt: stamp.Add(time.Hour * 2)},
		}
		for index, step := range rows {
			fixture.exec(t, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, task.ID, step.ID, index, step.Title, step.Description, step.Status, step.CreatedAt, step.UpdatedAt)
		}
		version := int64(9007199254740993)
		fixture.exec(t, `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, version)
		parentBefore := process.readTask(t, task)
		for index, target := range rows[:4] {
			arguments := []string{"task", "step", "delete", strings.ToUpper(task.ID), strings.ToUpper(target.ID), "--project", strings.ToUpper(project.ID), "--json"}
			routes := []string{"GET " + taskStepsCollectionRoute, "DELETE " + taskStepsItemRoute}
			if index%2 == 0 {
				arguments = append(arguments, "--if-version", strconv.FormatInt(version, 10))
				routes = routes[1:]
			}
			mark := acceptanceAssignmentMark(t, process, project)
			output := taskStepsRunSuccess(t, cli, arguments...)
			taskStepsCompleteJSON(t, output, false)
			actual := acceptanceCLIJSON[api.StepsResource](t, output)
			requests := taskStepsDeleteRequestBudget(t, process, project, mark, routes...)
			write := requests[len(requests)-1]
			if _, err := uuid.Parse(write.RequestID); err != nil {
				t.Fatal("installed Delete did not submit an original UUID request identity")
			}
			version++
			expected := api.StepsResource{ProjectID: project.ID, TaskID: task.ID, Version: version, Steps: rows[index+1:]}
			if !reflect.DeepEqual(actual, expected) || !strings.Contains(output, `"version":`+strconv.FormatInt(version, 10)) {
				t.Fatal("Delete lost exact +1 version, non-target fields/times or saved order")
			}
			if !process.logs.matches(map[string]any{"component": "task_step", "operation": "delete", "phase": "commit", "request_id": write.RequestID, "step_id": target.ID, "tx_outcome": "committed"}) {
				t.Fatal("installed Delete producer did not retain the canonical target and request identity")
			}
		}
		current := acceptanceDecode[api.StepsResource](t, process.request(context.Background(), http.MethodGet, path, nil, "steps-delete-readback"), http.StatusOK)
		if current.Version != version || !reflect.DeepEqual(current.Steps, rows[4:]) {
			t.Fatal("installed Delete did not persist the remaining complete collection")
		}
		parentAfter := process.readTask(t, task)
		preserved := parentAfter
		preserved.Version, preserved.UpdatedAt = parentBefore.Version, parentBefore.UpdatedAt
		if !reflect.DeepEqual(preserved, parentBefore) || parentAfter.Version != version {
			t.Fatal("installed Delete changed unrelated parent fields or missed its version increments")
		}
		if listed := acceptanceAttachmentList(t, process, task); len(listed) != 1 || !reflect.DeepEqual(listed[0], attachment) {
			t.Fatal("Step deletion changed referenced attachment metadata")
		}
		body := process.attachmentRequest(http.MethodGet, acceptanceAttachmentPath(task, "evidence.md"), "", nil)
		if body.err != nil || body.status != http.StatusOK || string(body.body) != string(attachmentBody) {
			t.Fatal("Step deletion removed or changed referenced attachment bytes")
		}
		refuse := func(taskID, stepID, code string, explicit bool, expectedRoutes ...string) {
			t.Helper()
			arguments := []string{"task", "step", "delete", taskID, stepID, "--project", project.ID, "--json"}
			if explicit {
				arguments = append(arguments, "--if-version", strconv.FormatInt(version, 10))
			}
			mark := acceptanceAssignmentMark(t, process, project)
			result := taskStepsRunRead(t, cli, arguments...)
			if result.status != 1 || result.stdout != "" || !strings.Contains(result.stderr, "code="+code) || strings.Contains(result.stderr, "outcome is unknown") {
				t.Fatalf("Delete refusal was concealed, retried or classified unknown: exit=%d, stderr=%s", result.status, result.stderr)
			}
			taskStepsDeleteRequestBudget(t, process, project, mark, expectedRoutes...)
		}
		refuse(task.ID, rows[0].ID, "not_found", true, "DELETE "+taskStepsItemRoute)
		refuse(uuid.NewString(), rows[4].ID, "not_found", false, "GET "+taskStepsCollectionRoute)
		mark := acceptanceAssignmentMark(t, process, project)
		emptyText := taskStepsRunSuccess(t, cli, "task", "step", "delete", task.ID, "00000000", "--project", project.ID, "--if-version", strconv.FormatInt(version, 10), "--json")
		taskStepsDeleteRequestBudget(t, process, project, mark, "DELETE "+taskStepsItemRoute)
		taskStepsCompleteJSON(t, emptyText, false)
		empty := acceptanceCLIJSON[api.StepsResource](t, emptyText)
		version++
		if empty.Version != version || empty.Steps == nil || len(empty.Steps) != 0 || !strings.Contains(emptyText, `"steps":[]`) {
			t.Fatal("last Step deletion did not return a real empty collection with version +1")
		}
		fixture.exec(t, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,'00000000',0,'maximum version','','done',$2,$2)`, task.ID, stamp)
		fixture.exec(t, `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, int64(math.MaxInt64))
		version = math.MaxInt64
		refuse(task.ID, "00000000", "version_exhausted", true, "DELETE "+taskStepsItemRoute)
		exhausted := acceptanceDecode[api.StepsResource](t, process.request(context.Background(), http.MethodGet, path, nil, "steps-delete-exhausted"), http.StatusOK)
		if exhausted.Version != math.MaxInt64 || len(exhausted.Steps) != 1 || exhausted.Steps[0].ID != "00000000" {
			t.Fatal("version exhaustion partly deleted the current Step")
		}
		fixture.exec(t, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, task.ID)
		refuse(task.ID, "00000000", "task_deleted", true, "DELETE "+taskStepsItemRoute)
		cli.configure(t, &acceptanceProcess{origin: process.origin, token: "invalid-steps-delete-pat"})
		unauthorized := taskStepsRunRead(t, cli, "task", "step", "delete", task.ID, "00000000", "--project", project.ID, "--if-version", strconv.FormatInt(version, 10), "--json")
		if unauthorized.status != 1 || unauthorized.stdout != "" || !strings.Contains(unauthorized.stderr, "status=401") || !strings.Contains(unauthorized.stderr, "daynight login") {
			t.Fatal("installed Delete unauthorized failure omitted login guidance or returned a resource")
		}
		cli.configure(t, process)
		process.signal(t)
		process.stopped(t, 0)
	})
}

func TestInstalledCLITaskStepsDeleteUnknownAfterRealCommit(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_task_steps_delete_unknown", []string{"ST-V8", "ST-V10", "ST-V12"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		project := process.project(t, "Unknown Delete")
		task := process.task(t, project, "Original delete identity only")
		fixture.exec(t, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,'00abcdef',0,'unknown-title-sentinel','unknown-markdown-sentinel','done','2026-11-03T10:11:12Z','2026-11-03T11:12:13Z')`, task.ID)
		target, err := url.Parse(process.origin)
		if err != nil {
			t.Fatal(err)
		}
		path := acceptanceTaskPath(task) + "/steps"
		type observedRequest struct{ method, id, path, authorization string }
		var mutex sync.Mutex
		var observed []observedRequest
		proxy := httputil.NewSingleHostReverseProxy(target)
		director := proxy.Director
		proxy.Director = func(request *http.Request) {
			director(request)
			if request.Method == http.MethodDelete && request.URL.Path != path+"/00abcdef" || request.Method == http.MethodGet && request.URL.Path != path {
				t.Error("unknown Delete crossed its original Task or Step scope")
			}
			mutex.Lock()
			observed = append(observed, observedRequest{method: request.Method, id: request.Header.Get("X-Request-ID"), path: request.URL.Path, authorization: request.Header.Get("Authorization")})
			mutex.Unlock()
		}
		proxy.ModifyResponse = func(response *http.Response) error {
			if response.Request.Method == http.MethodDelete && response.StatusCode == http.StatusOK {
				if err := response.Body.Close(); err != nil {
					t.Error("cannot close lost Delete response")
				}
				return errors.New("private proxy loss after actual Step deletion commit")
			}
			return nil
		}
		proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) { w.WriteHeader(http.StatusBadGateway) }
		server := httptest.NewServer(proxy)
		t.Cleanup(server.Close)
		cli.configure(t, &acceptanceProcess{origin: server.URL, token: process.token})
		result := taskStepsRunRead(t, cli, "task", "step", "delete", task.ID, "00ABCDEF", "--project", project.ID, "--if-version", "1", "--json")
		mutex.Lock()
		requests := append([]observedRequest{}, observed...)
		mutex.Unlock()
		if result.status != 1 || result.stdout != "" || !strings.Contains(result.stderr, "The Step Delete outcome is unknown.") || len(requests) != 2 || requests[0].method != http.MethodDelete || requests[1].method != http.MethodGet {
			t.Fatalf("unknown Delete lost one-DELETE/one-current-read lifecycle: status=%d request_count=%d diagnostic_bytes=%d", result.status, len(requests), len(result.stderr))
		}
		original := requests[0]
		if _, err := uuid.Parse(original.id); err != nil || requests[1].id != original.id+".r1" || original.authorization != "Bearer "+process.token || requests[1].authorization != original.authorization {
			t.Fatal("unknown Delete regenerated request identity or changed principal")
		}
		for _, required := range []string{"stepId=00abcdef", "taskId=" + task.ID, "projectId=" + project.ID, "requestId=" + original.id, "Current facts only: version=2 target=absent. The Delete outcome remains unknown."} {
			if !strings.Contains(result.stderr, required) {
				t.Fatalf("unknown Delete lost original diagnostic identity or current-only fact: missing %q", required)
			}
		}
		for _, private := range []string{"unknown-title-sentinel", "unknown-markdown-sentinel", "private proxy loss", process.token, "Step deleted."} {
			if strings.Contains(result.stderr, private) {
				t.Fatal("unknown Delete attributed historical success or exposed payload/private cause")
			}
		}
		current := acceptanceDecode[api.StepsResource](t, process.request(context.Background(), http.MethodGet, path, nil, "steps-delete-after-loss"), http.StatusOK)
		if current.Version != 2 || current.Steps == nil || len(current.Steps) != 0 {
			t.Fatal("actual lost receipt did not commit exactly one deletion")
		}
		cli.configure(t, process)
		process.signal(t)
		process.stopped(t, 0)
	})
}
