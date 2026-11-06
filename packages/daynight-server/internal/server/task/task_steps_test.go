package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

func stepsHTTPFixture(t *testing.T, logs io.Writer) (*postgres.Store, *resourceTestHandler, api.Task) {
	t.Helper()
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, logs)
	project := decodeResponse[api.Project](t, projectRequest(handler, "POST", "/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Steps", RepoURL: "https://example.com/steps", ExpectedUserID: handler.principal.UserID})), 201)
	task := decodeResponse[api.Task](t, projectRequest(handler, "POST", "/api/v1/projects/"+project.ID+"/tasks", `{"title":"Parent"}`), 201)
	return database, handler, task
}

func seedHTTPStep(t *testing.T, database *postgres.Store, taskID, id string, position int, title, description string) {
	t.Helper()
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at)
 VALUES($1,$2,$3,$4,$5,'done','2026-11-03T10:11:12.123456Z','2026-11-03T11:12:13.654321Z')`, taskID, id, position, title, description); err != nil {
		t.Fatal(err)
	}
}

func TestStepsHTTPReadResourcesAndRefusals(t *testing.T) {
	var logs bytes.Buffer
	database, handler, task := stepsHTTPFixture(t, &logs)
	path := "/api/v1/projects/" + task.ProjectID + "/tasks/" + task.ID + "/steps"
	emptyResponse := projectRequest(handler, "GET", path, "")
	empty := decodeResponse[api.StepsResource](t, emptyResponse, 200)
	assertStepsWireFields(t, emptyResponse.Body.Bytes(), false, 0)
	if empty.Steps == nil || len(empty.Steps) != 0 || empty.Version != task.Version {
		t.Fatalf("empty: %+v", empty)
	}
	seedHTTPStep(t, database, task.ID, "abcdef01", 1, "Review", "Task-owned Markdown")
	seedHTTPStep(t, database, task.ID, "00000000", 0, "  <Coding&中文>  ", "# secret-step-body\n\"\\\u2028\u2029")
	other := decodeResponse[api.Task](t, projectRequest(handler, "POST", "/api/v1/projects/"+task.ProjectID+"/tasks", `{"title":"Other parent"}`), 201)
	seedHTTPStep(t, database, other.ID, "abcdef01", 0, "Other task review", "isolated")
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=9007199254740993 WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	response := projectRequest(handler, "GET", path, "")
	resource := decodeResponse[api.StepsResource](t, response, 200)
	if len(resource.Steps) != 2 || resource.Steps[0].ID != "00000000" || resource.Steps[1].ID != "abcdef01" || resource.Version != 9007199254740993 ||
		resource.Steps[0].Title != "  <Coding&中文>  " || resource.Steps[0].Description != "# secret-step-body\n\"\\\u2028\u2029" ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"version":9007199254740993`)) || response.Body.Bytes()[response.Body.Len()-1] != '\n' ||
		response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != handler.principal.UserID {
		t.Fatalf("complete resource: %s", response.Body)
	}
	item := decodeResponse[api.StepResource](t, projectRequest(handler, "GET", path+"/ABCDEF01", ""), 200)
	if item.Step != resource.Steps[1] || item.TaskID != task.ID || item.ProjectID != task.ProjectID || item.Version != resource.Version {
		t.Fatalf("task-scoped item: %+v", item)
	}
	parent := projectRequest(handler, "GET", "/api/v1/projects/"+task.ProjectID+"/tasks/"+task.ID, "")
	if bytes.Contains(parent.Body.Bytes(), []byte(`"steps"`)) {
		t.Fatal("Task DTO embeds Steps")
	}
	for _, suffix := range []string{"?", "?limit=1", "?x=1&x=2", "?bad=%xx"} {
		assertProjectError(t, projectRequest(handler, "GET", path+suffix, ""), 400, "invalid_input")
	}
	for _, id := range []string{"abc", "000000000", "0000000g", task.ID} {
		assertProjectError(t, projectRequest(handler, "GET", path+"/"+id, ""), 400, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, "GET", path+"/11111111", ""), 404, "not_found")
	for _, method := range []string{"PUT", "OPTIONS"} {
		for _, endpoint := range []string{path, path + "/abcdef01"} {
			refusal := projectRequest(handler, method, endpoint, "")
			assertProjectError(t, refusal, 405, "method_not_allowed")
			allow := "GET, HEAD, PATCH, DELETE"
			if endpoint == path {
				allow = "GET, HEAD, POST"
			}
			if refusal.Header().Get("Allow") != allow || refusal.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("unsupported method metadata is invalid")
			}
		}
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET deleted_at=clock_timestamp() WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{path, path + "/abcdef01"} {
		assertProjectError(t, projectRequest(handler, "GET", endpoint, ""), 410, "task_deleted")
	}
	if logs.Len() == 0 || strings.Contains(logs.String(), "secret-step-body") || strings.Contains(logs.String(), "<Coding") {
		t.Fatal("Steps resource content leaked into logs")
	}
}

