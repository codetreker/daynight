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
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestStepsHTTPChangeContentStatusAndNoOp(t *testing.T) {
	title, description := "  <改名&> 😀 \uFEFF  ", " # raw Markdown-secret\n\"\\\u2028\u2029  "
	for _, tc := range []struct {
		name, body string
		expected   taskservice.UpdateTaskStep
		changed    bool
		version    int64
	}{
		{"paired edit", jsonBody(t, map[string]any{"version": 1, "title": title, "description": description}), taskservice.UpdateTaskStep{Version: 1, Title: &title, Description: &description}, true, 2},
		{"clear and omission", `{"version":2,"description":""}`, taskservice.UpdateTaskStep{Version: 2, Description: stepHTTPString("")}, true, 3},
		{"no-op", jsonBody(t, map[string]any{"version": 3, "title": title}), taskservice.UpdateTaskStep{Version: 3, Title: &title}, false, 3},
		{"maximum no-op", jsonBody(t, map[string]any{"version": int64(9223372036854775807), "title": title}), taskservice.UpdateTaskStep{Version: 9223372036854775807, Title: &title}, false, 9223372036854775807},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			rows := stepHTTPRows()[:2]
			rows[0].Title, rows[0].Description = title, description
			if tc.expected.Description != nil {
				rows[0].Description = *tc.expected.Description
			}
			result := stepHTTPWrite(t, tc.version, rows, tc.changed)
			h.Steps.UpdateFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
				checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
				if id != "abcdef01" || !reflect.DeepEqual(input, tc.expected) {
					t.Fatalf("Update arguments changed: %s %+v", id, input)
				}
				return result, nil
			}
			response := projectRequest(h, "PATCH", stepHTTPPath()+"/ABCDEF01", tc.body)
			resource := decodeResponse[api.StepsResource](t, response, 200)
			if resource.Version != tc.version || !bytes.Equal(response.Body.Bytes(), result.JSON) || response.Header().Get("Location") != "" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != h.principal.UserID {
				t.Fatal("change receipt or metadata changed")
			}
			if tc.changed != strings.Contains(logs.String(), `"phase":"persist"`) || !strings.Contains(logs.String(), `"tx_outcome":"committed"`) {
				t.Fatal("change and transaction facts conflated")
			}
			if !tc.changed && !strings.Contains(logs.String(), `"outcome":"unchanged"`) {
				t.Fatal("no-op outcome missing")
			}
			for _, sentinel := range []string{title, description, "Markdown-secret"} {
				if strings.Contains(logs.String(), sentinel) {
					t.Fatal("content entered diagnostic logs")
				}
			}
		})
	}
	for _, status := range []model.TaskStepStatus{model.TaskStepTodo, model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped} {
		for _, changed := range []bool{true, false} {
			t.Run(string(status)+fmt.Sprint(changed), func(t *testing.T) {
				var logs bytes.Buffer
				h := newHTTPFixture(t, &logs)
				rows := stepHTTPRows()
				rows[0].Status = status
				version := int64(9007199254740993)
				outputVersion := version
				if changed {
					outputVersion++
				}
				result := stepHTTPWrite(t, outputVersion, rows, changed)
				h.Steps.SetStatusFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
					checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
					if id != "abcdef01" || input.Version != version || input.Status != status {
						t.Fatal("status arguments changed")
					}
					return result, nil
				}
				response := projectRequest(h, "PUT", stepHTTPPath()+"/ABCDEF01/status", jsonBody(t, map[string]any{"version": version, "status": status}))
				if response.Code != 200 || !bytes.Equal(response.Body.Bytes(), result.JSON) || changed != strings.Contains(logs.String(), `"phase":"persist"`) {
					t.Fatal("status service result changed")
				}
			})
		}
	}
}

