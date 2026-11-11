package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
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
	for _, protocol := range []string{"2025-11-25", "2026-07-28"} {
		t.Run(protocol, func(t *testing.T) {
			fixture := newEntryFixture(t)
			body := strings.Repeat("a", 60000) + "<正文>"
			page, _ := json.Marshal(map[string]any{"items": []any{map[string]any{"id": testTargetID, "body": body}}, "hasMoreBefore": true, "hasMoreAfter": false})
			message, _ := json.Marshal(map[string]any{"id": testTargetID, "body": body})
			threads := &fakeThreads{page: taskservice.ThreadPageDocument{JSON: page}, message: taskservice.ThreadMessageDocument{Message: model.ThreadMessage{ID: testTargetID}, JSON: message}}
			if err := RegisterThreadTools(fixture.entry, threads); err != nil {
				t.Fatal(err)
			}
			client := fixture.client(t, protocol, "alice")
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
		})
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

func TestTypedToolRegistrationRejectsInvalidHandlerAndBudget(t *testing.T) {
	fixture := newEntryFixture(t)
	var absent func(context.Context, RequestActor, threadReadInput) (ToolResult, error)
	handler := func(context.Context, RequestActor, threadReadInput) (ToolResult, error) { return ToolResult{}, nil }
	for _, tc := range []struct {
		name     string
		want     string
		register func() error
	}{
		{"write nil handler", "MCP tool handler is required", func() error { return RegisterTypedTool(fixture.entry, nil, BudgetControl, absent) }},
		{"write invalid budget", "invalid MCP tool registration", func() error { return RegisterTypedTool(fixture.entry, nil, BudgetClass(0), handler) }},
		{"read nil handler", "MCP tool handler is required", func() error { return registerTypedReadTool(fixture.entry, nil, BudgetControl, absent) }},
		{"read invalid budget", "invalid MCP tool registration", func() error { return registerTypedReadTool(fixture.entry, nil, BudgetClass(0), handler) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.register(); err == nil || err.Error() != tc.want {
				t.Fatalf("got %v, want %q", err, tc.want)
			}
		})
	}
}

type mcpThreadIdentity struct{ principals map[string]model.Principal }

func (a mcpThreadIdentity) Authenticate(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
	principal, ok := a.principals[token]
	if !ok || kind != model.PATCredential {
		return model.Principal{}, errors.New("unexpected credential")
	}
	return principal, nil
}

func mcpThreadClient(t *testing.T, address, token, protocol string) *sdk.ClientSession {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	client := sdk.NewClient(&sdk.Implementation{Name: "mcp-thread-integration", Version: "1"}, nil)
	session, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: address + "/mcp", HTTPClient: &http.Client{Transport: headerTransport{base: http.DefaultTransport, token: token}}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: protocol})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := session.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})
	return session
}

type mcpThreadStore struct {
	t                *testing.T
	ReadSnapshotCall func(context.Context, func(store.SnapshotScope) error) error
	WriteThreadCall  func(context.Context, func(store.ThreadScope) error) (store.Completion, error)
}

func (s *mcpThreadStore) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	if s.ReadSnapshotCall == nil {
		unexpectedHTTPCall(s.t, "ReadSnapshot")
	}
	return s.ReadSnapshotCall(ctx, fn)
}
func (s *mcpThreadStore) WriteThread(ctx context.Context, fn func(store.ThreadScope) error) (store.Completion, error) {
	if s.WriteThreadCall == nil {
		unexpectedHTTPCall(s.t, "WriteThread")
	}
	return s.WriteThreadCall(ctx, fn)
}

type mcpThreadSnapshot struct {
	store.SnapshotScope
	Credentials store.CredentialReader
	Projects    store.ProjectReader
	Tasks       store.TaskReader
}

func newMCPThreadSnapshot(_ *testing.T) *mcpThreadSnapshot         { return &mcpThreadSnapshot{} }
func (s *mcpThreadSnapshot) CredentialDAO() store.CredentialReader { return s.Credentials }
func (s *mcpThreadSnapshot) ProjectDAO() store.ProjectReader       { return s.Projects }
func (s *mcpThreadSnapshot) TaskDAO() store.TaskReader             { return s.Tasks }

