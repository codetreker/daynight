package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestMCPTaskReceiptWireAndSchema(t *testing.T) {
	f := newTaskResourceFixture(t)
	task := taskFixtureTask()
	task.Description = "previous secret description"
	task.Title = "previous secret title"
	task.Version = 9223372036854775807
	title := "new title"
	expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 1, Title: &title}, nil, nil, task, nil)
	result, env := callTaskResource(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": task.ID, "ifVersion": "1", "title": title, "returnView": "receipt"})
	if result.IsError {
		t.Fatalf("receipt failed: %#v", env)
	}
	want := map[string]any{"projectId": f.project, "taskId": task.ID, "version": "9223372036854775807"}
	if got := object(t, env["data"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("receipt data = %#v, want %#v", got, want)
	}
	meta := object(t, env["meta"])
	if meta["outcome"] != "changed" || meta["writeOutcome"] != "confirmed" || !reflect.DeepEqual(object(t, meta["refs"]), want) {
		t.Fatalf("receipt metadata = %#v", meta)
	}
}

func TestMCPTaskOmittedVersionRequiresRead(t *testing.T) {
	for _, tc := range []struct {
		name   string
		scopes []scopepolicy.ScopeID
		allow  bool
	}{
		{"write only", []scopepolicy.ScopeID{"task:write"}, false},
		{"read and write", []scopepolicy.ScopeID{"task:read", "task:write"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := model.Principal{Kind: model.PATCredential, UserID: testUserID, CredentialID: testTargetID}
			auth := scopedPAT(t, p, tc.scopes...)
			m := &taskResourceMock{t: t, principal: p, project: testProjectID, calls: map[string]int{}, wantCalls: map[string]int{}}
			ctx := context.WithValue(t.Context(), taskResourceContextKey{}, m)
			if tc.allow {
				m.wantCalls["Get"] = 1
				m.GetFunc = func(context.Context, model.Principal, string, string) (model.Task, error) {
					return taskFixtureTask(), nil
				}
			}
			version, err := taskVersion(ctx, RequestActor{Principal: p, Authorization: &auth}, m, taskArguments{ProjectID: testProjectID, TaskID: testTargetID})
			if tc.allow {
				if err != nil || version != 1 {
					t.Fatalf("version=%d err=%v", version, err)
				}
			} else {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "insufficient_scope" {
					t.Fatalf("version=%d err=%v", version, err)
				}
			}
			if !reflect.DeepEqual(m.calls, m.wantCalls) {
				t.Fatalf("calls=%v want=%v", m.calls, m.wantCalls)
			}
		})
	}
}

func TestMCPTaskDefaultReceiptForRestrictedCredentials(t *testing.T) {
	for _, tc := range []struct {
		name        string
		scopes      []scopepolicy.ScopeID
		wantReceipt bool
	}{
		{"write only", []scopepolicy.ScopeID{"task:write"}, true},
		{"read and write", []scopepolicy.ScopeID{"task:read", "task:write"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := model.Principal{Kind: model.PATCredential, UserID: testUserID, CredentialID: testTargetID}
			auth := scopedPAT(t, p, tc.scopes...)
			m := &taskResourceMock{t: t, principal: p, project: testProjectID, calls: map[string]int{}, wantCalls: map[string]int{"Update": 1}}
			current := taskFixtureTask()
			current.Description = "prior secret"
			m.UpdateFunc = func(ctx context.Context, _ model.Principal, _, _ string, _ taskcore.UpdateTask, _, _ *[]string) (model.Task, error) {
				observed, full, present := taskservice.TaskWriteAuthorizationFromContext(ctx)
				if !present || observed.Principal != p || full == tc.wantReceipt {
					t.Errorf("authorization context: present=%v full=%v principal=%+v", present, full, observed.Principal)
				}
				return current, nil
			}
			ctx := context.WithValue(t.Context(), taskResourceContextKey{}, m)
			version, title := "1", "new"
			in := taskArguments{ProjectID: testProjectID, TaskID: testTargetID, IfVersion: &version, Title: &title}
			actor := RequestActor{Principal: p, Authorization: &auth, RequestID: "request", rpcResponseID: "rpc"}
			result, err := handleTaskTool(ctx, actor, m, nil, "task_update", in, map[string]json.RawMessage{"title": json.RawMessage(`"new"`)})
			if err != nil {
				t.Fatal(err)
			}
			data, err := json.Marshal(result.Data)
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal(data, &got); err != nil {
				t.Fatal(err)
			}
			if tc.wantReceipt {
				want := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "version": "1"}
				if !reflect.DeepEqual(got, want) || !result.SuccessMetadata || result.WriteOutcome != "confirmed" {
					t.Fatalf("receipt=%s result=%+v", data, result)
				}
			} else if got["projection"] != "summary" || result.SuccessMetadata {
				t.Fatalf("summary=%s result=%+v", data, result)
			}
			if !reflect.DeepEqual(m.calls, m.wantCalls) {
				t.Fatalf("calls=%v want=%v", m.calls, m.wantCalls)
			}
		})
	}
}