func TestStepsHTTPChangeStrictInputAndMethods(t *testing.T) {
	for _, tc := range []struct {
		method, suffix string
		allowed        []string
		good           string
	}{
		{"PATCH", "/abcdef01", []string{"version", "title", "description"}, `{"version":1,"title":"x"}`},
		{"PUT", "/abcdef01/status", []string{"version", "status"}, `{"version":1,"status":"todo"}`},
	} {
		t.Run(tc.method, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			bad := []string{"", `{}`, `null`, `[]`, `{`, tc.good + ` {}`, `{"version":1,"version":1,"title":"x"}`}
			if tc.method == "PUT" {
				bad = append(bad, `{"version":1}`)
			}
			for _, field := range tc.allowed {
				for _, value := range []string{"null", "false", "[]", "{}"} {
					var input map[string]json.RawMessage
					if err := json.Unmarshal([]byte(tc.good), &input); err != nil {
						t.Fatal(err)
					}
					input[field] = json.RawMessage(value)
					encoded, err := json.Marshal(input)
					if err != nil {
						t.Fatal(err)
					}
					bad = append(bad, string(encoded))
				}
			}
			if tc.method == "PATCH" {
				bad = append(bad, `{"version":1,"title":"`+string([]byte{0xff})+`"}`, `{"version":1,"title":"x","\u0074itle":"y"}`, `{"version":1,"title":"\ud800"}`, `{"version":1,"description":"\udfff"}`, `{"version":1,"status":"todo"}`)
			} else {
				bad = append(bad, `{"version":1,"status":"\ud800"}`, `{"version":1,"status":"todo","\u0073tatus":"done"}`, `{"version":1,"title":"x"}`)
			}
			for _, field := range []string{"id", "createdAt", "updatedAt", "before", "after", "position", "unknown"} {
				bad = append(bad, strings.TrimSuffix(tc.good, "}")+`,"`+field+`":"x"}`)
			}
			for _, version := range []string{`0`, `-1`, `1.0`, `1e0`, `9223372036854775808`, `"1"`} {
				bad = append(bad, strings.Replace(tc.good, `"version":1`, `"version":`+version, 1))
			}
			for index, body := range bad {
				t.Run(fmt.Sprint(index), func(t *testing.T) {
					assertProjectError(t, projectRequest(h, tc.method, stepHTTPPath()+tc.suffix, body), 400, "invalid_input")
				})
			}
			for _, suffix := range []string{"?", "?x=1", "?bad=%xx"} {
				assertProjectError(t, projectRequest(h, tc.method, stepHTTPPath()+tc.suffix+suffix, tc.good), 400, "invalid_input")
			}
			for _, id := range []string{"abc", "000000000", "0000000g"} {
				endpoint := stepHTTPPath() + "/" + id
				if tc.method == "PUT" {
					endpoint += "/status"
				}
				assertProjectError(t, projectRequest(h, tc.method, endpoint, tc.good), 400, "invalid_input")
			}
			request := httptest.NewRequest(tc.method, stepHTTPPath()+tc.suffix, strings.NewReader(tc.good))
			authorizeResourceRequest(h, request)
			request.Header.Set("X-Request-ID", "project-test")
			request.Header.Set("Content-Type", "text/plain")
			response := httptest.NewRecorder()
			h.ServeHTTP(response, request)
			assertProjectError(t, response, 400, "invalid_input")
			assertProjectError(t, projectRequest(h, tc.method, stepHTTPPath()+tc.suffix, strings.TrimSuffix(tc.good, "}")+`,"description":"`+strings.Repeat("x", httpx.MaxJSONBody)+`"}`), 413, "payload_too_large")
			if h.Steps.TotalCalls() != 0 {
				t.Fatal("protocol rejection invoked Step service")
			}
		})
	}
	h := newHTTPFixture(t, io.Discard)
	for _, tc := range []struct {
		endpoint, allow string
		methods         []string
	}{
		{stepHTTPPath(), "GET, HEAD, POST", []string{"PATCH", "PUT", "DELETE"}},
		{stepHTTPPath() + "/abcdef01", "GET, HEAD, PATCH, DELETE", []string{"POST", "PUT"}},
		{stepHTTPPath() + "/abcdef01/status", "PUT", []string{"GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"}},
	} {
		for _, method := range tc.methods {
			response := projectRequest(h, method, tc.endpoint, `{}`)
			if response.Code != 405 || response.Header().Get("Allow") != tc.allow || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("method %s %s fallback changed", method, tc.endpoint)
			}
		}
	}
	if h.Steps.TotalCalls() != 0 {
		t.Fatal("method fallback invoked service")
	}
}

