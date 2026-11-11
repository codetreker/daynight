package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type fakeStepReads struct {
	version int64
	items   []store.TaskStepProjection
	calls   int
}

func (f *fakeStepReads) header() model.TaskHeader {
	return model.TaskHeader{ProjectID: testProjectID, ID: testTargetID, Version: f.version}
}
func (f *fakeStepReads) ListPage(_ context.Context, _ model.Principal, _, _ string, after int64, limit int, version *int64, summary bool) (taskservice.StepsPage, error) {
	f.calls++
	if version != nil && *version != f.version {
		return taskservice.StepsPage{}, &model.Fault{Code: "version_conflict", Message: "Task version does not match."}
	}
	result := taskservice.StepsPage{Header: f.header(), Items: make([]store.TaskStepProjection, 0)}
	for _, item := range f.items {
		if item.Step.Position <= after {
			continue
		}
		if len(result.Items) == limit {
			result.HasMore = true
			break
		}
		if summary {
			item.Step.Description = ""
		}
		result.Items = append(result.Items, item)
	}
	return result, nil
}
func (f *fakeStepReads) GetSummary(_ context.Context, _ model.Principal, _, _, id string) (taskservice.StepSummary, error) {
	for _, item := range f.items {
		if item.Step.ID == id {
			item.Step.Description = ""
			return taskservice.StepSummary{Header: f.header(), Item: item}, nil
		}
	}
	return taskservice.StepSummary{}, tasksteps.NotFound(f.version, model.ErrNotFound)
}
func (f *fakeStepReads) Get(_ context.Context, _ model.Principal, _, _, id string) (taskservice.StepDocument, error) {
	for _, item := range f.items {
		if item.Step.ID == id {
			resource := taskcodec.ProjectItem(f.header(), item.Step)
			return taskservice.StepDocument{Resource: resource}, nil
		}
	}
	return taskservice.StepDocument{}, tasksteps.NotFound(f.version, model.ErrNotFound)
}
func sampleStepReads(count int, title string) *fakeStepReads {
	f := &fakeStepReads{version: 9007199254740993}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < count; i++ {
		f.items = append(f.items, store.TaskStepProjection{Step: model.TaskStep{ID: fmt.Sprintf("%08x", i), Position: int64(i), Title: title, Description: "content", Status: model.TaskStepTodo, CreatedAt: now, UpdatedAt: now}, TitleTruncated: len(title) > 512})
	}
	return f
}
func readCall(t *testing.T, client *sdk.ClientSession, name string, args map[string]any) *sdk.CallToolResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func readArgs() map[string]any {
	return map[string]any{"projectId": testProjectID, "taskId": testTargetID}
}

func TestStepReadDiscoveryAndVersionedTraversal(t *testing.T) {
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		t.Run(version, func(t *testing.T) {
			fixture := newEntryFixture(t)
			ops := sampleStepReads(3, strings.Repeat("界", 200))
			if err := RegisterStepReadTools(fixture.entry, ops); err != nil {
				t.Fatal(err)
			}
			client := fixture.client(t, version, "alice")
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			listing, err := client.ListTools(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			found := map[string]bool{}
			for _, tool := range listing.Tools {
				if strings.HasPrefix(tool.Name, "task_step_") {
					if tool.InputSchema == nil || tool.OutputSchema == nil {
						t.Fatalf("missing schemas: %+v", tool)
					}
					found[tool.Name] = true
				}
			}
			if len(found) != 2 || !found["task_step_list"] || !found["task_step_show"] {
				t.Fatalf("discovery: %+v", found)
			}
			args := readArgs()
			args["limit"] = 2
			result := readCall(t, client, "task_step_list", args)
			if result.IsError {
				t.Fatalf("first page: %+v", structured(t, result))
			}
			data := object(t, structured(t, result)["data"])
			items := data["items"].([]any)
			if data["version"] != "9007199254740993" || data["projection"] != "summary" || len(items) != 2 {
				t.Fatalf("page: %+v", data)
			}
			first := object(t, items[0])
			preview := first["titlePreview"].(string)
			if len(preview) > 512 || !utf8.ValidString(preview) || first["titleTruncated"] != true {
				t.Fatalf("preview: %+v", first)
			}
			cursor := data["nextCursor"].(string)
			args["cursor"] = cursor
			result = readCall(t, client, "task_step_list", args)
			data = object(t, structured(t, result)["data"])
			if result.IsError || len(data["items"].([]any)) != 1 || object(t, data["items"].([]any)[0])["id"] != "00000002" || data["nextCursor"] != nil {
				t.Fatalf("last page: %+v", data)
			}
			ops.version++
			result = readCall(t, client, "task_step_list", args)
			failure := object(t, structured(t, result)["error"])
			if !result.IsError || failure["code"] != "version_conflict" {
				t.Fatalf("version fence: %+v", failure)
			}
			args["view"] = "full"
			calls := ops.calls
			result = readCall(t, client, "task_step_list", args)
			failure = object(t, structured(t, result)["error"])
			if !result.IsError || failure["code"] != "invalid_input" || ops.calls != calls {
				t.Fatalf("cursor scope: %+v", failure)
			}
			show := readArgs()
			show["stepId"] = "ffffffff"
			result = readCall(t, client, "task_step_show", show)
			failure = object(t, structured(t, result)["error"])
			refs := object(t, failure["refs"])
			if !result.IsError || failure["code"] != "not_found" || refs["version"] != "9007199254740994" || refs["stepId"] != "ffffffff" {
				t.Fatalf("absence: %+v", failure)
			}
		})
	}
}