type mcpThreadCallPlan struct {
	t          *testing.T
	mu         sync.Mutex
	want, seen map[string]int
}

func newMCPThreadCallPlan(t *testing.T, want map[string]int) *mcpThreadCallPlan {
	t.Helper()
	p := &mcpThreadCallPlan{t: t, want: want, seen: make(map[string]int)}
	t.Cleanup(p.Verify)
	return p
}
func (p *mcpThreadCallPlan) Called(name string) {
	p.mu.Lock()
	p.seen[name]++
	got, want := p.seen[name], p.want[name]
	p.mu.Unlock()
	if got > want {
		unexpectedHTTPCall(p.t, name)
	}
}
func (p *mcpThreadCallPlan) Verify() {
	p.t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	for name, want := range p.want {
		if p.seen[name] != want {
			p.t.Errorf("DAO %s calls = %d, want %d", name, p.seen[name], want)
		}
	}
}

// Snapshot the declared fixture so calls cannot mutate subsequent expectations.
func mcpThreadClone[T any](value T) T {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var result T
	if err = json.Unmarshal(data, &result); err != nil {
		panic(err)
	}
	return result
}

func mcpStepsCheck(t *testing.T, ok bool, message string, values ...any) {
	t.Helper()
	if !ok {
		t.Errorf(message, values...)
		panic("MCP DAO expectation failed")
	}
}

type mcpThreadWritePlan struct {
	t          *testing.T
	plan       *mcpThreadCallPlan
	Principal  model.Principal
	TaskID     string
	Source     model.Task
	Head       *model.ThreadPosition
	ReplyID    string
	Reply      model.ThreadMessage
	ReplyError error
	Input      model.ThreadMessage
	Inserted   model.ThreadMessage
	Completion store.Completion
	order      []string
}

func (p *mcpThreadWritePlan) called(name string) {
	p.plan.Called(name)
	p.order = append(p.order, name)
}

func (p *mcpThreadWritePlan) write(tx *mcpThreadStore) {
	p.Source = mcpThreadClone(p.Source)
	p.Head = mcpThreadClone(p.Head)
	p.Reply = mcpThreadClone(p.Reply)
	p.Input = mcpThreadClone(p.Input)
	p.Inserted = mcpThreadClone(p.Inserted)
	tx.WriteThreadCall = func(ctx context.Context, write func(store.ThreadScope) error) (store.Completion, error) {
		p.called("write")
		mcpStepsCheck(p.t, ctx.Err() == nil && write != nil, "invalid Thread write callback")
		err := write(&mcpThreadWriteScope{p: p})
		return p.Completion, err
	}
}

type mcpThreadWriteScope struct{ p *mcpThreadWritePlan }

