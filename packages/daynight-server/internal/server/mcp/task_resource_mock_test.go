package mcp

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type taskResourceAuthenticator struct{ principal model.Principal }

func (a taskResourceAuthenticator) Authenticate(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
	if kind != model.PATCredential || token != "alice" {
		return model.Principal{}, &model.Fault{Code: "unauthenticated", Message: "invalid credential"}
	}
	return a.principal, nil
}

type taskResourceContextKey struct{}

type taskResourceMock struct {
	t                  *testing.T
	principal          model.Principal
	project            string
	mu                 sync.Mutex
	calls              map[string]int
	wantCalls          map[string]int
	CreateFunc         func(context.Context, model.Principal, string, taskcore.CreateTask) (model.Task, error)
	GetFunc            func(context.Context, model.Principal, string, string) (model.Task, error)
	UpdateFunc         func(context.Context, model.Principal, string, string, taskcore.UpdateTask, *[]string, *[]string) (model.Task, error)
	ReplaceTagsFunc    func(context.Context, model.Principal, string, string, int64, *[]string) (model.Task, error)
	SetStatusFunc      func(context.Context, model.Principal, string, string, taskcore.SetTaskStatus) (model.Task, error)
	DeleteFunc         func(context.Context, model.Principal, string, string, taskcore.DeleteTask) error
	SetPropertyFunc    func(context.Context, model.Principal, string, string, string, string, int64) (model.Task, error)
	RemovePropertyFunc func(context.Context, model.Principal, string, string, string, int64) (model.Task, error)
}

func (m *taskResourceMock) expectCalls(want map[string]int) { m.wantCalls = want }

func (m *taskResourceMock) called(name string, ctx context.Context, principal model.Principal, project string, configured bool) error {
	m.mu.Lock()
	m.calls[name]++
	unexpected := m.calls[name] > m.wantCalls[name]
	m.mu.Unlock()
	if unexpected {
		m.t.Errorf("unexpected additional Task operation %s", name)
		return errors.New("unexpected additional Task operation " + name)
	}
	if ctx == nil || ctx.Err() != nil || ctx.Value(taskResourceContextKey{}) != m || principal != m.principal || project != m.project {
		m.t.Errorf("%s changed the active context, principal or project: principal=%+v project=%s", name, principal, project)
		return errors.New("incorrect Task operation context or identity")
	}
	if !configured {
		m.t.Errorf("unexpected Task operation %s", name)
		return errors.New("unexpected Task operation " + name)
	}
	return nil
}

func (m *taskResourceMock) Create(ctx context.Context, p model.Principal, project string, in taskcore.CreateTask) (model.Task, error) {
	if err := m.called("Create", ctx, p, project, m.CreateFunc != nil); err != nil {
		return model.Task{}, err
	}
	return m.CreateFunc(ctx, p, project, in)
}
func (m *taskResourceMock) Get(ctx context.Context, p model.Principal, project, id string) (model.Task, error) {
	if err := m.called("Get", ctx, p, project, m.GetFunc != nil); err != nil {
		return model.Task{}, err
	}
	return m.GetFunc(ctx, p, project, id)
}
func (m *taskResourceMock) UpdatePartitionedDependencies(ctx context.Context, p model.Principal, project, id string, in taskcore.UpdateTask, ordinary, external *[]string) (model.Task, error) {
	if err := m.called("Update", ctx, p, project, m.UpdateFunc != nil); err != nil {
		return model.Task{}, err
	}
	return m.UpdateFunc(ctx, p, project, id, in, ordinary, external)
}
func (m *taskResourceMock) ReplaceTags(ctx context.Context, p model.Principal, project, id string, version int64, tags *[]string) (model.Task, error) {
	if err := m.called("ReplaceTags", ctx, p, project, m.ReplaceTagsFunc != nil); err != nil {
		return model.Task{}, err
	}
	return m.ReplaceTagsFunc(ctx, p, project, id, version, tags)
}
func (m *taskResourceMock) SetStatus(ctx context.Context, p model.Principal, project, id string, in taskcore.SetTaskStatus) (model.Task, error) {
	if err := m.called("SetStatus", ctx, p, project, m.SetStatusFunc != nil); err != nil {
		return model.Task{}, err
	}
	return m.SetStatusFunc(ctx, p, project, id, in)
}
func (m *taskResourceMock) Delete(ctx context.Context, p model.Principal, project, id string, in taskcore.DeleteTask) error {
	if err := m.called("Delete", ctx, p, project, m.DeleteFunc != nil); err != nil {
		return err
	}
	return m.DeleteFunc(ctx, p, project, id, in)
}
func (m *taskResourceMock) SetProperty(ctx context.Context, p model.Principal, project, id, name, value string, version int64) (model.Task, error) {
	if err := m.called("SetProperty", ctx, p, project, m.SetPropertyFunc != nil); err != nil {
		return model.Task{}, err
	}
	return m.SetPropertyFunc(ctx, p, project, id, name, value, version)
}
func (m *taskResourceMock) RemoveProperty(ctx context.Context, p model.Principal, project, id, name string, version int64) (model.Task, error) {
	if err := m.called("RemoveProperty", ctx, p, project, m.RemovePropertyFunc != nil); err != nil {
		return model.Task{}, err
	}
	return m.RemovePropertyFunc(ctx, p, project, id, name, version)
}