func TestStepReadAdmissionFollowsMaterialization(t *testing.T) {
	fixture := newEntryFixture(t)
	ops := sampleStepReads(1, "step")
	if err := RegisterStepReadTools(fixture.entry, ops); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2026-07-28", "alice")
	release, err := fixture.entry.budget.Acquire(context.Background(), BudgetLarge)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(release)
	for _, name := range []string{"task_step_list", "task_step_show"} {
		args := readArgs()
		if name == "task_step_show" {
			args["stepId"] = "00000000"
		}
		if r := readCall(t, client, name, args); r.IsError {
			t.Fatalf("summary blocked: %+v", structured(t, r))
		}
		args["view"] = "full"
		r := readCall(t, client, name, args)
		failure := object(t, structured(t, r)["error"])
		if !r.IsError || failure["code"] != "resource_busy" {
			t.Fatalf("full admission: %+v", failure)
		}
	}
	release()
	var releases []func()
	for range 16 {
		r, e := fixture.entry.budget.Acquire(context.Background(), BudgetControl)
		if e != nil {
			t.Fatal(e)
		}
		releases = append(releases, r)
	}
	defer func() {
		for _, r := range releases {
			r()
		}
	}()
	args := readArgs()
	r := readCall(t, client, "task_step_list", args)
	failure := object(t, structured(t, r)["error"])
	if !r.IsError || failure["code"] != "resource_busy" {
		t.Fatalf("control admission: %+v", failure)
	}
	args["view"] = "full"
	r = readCall(t, client, "task_step_list", args)
	if r.IsError {
		t.Fatalf("full blocked: %+v", structured(t, r))
	}
}

func TestStepReadCursorRejectsMalformedScope(t *testing.T) {
	expected := stepCursor{UserID: testUserID, ProjectID: testProjectID, TaskID: testTargetID, View: "summary"}
	for _, raw := range []string{"!", strings.Repeat("a", 2049), encodeStepCursor(stepCursor{Schema: 1, Kind: "task-steps", UserID: testUserID, ProjectID: testProjectID, TaskID: testTargetID, View: "summary", Version: "9223372036854775808", Position: 0})} {
		_, _, err := decodeStepCursor(raw, expected)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "invalid_input" {
			t.Fatalf("cursor error: %v", err)
		}
	}
}

func TestStepReadSnapshotFailureDoesNotClaimWriteOutcome(t *testing.T) {
	fixture := newEntryFixture(t)
	ops := &failingStepReads{fakeStepReads: sampleStepReads(1, "step")}
	if err := RegisterStepReadTools(fixture.entry, ops); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2025-11-25", "alice")
	args := readArgs()
	args["stepId"] = "00000000"
	result := readCall(t, client, "task_step_show", args)
	failure := object(t, structured(t, result)["error"])
	if !result.IsError || failure["code"] != "internal_error" {
		t.Fatalf("read failure: %+v", failure)
	}
	if _, present := failure["writeOutcome"]; present {
		t.Fatalf("read claimed a write result: %+v", failure)
	}
}

type failingStepReads struct{ *fakeStepReads }

func (*failingStepReads) GetSummary(context.Context, model.Principal, string, string, string) (taskservice.StepSummary, error) {
	return taskservice.StepSummary{}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("snapshot commit failed")}
}

func TestRegisterToolRejectsInvalidBudgetClass(t *testing.T) {
	fixture := newEntryFixture(t)
	err := fixture.entry.RegisterTool(simpleTestTool("bad_budget", testObjectSchema(), testObjectSchema()), BudgetClass(255), func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		t.Fatal("invalid registration invoked handler")
		return ToolResult{}, nil
	})
	if err == nil {
		t.Fatal("invalid budget class was accepted")
	}
}