func TestStepsHTTPChangeDomainRefusalsAndUnicodeForwarding(t *testing.T) {
	for _, tc := range []struct {
		method, suffix, body string
		title, description   *string
		status               *model.TaskStepStatus
	}{
		{method: "PATCH", suffix: "/abcdef01", body: `{"version":1}`},
		{method: "PATCH", suffix: "/abcdef01", body: `{"version":1,"title":""}`, title: stepHTTPString("")},
		{method: "PATCH", suffix: "/abcdef01", body: `{"version":1,"title":"\u0085"}`, title: stepHTTPString("\u0085")},
		{method: "PATCH", suffix: "/abcdef01", body: `{"version":1,"description":"\u0000"}`, description: stepHTTPString("\x00")},
		{method: "PUT", suffix: "/abcdef01/status", body: `{"version":1,"status":""}`, status: stepHTTPStatus("")},
		{method: "PUT", suffix: "/abcdef01/status", body: `{"version":1,"status":"DONE"}`, status: stepHTTPStatus("DONE")},
	} {
		t.Run(tc.body, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			failure := taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}
			if tc.method == "PATCH" {
				h.Steps.UpdateFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
					checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
					if id != "abcdef01" || !reflect.DeepEqual(input, taskservice.UpdateTaskStep{Version: 1, Title: tc.title, Description: tc.description}) {
						t.Fatal("domain update input changed")
					}
					return failure, &model.Fault{Code: "invalid_input", Message: "Invalid Step changes."}
				}
			} else {
				h.Steps.SetStatusFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
					checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
					if id != "abcdef01" || input.Version != 1 || input.Status != *tc.status {
						t.Fatal("domain status input changed")
					}
					return failure, &model.Fault{Code: "invalid_input", Message: "Invalid Step status."}
				}
			}
			assertProjectError(t, projectRequest(h, tc.method, stepHTTPPath()+tc.suffix, tc.body), 400, "invalid_input")
		})
	}
	for _, tc := range []struct {
		method, suffix string
		code           string
		status         int
	}{
		{"PATCH", "/abcdef01", "version_conflict", 409}, {"PUT", "/abcdef01/status", "version_conflict", 409},
		{"PATCH", "/ffffffff", "not_found", 404}, {"PUT", "/ffffffff/status", "not_found", 404},
		{"PATCH", "/abcdef01", "version_exhausted", 409}, {"PUT", "/abcdef01/status", "version_exhausted", 409},
		{"PATCH", "/ffffffff", "task_deleted", 410}, {"PUT", "/ffffffff/status", "task_deleted", 410},
	} {
		t.Run(tc.method+tc.code, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			refusal := taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}
			fault := &model.Fault{Code: tc.code, Message: "Step mutation refused."}
			if tc.method == "PATCH" {
				h.Steps.UpdateFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
					checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
					return refusal, fault
				}
			} else {
				h.Steps.SetStatusFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
					checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
					return refusal, fault
				}
			}
			values := map[string]any{"version": int64(9223372036854775807)}
			if tc.method == "PATCH" {
				values["title"] = "x"
			} else {
				values["status"] = "todo"
			}
			assertProjectError(t, projectRequest(h, tc.method, stepHTTPPath()+tc.suffix, jsonBody(t, values)), tc.status, tc.code)
		})
	}
	for _, tc := range []struct{ body, title, description string }{
		{`{"version":1,"title":"�\ud83d\ude00\\ud800","description":"\ufeff"}`, "�😀\\ud800", "\uFEFF"},
		{`{"version":1,"description":"X"}`, "", "X"},
	} {
		t.Run(tc.description, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			body := tc.body
			if tc.title == "" {
				body += strings.Repeat(" ", httpx.MaxJSONBody-len(body))
			}
			row := stepHTTPRows()[0]
			row.Description = tc.description
			if tc.title != "" {
				row.Title = tc.title
			}
			result := stepHTTPWrite(t, 2, []api.TaskStep{row}, true)
			h.Steps.UpdateFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
				checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
				if id != "abcdef01" || input.Version != 1 || input.Description == nil || *input.Description != tc.description || tc.title == "" && input.Title != nil || tc.title != "" && (input.Title == nil || *input.Title != tc.title) {
					t.Fatal("Unicode or whitespace boundary lost field presence")
				}
				return result, nil
			}
			response := projectRequest(h, "PATCH", stepHTTPPath()+"/abcdef01", body)
			if response.Code != 200 || !bytes.Equal(response.Body.Bytes(), result.JSON) {
				t.Fatal("accepted input changed frozen response")
			}
		})
	}
}