func (s *mcpThreadWriteScope) TaskDAO() store.ThreadTaskDAO             { return s }
func (s *mcpThreadWriteScope) CredentialDAO() store.ThreadCredentialDAO { return s }
func (s *mcpThreadWriteScope) ProjectDAO() store.ThreadProjectDAO       { return s }
func (s *mcpThreadWriteScope) ThreadDAO() store.ThreadDAO               { return s }
func (s *mcpThreadWriteScope) CaptureDAO() store.WebhookCaptureDAO {
	return &mcpThreadCapture{p: s.p}
}
func (s *mcpThreadWriteScope) LockTaskPresence(ctx context.Context, projectID, taskID string) (store.TaskPresence, error) {
	s.p.called("presence")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && projectID == mcpStepsProjectID && taskID == s.p.TaskID, "Thread presence scope: %s/%s", projectID, taskID)
	return store.TaskPresence{Found: true}, nil
}
func (s *mcpThreadWriteScope) SourceTask(ctx context.Context, projectID, taskID string) (model.Task, error) {
	s.p.called("source")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && projectID == mcpStepsProjectID && taskID == s.p.TaskID && s.p.Source.ID == taskID, "Thread claim source changed: %s/%s", projectID, taskID)
	return mcpThreadClone(s.p.Source), nil
}
func (s *mcpThreadWriteScope) Credential(ctx context.Context, principal model.Principal) (store.ThreadCredential, error) {
	s.p.called("credential")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && principal == s.p.Principal, "Thread credential actor: %+v", principal)
	return store.ThreadCredential{}, nil
}
func (s *mcpThreadWriteScope) CredentialValid(ctx context.Context, credential store.ThreadCredential) (bool, error) {
	s.p.called("valid")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && credential.ExpiresAt == nil, "Thread final credential changed")
	return true, nil
}
func (s *mcpThreadWriteScope) AuthorName(ctx context.Context, userID string) (*string, error) {
	s.p.called("name")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && userID == s.p.Principal.UserID, "Thread author identity: %s", userID)
	return mcpThreadClone(s.p.Input.Author.DisplayName), nil
}
func (s *mcpThreadWriteScope) LockProjectAuthorization(ctx context.Context, principal model.Principal, projectID string) (model.ProjectAccess, error) {
	s.p.called("access")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && principal == s.p.Principal && projectID == mcpStepsProjectID, "Thread Project admission changed")
	return model.ProjectAccess{ProjectID: projectID, UserID: principal.UserID, Role: model.ProjectAdmin}, nil
}
func (s *mcpThreadWriteScope) LockHead(ctx context.Context, taskID string) (*model.ThreadPosition, error) {
	s.p.called("head")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && taskID == s.p.TaskID, "Thread head identity: %s", taskID)
	return mcpThreadClone(s.p.Head), nil
}
func (s *mcpThreadWriteScope) ThreadMessage(ctx context.Context, taskID, id string) (model.ThreadMessage, error) {
	s.p.called("reply")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && taskID == s.p.TaskID && id == s.p.ReplyID, "Thread reply scope: %s/%s", taskID, id)
	return mcpThreadClone(s.p.Reply), s.p.ReplyError
}
func (s *mcpThreadWriteScope) InsertMessage(ctx context.Context, message model.ThreadMessage) (model.ThreadMessage, error) {
	s.p.called("insert")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && reflect.DeepEqual(message, s.p.Input), "Thread insert changed body/author/reply: %+v want %+v", message, s.p.Input)
	return mcpThreadClone(s.p.Inserted), nil
}
func (s *mcpThreadWriteScope) PrepareTimestamp(ctx context.Context, message *model.ThreadMessage, head *model.ThreadPosition) error {
	s.p.called("clock")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && message != nil && reflect.DeepEqual(*message, s.p.Inserted) && reflect.DeepEqual(head, s.p.Head), "Thread timestamp did not use the inserted message and admitted head")
	return nil
}
func (s *mcpThreadWriteScope) AdvanceHead(ctx context.Context, taskID string, position model.ThreadPosition) error {
	s.p.called("advance")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && taskID == s.p.TaskID && position == s.p.Inserted.Position(), "Thread advance changed message position: %s/%+v", taskID, position)
	return nil
}

type mcpThreadCapture struct {
	store.WebhookCaptureDAO
	p *mcpThreadWritePlan
}

func (c *mcpThreadCapture) FreezeAudience(ctx context.Context, projectID string, eventTypes []string) ([]store.WebhookAudience, error) {
	c.p.called("capture")
	mcpStepsCheck(c.p.t, ctx.Err() == nil && projectID == mcpStepsProjectID && reflect.DeepEqual(eventTypes, []string{"task.thread_posted"}), "Thread capture changed Project/type: %s/%v", projectID, eventTypes)
	return []store.WebhookAudience{}, nil
}

type mcpThreadReadPlan struct {
	t                     *testing.T
	plan                  *mcpThreadCallPlan
	Principal             model.Principal
	TaskID                string
	AccessError           error
	AnchorID              string
	Anchor                model.ThreadMessage
	Before                bool
	Limit                 int
	Candidates            []model.ThreadMessage
	First, Last           model.ThreadPosition
	MoreBefore, MoreAfter bool
}