type mcpStepMarkerKey struct{}
type mcpStepMarker struct {
	mu        sync.Mutex
	authCalls int
	principal model.Principal
}

func mcpStepRequestMarker(t *testing.T, ctx context.Context) *mcpStepMarker {
	t.Helper()
	marker, ok := ctx.Value(mcpStepMarkerKey{}).(*mcpStepMarker)
	if !ok || marker == nil {
		t.Error("MCP request context lost its marker")
		return nil
	}
	if err := ctx.Err(); err != nil {
		t.Errorf("MCP operation context is already canceled: %v", err)
	}
	return marker
}

const mcpStepsProjectID = "c3333333-3333-4333-8333-333333333333"
const mcpStepsTaskID = "d4444444-4444-4444-8444-444444444444"

type mcpStepIdentity struct {
	t          *testing.T
	principals map[string]model.Principal
}

func (i *mcpStepIdentity) Authenticate(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
	marker := mcpStepRequestMarker(i.t, ctx)
	principal, ok := i.principals[token]
	if !ok || kind != model.PATCredential || principal.Kind != model.PATCredential {
		i.t.Errorf("unexpected MCP credential kind/token")
		return model.Principal{}, errors.New("unexpected MCP credential")
	}
	if marker != nil {
		marker.mu.Lock()
		marker.authCalls++
		marker.principal = principal
		marker.mu.Unlock()
	}
	return principal, nil
}

func newMCPStepOperationServer(t *testing.T, principals map[string]model.Principal) (*httptest.Server, *mcpStepOperations) {
	t.Helper()
	ops := &mcpStepOperations{t: t, total: make(map[string]int)}
	identity := &mcpStepIdentity{t: t, principals: principals}
	server, _ := newAdapterHost(t, identity, io.Discard, func(entry *Entry, _ string) error {
		if err := RegisterStepReadTools(entry, ops); err != nil {
			return err
		}
		return RegisterStepWriteTools(entry, ops)
	}, func(handler http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			marker := &mcpStepMarker{}
			handler.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), mcpStepMarkerKey{}, marker)))
			if r.URL.Path == "/mcp" && r.Method != http.MethodOptions && r.Header.Get("Authorization") != "" {
				marker.mu.Lock()
				calls := marker.authCalls
				marker.mu.Unlock()
				if calls != 1 {
					t.Errorf("MCP HTTP request authentication calls = %d, want 1", calls)
				}
			}
		})
	})
	return server, ops
}

type mcpStepOperations struct {
	t       *testing.T
	mu      sync.Mutex
	current *mcpStepOperationPlan
	total   map[string]int
}

type mcpStepOperationPlan struct {
	owner        *mcpStepOperations
	actor        model.Principal
	order        []string
	next         int
	ctx          context.Context
	marker       *mcpStepMarker
	onListPage   func(context.Context, model.Principal, string, string, int64, int, *int64, bool) (taskservice.StepsPage, error)
	onGetSummary func(context.Context, model.Principal, string, string, string) (taskservice.StepSummary, error)
	onGet        func(context.Context, model.Principal, string, string, string) (taskservice.StepDocument, error)
	onAdd        func(context.Context, model.Principal, string, string, taskservice.AddTaskStep) (taskservice.StepsWriteResult, error)
	onUpdate     func(context.Context, model.Principal, string, string, string, taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error)
	onSetStatus  func(context.Context, model.Principal, string, string, string, taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error)
	onMove       func(context.Context, model.Principal, string, string, string, taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error)
	onDelete     func(context.Context, model.Principal, string, string, string, taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error)
}