func TestStepsHTTPRejectsCorruptStorage(t *testing.T) {
	var logs bytes.Buffer
	database, handler, task := stepsHTTPFixture(t, &logs)
	seedHTTPStep(t, database, task.ID, "00000000", 0, "Valid", "body-sentinel-must-not-log")
	path := "/api/v1/projects/" + task.ProjectID + "/tasks/" + task.ID + "/steps"
	for _, update := range []string{
		`UPDATE task_steps SET position=2`,
		`UPDATE task_steps SET position=0,title=E'\u0085'`,
		`UPDATE task_steps SET title='Valid',created_at='infinity'`,
	} {
		if _, err := database.Pool.Exec(context.Background(), update); err != nil {
			t.Fatal(err)
		}
		assertProjectError(t, projectRequest(handler, "GET", path, ""), 500, "internal_error")
	}
	if strings.Contains(logs.String(), "body-sentinel-must-not-log") || strings.Contains(logs.String(), "SELECT ") {
		t.Fatal("storage failure logs exposed row or SQL content")
	}
}

func TestStepsHTTPReadPreservesEveryStateAndTimestamp(t *testing.T) {
	database, handler, task := stepsHTTPFixture(t, io.Discard)
	stamp := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
	rows := []api.TaskStep{
		{ID: "abcdef01", Title: "  <同名&> 😀 \x1b[31m\n", Description: "# 完整 Markdown\n<>& \"\\\r\n\u2028\u2029", Status: "done", CreatedAt: stamp, UpdatedAt: stamp.Add(time.Hour)},
		{ID: "00000000", Title: "\uFEFF", Description: "", Status: "todo", CreatedAt: stamp.Add(time.Microsecond), UpdatedAt: stamp.Add(time.Microsecond)},
		{ID: "fedcba98", Title: "same", Description: "third", Status: "skipped", CreatedAt: stamp.Add(time.Second), UpdatedAt: stamp.Add(time.Second)},
		{ID: "11111111", Title: "same", Description: "fourth", Status: "in_progress", CreatedAt: stamp.Add(2 * time.Second), UpdatedAt: stamp.Add(2 * time.Second)},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for position, step := range rows {
		if _, err := database.Pool.Exec(ctx, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, task.ID, step.ID, position, step.Title, step.Description, string(step.Status), step.CreatedAt, step.UpdatedAt); err != nil {
			t.Fatal(err)
		}
	}
	const version int64 = 9007199254740993
	if _, err := database.Pool.Exec(ctx, `UPDATE tasks SET version=$1 WHERE id=$2`, version, task.ID); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/projects/" + strings.ToUpper(task.ProjectID) + "/tasks/" + strings.ToUpper(task.ID) + "/steps"
	response := projectRequest(handler, "GET", path, "")
	resource := decodeResponse[api.StepsResource](t, response, 200)
	assertStepsWireFields(t, response.Body.Bytes(), false, len(rows))
	if resource.ProjectID != task.ProjectID || resource.TaskID != task.ID || resource.Version != version || !reflect.DeepEqual(resource.Steps, rows) || !bytes.Contains(response.Body.Bytes(), []byte(`"version":9007199254740993`)) {
		t.Fatalf("complete seeded collection: %+v", resource)
	}
	itemResponse := projectRequest(handler, "GET", path+"/ABCDEF01", "")
	item := decodeResponse[api.StepResource](t, itemResponse, 200)
	assertStepsWireFields(t, itemResponse.Body.Bytes(), true, 1)
	if item.ProjectID != task.ProjectID || item.TaskID != task.ID || item.Version != version || item.Step != rows[0] {
		t.Fatalf("complete scoped item: %+v", item)
	}
}

func assertStepsWireFields(t *testing.T, data []byte, item bool, count int) {
	t.Helper()
	assertObject := func(fields map[string]json.RawMessage, names ...string) {
		t.Helper()
		if len(fields) != len(names) {
			t.Fatalf("unexpected resource field count: got %d want %d", len(fields), len(names))
		}
		for _, name := range names {
			value, exists := fields[name]
			if !exists || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				t.Fatalf("missing or null resource field %q", name)
			}
		}
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal("resource is not valid JSON")
	}
	key := "steps"
	if item {
		key = "step"
	}
	assertObject(fields, "projectId", "taskId", "version", key)
	var rows []map[string]json.RawMessage
	if item {
		var row map[string]json.RawMessage
		if err := json.Unmarshal(fields[key], &row); err != nil {
			t.Fatal("Step is not a JSON object")
		}
		rows = []map[string]json.RawMessage{row}
	} else if err := json.Unmarshal(fields[key], &rows); err != nil || rows == nil {
		t.Fatal("Steps is not a JSON array")
	}
	if len(rows) != count {
		t.Fatalf("unexpected Step count: got %d want %d", len(rows), count)
	}
	for _, row := range rows {
		assertObject(row, "id", "title", "description", "status", "createdAt", "updatedAt")
	}
}
