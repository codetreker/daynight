package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func stepHTTPString(value string) *string                             { return &value }
func stepHTTPStatus(value model.TaskStepStatus) *model.TaskStepStatus { return &value }

func TestStepsHTTPAddPlacementCompleteResourceAndExactVersion(t *testing.T) {
	const version int64 = 9007199254740993
	title, markdown := "  <同名&> 😀 \uFEFF  ", "  # Markdown-secret\n\"\\\u2028\u2029  "
	cases := []struct {
		body  string
		input taskservice.AddTaskStep
		id    string
	}{
		{jsonBody(t, map[string]any{"version": version, "id": "ABCDEF01", "title": title, "description": markdown}), taskservice.AddTaskStep{Version: version, ID: "ABCDEF01", Title: title, Description: markdown}, "abcdef01"},
		{jsonBody(t, map[string]any{"version": version, "id": "00000000", "title": title, "status": "done", "before": "ABCDEF01"}), taskservice.AddTaskStep{Version: version, ID: "00000000", Title: title, Status: stepHTTPStatus(model.TaskStepDone), Before: stepHTTPString("ABCDEF01")}, "00000000"},
		{jsonBody(t, map[string]any{"version": version, "id": "12345678", "title": title, "status": "in_progress", "after": "00000000"}), taskservice.AddTaskStep{Version: version, ID: "12345678", Title: title, Status: stepHTTPStatus(model.TaskStepInProgress), After: stepHTTPString("00000000")}, "12345678"},
		{jsonBody(t, map[string]any{"version": version, "id": "fedcba98", "title": "\uFEFF", "status": "skipped"}), taskservice.AddTaskStep{Version: version, ID: "fedcba98", Title: "\uFEFF", Status: stepHTTPStatus(model.TaskStepSkipped)}, "fedcba98"},
	}
	for _, tc := range cases {
		t.Run(tc.id, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			row := stepHTTPRows()[0]
			row.ID, row.Title, row.Description = tc.id, tc.input.Title, tc.input.Description
			row.UpdatedAt = row.CreatedAt
			row.Status = model.TaskStepTodo
			if tc.input.Status != nil {
				row.Status = *tc.input.Status
			}
			result := stepHTTPWrite(t, version+1, []api.TaskStep{row}, true)
			h.Steps.AddFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
				checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
				if !reflect.DeepEqual(input, tc.input) {
					t.Fatalf("Add input changed: %+v want %+v", input, tc.input)
				}
				return result, nil
			}
			response := projectRequest(h, "POST", stepHTTPPath(), tc.body)
			resource := decodeResponse[api.StepsResource](t, response, 201)
			if resource.ProjectID != testProjectID || resource.TaskID != testTaskID || resource.Version != version+1 || !bytes.Equal(response.Body.Bytes(), result.JSON) || response.Header().Get("Location") != stepHTTPPath()+"/"+tc.id || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != h.principal.UserID || response.Body.Bytes()[response.Body.Len()-1] != '\n' {
				t.Fatal("complete creation receipt changed")
			}
			for _, fact := range []string{`"component":"task_step"`, `"operation":"add"`, `"phase":"prepare"`, `"phase":"persist"`, `"phase":"commit"`, `"tx_outcome":"committed"`, `"response_outcome":"written"`, `"status":201`, `"written_bytes":`} {
				if !strings.Contains(logs.String(), fact) {
					t.Fatalf("missing diagnostic fact %s", fact)
				}
			}
			for _, sentinel := range []string{title, markdown, "Markdown-secret"} {
				if strings.Contains(logs.String(), sentinel) {
					t.Fatal("Step content leaked into logs")
				}
			}
		})
	}
}

func TestStepsHTTPAddStrictProtocolInputDoesNotCallService(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	base := `{"version":1,"id":"00000000","title":"x"}`
	bodies := []string{"", `null`, `[]`, `true`, `"x"`, `{`, `{} `, base + ` {}`, `{"Version":1,"id":"00000000","title":"x"}`,
		`{"version":1,"id":"00000000","\u0069d":"00000001","title":"x"}`, `{"version":1,"version":1,"id":"00000000","title":"x"}`,
		`{"version":1,"id":"00000000","title":"\ud800"}`, `{"version":1,"id":"00000000","title":"\udfff"}`, `{"version":1,"id":"00000000","title":"x","description":"\ud800x"}`,
		`{"version":1,"id":"00000000","title":"` + string([]byte{0xff}) + `"}`,
	}
	for _, field := range []string{"version", "id", "title", "description", "status", "before", "after"} {
		for _, value := range []string{"null", "false", "[]", "{}"} {
			input := map[string]json.RawMessage{"version": json.RawMessage("1"), "id": json.RawMessage(`"00000000"`), "title": json.RawMessage(`"x"`)}
			input[field] = json.RawMessage(value)
			encoded, err := json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			bodies = append(bodies, string(encoded))
		}
	}
	for _, version := range []string{`0`, `-1`, `1.0`, `1e0`, `9223372036854775808`, `"1"`} {
		bodies = append(bodies, `{"version":`+version+`,"id":"00000000","title":"x"}`)
	}
	for _, id := range []string{"", "0", "000000000", "0000000g", testTaskID} {
		bodies = append(bodies, jsonBody(t, map[string]any{"version": 1, "id": id, "title": "x"}))
	}
	for _, extra := range []string{`,"createdAt":"today"`, `,"updatedAt":"today"`, `,"position":0`, `,"unknown":"x"`} {
		bodies = append(bodies, strings.TrimSuffix(base, "}")+extra+"}")
	}
	for index, body := range bodies {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			assertProjectError(t, projectRequest(h, "POST", stepHTTPPath(), body), 400, "invalid_input")
		})
	}
	for _, suffix := range []string{"?", "?x=1", "?bad=%xx"} {
		assertProjectError(t, projectRequest(h, "POST", stepHTTPPath()+suffix, base), 400, "invalid_input")
	}
	request := httptest.NewRequest("POST", stepHTTPPath(), strings.NewReader(base))
	authorizeResourceRequest(h, request)
	request.Header.Set("Content-Type", "text/plain")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	assertProjectError(t, response, 400, "invalid_input")
	exact := base + strings.Repeat(" ", httpx.MaxJSONBody-len(base))
	assertProjectError(t, projectRequest(h, "POST", stepHTTPPath(), exact+" "), 413, "payload_too_large")
	assertProjectError(t, projectRequest(h, "POST", stepHTTPPath()+"/abcdef01", `{}`), 405, "method_not_allowed")
	if h.Steps.TotalCalls() != 0 {
		t.Fatal("protocol rejection invoked Step service")
	}
}

