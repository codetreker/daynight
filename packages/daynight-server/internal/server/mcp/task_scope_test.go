package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type scopedTaskStore struct {
	store.ProjectWriter
	snapshot scopedTaskSnapshot
}

func (s scopedTaskStore) ReadSnapshot(_ context.Context, next func(store.SnapshotScope) error) error {
	return next(s.snapshot)
}

type scopedTaskSnapshot struct {
	store.SnapshotScope
	projects scopedTaskProjects
	tasks    scopedTaskGraphDAO
}

func (s scopedTaskSnapshot) ProjectDAO() store.ProjectReader           { return s.projects }
func (s scopedTaskSnapshot) TaskDAO() store.TaskReader                 { return s.tasks }
func (s scopedTaskSnapshot) CredentialDAO() store.CredentialReader     { return scopedTaskCredential{} }
func (s scopedTaskSnapshot) GoalRelationDAO() store.GoalRelationReader { return scopedTaskGoals{} }
func (s scopedTaskSnapshot) ObservedAt(context.Context) (time.Time, error) {
	return time.Date(2026, 11, 20, 1, 2, 3, 0, time.UTC), nil
}

type scopedTaskCredential struct{}

type scopedTaskGoals struct{}

func (scopedTaskGoals) Source(context.Context, string, string, string) (store.GoalRelationSource, error) {
	return store.GoalRelationSource{Type: model.TaskTypeGoal, Status: model.TaskTodo, CanRead: true}, nil
}
func (scopedTaskGoals) Prerequisites(context.Context, string, string, string) ([]store.GoalRelationEdge, error) {
	return []store.GoalRelationEdge{}, nil
}
func (scopedTaskGoals) Successors(context.Context, string, string, string, string, int) ([]store.GoalRelationTarget, error) {
	return []store.GoalRelationTarget{}, nil
}

func (scopedTaskCredential) Credential(context.Context, model.Principal) (store.ThreadCredential, error) {
	return store.ThreadCredential{}, nil
}

type scopedTaskProjects struct {
	store.ProjectReader
	t    *testing.T
	full bool
}

func (s scopedTaskProjects) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	return model.ProjectAccess{ProjectID: testProjectID, Role: model.ProjectAdmin}, nil
}
func (s scopedTaskProjects) Project(context.Context, string) (model.Project, error) {
	if !s.full {
		s.t.Fatal("MCP task-only query read Project settings")
	}
	return model.Project{ID: testProjectID, Name: "Private Project", RepoURL: "https://github.com/private/repository"}, nil
}

type scopedTaskGraphDAO struct{ store.TaskReader }

func (scopedTaskGraphDAO) Task(context.Context, string, string) (model.Task, error) {
	return model.Task{ID: testTargetID, ProjectID: testProjectID, Type: model.TaskTypeTask, Properties: model.TaskProperties{"worker": json.RawMessage(`{"nativeSessionId":"private-session"}`), "blocked": json.RawMessage(`false`)}}, nil
}

func (scopedTaskGraphDAO) TaskCacheEpoch(context.Context, string) (string, error) {
	return testProjectID, nil
}

func (scopedTaskGraphDAO) TaskPresence(context.Context, string, string) (store.TaskPresence, error) {
	return store.TaskPresence{Found: true}, nil
}
func (scopedTaskGraphDAO) TaskGraphTasks(context.Context, string, string, store.TaskGraphSelection, int) ([]model.GraphTask, error) {
	return []model.GraphTask{{ID: testTargetID, Type: model.TaskTypeTask, Status: model.TaskInProgress}}, nil
}

func TestScopedTaskGraphToolsMaskProjectInBothModes(t *testing.T) {
	for _, full := range []bool{false, true} {
		for _, depends := range []bool{false, true} {
			f := newEntryFixture(t)
			a := scopedTestAuthorization(t, "task:read")
			if full {
				a = scopedTestAuthorization(t, "task:read", "project:read")
			}
			if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"task": a}}); err != nil {
				t.Fatal(err)
			}
			db := scopedTaskStore{snapshot: scopedTaskSnapshot{projects: scopedTaskProjects{t: t, full: full}}}
			if err := RegisterScopedTaskReadTools(f.entry, taskservice.NewTasks(db), taskservice.NewObservations(db, nil)); err != nil {
				t.Fatal(err)
			}
			result, body := callTaskResource(t, f.client(t, "2026-07-28", "task"), "task_graph", map[string]any{"projectId": testProjectID, "taskId": testTargetID, "dependsOnly": depends})
			if result.IsError {
				t.Fatalf("graph: %#v", body)
			}
			data := object(t, body["data"])
			project := object(t, data["project"])
			if project["id"] != testProjectID || !full && len(project) != 1 || full && project["name"] != "Private Project" {
				t.Fatalf("project full=%v depends=%v: %#v", full, depends, project)
			}
			if !depends {
				node := object(t, data["tasks"].([]any)[0])
				session := object(t, node["session"])
				if session["reason"] != "insufficient_scope" || session["sessionId"] != nil || session["observedAt"] != nil || data["partial"] != true {
					t.Fatalf("session projection %#v", data)
				}
			}
		}
	}
}

