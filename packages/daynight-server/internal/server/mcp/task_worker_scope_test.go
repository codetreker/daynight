package mcp

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

// The MCP protocol and Task service run against controlled project and task
// facts; storage mechanics remain owned by the DAO tests.
type workerScopeStore struct {
	current model.Task
	writes  int
}
type workerScopeWrite struct {
	store.ProjectWriteScope
	state *workerScopeStore
}
type workerScopeTaskDAO struct {
	store.TaskWriteDAO
	state *workerScopeStore
}
type workerScopeProjectDAO struct{ store.ProjectWriteDAO }
type workerScopeSessionDAO struct{ store.ProjectSessionDAO }
type workerScopeSnapshot struct {
	store.SnapshotScope
	state *workerScopeStore
}
type workerScopeProjectReader struct{ store.ProjectReader }
type workerScopeTaskReader struct {
	store.TaskReader
	state *workerScopeStore
}

func (s *workerScopeStore) WriteProject(_ context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	if id != s.current.ProjectID {
		panic("unexpected project")
	}
	err := work(workerScopeWrite{state: s})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (s *workerScopeStore) ReadSnapshot(_ context.Context, read func(store.SnapshotScope) error) error {
	return read(workerScopeSnapshot{state: s})
}
func (s workerScopeWrite) ProjectDAO() store.ProjectWriteDAO   { return workerScopeProjectDAO{} }
func (s workerScopeWrite) TaskDAO() store.TaskWriteDAO         { return workerScopeTaskDAO{state: s.state} }
func (s workerScopeWrite) SessionDAO() store.ProjectSessionDAO { return workerScopeSessionDAO{} }
func (workerScopeProjectDAO) ProjectAccess(_ context.Context, p model.Principal) (model.ProjectAccess, error) {
	return model.ProjectAccess{ProjectID: testProjectID, UserID: p.UserID, Role: model.ProjectAdmin}, nil
}
func (s workerScopeTaskDAO) TaskHeader(_ context.Context, id string) (model.TaskHeader, error) {
	return model.TaskHeader{ID: id, ProjectID: s.state.current.ProjectID, Type: model.TaskTypeTask}, nil
}
func (s workerScopeTaskDAO) Task(_ context.Context, id string) (model.Task, error) {
	if id != s.state.current.ID {
		panic("unexpected task")
	}
	return s.state.current, nil
}
func (workerScopeTaskDAO) TasksByID(_ context.Context, ids []string) ([]model.Task, error) {
	if len(ids) != 0 {
		panic("unexpected dependencies")
	}
	return []model.Task{}, nil
}
func (s workerScopeTaskDAO) UpdateTask(_ context.Context, id string, values store.TaskWrite) (model.Task, error) {
	if id != s.state.current.ID {
		panic("unexpected write")
	}
	s.state.writes++
	s.state.current.AllowAgents = values.AllowAgents
	s.state.current.Version++
	return s.state.current, nil
}
func (workerScopeSessionDAO) DrainTaskSessions(context.Context, string, store.TaskSessionDrain) error {
	return nil
}
func (workerScopeSessionDAO) TransitionTaskSessionReceipts(context.Context, string, store.TaskSessionReceiptTransition) error {
	return nil
}
func (s workerScopeSnapshot) ProjectDAO() store.ProjectReader { return workerScopeProjectReader{} }
func (s workerScopeSnapshot) TaskDAO() store.TaskReader       { return workerScopeTaskReader{state: s.state} }
func (workerScopeProjectReader) ProjectAccess(_ context.Context, p model.Principal, project string) (model.ProjectAccess, error) {
	return model.ProjectAccess{ProjectID: project, UserID: p.UserID, Role: model.ProjectAdmin}, nil
}
func (s workerScopeTaskReader) TaskHeader(_ context.Context, project, id string) (model.TaskHeader, error) {
	return model.TaskHeader{ID: id, ProjectID: project, Type: s.state.current.Type}, nil
}

func TestMCPDefaultScopeAllowsAgentPermissionButNotClaimCompletion(t *testing.T) {
	entries, err := scopepolicy.Catalog(scopepolicy.MCP)
	if err != nil {
		t.Fatal(err)
	}
	available := make([]scopepolicy.ScopeID, 0, len(entries))
	for _, entry := range entries {
		available = append(available, entry.ID)
	}
	defaults, err := scopepolicy.Defaults(scopepolicy.MCP, available)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.MCP, defaults, 1)
	if err != nil {
		t.Fatal(err)
	}
	principal := model.Principal{Kind: model.OAuthCredential, UserID: testUserID, CredentialID: testTargetID}
	auth := model.CredentialAuthorization{Principal: principal, Profile: model.ScopedMCPProfile, Policy: &policy}
	state := &workerScopeStore{current: taskFixtureTask()}
	tasks := taskservice.NewTasks(state)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	entry, err := New(testAuthenticator{}, "https://daynight.test", nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	token := model.OAuthAccessPrefix + "default"
	if err := entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{token: auth}}); err != nil {
		t.Fatal(err)
	}
	if err := RegisterScopedTaskWriteTools(entry, tasks, nil); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(entry)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := entry.Shutdown(ctx); err != nil {
			t.Error(err)
		}
		server.Close()
	})
	client := (&entryFixture{entry: entry, server: server}).client(t, "2026-07-28", token)
	args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "ifVersion": "1", "allowAgents": true, "returnView": "receipt"}
	result, env := callTaskResource(t, client, "task_update", args)
	if result.IsError || !state.current.AllowAgents || state.current.Version != 2 || state.writes != 1 {
		t.Fatalf("allowAgents: result=%v env=%v state=%+v writes=%d", result.IsError, env, state.current, state.writes)
	}

	claim := "abcdefab-1111-4111-8111-111111111111"
	worker := &model.WorkerClaim{ClaimID: claim, State: model.WorkerActive, UserID: testUserID, WorkerID: "abcdefab-2222-4222-8222-222222222222", Machine: model.WorkerMachine{ID: "abcdefab-3333-4333-8333-333333333333", Name: "worker"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: "abcdefab-4444-4444-8444-444444444444", Phase: model.WorkerExecuting, ClaimedAt: state.current.CreatedAt}
	raw, err := taskproperty.EncodeWorker(worker)
	if err != nil {
		t.Fatal(err)
	}
	state.current.Status, state.current.Properties, state.current.Version = model.TaskInProgress, model.TaskProperties{"worker": raw}, 3
	before, err := json.Marshal(state.current)
	if err != nil {
		t.Fatal(err)
	}
	scopedToolCall(t, client, "task_set_status", map[string]any{"projectId": testProjectID, "taskId": testTargetID, "ifVersion": "3", "status": "done", "claimId": claim, "returnView": "receipt"}, "insufficient_scope", "not_committed")
	after, err := json.Marshal(state.current)
	if err != nil {
		t.Fatal(err)
	}
	if state.writes != 1 || string(before) != string(after) {
		t.Fatalf("claim completion changed task: before=%s after=%s writes=%d", before, after, state.writes)
	}
}
