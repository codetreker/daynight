package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func stepHTTPPath() string {
	return "/api/v1/projects/" + testProjectID + "/tasks/" + testTaskID + "/steps"
}

func stepHTTPRows() []api.TaskStep {
	stamp := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
	return []api.TaskStep{
		{ID: "abcdef01", Title: "  <同名&> 😀 \x1b[31m\n", Description: "# 完整 Markdown\n<>& \"\\\r\n\u2028\u2029", Status: model.TaskStepDone, CreatedAt: stamp, UpdatedAt: stamp.Add(time.Hour)},
		{ID: "00000000", Title: "\uFEFF", Description: "", Status: model.TaskStepTodo, CreatedAt: stamp.Add(time.Microsecond), UpdatedAt: stamp.Add(time.Microsecond)},
		{ID: "fedcba98", Title: "same", Description: "third", Status: model.TaskStepSkipped, CreatedAt: stamp.Add(time.Second), UpdatedAt: stamp.Add(time.Second)},
		{ID: "11111111", Title: "same", Description: "fourth", Status: model.TaskStepInProgress, CreatedAt: stamp.Add(2 * time.Second), UpdatedAt: stamp.Add(2 * time.Second)},
	}
}

func stepHTTPDocument(t *testing.T, version int64, rows []api.TaskStep) taskservice.StepsDocument {
	t.Helper()
	resource := api.StepsResource{ProjectID: testProjectID, TaskID: testTaskID, Version: version, Steps: rows}
	data, err := json.Marshal(resource)
	if err != nil {
		t.Fatal(err)
	}
	return taskservice.StepsDocument{Resource: resource, JSON: append(data, '\n')}
}

func stepHTTPItem(t *testing.T, version int64, row api.TaskStep) taskservice.StepDocument {
	t.Helper()
	resource := api.StepResource{ProjectID: testProjectID, TaskID: testTaskID, Version: version, Step: row}
	data, err := json.Marshal(resource)
	if err != nil {
		t.Fatal(err)
	}
	return taskservice.StepDocument{Resource: resource, JSON: append(data, '\n')}
}

func stepHTTPWrite(t *testing.T, version int64, rows []api.TaskStep, changed bool) taskservice.StepsWriteResult {
	t.Helper()
	return taskservice.StepsWriteResult{StepsDocument: stepHTTPDocument(t, version, rows), Changed: changed, Phase: "commit", TransactionOutcome: store.TransactionCommitted}
}

func checkStepHTTPCall(t *testing.T, h *resourceTestHandler, ctx context.Context, principal model.Principal, projectID, taskID string) {
	t.Helper()
	if principal != h.principal || projectID != testProjectID || taskID != testTaskID || ctx == nil || ctx.Err() != nil || httpx.RequestID(ctx) == "" {
		t.Fatalf("Step request arguments changed: principal=%+v project=%s task=%s context=%v", principal, projectID, taskID, ctx)
	}
}

func TestStepsHTTPReadResourcesAndRefusals(t *testing.T) {
	t.Run("empty collection", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		document := stepHTTPDocument(t, 1, []api.TaskStep{})
		h.Steps.ListFunc = func(ctx context.Context, p model.Principal, projectID, taskID string) (taskservice.StepsDocument, error) {
			checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
			return document, nil
		}
		response := projectRequest(h, "GET", stepHTTPPath(), "")
		result := decodeResponse[api.StepsResource](t, response, 200)
		assertStepsWireFields(t, response.Body.Bytes(), false, 0)
		if result.Steps == nil || result.Version != 1 || !bytes.Equal(response.Body.Bytes(), document.JSON) {
			t.Fatal("empty collection bytes changed")
		}
	})
	t.Run("protocol refusals", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		for _, suffix := range []string{"?", "?limit=1", "?x=1&x=2", "?bad=%xx"} {
			assertProjectError(t, projectRequest(h, "GET", stepHTTPPath()+suffix, ""), 400, "invalid_input")
		}
		for _, id := range []string{"abc", "000000000", "0000000g", testTaskID} {
			assertProjectError(t, projectRequest(h, "GET", stepHTTPPath()+"/"+id, ""), 400, "invalid_input")
		}
		for _, method := range []string{"PUT", "OPTIONS"} {
			for _, endpoint := range []string{stepHTTPPath(), stepHTTPPath() + "/abcdef01"} {
				refusal := projectRequest(h, method, endpoint, "")
				assertProjectError(t, refusal, 405, "method_not_allowed")
				allow := "GET, HEAD, PATCH, DELETE"
				if endpoint == stepHTTPPath() {
					allow = "GET, HEAD, POST"
				}
				if refusal.Header().Get("Allow") != allow || refusal.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("unsupported method metadata is invalid")
				}
			}
		}
		if h.Steps.TotalCalls() != 0 {
			t.Fatal("protocol refusal invoked Step service")
		}
	})
	for _, tc := range []struct {
		name, code string
		status     int
	}{{"missing", "not_found", 404}, {"deleted parent", "task_deleted", 410}} {
		t.Run(tc.name, func(t *testing.T) {
			for _, item := range []bool{false, true} {
				h := newHTTPFixture(t, io.Discard)
				fault := &model.Fault{Code: tc.code, Message: "Resource is unavailable."}
				if item {
					h.Steps.GetFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string) (taskservice.StepDocument, error) {
						checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
						if id != "abcdef01" {
							t.Fatal("Step ID was not canonicalized")
						}
						if tc.code == "not_found" {
							return taskservice.StepDocument{}, &tasksteps.StepAbsence{Version: 2, Cause: fault}
						}
						return taskservice.StepDocument{}, fault
					}
				} else {
					h.Steps.ListFunc = func(ctx context.Context, p model.Principal, projectID, taskID string) (taskservice.StepsDocument, error) {
						checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
						return taskservice.StepsDocument{}, fault
					}
				}
				path := stepHTTPPath()
				if item {
					path += "/ABCDEF01"
				}
				assertProjectError(t, projectRequest(h, "GET", path, ""), tc.status, tc.code)
			}
		})
	}
}