func TestScopedTaskToolsRetainDiscoveryAndRequireSchemaScope(t *testing.T) {
	f := newEntryFixture(t)
	a := scopedTestAuthorization(t, "project:read")
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"project": a}}); err != nil {
		t.Fatal(err)
	}
	if err := RegisterScopedTaskReadTools(f.entry, &taskservice.Tasks{}, &taskservice.Observations{}); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "project")
	listing, err := client.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"task_list": true, "task_ready": true, "task_graph": true, "task_work_list": true, "task_show": true, "task_properties": true, "goal_dependencies_show": true}
	schemas := make(map[string]string)
	for _, raw := range [][]byte{taskQueryToolDefinitions, taskToolDefinitions, goalDependencyTools} {
		var definitions []sdk.Tool
		if err := json.Unmarshal(raw, &definitions); err != nil {
			t.Fatal(err)
		}
		for _, tool := range definitions {
			encoded, err := json.Marshal(tool.InputSchema)
			if err != nil {
				t.Fatal(err)
			}
			schemas[tool.Name] = string(encoded)
		}
	}
	var workDefinition sdk.Tool
	if err := json.Unmarshal(taskWorkToolDefinition, &workDefinition); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(workDefinition.InputSchema)
	if err != nil {
		t.Fatal(err)
	}
	schemas[workDefinition.Name] = string(encoded)
	if len(listing.Tools) != len(want)+1 {
		t.Fatalf("tools %#v", listing.Tools)
	}
	for _, tool := range listing.Tools {
		if tool.Name == "test_only" {
			continue
		}
		if !want[tool.Name] || !f.entry.scopedTools[tool.Name] {
			t.Fatalf("unexpected or unprotected tool %s", tool.Name)
		}
		encoded, err := json.Marshal(tool.InputSchema)
		if err != nil || string(encoded) != schemas[tool.Name] {
			t.Fatalf("schema changed for %s: %s %v", tool.Name, encoded, err)
		}
	}
	result, body := callTaskResource(t, client, "task_properties", map[string]any{"mode": "schema"})
	if !result.IsError || object(t, body["error"])["code"] != "insufficient_scope" {
		t.Fatalf("schema denial %#v", body)
	}
}