type taskResourceFixture struct {
	client     *sdk.ClientSession
	entry      *Entry
	server     *httptest.Server
	operations *taskResourceMock
	principal  model.Principal
	project    string
}

func newTaskResourceFixture(t *testing.T) *taskResourceFixture {
	t.Helper()
	f := &taskResourceFixture{project: testProjectID, principal: model.Principal{Kind: model.PATCredential, UserID: testUserID, CredentialID: "task-credential"}}
	f.operations = &taskResourceMock{t: t, principal: f.principal, project: f.project, calls: map[string]int{}, wantCalls: map[string]int{}}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	entry, err := New(taskResourceAuthenticator{f.principal}, "https://daynight.test", nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.entry = entry
	if err := RegisterTaskTools(entry, f.operations, f.operations); err != nil {
		t.Fatal(err)
	}
	f.server = httptest.NewServer(httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		entry.ServeHTTP(w, request.WithContext(context.WithValue(request.Context(), taskResourceContextKey{}, f.operations)))
	})))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := entry.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
		f.server.Close()
		f.operations.mu.Lock()
		defer f.operations.mu.Unlock()
		if !reflect.DeepEqual(f.operations.calls, f.operations.wantCalls) {
			t.Errorf("Task operation calls: got %v want %v", f.operations.calls, f.operations.wantCalls)
		}
	})
	f.client = (&entryFixture{entry: entry, server: f.server}).client(t, "2026-07-28", "alice")
	return f
}

func taskFixtureTask() model.Task {
	stamp := time.Date(2026, 11, 1, 2, 3, 4, 567000000, time.UTC)
	assigned := testUserID
	return model.Task{ID: testTargetID, ProjectID: testProjectID, Type: model.TaskTypeTask, Title: "Test task", Properties: model.TaskProperties{}, Status: model.TaskTodo, Version: 1, CreatedAt: stamp, UpdatedAt: stamp, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, AssignedTo: &assigned, Ready: true}
}

type taskResourceQueryMock struct {
	base      *taskResourceMock
	GraphFunc func(context.Context, model.Principal, string, string) (model.TaskGraph, error)
	ListFunc  func(context.Context, model.Principal, string, taskcore.MCPListRequest, func(store.TaskPriorityItem, string, bool) bool) error
}

func (m *taskResourceQueryMock) Graph(ctx context.Context, principal model.Principal, project, task string) (model.TaskGraph, error) {
	if err := m.base.called("Graph", ctx, principal, project, m.GraphFunc != nil); err != nil {
		return model.TaskGraph{}, err
	}
	return m.GraphFunc(ctx, principal, project, task)
}
func (m *taskResourceQueryMock) MCPList(ctx context.Context, principal model.Principal, project string, input taskcore.MCPListRequest, visit func(store.TaskPriorityItem, string, bool) bool) error {
	if err := m.base.called("MCPList", ctx, principal, project, m.ListFunc != nil); err != nil {
		return err
	}
	return m.ListFunc(ctx, principal, project, input, visit)
}
func (m *taskResourceQueryMock) MCPReady(ctx context.Context, principal model.Principal, project string, input taskcore.MCPReadyRequest) ([]store.TaskPriorityItem, error) {
	return nil, m.base.called("MCPReady", ctx, principal, project, false)
}

func (m *taskResourceMock) ObserveGet(ctx context.Context, p model.Principal, project, id string) (taskservice.ObservedTask, error) {
	task, err := m.Get(ctx, p, project, id)
	return taskservice.ObservedTask{Task: task, Session: observationFixture()}, err
}
func (m *taskResourceQueryMock) ObserveGraph(ctx context.Context, p model.Principal, project, id string) (taskservice.ObservedGraph, error) {
	graph, err := m.Graph(ctx, p, project, id)
	return observedGraphFixture(graph), err
}
func (m *taskResourceQueryMock) ObservedMCPList(ctx context.Context, p model.Principal, project string, input taskcore.MCPListRequest) (taskservice.ObservedMCPPage, error) {
	page := taskservice.ObservedMCPPage{Items: []taskservice.ObservedMCPItem{}, ObservedAt: time.Now().UTC()}
	err := m.MCPList(ctx, p, project, input, func(item store.TaskPriorityItem, cursor string, more bool) bool {
		page.Items = append(page.Items, taskservice.ObservedMCPItem{Item: item, Session: observationFixture()})
		if more {
			page.NextCursor = &cursor
		} else {
			page.NextCursor = nil
		}
		return true
	})
	return page, err
}
