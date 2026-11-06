package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type fakeThreads struct {
	listInput taskservice.ThreadListRequest
	postInput taskservice.CreateThreadMessage
	principal model.Principal
	page      taskservice.ThreadPageDocument
	message   taskservice.ThreadMessageDocument
	err       error
	posts     int
}

func (f *fakeThreads) List(_ context.Context, principal model.Principal, _, _ string, in taskservice.ThreadListRequest) (taskservice.ThreadPageDocument, error) {
	f.principal, f.listInput = principal, in
	return f.page, f.err
}
func (f *fakeThreads) Post(_ context.Context, principal model.Principal, _, _ string, in taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
	f.principal, f.postInput = principal, in
	f.posts++
	return f.message, f.err
}

func TestThreadToolsHTTPContract(t *testing.T) {
	fixture := newEntryFixture(t)
	body := strings.Repeat("a", 60000) + "<正文>"
	page, _ := json.Marshal(map[string]any{"items": []any{map[string]any{"id": testTargetID, "body": body}}, "hasMoreBefore": true, "hasMoreAfter": false})
	message, _ := json.Marshal(map[string]any{"id": testTargetID, "body": body})
	threads := &fakeThreads{page: taskservice.ThreadPageDocument{JSON: page}, message: taskservice.ThreadMessageDocument{Message: model.ThreadMessage{ID: testTargetID}, JSON: message}}
	if err := RegisterThreadTools(fixture.entry, threads); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	call := func(name string, args any) *sdk.CallToolResult {
		t.Helper()
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	base := map[string]any{"projectId": testProjectID, "taskId": testTeamID}
	result := call("task_thread_read", base)
	data := object(t, structured(t, result)["data"])
	items := data["items"].([]any)
	if result.IsError || object(t, items[0])["body"] != body || data["hasMoreBefore"] != true || threads.listInput.Count != 20 {
		t.Fatalf("read result or default lost: %+v %+v", data, threads.listInput)
	}
	result = call("task_thread_read", map[string]any{"projectId": testProjectID, "taskId": testTeamID, "beforeId": testTargetID, "count": 1, "details": true})
	if result.IsError || threads.listInput.BeforeID == nil || *threads.listInput.BeforeID != testTargetID || threads.listInput.Count != 1 || !threads.listInput.Details {
		t.Fatalf("before input %+v", threads.listInput)
	}
	result = call("task_thread_read", map[string]any{"projectId": testProjectID, "taskId": testTeamID, "afterId": testTargetID})
	if result.IsError || threads.listInput.AfterID == nil || *threads.listInput.AfterID != testTargetID {
		t.Fatalf("after input %+v", threads.listInput)
	}
	result = call("task_thread_read", map[string]any{"projectId": testProjectID, "taskId": testTeamID, "beforeId": testTargetID, "afterId": testTargetID})
	if !result.IsError {
		t.Fatal("both boundaries accepted")
	}
	result = call("task_thread_post", map[string]any{"projectId": testProjectID, "taskId": testTeamID, "body": body, "replyTo": testTargetID, "claimId": testUserID})
	if result.IsError || object(t, structured(t, result)["data"])["id"] != testTargetID || threads.postInput.Body != body || *threads.postInput.ReplyTo != testTargetID || *threads.postInput.ClaimID != testUserID {
		t.Fatalf("post result %+v input %+v", result, threads.postInput)
	}
	threads.err = &taskservice.ThreadMessageError{MessageID: testTargetID, Cause: &store.ThreadTransactionError{Phase: "commit", OutcomeUnknown: true, Cause: errors.New("lost")}}
	result = call("task_thread_post", map[string]any{"projectId": testProjectID, "taskId": testTeamID, "body": "draft"})
	failure := object(t, structured(t, result)["error"])
	refs := object(t, failure["refs"])
	if !result.IsError || failure["code"] != "message_outcome_unknown" || failure["writeOutcome"] != "unknown" || refs["candidateMessageId"] != testTargetID || refs["messageId"] != nil || threads.posts != 2 {
		t.Fatalf("unknown result %+v, calls %d", failure, threads.posts)
	}
	threads.err = &model.Fault{Code: "forbidden", Message: "Project access is required."}
	result = call("task_thread_read", base)
	if !result.IsError || object(t, structured(t, result)["error"])["code"] != "forbidden" {
		t.Fatalf("permission: %+v", result)
	}
}

func TestThreadToolRegistrationRequiresDefinitions(t *testing.T) {
	original := threadToolsJSON
	t.Cleanup(func() { threadToolsJSON = original })
	threadToolsJSON = []byte("[")
	if err := RegisterThreadTools(newEntryFixture(t).entry, &fakeThreads{}); err == nil {
		t.Fatal("corrupt tool definitions accepted")
	}
	threadToolsJSON = []byte("[]")
	if err := RegisterThreadTools(newEntryFixture(t).entry, &fakeThreads{}); err == nil {
		t.Fatal("missing tools accepted")
	}
}

func TestThreadPostRESTBodyBudget(t *testing.T) {
	if got := threadPostBodySize(threadPostInput{Body: "<\n\x01"}); got != len(`{"body":"<\n\u0001"}`) {
		t.Fatalf("escaped body size %d", got)
	}
	threads := &fakeThreads{message: taskservice.ThreadMessageDocument{Message: model.ThreadMessage{ID: testTargetID}, JSON: []byte(`{"id":"` + testTargetID + `"}`)}}
	handler := threadTools{threads: threads}
	input := threadPostInput{Body: strings.Repeat("a", (1<<20)-len(`{"body":""}`))}
	if _, err := handler.post(context.Background(), projectActor(), input); err != nil {
		t.Fatalf("boundary refused: %v", err)
	}
	input.Body += "a"
	if _, err := handler.post(context.Background(), projectActor(), input); err == nil || threads.posts != 1 {
		t.Fatalf("oversized body reached service: %v; posts=%d", err, threads.posts)
	}
}

func TestThreadCompletionAndSafeResourceLogging(t *testing.T) {
	fixture := newEntryFixture(t)
	var logs bytes.Buffer
	fixture.entry.logger = slog.New(slog.NewJSONHandler(&logs, nil))
	threads := &fakeThreads{message: taskservice.ThreadMessageDocument{Message: model.ThreadMessage{ID: testTargetID}, JSON: []byte(`{"id":"` + testTargetID + `"}`)}}
	if err := RegisterThreadTools(fixture.entry, threads); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	call := func() *sdk.CallToolResult {
		t.Helper()
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "task_thread_post", Arguments: map[string]any{"projectId": testProjectID, "taskId": testTeamID, "body": "secret body", "claimId": testUserID}})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	if result := call(); result.IsError {
		t.Fatalf("confirmed post: %+v", result)
	}
	logsText := logs.String()
	for _, fragment := range []string{`"project_id":"` + testProjectID + `"`, `"task_id":"` + testTeamID + `"`, `"claim_id":"` + testUserID + `"`, `"message_id":"` + testTargetID + `"`, `"write_outcome":"confirmed"`} {
		if !strings.Contains(logsText, fragment) {
			t.Fatalf("missing %s in %s", fragment, logsText)
		}
	}
	if strings.Contains(logsText, "secret body") {
		t.Fatal("body leaked into logs")
	}
	logs.Reset()
	threads.err = &taskservice.ThreadMessageError{MessageID: testTargetID, Outcome: store.TransactionNotCommitted, Cause: &store.ThreadTransactionError{Phase: "callback", Cause: &model.Fault{Code: "forbidden", Message: "denied"}}}
	result := call()
	failure := object(t, structured(t, result)["error"])
	if !result.IsError || failure["code"] != "forbidden" || failure["writeOutcome"] != "not_committed" {
		t.Fatalf("rolled back result: %+v", failure)
	}
	logsText = logs.String()
	if !strings.Contains(logsText, `"candidate_message_id":"`+testTargetID+`"`) || strings.Contains(logsText, `"message_id":`) || strings.Contains(logsText, "secret body") {
		t.Fatalf("unsafe failure log: %s", logsText)
	}
	logs.Reset()
	threads.err = &taskservice.ThreadMessageError{Outcome: store.TransactionNotCommitted, Cause: &store.ThreadTransactionError{Phase: "rollback", RollbackFailed: true, Cause: &model.Fault{Code: "forbidden", Message: "denied"}}}
	result = call()
	failure = object(t, structured(t, result)["error"])
	if !result.IsError || failure["code"] != "internal_error" || failure["writeOutcome"] != "not_committed" {
		t.Fatalf("cleanup failure: %+v", failure)
	}
}

