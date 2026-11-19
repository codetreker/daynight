package task_test

import (
	"context"
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

const testBotID = "e5555555-e555-4555-8555-e55555555555"

func botDeclarationRequest(h *resourceTestHandler, method, path, body string, header []string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(h, request)
	request.Header.Set("Content-Type", "application/json; charset=UTF-8")
	request.Header.Set("X-Request-ID", "project-test")
	if header != nil {
		request.Header["X-Daynight-Bot-Id"] = header
	}
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	return response
}

func TestBotDeclarationRejectsMalformedHeaderBeforeEveryWrite(t *testing.T) {
	task := taskCollection(testProjectID) + "/" + testTaskID
	step := stepHTTPPath() + "/" + testStepID
	routes := []struct{ method, path string }{
		{"POST", taskCollection(testProjectID)},
		{"PATCH", task},
		{"DELETE", task},
		{"PUT", task + "/status"},
		{"PUT", task + "/properties/blocked"},
		{"DELETE", task + "/properties/blocked"},
		{"POST", task + "/worker-claim"},
		{"PATCH", task + "/worker-claim"},
		{"POST", task + "/worker-claim/release"},
		{"POST", task + "/worker-claim/withdraw"},
		{"POST", stepHTTPPath()},
		{"PATCH", step},
		{"DELETE", step},
		{"PUT", step + "/status"},
		{"PUT", step + "/position"},
		{"POST", task + "/thread/messages"},
	}
	headers := [][]string{
		{},
		{""},
		{"bad"},
		{"00000000-0000-0000-0000-000000000000"},
		{strings.ToUpper(testBotID)},
		{"{" + testBotID + "}"},
		{strings.ReplaceAll(testBotID, "-", "")},
		{testBotID, testBotID},
		{testBotID + "," + testBotID},
	}
	h := newHTTPFixture(t, io.Discard)
	for _, route := range routes {
		for _, header := range headers {
			response := botDeclarationRequest(h, route.method, route.path, `{}`, header)
			assertProjectError(t, response, 400, "invalid_input")
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("%s %s header %q: cache policy %q", route.method, route.path, header, response.Header().Get("Cache-Control"))
			}
		}
	}
	if h.TotalCalls() != 0 {
		t.Fatalf("malformed Bot declarations reached %d service calls", h.TotalCalls())
	}
}

func TestBotDeclarationReachesWriteOperations(t *testing.T) {
	refusal := &model.Fault{Code: "forbidden", Message: "The declared Bot is not available to this credential."}
	expect := func(t *testing.T, ctx context.Context, declared bool) {
		t.Helper()
		botID, ok := taskservice.DeclaredBot(ctx)
		if ok != declared || declared && botID != testBotID {
			t.Fatalf("declared Bot = %q %v, want %v", botID, ok, declared)
		}
	}
	for _, declared := range []bool{false, true} {
		var header []string
		if declared {
			header = []string{testBotID}
		}
		t.Run(fmt.Sprintf("task declared=%v", declared), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Tasks.CreateFunc = func(ctx context.Context, _ model.Principal, _ string, _ taskcore.CreateTask) (model.Task, error) {
				expect(t, ctx, declared)
				return model.Task{}, fmt.Errorf("write task: %w", refusal)
			}
			assertProjectError(t, botDeclarationRequest(h, "POST", taskCollection(testProjectID), `{"title":"Declared"}`, header), 403, "forbidden")
		})
		t.Run(fmt.Sprintf("step declared=%v", declared), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Steps.AddFunc = func(ctx context.Context, _ model.Principal, _, _ string, _ taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
				expect(t, ctx, declared)
				failure := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: refusal}
				return taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}, fmt.Errorf("write task steps: %w", failure)
			}
			assertProjectError(t, botDeclarationRequest(h, "POST", stepHTTPPath(), `{"version":1,"id":"abcdef01","title":"Declared"}`, header), 403, "forbidden")
		})
		t.Run(fmt.Sprintf("thread declared=%v", declared), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Threads.PostFunc = func(ctx context.Context, _ model.Principal, _, _ string, _ taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
				expect(t, ctx, declared)
				return taskservice.ThreadMessageDocument{}, &taskservice.ThreadMessageError{Outcome: store.TransactionNotCommitted, Cause: &store.ThreadTransactionError{Phase: "callback", Cause: refusal}}
			}
			path := taskCollection(testProjectID) + "/" + testTaskID + "/thread/messages"
			assertProjectError(t, botDeclarationRequest(h, "POST", path, `{"body":"Declared"}`, header), 403, "forbidden")
		})
	}
}