func TestScopedTaskSearchUsesAuthenticatedPolicy(t *testing.T) {
	f := newEntryFixture(t)
	a := scopedTestAuthorization(t, "task:read")
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"task": a}}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	if err := RegisterScopedTaskSearchTool(f.entry, func(ctx context.Context, got model.CredentialAuthorization, project string, input tasksearch.Request) (tasksearch.Page, error) {
		calls++
		if got.Principal != a.Principal || got.Policy.Version() != a.Policy.Version() || project != testProjectID || input.Query != "visible" || input.Cursor == nil || *input.Cursor != "opaque" || ctx.Err() != nil {
			t.Fatalf("search policy/input %#v %#v", got, input)
		}
		return tasksearch.Page{ProjectID: project, Items: []tasksearch.Item{}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	result, body := callTaskResource(t, f.client(t, "2026-07-28", "task"), "task_search", map[string]any{"projectId": testProjectID, "query": "visible", "cursor": "opaque"})
	if result.IsError || calls != 1 {
		t.Fatalf("search %#v calls=%d", body, calls)
	}
}

func TestScopedTaskReadsRejectMissingPolicyBeforeServices(t *testing.T) {
	s := scopedTaskReads{}
	p := scopedTestAuthorization(t, "task:read").Principal
	ctx := context.Background()
	checks := []func() error{
		func() error { _, err := s.Get(ctx, p, testProjectID, testTargetID); return err },
		func() error { _, err := s.ObserveGet(ctx, p, testProjectID, testTargetID); return err },
		func() error { _, err := s.Graph(ctx, p, testProjectID, testTargetID); return err },
		func() error { _, err := s.ObserveGraph(ctx, p, testProjectID, testTargetID); return err },
		func() error {
			_, err := s.ShowGoalDependencies(ctx, p, testProjectID, testTargetID, model.PageRequest{})
			return err
		},
		func() error {
			_, err := s.ObservedMCPList(ctx, p, testProjectID, taskcore.MCPListRequest{})
			return err
		},
		func() error { _, err := s.MCPReady(ctx, p, testProjectID, taskcore.MCPReadyRequest{}); return err },
		func() error { _, err := s.WorkList(ctx, p, testProjectID, taskcore.WorkRequest{}); return err },
	}
	for _, check := range checks {
		if err := check(); err == nil || !strings.Contains(err.Error(), "authorization") {
			t.Fatalf("missing policy %v", err)
		}
	}
}

func TestScopedTaskReadAdaptersPreserveServiceScopeRefusals(t *testing.T) {
	a := scopedTestAuthorization(t, "project:read")
	ctx := context.WithValue(t.Context(), scopedAuthorizationKey{}, a)
	db := scopedTaskStore{snapshot: scopedTaskSnapshot{projects: scopedTaskProjects{t: t}}}
	s := scopedTaskReads{Tasks: taskservice.NewTasks(db), observations: taskservice.NewObservations(db, nil)}
	for name, read := range map[string]func() error{
		"get":  func() error { _, err := s.Get(ctx, a.Principal, testProjectID, testTargetID); return err },
		"show": func() error { _, err := s.ObserveGet(ctx, a.Principal, testProjectID, testTargetID); return err },
		"goal dependencies": func() error {
			_, err := s.ShowGoalDependencies(ctx, a.Principal, testProjectID, testTargetID, model.PageRequest{})
			return err
		},
		"list": func() error {
			_, err := s.ObservedMCPList(ctx, a.Principal, testProjectID, taskcore.MCPListRequest{Limit: 1, View: "summary"})
			return err
		},
		"ready": func() error {
			_, err := s.MCPReady(ctx, a.Principal, testProjectID, taskcore.MCPReadyRequest{Limit: 1, View: "summary"})
			return err
		},
		"work": func() error {
			_, err := s.WorkList(ctx, a.Principal, testProjectID, taskcore.WorkRequest{})
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := read(); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
				t.Fatalf("service refusal was lost: %v", err)
			}
		})
	}
}

func TestScopedTaskResourceAdaptersUseRequestPolicy(t *testing.T) {
	a := scopedTestAuthorization(t, "task:read")
	ctx := context.WithValue(t.Context(), scopedAuthorizationKey{}, a)
	db := scopedTaskStore{snapshot: scopedTaskSnapshot{projects: scopedTaskProjects{t: t}}}
	s := scopedTaskReads{Tasks: taskservice.NewTasks(db), observations: taskservice.NewObservations(db, nil)}
	value, err := s.Get(ctx, a.Principal, testProjectID, testTargetID)
	if err != nil || value.ID != testTargetID || len(value.Properties) != 1 || string(value.Properties["blocked"]) != "false" {
		t.Fatalf("Task resource policy projection: %#v %v", value, err)
	}
	observed, err := s.ObserveGet(ctx, a.Principal, testProjectID, testTargetID)
	if err != nil || observed.Task.ID != testTargetID || len(observed.Task.Properties) != 1 || observed.Session.Reason != "insufficient_scope" || observed.Session.SessionID != nil {
		t.Fatalf("Task observation policy projection: %#v %v", observed, err)
	}
	goal, err := s.ShowGoalDependencies(ctx, a.Principal, testProjectID, testTargetID, model.PageRequest{Limit: 1})
	if err != nil || goal.GoalID != testTargetID || len(goal.Prerequisites) != 0 || len(goal.Successors) != 0 {
		t.Fatalf("Goal relationship result: %#v %v", goal, err)
	}
	other := a.Principal
	other.UserID = testTargetID
	if _, err := (scopedTaskReads{}).Get(ctx, other, testProjectID, testTargetID); err == nil {
		t.Fatal("mismatched request identity reached the service")
	}
}