func TestThreadReadLogsSafeScopeAndPreservesFailure(t *testing.T) {
	fixture := newEntryFixture(t)
	var logs bytes.Buffer
	fixture.entry.logger = slog.New(slog.NewJSONHandler(&logs, nil))
	threads := &fakeThreads{page: taskservice.ThreadPageDocument{JSON: []byte(`{"items":[],"hasMoreBefore":false,"hasMoreAfter":false}`)}}
	if err := RegisterThreadTools(fixture.entry, threads); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	call := func() *sdk.CallToolResult {
		t.Helper()
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "task_thread_read", Arguments: map[string]any{"projectId": testProjectID, "taskId": testTeamID}})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	if result := call(); result.IsError {
		t.Fatalf("read: %+v", result)
	}
	if text := logs.String(); !strings.Contains(text, `"project_id":"`+testProjectID+`"`) || !strings.Contains(text, `"task_id":"`+testTeamID+`"`) {
		t.Fatalf("missing scope: %s", text)
	}
	logs.Reset()
	threads.err = &model.Fault{Code: "forbidden", Message: "Project access is required."}
	result := call()
	failure := object(t, structured(t, result)["error"])
	if !result.IsError || failure["code"] != "forbidden" || failure["writeOutcome"] != nil {
		t.Fatalf("read error changed: %+v", failure)
	}
	refs := object(t, failure["refs"])
	if refs["projectId"] != testProjectID || refs["taskId"] != testTeamID {
		t.Fatalf("missing error scope: %+v", refs)
	}
	if text := logs.String(); !strings.Contains(text, `"project_id":"`+testProjectID+`"`) || !strings.Contains(text, `"task_id":"`+testTeamID+`"`) {
		t.Fatalf("missing failure scope: %s", text)
	}
	threads.err = &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &model.Fault{Code: "forbidden", Message: "Project access is required."}}
	result = call()
	failure = object(t, structured(t, result)["error"])
	if !result.IsError || failure["code"] != "forbidden" || failure["writeOutcome"] != nil {
		t.Fatalf("snapshot completion reported as a write: %+v", failure)
	}
}