func TestMCPScopedTaskWriteRegistrationAndAdmission(t *testing.T) {
	write := scopedTestAuthorization(t, "task:write")
	readWrite := scopedTestAuthorization(t, "task:read", "task:write")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	entry, err := New(testAuthenticator{}, "https://daynight.test", nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"write": write, "both": readWrite}}); err != nil {
		t.Fatal(err)
	}
	m := &taskResourceMock{t: t, principal: write.Principal, project: testProjectID, calls: map[string]int{}, wantCalls: map[string]int{"Update": 3}}
	m.UpdateFunc = func(ctx context.Context, _ model.Principal, _, _ string, _ taskcore.UpdateTask, _, _ *[]string) (model.Task, error) {
		a, full, present := taskservice.TaskWriteAuthorizationFromContext(ctx)
		if !present {
			t.Error("missing scoped write context")
			return model.Task{}, errors.New("missing authorization")
		}
		ops := []scopepolicy.Operation{scopepolicy.TaskWrite}
		if full {
			ops = append(ops, scopepolicy.TaskRead)
		}
		if err := scopeadmission.Require(a, ops...); err != nil {
			return model.Task{}, err
		}
		task := taskFixtureTask()
		task.Description = "previous secret"
		return task, nil
	}
	if err := registerScopedTaskWriteTools(entry, m, m); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entry.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), taskResourceContextKey{}, m)))
	}))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := entry.Shutdown(ctx); err != nil {
			t.Error(err)
		}
		server.Close()
	})
	fixture := &entryFixture{entry: entry, server: server}
	writeClient := fixture.client(t, "2026-07-28", "write")
	bothClient := fixture.client(t, "2026-07-28", "both")
	args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "title": "new", "ifVersion": "1"}
	result, env := callTaskResource(t, writeClient, "task_update", args)
	if result.IsError || len(object(t, env["data"])) != 3 || object(t, env["meta"])["writeOutcome"] != "confirmed" {
		t.Fatalf("write-only receipt: %#v", env)
	}
	args["returnView"] = "full"
	scopedToolCall(t, writeClient, "task_update", args, "insufficient_scope", "not_committed")
	delete(args, "returnView")
	delete(args, "ifVersion")
	scopedToolCall(t, writeClient, "task_update", args, "insufficient_scope", "not_committed")
	args["ifVersion"] = "1"
	result, env = callTaskResource(t, bothClient, "task_update", args)
	if result.IsError || object(t, env["data"])["projection"] != "summary" {
		t.Fatalf("read-write summary: %#v", env)
	}
	if !reflect.DeepEqual(m.calls, m.wantCalls) {
		t.Fatalf("calls=%v want=%v", m.calls, m.wantCalls)
	}
}