func TestScopedTaskRegistrationRejectsMissingDependenciesAndDuplicates(t *testing.T) {
	if err := RegisterScopedTaskReadTools(nil, &taskservice.Tasks{}, &taskservice.Observations{}); err == nil {
		t.Fatal("missing entry accepted")
	}
	if err := RegisterScopedTaskSearchTool(nil, func(context.Context, model.CredentialAuthorization, string, tasksearch.Request) (tasksearch.Page, error) {
		return tasksearch.Page{}, nil
	}); err == nil {
		t.Fatal("missing search entry accepted")
	}
	for _, duplicate := range []string{"task_list", "task_work_list", "task_show", "goal_dependencies_show", "task_search"} {
		t.Run(duplicate, func(t *testing.T) {
			f := newEntryFixture(t)
			if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{}); err != nil {
				t.Fatal(err)
			}
			if err := f.entry.RegisterTool(&sdk.Tool{Name: duplicate, InputSchema: map[string]any{"type": "object"}}, BudgetControl, func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
				t.Fatal("duplicate handler executed")
				return ToolResult{}, nil
			}); err != nil {
				t.Fatal(err)
			}
			var err error
			if duplicate == "task_search" {
				err = RegisterScopedTaskSearchTool(f.entry, func(context.Context, model.CredentialAuthorization, string, tasksearch.Request) (tasksearch.Page, error) {
					t.Fatal("duplicate search executed")
					return tasksearch.Page{}, nil
				})
			} else {
				err = RegisterScopedTaskReadTools(f.entry, &taskservice.Tasks{}, &taskservice.Observations{})
			}
			if err == nil || !strings.Contains(err.Error(), duplicate) {
				t.Fatalf("duplicate %s accepted: %v", duplicate, err)
			}
		})
	}
}

func TestScopedTaskReadAndWriteToolsComposeInEitherOrder(t *testing.T) {
	for _, writeFirst := range []bool{false, true} {
		name := "read first"
		if writeFirst {
			name = "write first"
		}
		t.Run(name, func(t *testing.T) {
			f := newEntryFixture(t)
			a := scopedTestAuthorization(t, "task:read", "task:write", "task:dependencies")
			if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"task": a}}); err != nil {
				t.Fatal(err)
			}
			db := scopedTaskStore{snapshot: scopedTaskSnapshot{projects: scopedTaskProjects{t: t}}}
			tasks, observations := taskservice.NewTasks(db), taskservice.NewObservations(db, nil)
			registerRead := func() error { return RegisterScopedTaskReadTools(f.entry, tasks, observations) }
			registerWrite := func() error {
				if err := RegisterScopedTaskWriteTools(f.entry, tasks, observations); err != nil {
					return err
				}
				return RegisterScopedGoalDependencyWriteTools(f.entry, tasks)
			}
			registrations := []func() error{registerRead, registerWrite}
			if writeFirst {
				registrations[0], registrations[1] = registrations[1], registrations[0]
			}
			for _, register := range registrations {
				if err := register(); err != nil {
					t.Fatal(err)
				}
			}
			client := f.client(t, "2026-07-28", "task")
			listing, err := client.ListTools(t.Context(), nil)
			if err != nil {
				t.Fatal(err)
			}
			want := map[string]bool{}
			for _, tool := range []string{"task_list", "task_ready", "task_graph", "task_work_list", "task_show", "task_properties", "goal_dependencies_show", "task_create", "task_update", "task_set_status", "task_delete", "task_set_property", "task_remove_property", "goal_dependencies_edit"} {
				want[tool] = true
			}
			for _, tool := range listing.Tools {
				if tool.Name == "test_only" {
					continue
				}
				if !want[tool.Name] || !f.entry.scopedTools[tool.Name] {
					t.Fatalf("unexpected or unclassified tool %s", tool.Name)
				}
				delete(want, tool.Name)
			}
			if len(want) != 0 {
				t.Fatalf("missing tools: %v", want)
			}
			for _, call := range []struct {
				name string
				args map[string]any
			}{
				{"task_show", map[string]any{"projectId": testProjectID, "taskId": testTargetID}},
				{"task_properties", map[string]any{"projectId": testProjectID, "taskId": testTargetID, "mode": "values"}},
				{"goal_dependencies_show", map[string]any{"projectId": testProjectID, "goalId": testTargetID, "limit": 1}},
			} {
				result, body := callTaskResource(t, client, call.name, call.args)
				if result.IsError {
					t.Fatalf("%s: %#v", call.name, body)
				}
			}
			scopedToolCall(t, client, "task_delete", map[string]any{"projectId": testProjectID, "taskId": testTargetID, "ifVersion": "9223372036854775808"}, "invalid_input", "")
			scopedToolCall(t, client, "goal_dependencies_edit", map[string]any{"projectId": testProjectID, "goalId": testTargetID, "ifRevision": "9223372036854775808", "mode": "replace", "prerequisites": []string{}}, "invalid_input", "")
		})
	}
}