func (p *mcpThreadReadPlan) snapshot(tx *mcpThreadStore) {
	p.Anchor = mcpThreadClone(p.Anchor)
	p.Candidates = mcpThreadClone(p.Candidates)
	s := newMCPThreadSnapshot(p.t)
	s.Credentials = &mcpThreadReadCredential{p}
	s.Projects = &mcpThreadReadProject{p: p}
	s.Tasks = &mcpThreadReader{p: p}
	tx.ReadSnapshotCall = func(ctx context.Context, read func(store.SnapshotScope) error) error {
		p.plan.Called("snapshot")
		mcpStepsCheck(p.t, ctx.Err() == nil && read != nil, "invalid Thread snapshot callback")
		return read(s)
	}
}

type mcpThreadReadCredential struct{ p *mcpThreadReadPlan }

func (r *mcpThreadReadCredential) Credential(ctx context.Context, principal model.Principal) (store.ThreadCredential, error) {
	r.p.plan.Called("credential")
	mcpStepsCheck(r.p.t, ctx.Err() == nil && principal == r.p.Principal, "Thread read credential actor changed: %+v", principal)
	return store.ThreadCredential{}, nil
}

type mcpThreadReadProject struct {
	store.ProjectReader
	p *mcpThreadReadPlan
}

func (r *mcpThreadReadProject) ProjectAccess(ctx context.Context, principal model.Principal, projectID string) (model.ProjectAccess, error) {
	r.p.plan.Called("access")
	mcpStepsCheck(r.p.t, ctx.Err() == nil && principal == r.p.Principal && projectID == mcpStepsProjectID, "Thread read Project actor/scope changed")
	return model.ProjectAccess{ProjectID: projectID, UserID: principal.UserID, Role: model.ProjectAdmin}, r.p.AccessError
}

type mcpThreadReader struct {
	store.TaskReader
	p *mcpThreadReadPlan
}

func (r *mcpThreadReader) TaskPresence(ctx context.Context, projectID, taskID string) (store.TaskPresence, error) {
	r.p.plan.Called("presence")
	mcpStepsCheck(r.p.t, ctx.Err() == nil && projectID == mcpStepsProjectID && taskID == r.p.TaskID, "Thread read presence changed: %s/%s", projectID, taskID)
	return store.TaskPresence{Found: true}, nil
}
func (r *mcpThreadReader) ThreadMessage(ctx context.Context, taskID, id string) (model.ThreadMessage, error) {
	r.p.plan.Called("anchor")
	mcpStepsCheck(r.p.t, ctx.Err() == nil && taskID == r.p.TaskID && id == r.p.AnchorID, "Thread read anchor changed: %s/%s", taskID, id)
	return mcpThreadClone(r.p.Anchor), nil
}
func (r *mcpThreadReader) ThreadCandidates(ctx context.Context, taskID string, anchor *model.ThreadPosition, before bool, limit int) ([]model.ThreadMessage, error) {
	r.p.plan.Called("candidates")
	var expected *model.ThreadPosition
	if r.p.AnchorID != "" {
		position := r.p.Anchor.Position()
		expected = &position
	}
	mcpStepsCheck(r.p.t, ctx.Err() == nil && taskID == r.p.TaskID && reflect.DeepEqual(anchor, expected) && before == r.p.Before && limit == r.p.Limit, "Thread candidate scope/bounds: %s/%+v/%v/%d", taskID, anchor, before, limit)
	return mcpThreadClone(r.p.Candidates), nil
}
func (r *mcpThreadReader) ThreadSides(ctx context.Context, taskID string, first, last model.ThreadPosition) (bool, bool, error) {
	r.p.plan.Called("sides")
	mcpStepsCheck(r.p.t, ctx.Err() == nil && taskID == r.p.TaskID && first == r.p.First && last == r.p.Last, "Thread page sides changed identity/positions: %s/%+v/%+v", taskID, first, last)
	return r.p.MoreBefore, r.p.MoreAfter, nil
}

type dropMCPResponse struct {
	token string
	drop  bool
}

func (d *dropMCPResponse) RoundTrip(req *http.Request) (*http.Response, error) {
	r := req.Clone(req.Context())
	r.Header = req.Header.Clone()
	r.Header.Set("Authorization", "Bearer "+d.token)
	response, err := http.DefaultTransport.RoundTrip(r)
	if err == nil && d.drop {
		d.drop = false
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		return nil, errors.New("test: response lost after server completion")
	}
	return response, err
}