func TestMCPGoalDependencyEditBindsWriteAuthorization(t *testing.T) {
	a := scopedTestAuthorization(t, "task:dependencies")
	calls := 0
	stub := goalDependencyStub{edit: func(ctx context.Context, p model.Principal, project, goal string, _ taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error) {
		calls++
		got, full, present := taskservice.TaskWriteAuthorizationFromContext(ctx)
		if !present || full || got.Principal != p || p != a.Principal || project != testProjectID || goal != testTargetID {
			t.Errorf("wrong Goal authorization or identity")
		}
		if err := scopeadmission.Require(got, scopepolicy.TaskDependencies); err != nil {
			return taskcore.GoalDependencyReceipt{}, err
		}
		return taskcore.GoalDependencyReceipt{GoalID: goal, Revision: 2, Changed: true}, nil
	}}
	raw, err := json.Marshal(map[string]any{"projectId": testProjectID, "goalId": testTargetID, "ifRevision": "1", "mode": "replace", "prerequisites": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := goalDependencyTool(t.Context(), RequestActor{Principal: a.Principal, Authorization: &a}, "goal_dependencies_edit", raw, stub)
	if err != nil || calls != 1 || result.WriteOutcome != "confirmed" {
		t.Fatalf("result=%+v calls=%d err=%v", result, calls, err)
	}
	data, err := json.Marshal(result.Data)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, map[string]any{"goalId": testTargetID, "revision": "2", "changed": true}) {
		t.Fatalf("receipt=%s", data)
	}
}

func TestMCPCreateExplicitDefaultAssigneeNeedsOnlyTaskWrite(t *testing.T) {
	for _, kind := range []model.TaskType{model.TaskTypeTask, model.TaskTypeGoal} {
		t.Run(string(kind), func(t *testing.T) {
			f := newTaskResourceFixture(t)
			current := taskFixtureTask()
			current.Type = kind
			f.operations.wantCalls["Create"]++
			f.operations.CreateFunc = func(_ context.Context, p model.Principal, _ string, input taskcore.CreateTask) (model.Task, error) {
				if !input.AssignedToPresent || input.AssignedTo == nil || *input.AssignedTo != p.UserID || input.DefaultAssignedTo == nil || *input.DefaultAssignedTo != p.UserID {
					t.Errorf("create assignment = %+v", input)
				}
				if got := taskcore.CreateOperations(input, p); !reflect.DeepEqual(got, []scopepolicy.Operation{scopepolicy.TaskWrite}) {
					t.Errorf("default assignee scope = %v", got)
				}
				return current, nil
			}
			taskData(t, f.client, "task_create", map[string]any{"projectId": f.project, "title": "Task", "type": string(kind), "assignedTo": f.principal.UserID})
		})
	}
}

func TestScopedTaskWritePublicRegistrations(t *testing.T) {
	for _, tc := range []struct {
		name     string
		register func(*Entry, *taskservice.Tasks) error
		writes   []string
		reads    []string
	}{
		{"task", func(e *Entry, tasks *taskservice.Tasks) error { return RegisterScopedTaskWriteTools(e, tasks, nil) }, []string{"task_create", "task_update", "task_set_status", "task_delete", "task_set_property", "task_remove_property"}, []string{"task_show", "task_properties"}},
		{"goal dependencies", RegisterScopedGoalDependencyWriteTools, []string{"goal_dependencies_edit"}, []string{"goal_dependencies_show"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service := taskservice.NewTasks(nil)
			if err := tc.register(nil, service); err == nil {
				t.Fatal("nil entry accepted")
			}
			fixture := newEntryFixture(t)
			if err := tc.register(fixture.entry, service); err == nil {
				t.Fatal("entry without scoped authentication accepted")
			}
			if err := fixture.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{}}); err != nil {
				t.Fatal(err)
			}
			if err := tc.register(fixture.entry, nil); err == nil {
				t.Fatal("nil Tasks service accepted")
			}
			if err := tc.register(fixture.entry, service); err != nil {
				t.Fatal(err)
			}
			for _, name := range tc.writes {
				if !fixture.entry.toolNames[name] || !fixture.entry.scopedTools[name] {
					t.Errorf("write tool %s is not registered and classified", name)
				}
			}
			for _, name := range tc.reads {
				if fixture.entry.toolNames[name] || fixture.entry.scopedTools[name] {
					t.Errorf("write registration published read tool %s", name)
				}
			}
			if err := tc.register(fixture.entry, service); err == nil {
				t.Fatal("duplicate registration accepted")
			}
		})
	}
}