func TestStepsHTTPChangeCommittedResponseLossAndReconcile(t *testing.T) {
	stepHTTPResponseLoss(t, "change")
	stepHTTPResponseLoss(t, "status")
}

func stepHTTPResponseLoss(t *testing.T, operation string) {
	t.Helper()
	for _, mode := range []string{"short", "failed", "canceled_before_body"} {
		t.Run(operation+"/"+mode, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			rows := stepHTTPRows()
			rows[0].Title, rows[0].Description = "secret-title", "secret-markdown https://secret.invalid token-secret"
			result := stepHTTPWrite(t, 2, rows, true)
			method, suffix, body := "PATCH", "/ABCDEF01", `{"version":1,"title":"secret-title","description":"secret-markdown https://secret.invalid token-secret"}`
			commit := func(callCtx context.Context, p model.Principal, projectID, taskID string) (taskservice.StepsWriteResult, error) {
				checkStepHTTPCall(t, h, callCtx, p, projectID, taskID)
				if httpx.RequestID(callCtx) != "steps-lost" {
					t.Fatal("request identity changed before mutation")
				}
				if mode == "canceled_before_body" {
					cancel()
				}
				return result, nil
			}
			switch operation {
			case "add":
				method, suffix = "POST", ""
				body = `{"version":1,"id":"ABCDEF01","title":"secret-title","description":"secret-markdown https://secret.invalid token-secret"}`
				rows[0].Status, rows[0].UpdatedAt = model.TaskStepTodo, rows[0].CreatedAt
				result = stepHTTPWrite(t, 2, rows[:1], true)
				h.Steps.AddFunc = func(callCtx context.Context, p model.Principal, projectID, taskID string, input taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
					if input.ID != "ABCDEF01" || input.Version != 1 || input.Title != "secret-title" || input.Description != "secret-markdown https://secret.invalid token-secret" {
						t.Fatal("Add lost-response arguments changed")
					}
					return commit(callCtx, p, projectID, taskID)
				}
			case "change":
				h.Steps.UpdateFunc = func(callCtx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
					if id != "abcdef01" || input.Version != 1 || input.Title == nil || *input.Title != "secret-title" || input.Description == nil || *input.Description != "secret-markdown https://secret.invalid token-secret" {
						t.Fatal("Update lost-response arguments changed")
					}
					return commit(callCtx, p, projectID, taskID)
				}
			case "status":
				method, suffix, body = "PUT", "/ABCDEF01/status", `{"version":1,"status":"todo"}`
				rows[0].Status = model.TaskStepTodo
				result = stepHTTPWrite(t, 2, rows, true)
				h.Steps.SetStatusFunc = func(callCtx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
					if id != "abcdef01" || input.Version != 1 || input.Status != model.TaskStepTodo {
						t.Fatal("Status lost-response arguments changed")
					}
					return commit(callCtx, p, projectID, taskID)
				}
			case "delete":
				method, body = "DELETE", `{"version":1}`
				result = stepHTTPWrite(t, 2, rows[1:], true)
				h.Steps.DeleteFunc = func(callCtx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error) {
					if id != "abcdef01" || input.Version != 1 {
						t.Fatal("Delete lost-response arguments changed")
					}
					return commit(callCtx, p, projectID, taskID)
				}
			case "move":
				method, suffix, body = "PUT", "/ABCDEF01/position", `{"version":1,"position":"last"}`
				result = stepHTTPWrite(t, 2, []api.TaskStep{rows[1], rows[2], rows[3], rows[0]}, true)
				h.Steps.MoveFunc = func(callCtx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
					if id != "abcdef01" || input.Version != 1 || input.Position == nil || *input.Position != "last" {
						t.Fatal("Move lost-response arguments changed")
					}
					return commit(callCtx, p, projectID, taskID)
				}
			default:
				t.Fatal("unsupported response-loss operation")
			}
			request := httptest.NewRequest(method, stepHTTPPath()+suffix, strings.NewReader(body)).WithContext(ctx)
			authorizeResourceRequest(h, request)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Request-ID", "steps-lost")
			writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: mode == "short"}
			h.ServeHTTP(writer, request)
			status := 200
			if operation == "add" {
				status = 201
			}
			if mode == "canceled_before_body" && writer.calls != 0 || mode != "canceled_before_body" && (writer.calls != 1 || writer.Code != status) {
				t.Fatal("response replayed or returned wrong status")
			}
			outcome := "failed"
			if mode == "canceled_before_body" {
				outcome = mode
			}
			if !strings.Contains(logs.String(), `"tx_outcome":"committed"`) || !strings.Contains(logs.String(), `"response_outcome":"`+outcome+`"`) || !strings.Contains(logs.String(), `"written_bytes":0`) {
				t.Fatal("commit and response facts missing")
			}
			if operation == "delete" || operation == "move" {
				h.Steps.ListFunc = func(callCtx context.Context, p model.Principal, projectID, taskID string) (taskservice.StepsDocument, error) {
					checkStepHTTPCall(t, h, callCtx, p, projectID, taskID)
					return result.StepsDocument, nil
				}
				read := httptest.NewRequest("GET", stepHTTPPath(), nil)
				authorizeResourceRequest(h, read)
				read.Header.Set("X-Request-ID", "steps-lost.r1")
				response := httptest.NewRecorder()
				h.ServeHTTP(response, read)
				if response.Code != 200 || !bytes.Equal(response.Body.Bytes(), result.JSON) || !strings.Contains(logs.String(), `"outcome":"current_state"`) {
					t.Fatal("current collection reconciliation changed")
				}
			}
			if operation != "move" {
				h.Steps.GetFunc = func(callCtx context.Context, p model.Principal, projectID, taskID, id string) (taskservice.StepDocument, error) {
					checkStepHTTPCall(t, h, callCtx, p, projectID, taskID)
					if id != "abcdef01" {
						t.Fatal("reconciliation Step ID changed")
					}
					if operation == "delete" {
						return taskservice.StepDocument{}, &tasksteps.StepAbsence{Version: 2, Cause: &model.Fault{Code: "not_found", Message: "Step is unavailable."}}
					}
					return stepHTTPItem(t, 2, rows[0]), nil
				}
				read := httptest.NewRequest("GET", stepHTTPPath()+"/abcdef01", nil)
				authorizeResourceRequest(h, read)
				read.Header.Set("X-Request-ID", "steps-lost.r2")
				response := httptest.NewRecorder()
				h.ServeHTTP(response, read)
				if operation == "delete" {
					if response.Code != 404 || !strings.Contains(logs.String(), `"outcome":"absent"`) {
						t.Fatal("deleted target absence lost")
					}
				} else {
					item := decodeResponse[api.StepResource](t, response, 200)
					if item.Version != 2 || item.Step != rows[0] || !strings.Contains(logs.String(), `"outcome":"found"`) {
						t.Fatal("committed current item changed")
					}
				}
			}
			if !strings.Contains(logs.String(), `"read_kind":"reconcile"`) {
				t.Fatal("reconciliation identity missing")
			}
			for _, sentinel := range []string{"secret-title", "secret-markdown", "secret.invalid", "token-secret", "private response failure"} {
				if strings.Contains(logs.String(), sentinel) {
					t.Fatalf("response-loss diagnostics leaked %s", sentinel)
				}
			}
			expected := 2
			if operation == "delete" {
				expected = 3
			}
			if h.Steps.TotalCalls() != expected {
				t.Fatalf("reconciliation replayed mutation: calls=%d want=%d", h.Steps.TotalCalls(), expected)
			}
		})
	}
}

