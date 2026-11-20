package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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

func (s scopedTaskSnapshot) ProjectDAO() store.ProjectReader       { return s.projects }
func (s scopedTaskSnapshot) TaskDAO() store.TaskReader             { return s.tasks }
func (s scopedTaskSnapshot) CredentialDAO() store.CredentialReader { return scopedTaskCredential{} }
func (s scopedTaskSnapshot) ObservedAt(context.Context) (time.Time, error) {
	return time.Date(2026, 11, 20, 1, 2, 3, 0, time.UTC), nil
}

type scopedTaskCredential struct{}

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
	}
	for _, check := range checks {
		if err := check(); err == nil || !strings.Contains(err.Error(), "authorization") {
			t.Fatalf("missing policy %v", err)
		}
	}
}