func (o *mcpStepOperations) plan(actor model.Principal, order ...string) *mcpStepOperationPlan {
	p := &mcpStepOperationPlan{owner: o, actor: actor, order: append([]string(nil), order...)}
	o.mu.Lock()
	o.current = p
	o.mu.Unlock()
	return p
}
func (p *mcpStepOperationPlan) verify() {
	p.owner.t.Helper()
	p.owner.mu.Lock()
	defer p.owner.mu.Unlock()
	if p.next != len(p.order) {
		p.owner.t.Errorf("Step operation calls = %d, want %d (%v)", p.next, len(p.order), p.order)
	}
}
func (o *mcpStepOperations) counts() map[string]int {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := make(map[string]int, len(o.total))
	for k, v := range o.total {
		out[k] = v
	}
	return out
}
func (o *mcpStepOperations) invoke(ctx context.Context, actor model.Principal, name string) *mcpStepOperationPlan {
	marker := mcpStepRequestMarker(o.t, ctx)
	o.mu.Lock()
	defer o.mu.Unlock()
	o.total[name]++
	p := o.current
	if p == nil {
		o.t.Errorf("unconfigured Step.%s call", name)
		return nil
	}
	if p.next >= len(p.order) || p.order[p.next] != name {
		o.t.Errorf("unexpected Step.%s call at index %d, want %v", name, p.next, p.order)
		return nil
	}
	p.next++
	if actor != p.actor {
		o.t.Errorf("Step.%s actor = %+v, want %+v", name, actor, p.actor)
	}
	if marker != nil {
		marker.mu.Lock()
		calls, authenticated := marker.authCalls, marker.principal
		marker.mu.Unlock()
		if calls != 1 || authenticated != actor {
			o.t.Errorf("Step.%s authentication = %d/%+v, want 1/%+v", name, calls, authenticated, actor)
		}
	}
	if p.ctx == nil {
		p.ctx, p.marker = ctx, marker
	} else if p.ctx != ctx || p.marker != marker {
		o.t.Errorf("Step.%s did not retain the tool context and request marker", name)
	}
	return p
}
func (o *mcpStepOperations) missing(name string) error {
	o.t.Errorf("unconfigured Step.%s callback", name)
	return errors.New("unconfigured Step." + name)
}

func (o *mcpStepOperations) ListPage(ctx context.Context, actor model.Principal, project, taskID string, after int64, limit int, version *int64, summary bool) (taskservice.StepsPage, error) {
	p := o.invoke(ctx, actor, "ListPage")
	if p == nil || p.onListPage == nil {
		return taskservice.StepsPage{}, o.missing("ListPage")
	}
	return p.onListPage(ctx, actor, project, taskID, after, limit, version, summary)
}
func (o *mcpStepOperations) GetSummary(ctx context.Context, actor model.Principal, project, taskID, id string) (taskservice.StepSummary, error) {
	p := o.invoke(ctx, actor, "GetSummary")
	if p == nil || p.onGetSummary == nil {
		return taskservice.StepSummary{}, o.missing("GetSummary")
	}
	return p.onGetSummary(ctx, actor, project, taskID, id)
}
func (o *mcpStepOperations) List(ctx context.Context, actor model.Principal, project, taskID string) (taskservice.StepsDocument, error) {
	o.invoke(ctx, actor, "List")
	return taskservice.StepsDocument{}, o.missing("List")
}
func (o *mcpStepOperations) Get(ctx context.Context, actor model.Principal, project, taskID, id string) (taskservice.StepDocument, error) {
	p := o.invoke(ctx, actor, "Get")
	if p == nil || p.onGet == nil {
		return taskservice.StepDocument{}, o.missing("Get")
	}
	return p.onGet(ctx, actor, project, taskID, id)
}
func (o *mcpStepOperations) Add(ctx context.Context, actor model.Principal, project, taskID string, input taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
	p := o.invoke(ctx, actor, "Add")
	if p == nil || p.onAdd == nil {
		return taskservice.StepsWriteResult{}, o.missing("Add")
	}
	return p.onAdd(ctx, actor, project, taskID, input)
}
func (o *mcpStepOperations) Update(ctx context.Context, actor model.Principal, project, taskID, id string, input taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
	p := o.invoke(ctx, actor, "Update")
	if p == nil || p.onUpdate == nil {
		return taskservice.StepsWriteResult{}, o.missing("Update")
	}
	return p.onUpdate(ctx, actor, project, taskID, id, input)
}
func (o *mcpStepOperations) SetStatus(ctx context.Context, actor model.Principal, project, taskID, id string, input taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
	p := o.invoke(ctx, actor, "SetStatus")
	if p == nil || p.onSetStatus == nil {
		return taskservice.StepsWriteResult{}, o.missing("SetStatus")
	}
	return p.onSetStatus(ctx, actor, project, taskID, id, input)
}
func (o *mcpStepOperations) Move(ctx context.Context, actor model.Principal, project, taskID, id string, input taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
	p := o.invoke(ctx, actor, "Move")
	if p == nil || p.onMove == nil {
		return taskservice.StepsWriteResult{}, o.missing("Move")
	}
	return p.onMove(ctx, actor, project, taskID, id, input)
}
func (o *mcpStepOperations) Delete(ctx context.Context, actor model.Principal, project, taskID, id string, input taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error) {
	p := o.invoke(ctx, actor, "Delete")
	if p == nil || p.onDelete == nil {
		return taskservice.StepsWriteResult{}, o.missing("Delete")
	}
	return p.onDelete(ctx, actor, project, taskID, id, input)
}