func TestStepsHTTPRejectsCorruptStorage(t *testing.T) {
	for _, cause := range []string{"stored positions are not dense", "invalid stored title", "invalid stored timestamp"} {
		t.Run(cause, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			h.Steps.ListFunc = func(ctx context.Context, p model.Principal, projectID, taskID string) (taskservice.StepsDocument, error) {
				checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
				return taskservice.StepsDocument{}, errors.New(cause + " body-sentinel-must-not-log SELECT private")
			}
			assertProjectError(t, projectRequest(h, "GET", stepHTTPPath(), ""), 500, "internal_error")
			for _, sentinel := range []string{cause, "body-sentinel-must-not-log", "SELECT private"} {
				if strings.Contains(logs.String(), sentinel) {
					t.Fatalf("storage error leaked %q", sentinel)
				}
			}
		})
	}
}

func TestStepsHTTPReadPreservesEveryStateAndTimestamp(t *testing.T) {
	var logs bytes.Buffer
	h := newHTTPFixture(t, &logs)
	const version int64 = 9007199254740993
	rows := stepHTTPRows()
	document := stepHTTPDocument(t, version, rows)
	h.Steps.ListFunc = func(ctx context.Context, p model.Principal, projectID, taskID string) (taskservice.StepsDocument, error) {
		checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
		return document, nil
	}
	h.Steps.GetFunc = func(ctx context.Context, p model.Principal, projectID, taskID, stepID string) (taskservice.StepDocument, error) {
		checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
		if stepID != "abcdef01" {
			t.Fatal("Step ID was not canonicalized")
		}
		return stepHTTPItem(t, version, rows[0]), nil
	}
	path := "/api/v1/projects/" + strings.ToUpper(testProjectID) + "/tasks/" + strings.ToUpper(testTaskID) + "/steps"
	response := projectRequest(h, "GET", path, "")
	resource := decodeResponse[api.StepsResource](t, response, 200)
	assertStepsWireFields(t, response.Body.Bytes(), false, len(rows))
	if resource.ProjectID != testProjectID || resource.TaskID != testTaskID || resource.Version != version || !reflect.DeepEqual(resource.Steps, rows) || !bytes.Equal(response.Body.Bytes(), document.JSON) || !bytes.Contains(response.Body.Bytes(), []byte(`"version":9007199254740993`)) {
		t.Fatal("complete service document changed on the wire")
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != h.principal.UserID || response.Body.Bytes()[response.Body.Len()-1] != '\n' {
		t.Fatal("read metadata or newline changed")
	}
	itemResponse := projectRequest(h, "GET", path+"/ABCDEF01", "")
	item := decodeResponse[api.StepResource](t, itemResponse, 200)
	assertStepsWireFields(t, itemResponse.Body.Bytes(), true, 1)
	if item.ProjectID != testProjectID || item.TaskID != testTaskID || item.Version != version || item.Step != rows[0] {
		t.Fatal("scoped Step item changed")
	}
	for _, sentinel := range []string{"完整 Markdown", "<同名", "third", "fourth"} {
		if strings.Contains(logs.String(), sentinel) {
			t.Fatalf("Step content leaked %q", sentinel)
		}
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