func TestMCPThreadProduction(t *testing.T) {
	for _, protocol := range []string{"2025-11-25", "2026-07-28"} {
		t.Run(protocol, func(t *testing.T) {
			principal := defaultHTTPPrincipal()
			outsider := principal
			outsider.UserID = "e5555555-5555-4555-8555-555555555555"
			outsider.CredentialID = "f6666666-6666-4666-8666-666666666666"
			token, otherToken := defaultHTTPToken(), "dnpat_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"
			tx := &mcpThreadStore{t: t}
			identity := mcpThreadIdentity{principals: map[string]model.Principal{token: principal, otherToken: outsider}}
			production, _ := newAdapterHost(t, identity, io.Discard, func(entry *Entry, _ string) error {
				return RegisterThreadTools(entry, taskservice.NewTaskThreads(tx))
			})
			client, denied := mcpThreadClient(t, production.URL, token, protocol), mcpThreadClient(t, production.URL, otherToken, protocol)
			now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
			name := "Alice"
			otherID := "a7777777-7777-4777-8777-777777777777"
			call := func(session *sdk.ClientSession, name string, args map[string]any) (*sdk.CallToolResult, map[string]any) {
				t.Helper()
				ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
				defer cancel()
				result, err := session.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
				if err != nil {
					t.Fatalf("%s: %v", name, err)
				}
				raw, err := json.Marshal(result.StructuredContent)
				if err != nil {
					t.Fatal(err)
				}
				var envelope map[string]any
				if err = json.Unmarshal(raw, &envelope); err != nil {
					t.Fatal(err)
				}
				return result, envelope
			}
			args := func(id string) map[string]any { return map[string]any{"projectId": mcpStepsProjectID, "taskId": id} }
			message := func(taskID, id, body string, at time.Time, reply *string) model.ThreadMessage {
				return model.ThreadMessage{TaskID: taskID, ID: id, Author: model.ThreadAuthor{UserID: principal.UserID, DisplayName: &name}, Body: body, CreatedAt: at, ReplyTo: reply}
			}
			head := func(m model.ThreadMessage) *model.ThreadPosition { p := m.Position(); return &p }
			planPost := func(expected model.ThreadMessage, previous *model.ThreadPosition, reply model.ThreadMessage, replyErr error, source model.Task) *mcpThreadWritePlan {
				t.Helper()
				want := map[string]int{"write": 1, "presence": 1, "credential": 1, "access": 1, "name": 1, "head": 1}
				if expected.ReplyTo != nil {
					want["reply"] = 1
				}
				if expected.Author.Agent {
					want["source"] = 1
				}
				outcome := store.TransactionCommitted
				if replyErr == nil {
					want["insert"] = 1
					want["clock"] = 1
					want["valid"] = 1
					want["advance"] = 1
					want["capture"] = 1
				} else {
					outcome = store.TransactionNotCommitted
				}
				input := expected
				input.ID = ""
				input.CreatedAt = time.Time{}
				p := &mcpThreadWritePlan{t: t, plan: newMCPThreadCallPlan(t, want), Principal: principal, TaskID: expected.TaskID, Source: source, Head: previous, Reply: reply, ReplyError: replyErr, Input: input, Inserted: expected, Completion: store.Completion{Outcome: outcome}}
				if expected.ReplyTo != nil {
					p.ReplyID = *expected.ReplyTo
				}
				p.write(tx)
				tx.ReadSnapshotCall = nil
				return p
			}
			verifyPost := func(p *mcpThreadWritePlan) {
				t.Helper()
				p.plan.Verify()
				want := []string{"write", "presence", "credential", "access", "name"}
				if p.Input.Author.Agent {
					want = append(want, "source")
				}
				want = append(want, "head")
				if p.ReplyID != "" {
					want = append(want, "reply")
				}
				if p.ReplyError == nil {
					want = append(want, "insert", "clock", "valid", "advance", "capture")
				}
				if !reflect.DeepEqual(p.order, want) {
					t.Fatalf("Thread append order: %v want %v", p.order, want)
				}
			}
			post := func(expected model.ThreadMessage, previous *model.ThreadPosition, reply model.ThreadMessage, source model.Task) map[string]any {
				t.Helper()
				p := planPost(expected, previous, reply, nil, source)
				a := args(expected.TaskID)
				a["body"] = expected.Body
				if expected.ReplyTo != nil {
					a["replyTo"] = *expected.ReplyTo
				}
				if expected.Author.Agent {
					a["claimId"] = expected.Author.Execution.ClaimID
				}
				result, value := call(client, "task_thread_post", a)
				if result.IsError {
					t.Fatalf("post: %+v", value)
				}
				verifyPost(p)
				data := value["data"].(map[string]any)
				if data["id"] != expected.ID || data["body"] != expected.Body || data["author"].(map[string]any)["userId"] != principal.UserID || data["author"].(map[string]any)["Agent"] != expected.Author.Agent {
					t.Fatalf("message receipt: %+v", data)
				}
				return data
			}
			planRead := func(actor model.Principal, taskID string, anchor model.ThreadMessage, before bool, limit int, candidates []model.ThreadMessage, first, last model.ThreadPosition, moreBefore, moreAfter bool, accessErr error) *mcpThreadReadPlan {
				t.Helper()
				want := map[string]int{"snapshot": 1, "credential": 1, "access": 1}
				if accessErr == nil {
					want["presence"] = 1
					want["candidates"] = 1
					if len(candidates) > 0 {
						want["sides"] = 1
					}
					if anchor.ID != "" {
						want["anchor"] = 1
					}
				}
				p := &mcpThreadReadPlan{t: t, plan: newMCPThreadCallPlan(t, want), Principal: actor, TaskID: taskID, AccessError: accessErr, AnchorID: anchor.ID, Anchor: anchor, Before: before, Limit: limit, Candidates: candidates, First: first, Last: last, MoreBefore: moreBefore, MoreAfter: moreAfter}
				p.snapshot(tx)
				tx.WriteThreadCall = nil
				return p
			}
			firstModel := message(mcpStepsTaskID, "a1111111-1111-4111-8111-111111111110", "first", now, nil)
			first := post(firstModel, nil, model.ThreadMessage{}, model.Task{})
			firstID := firstModel.ID
			secondModel := message(mcpStepsTaskID, "a1111111-1111-4111-8111-111111111112", "reply", now.Add(time.Second), &firstID)
			second := post(secondModel, head(firstModel), firstModel, model.Task{})
			secondID := secondModel.ID
			if second["replyTo"] != firstID {
				t.Fatalf("reply: %+v", second)
			}
			crossModel := message(otherID, "a1111111-1111-4111-8111-111111111113", "cross", now.Add(2*time.Second), &firstID)
			crossPlan := planPost(crossModel, nil, model.ThreadMessage{}, model.ErrNotFound, model.Task{})
			cross := args(otherID)
			cross["body"] = "cross"
			cross["replyTo"] = firstID
			result, value := call(client, "task_thread_post", cross)
			if !result.IsError || value["error"].(map[string]any)["code"] != "message_not_found" {
				t.Fatalf("cross-task reply: %+v", value)
			}
			verifyPost(crossPlan)
			deniedPlan := planRead(outsider, mcpStepsTaskID, model.ThreadMessage{}, true, 21, nil, model.ThreadPosition{}, model.ThreadPosition{}, false, false, model.ErrNotFound)
			result, value = call(denied, "task_thread_read", args(mcpStepsTaskID))
			if !result.IsError || value["error"].(map[string]any)["code"] != "forbidden" {
				t.Fatalf("unauthorized read: %+v", value)
			}
			deniedPlan.plan.Verify()
			for _, tc := range []struct {
				field, boundary, expected     string
				anchor, row                   model.ThreadMessage
				before, moreBefore, moreAfter bool
			}{{"beforeId", secondID, firstID, secondModel, firstModel, true, false, true}, {"afterId", firstID, secondID, firstModel, secondModel, false, true, false}} {
				p := planRead(principal, mcpStepsTaskID, tc.anchor, tc.before, 2, []model.ThreadMessage{tc.row}, tc.row.Position(), tc.row.Position(), tc.moreBefore, tc.moreAfter, nil)
				a := args(mcpStepsTaskID)
				a[tc.field] = tc.boundary
				a["count"] = 1
				result, value = call(client, "task_thread_read", a)
				if result.IsError {
					t.Fatalf("read: %+v", value)
				}
				p.plan.Verify()
				items := value["data"].(map[string]any)["items"].([]any)
				if len(items) != 1 || items[0].(map[string]any)["id"] != tc.expected {
					t.Fatalf("page: %+v", value)
				}
				if tc.expected == firstID && items[0].(map[string]any)["body"] != first["body"] {
					t.Fatal("message truncated")
				}
			}
			// Exact message admission remains opt-in.
			if os.Getenv("DAYNIGHT_MCP_THREAD_CAPACITY") == "1" {
				probeModel := message(otherID, "a1111111-1111-4111-8111-111111111114", "x", now.Add(3*time.Second), nil)
				probe := post(probeModel, nil, model.ThreadMessage{}, model.Task{})
				encoded, err := json.Marshal(probe)
				if err != nil {
					t.Fatal(err)
				}
				exactBody := strings.Repeat("x", 65536-(len(encoded)-1))
				maxMessages := make([]model.ThreadMessage, 0, 4)
				previous := probeModel
				for i := range 4 {
					expected := message(otherID, fmt.Sprintf("a1111111-1111-4111-8111-%012d", 20+i), exactBody, now.Add(time.Duration(4+i)*time.Second), nil)
					value := post(expected, head(previous), model.ThreadMessage{}, model.Task{})
					encoded, err = json.Marshal(value)
					if err != nil || len(encoded) != 65536 {
						t.Fatalf("message size %d: %v", len(encoded), err)
					}
					maxMessages = append(maxMessages, expected)
					previous = expected
				}
				excess := message(otherID, "a1111111-1111-4111-8111-111111111115", exactBody+"x", now.Add(9*time.Second), nil)
				input := excess
				input.ID, input.CreatedAt = "", time.Time{}
				p := &mcpThreadWritePlan{t: t, plan: newMCPThreadCallPlan(t, map[string]int{"write": 1, "presence": 1, "credential": 1, "access": 1, "name": 1, "head": 1, "insert": 1, "clock": 1}), Principal: principal, TaskID: otherID, Head: head(previous), Input: input, Inserted: excess, Completion: store.Completion{Outcome: store.TransactionNotCommitted}}
				p.write(tx)
				tx.ReadSnapshotCall = nil
				a := args(otherID)
				a["body"] = excess.Body
				result, value = call(client, "task_thread_post", a)
				if !result.IsError || value["error"].(map[string]any)["code"] != "payload_too_large" {
					t.Fatalf("oversize: %+v", value)
				}
				p.plan.Verify()
				tailCandidates := []model.ThreadMessage{maxMessages[3], maxMessages[2], maxMessages[1], maxMessages[0], probeModel}
				read := planRead(principal, otherID, model.ThreadMessage{}, true, 101, tailCandidates, probeModel.Position(), maxMessages[3].Position(), false, false, nil)
				a = args(otherID)
				a["count"] = 100
				result, value = call(client, "task_thread_read", a)
				if result.IsError {
					t.Fatalf("capacity page: %+v", value)
				}
				read.plan.Verify()
				page := value["data"].(map[string]any)
				encoded, err = json.Marshal(page)
				items := page["items"].([]any)
				if err != nil || len(items) != 5 || items[0].(map[string]any)["id"] != probeModel.ID || items[4].(map[string]any)["id"] != maxMessages[3].ID || page["hasMoreBefore"] != false || page["hasMoreAfter"] != false {
					t.Fatalf("capacity tail: bytes=%d page=%+v", len(encoded), page)
				}
				read = planRead(principal, otherID, maxMessages[1], true, 21, []model.ThreadMessage{maxMessages[0], probeModel}, probeModel.Position(), maxMessages[0].Position(), false, true, nil)
				a = args(otherID)
				a["beforeId"] = maxMessages[1].ID
				result, value = call(client, "task_thread_read", a)
				if result.IsError {
					t.Fatalf("capacity preceding page: %+v", value)
				}
				read.plan.Verify()
				page = value["data"].(map[string]any)
				items = page["items"].([]any)
				if len(items) != 2 || items[1].(map[string]any)["id"] != maxMessages[0].ID || page["hasMoreAfter"] != true {
					t.Fatal("capacity pagination skipped messages")
				}
			}
			// The declared current claim is read only when explicit attribution is requested.
			claimID := "b2222222-2222-4222-8222-222222222220"
			workerID := "b2222222-2222-4222-8222-222222222221"
			worker := &model.WorkerClaim{ClaimID: claimID, State: model.WorkerActive, UserID: principal.UserID, WorkerID: workerID, Machine: model.WorkerMachine{ID: "b2222222-2222-4222-8222-222222222223", Name: "MCP host"}, Platform: model.TaskPlatform("linux"), Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: "b2222222-2222-4222-8222-222222222224", Phase: model.WorkerExecuting, ClaimedAt: now}
			workerRaw, err := taskproperty.EncodeWorker(worker)
			if err != nil {
				t.Fatal(err)
			}
			source := model.Task{ID: mcpStepsTaskID, ProjectID: mcpStepsProjectID, Status: model.TaskInProgress, Version: 3, Properties: model.TaskProperties{"worker": workerRaw}}
			agentModel := message(mcpStepsTaskID, "a1111111-1111-4111-8111-111111111116", "agent message", now.Add(10*time.Second), nil)
			agentModel.Author.Agent = true
			agentModel.Author.Execution = &model.ThreadExecution{ClaimID: claimID, WorkerID: workerID, Provider: "codex"}
			posted := post(agentModel, head(secondModel), model.ThreadMessage{}, source)
			if posted["author"].(map[string]any)["Agent"] != true {
				t.Fatalf("claim post: %+v", posted)
			}
			detailsPlan := planRead(principal, mcpStepsTaskID, model.ThreadMessage{}, true, 21, []model.ThreadMessage{agentModel, secondModel, firstModel}, firstModel.Position(), agentModel.Position(), false, false, nil)
			a := args(mcpStepsTaskID)
			a["details"] = true
			result, value = call(client, "task_thread_read", a)
			if result.IsError {
				t.Fatalf("details: %+v", value)
			}
			detailsPlan.plan.Verify()
			items := value["data"].(map[string]any)["items"].([]any)
			author := items[len(items)-1].(map[string]any)["author"].(map[string]any)
			if author["execution"].(map[string]any)["claimId"] != claimID {
				t.Fatalf("claim attribution: %+v", author)
			}

			transport := &dropMCPResponse{token: token}
			sdkClient := sdk.NewClient(&sdk.Implementation{Name: "mcp-drop-test", Version: "1"}, nil)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			lost, err := sdkClient.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: production.URL + "/mcp", HTTPClient: &http.Client{Transport: transport}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: protocol})
			if err != nil {
				t.Fatal(err)
			}
			defer lost.Close()
			lostModel := message(mcpStepsTaskID, "a1111111-1111-4111-8111-111111111117", "lost response", now.Add(11*time.Second), nil)
			lostPlan := planPost(lostModel, head(agentModel), model.ThreadMessage{}, nil, model.Task{})
			transport.drop = true
			a = args(mcpStepsTaskID)
			a["body"] = "lost response"
			if _, err = lost.CallTool(ctx, &sdk.CallToolParams{Name: "task_thread_post", Arguments: a}); err == nil {
				t.Fatal("expected lost response")
			}
			verifyPost(lostPlan)
			readAfterLoss := planRead(principal, mcpStepsTaskID, model.ThreadMessage{}, true, 21, []model.ThreadMessage{lostModel, agentModel, secondModel, firstModel}, firstModel.Position(), lostModel.Position(), false, false, nil)
			result, value = call(client, "task_thread_read", args(mcpStepsTaskID))
			if result.IsError {
				t.Fatalf("read after loss: %+v", value)
			}
			readAfterLoss.plan.Verify()
			items = value["data"].(map[string]any)["items"].([]any)
			count := 0
			for _, item := range items {
				if item.(map[string]any)["body"] == "lost response" {
					count++
				}
			}
			if count != 1 {
				t.Fatalf("expected one returned message after loss, got %d", count)
			}
		})
	}
}