func TestStepsHTTPAddDomainRefusalsAndUnicodeForwarding(t *testing.T) {
	invalid := []map[string]any{}
	for _, title := range []string{"", " \t\n\u0085\u2000 ", "\x00"} {
		invalid = append(invalid, map[string]any{"version": 1, "id": "00000000", "title": title})
	}
	for _, extra := range []map[string]any{{"status": ""}, {"status": "DONE"}, {"before": "bad"}, {"after": "bad"}, {"before": "00000001", "after": "00000002"}, {"description": "\x00"}} {
		input := map[string]any{"version": 1, "id": "00000000", "title": "x"}
		for name, value := range extra {
			input[name] = value
		}
		invalid = append(invalid, input)
	}
	for index, values := range invalid {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Steps.AddFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
				checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
				if input.Version != 1 || input.ID != "00000000" || input.Title != values["title"] {
					t.Fatal("domain value changed before service")
				}
				if value, ok := values["description"]; ok && input.Description != value {
					t.Fatal("description changed")
				}
				if value, ok := values["status"]; ok && (input.Status == nil || string(*input.Status) != value) {
					t.Fatal("status changed")
				}
				if value, ok := values["before"]; ok && (input.Before == nil || *input.Before != value) {
					t.Fatal("before changed")
				}
				if value, ok := values["after"]; ok && (input.After == nil || *input.After != value) {
					t.Fatal("after changed")
				}
				return taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}, &model.Fault{Code: "invalid_input", Message: "Invalid Step input."}
			}
			assertProjectError(t, projectRequest(h, "POST", stepHTTPPath(), jsonBody(t, values)), 400, "invalid_input")
		})
	}
	for _, tc := range []struct {
		version int64
		code    string
		status  int
	}{{1, "step_id_conflict", 409}, {9007199254740993, "version_conflict", 409}, {1, "not_found", 404}, {9223372036854775807, "version_exhausted", 409}} {
		t.Run(tc.code, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Steps.AddFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
				checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
				if input.Version != tc.version {
					t.Fatal("exact version changed")
				}
				return taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}, &model.Fault{Code: tc.code, Message: "Step mutation refused."}
			}
			assertProjectError(t, projectRequest(h, "POST", stepHTTPPath(), jsonBody(t, map[string]any{"version": tc.version, "id": "abcdef01", "title": "x"})), tc.status, tc.code)
		})
	}
	for _, body := range []string{`{"version":1,"id":"00000000","title":"�\ud83d\ude00\\ud800","description":""}`, `{"version":1,"id":"00000000","title":"x"}` + strings.Repeat(" ", httpx.MaxJSONBody-len(`{"version":1,"id":"00000000","title":"x"}`))} {
		t.Run(fmt.Sprint(len(body)), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			title := "x"
			if len(body) < httpx.MaxJSONBody {
				title = "�😀\\ud800"
			}
			row := stepHTTPRows()[0]
			row.ID, row.Title, row.Description = "00000000", title, ""
			result := stepHTTPWrite(t, 2, []api.TaskStep{row}, true)
			h.Steps.AddFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
				checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
				if input.Title != title || input.Description != "" || input.Version != 1 {
					t.Fatal("valid Unicode or exact body boundary changed")
				}
				return result, nil
			}
			response := projectRequest(h, "POST", stepHTTPPath(), body)
			if response.Code != 201 || !bytes.Equal(response.Body.Bytes(), result.JSON) {
				t.Fatal("valid input receipt changed")
			}
		})
	}
}

func TestStepsHTTPAddCommittedResponseLossAndReadOnlyReconciliation(t *testing.T) {
	stepHTTPResponseLoss(t, "add")
}