func TestStepsHTTPMutationFailurePreservesCompletionMetadata(t *testing.T) {
	for _, operation := range []string{"add", "change", "status", "delete", "move"} {
		for _, tc := range []struct {
			name, phase string
			outcome     store.TransactionOutcome
			cleanup     bool
			cause       error
			code        string
			status      int
		}{
			{"refused", "prepare", store.TransactionNotCommitted, false, &model.Fault{Code: "version_conflict", Message: "Parent version does not match."}, "version_conflict", 409},
			{"unknown commit", "commit", store.TransactionUnknown, false, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: fmt.Errorf("driver-secret")}, "internal_error", 500},
			{"cleanup failure", "cleanup", store.TransactionNotCommitted, true, &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: &model.Fault{Code: "version_conflict", Message: "private-domain-secret"}}, "internal_error", 500},
		} {
			t.Run(operation+"/"+tc.name, func(t *testing.T) {
				var logs bytes.Buffer
				h := newHTTPFixture(t, &logs)
				result := taskservice.StepsWriteResult{Phase: tc.phase, TransactionOutcome: tc.outcome, CleanupFailed: tc.cleanup}
				finish := func(ctx context.Context, p model.Principal, projectID, taskID string) (taskservice.StepsWriteResult, error) {
					checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
					return result, tc.cause
				}
				method, suffix, body := "PATCH", "/ABCDEF01", `{"version":1,"title":"x"}`
				switch operation {
				case "add":
					method, suffix, body = "POST", "", `{"version":1,"id":"ABCDEF01","title":"x"}`
					h.Steps.AddFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
						if input.Version != 1 || input.ID != "ABCDEF01" || input.Title != "x" {
							t.Fatal("failure path changed Add input")
						}
						return finish(ctx, p, projectID, taskID)
					}
				case "change":
					h.Steps.UpdateFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
						if id != "abcdef01" || input.Version != 1 || input.Title == nil || *input.Title != "x" {
							t.Fatal("failure path changed Update input")
						}
						return finish(ctx, p, projectID, taskID)
					}
				case "status":
					method, suffix, body = "PUT", "/ABCDEF01/status", `{"version":1,"status":"todo"}`
					h.Steps.SetStatusFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
						if id != "abcdef01" || input.Version != 1 || input.Status != model.TaskStepTodo {
							t.Fatal("failure path changed SetStatus input")
						}
						return finish(ctx, p, projectID, taskID)
					}
				case "delete":
					method, body = "DELETE", `{"version":1}`
					h.Steps.DeleteFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error) {
						if id != "abcdef01" || input.Version != 1 {
							t.Fatal("failure path changed Delete input")
						}
						return finish(ctx, p, projectID, taskID)
					}
				case "move":
					method, suffix, body = "PUT", "/ABCDEF01/position", `{"version":1,"position":"last"}`
					h.Steps.MoveFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
						if id != "abcdef01" || input.Version != 1 || input.Position == nil || *input.Position != "last" {
							t.Fatal("failure path changed Move input")
						}
						return finish(ctx, p, projectID, taskID)
					}
				}
				assertProjectError(t, projectRequest(h, method, stepHTTPPath()+suffix, body), tc.status, tc.code)
				for _, fact := range []string{`"phase":"` + tc.phase + `"`, `"tx_outcome":"` + string(tc.outcome) + `"`, `"cleanup_failed":` + fmt.Sprint(tc.cleanup), `"error_code":"` + tc.code + `"`} {
					if !strings.Contains(logs.String(), fact) {
						t.Fatalf("completion fact missing: %s", fact)
					}
				}
				if strings.Contains(logs.String(), "driver-secret") || strings.Contains(logs.String(), "private-domain-secret") {
					t.Fatal("operation cause leaked into logs")
				}
			})
		}
	}
}
