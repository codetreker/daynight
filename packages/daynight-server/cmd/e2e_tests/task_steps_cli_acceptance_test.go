package e2e_tests

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
)

func taskStepsRunRead(t *testing.T, cli *acceptanceCLI, arguments ...string) acceptanceCLIResult {
	t.Helper()
	return acceptanceCLIReceive(t, cli.start(t, "/", arguments...))
}

func taskStepsRunSuccess(t *testing.T, cli *acceptanceCLI, arguments ...string) string {
	t.Helper()
	result := taskStepsRunRead(t, cli, arguments...)
	if result.status != 0 || result.stderr != "" {
		t.Fatalf("installed Steps CLI failed (exit=%d): %s", result.status, result.stderr)
	}
	return result.stdout
}

func taskStepsCompleteJSON(t *testing.T, output string, item bool) {
	t.Helper()
	fields := acceptanceCLIJSON[map[string]json.RawMessage](t, output)
	key := "steps"
	if item {
		key = "step"
	}
	if len(fields) != 4 {
		t.Fatal("installed Steps JSON has missing or extra resource fields")
	}
	for _, name := range []string{"projectId", "taskId", "version", key} {
		raw, exists := fields[name]
		if !exists || string(raw) == "null" {
			t.Fatal("installed Steps JSON omitted a required resource field")
		}
	}
	var rows []map[string]json.RawMessage
	if item {
		rows = []map[string]json.RawMessage{acceptanceCLIJSON[map[string]json.RawMessage](t, string(fields[key]))}
	} else {
		rows = acceptanceCLIJSON[[]map[string]json.RawMessage](t, string(fields[key]))
		if rows == nil {
			t.Fatal("installed Steps JSON array is absent")
		}
	}
	for _, row := range rows {
		if len(row) != 6 {
			t.Fatal("installed Step JSON omitted or added fields")
		}
		for _, name := range []string{"id", "title", "description", "status", "createdAt", "updatedAt"} {
			raw, exists := row[name]
			if !exists || string(raw) == "null" {
				t.Fatal("installed Step JSON omitted a required field")
			}
		}
	}
}

func taskStepsReadRequests(process *acceptanceProcess) []string {
	process.logs.mu.Lock()
	defer process.logs.mu.Unlock()
	requests := make([]string, 0)
	for _, event := range process.logs.events {
		if event["type"] == "http_request" {
			route, _ := event["route"].(string)
			if strings.HasPrefix(route, "GET /api/v1/") || strings.HasPrefix(route, "/api/v1/") {
				requests = append(requests, route)
			}
		}
	}
	return requests
}

func taskStepsOneGet(t *testing.T, process *acceptanceProcess, read func() string, route string) string {
	t.Helper()
	before := len(taskStepsReadRequests(process))
	output := read()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := acceptanceEventually(ctx, func() (bool, error) { return len(taskStepsReadRequests(process)) >= before+1, nil }); err != nil {
		t.Fatal("Steps CLI GET did not complete its production request log")
	}
	after := taskStepsReadRequests(process)
	if len(after) != before+1 || after[before] != route {
		t.Fatalf("explicit Steps read made hidden requests: %v", after[before:])
	}
	return output
}

func TestInstalledCLITaskStepsReadAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_task_steps_read", []string{"ST-V1", "ST-V2", "ST-V3", "ST-V4", "ST-V9", "ST-V10"}, func(t *testing.T, scenario *acceptanceScenario) {
		cli := newAcceptanceCLI(t, receipt, scenario)
		if err := os.WriteFile(filepath.Join(cli.home, ".daynight", "config.yml"), []byte("serverUrl: [invalid\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		for _, arguments := range [][]string{{"task", "step", "--help"}, {"task", "step", "list", "--help"}, {"task", "step", "show", "--help"}} {
			output := taskStepsRunSuccess(t, cli, arguments...)
			if !strings.Contains(output, "task step") || strings.Contains(output, "--if-version") {
				t.Fatal("Steps read help is missing or advertises write options")
			}
		}
		for _, arguments := range [][]string{{"task", "step", "add", uuid.NewString()}, {"task", "step", "delete"}, {"task", "step", "move"}, {"task", "step", "set-status"}, {"task", "step", "list", "bad"}, {"task", "step", "show", uuid.NewString(), "abc"}, {"task", "step", "list", uuid.NewString(), "--project", "bad"}, {"task", "step", "list", uuid.NewString(), "--if-version", "1"}} {
			result := taskStepsRunRead(t, cli, arguments...)
			if result.status != 2 || result.stdout != "" || result.stderr == "" {
				t.Fatal("unsupported/invalid Steps read did not fail as usage before configuration")
			}
		}
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli.configure(t, process)
		project := process.project(t, "Installed Steps reads")
		task := process.task(t, project, "Task-owned records")
		route := "GET /api/v1/projects/{projectId}/tasks/{taskId}/steps"
		empty := acceptanceCLIJSON[api.StepsResource](t, taskStepsOneGet(t, process, func() string {
			return taskStepsRunSuccess(t, cli, "task", "step", "list", task.ID, "--project", project.ID, "--json")
		}, route))
		if empty.ProjectID != project.ID || empty.TaskID != task.ID || empty.Version != 1 || empty.Steps == nil || len(empty.Steps) != 0 {
			t.Fatal("installed Steps read invented or omitted empty resource fields")
		}
		title := "  <同名&> 😀 " + strings.Repeat("long-title-", 40) + "\x1b[31m\nInjected label\r\u2028\u2029"
		description := "  # 完整 Markdown\n\tbody <>& \"\\\r\n\x1b[32m\u2028\u2029\\u001b  " + strings.Repeat("Markdown-line-中文-", 256) + "end-of-markdown  "
		stamp := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
		rows := []api.TaskStep{
			{ID: "abcdef01", Title: title, Description: description, Status: core.TaskStepDone, CreatedAt: stamp, UpdatedAt: stamp.Add(time.Hour)},
			{ID: "00000000", Title: "\uFEFF", Description: "", Status: core.TaskStepTodo, CreatedAt: stamp.Add(time.Microsecond), UpdatedAt: stamp.Add(time.Microsecond)},
			{ID: "fedcba98", Title: "same", Description: "third", Status: core.TaskStepSkipped, CreatedAt: stamp.Add(time.Second), UpdatedAt: stamp.Add(time.Second)},
			{ID: "11111111", Title: "same", Description: "fourth", Status: core.TaskStepInProgress, CreatedAt: stamp.Add(time.Second * 2), UpdatedAt: stamp.Add(time.Second * 2)},
		}
		for index, step := range rows {
			fixture.exec(t, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, task.ID, step.ID, index, step.Title, step.Description, step.Status, step.CreatedAt, step.UpdatedAt)
		}
		fixture.exec(t, `UPDATE tasks SET version=9007199254740993 WHERE id=$1`, task.ID)
		parentBefore := acceptanceDecode[api.Task](t, process.request(context.Background(), http.MethodGet, acceptanceTaskPath(task), nil, "steps-cli-parent-before"), http.StatusOK)
		syncContext, syncCancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := acceptanceEventually(syncContext, func() (bool, error) {
			return process.logs.matches(map[string]any{"type": "http_request", "request_id": "steps-cli-parent-before"}), nil
		}); err != nil {
			syncCancel()
			t.Fatal("parent fixture read log did not complete")
		}
		syncCancel()
		expected := api.StepsResource{ProjectID: project.ID, TaskID: task.ID, Version: 9007199254740993, Steps: rows}
		{
			output := taskStepsOneGet(t, process, func() string {
				return taskStepsRunSuccess(t, cli, "task", "step", "list", task.ID, "--project", strings.ToUpper(project.ID), "--json")
			}, route)
			taskStepsCompleteJSON(t, output, false)
			actual := acceptanceCLIJSON[api.StepsResource](t, output)
			if !reflect.DeepEqual(actual, expected) || !strings.Contains(output, `"version":9007199254740993`) {
				t.Fatal("installed Steps JSON changed order, text, precision or complete fields")
			}
			itemText := taskStepsOneGet(t, process, func() string {
				return taskStepsRunSuccess(t, cli, "task", "step", "show", strings.ToUpper(task.ID), "ABCDEF01", "--project", project.ID, "--json")
			}, "GET /api/v1/projects/{projectId}/tasks/{taskId}/steps/{stepId}")
			taskStepsCompleteJSON(t, itemText, true)
			item := acceptanceCLIJSON[api.StepResource](t, itemText)
			if item.ProjectID != project.ID || item.TaskID != task.ID || item.Version != expected.Version || item.Step != rows[0] {
				t.Fatal("installed show lost exact scoped identity or Markdown/time")
			}
		}
		listText := taskStepsRunSuccess(t, cli, "task", "step", "list", task.ID, "--project", project.ID)
		for _, part := range []string{task.ID, "9007199254740993", "Steps: 4", "1. abcdef01", "2. 00000000", "3. fedcba98", "4. 11111111", strings.Repeat("long-title-", 40), `\u001b[31m`, `\nInjected label`} {
			if !strings.Contains(listText, part) {
				t.Fatalf("installed readable Steps list omitted %q", part)
			}
		}
		showText := taskStepsRunSuccess(t, cli, "task", "step", "show", task.ID, "abcdef01", "--project", project.ID)
		for _, part := range []string{task.ID, "9007199254740993", "abcdef01", strings.Repeat("long-title-", 40), "完整 Markdown", strings.Repeat("Markdown-line-中文-", 256), "end-of-markdown", `\u001b[32m`, "2026-11-03T10:11:12.123456Z", "2026-11-03T11:11:12.123456Z"} {
			if !strings.Contains(showText, part) {
				t.Fatalf("installed readable show omitted %q", part)
			}
		}
		if strings.ContainsAny(listText+showText, "\x1b\r\u2028\u2029") {
			t.Fatal("installed readable Steps output exposed terminal controls")
		}
		cli.git(t, "-C", cli.repo, "remote", "set-url", "origin", project.RepoURL)
		discovered := acceptanceCLIJSON[api.StepsResource](t, cli.run(t, cli.repo, "task", "step", "list", task.ID, "--json"))
		if !reflect.DeepEqual(discovered, expected) {
			t.Fatal("installed repository discovery did not retain the Steps resource")
		}
		process.signal(t)
		process.stopped(t, 0)
		restarted := fixture.launch(t, map[string]string{"DAYNIGHT_LISTEN_ADDR": process.address}).started(t)
		fixture.exec(t, `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, int64(math.MaxInt64))
		maximum := acceptanceCLIJSON[api.StepsResource](t, taskStepsRunSuccess(t, cli, "task", "step", "list", task.ID, "--project", project.ID, "--json"))
		expected.Version = math.MaxInt64
		if !reflect.DeepEqual(maximum, expected) {
			t.Fatal("installed Steps read lost persisted data or maximum exact int64 after restart")
		}
		if parentAfter := restarted.readTask(t, task); parentAfter.Title != parentBefore.Title || parentAfter.Description != parentBefore.Description || parentAfter.UpdatedAt != parentBefore.UpdatedAt || parentAfter.Version != math.MaxInt64 {
			t.Fatal("CLI reads changed persisted parent metadata/time")
		}
		for _, test := range []struct {
			arguments []string
			code      string
		}{
			{[]string{"task", "step", "show", task.ID, "22222222", "--project", project.ID, "--json"}, "not_found"},
			{[]string{"task", "step", "list", uuid.NewString(), "--project", project.ID, "--json"}, "not_found"},
		} {
			result := taskStepsRunRead(t, cli, test.arguments...)
			if result.status != 1 || result.stdout != "" || !strings.Contains(result.stderr, "code="+test.code) || strings.Contains(result.stderr, "Caused by:") {
				t.Fatal("installed Steps read failure became empty output or leaked a cause chain")
			}
		}
		fixture.exec(t, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, task.ID)
		deleted := taskStepsRunRead(t, cli, "task", "step", "list", task.ID, "--project", project.ID, "--json")
		if deleted.status != 1 || deleted.stdout != "" || !strings.Contains(deleted.stderr, "code=task_deleted") {
			t.Fatal("installed Steps read concealed parent deletion")
		}
		cli.configure(t, &acceptanceProcess{origin: restarted.origin, token: "invalid-steps-pat"})
		unauthorized := taskStepsRunRead(t, cli, "task", "step", "list", task.ID, "--project", project.ID, "--json")
		if unauthorized.status != 1 || unauthorized.stdout != "" || !strings.Contains(unauthorized.stderr, "daynight login") || !strings.Contains(unauthorized.stderr, "status="+strconv.Itoa(http.StatusUnauthorized)) {
			t.Fatal("installed Steps unauthorized read omitted login guidance or returned a resource")
		}
		cli.configure(t, restarted)
		restarted.signal(t)
		restarted.stopped(t, 0)
	})
}
