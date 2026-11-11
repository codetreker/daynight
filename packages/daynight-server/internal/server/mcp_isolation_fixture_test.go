package server

import (
	"bytes"
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func mcpAttachmentCheck(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("MCP attachment DAO arguments: got %#v, want %#v", got, want)
		panic("MCP attachment DAO contract violated")
	}
}

func assertMCPUnstartedObservation(t *testing.T, item map[string]any) {
	t.Helper()
	observation, ok := item["session"].(map[string]any)
	if !ok || observation["observation"] != "observed" || observation["registration"] != "not_applicable" || observation["reason"] != "not_started" {
		t.Fatalf("unstarted Task observation: %#v", item)
	}
	send, ok := observation["send"].(map[string]any)
	if !ok || send["allowed"] != false || send["reason"] != "not_started" {
		t.Fatalf("unstarted Task send eligibility: %#v", observation)
	}
}

func mcpIsolationTaskRead(t *testing.T, tx *httpTestStore, p model.Principal, project model.Project, target model.Task, name, view string) {
	want := map[string]int{"snapshot": 1, "access": 1, "priority": 1}
	if name == "task_list" {
		want["fence"] = 1
	}
	if view == "full" {
		want["task"] = 1
	}
	if name == "task_graph" {
		delete(want, "priority")
		delete(want, "fence")
		delete(want, "task")
		want["project"] = 1
		want["presence"] = 1
		want["nodes"] = 1
		want["clock"] = 1
	}
	if name != "task_ready" {
		want["snapshot"] = 2
		want["access"] = 2
		want["credential"] = 2
		want["sources"] = 2
		want["clock"]++
	}
	counts := newHTTPCallPlan(t, want)
	scope := newHTTPTestSnapshot(t)
	if name != "task_ready" {
		scope.Credentials = &taskHTTPCredentialReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "MCP observation credential"), CredentialFn: func(ctx context.Context, actor model.Principal) (store.ThreadCredential, error) {
			counts.Called("credential")
			mcpAttachmentCheck(t, actor, p)
			return store.ThreadCredential{}, nil
		}}
		scope.Sessions = &taskHTTPSessionReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "MCP observation sources"), TaskSessionSourcesFn: func(ctx context.Context, pid string, ids []string) ([]store.TaskSessionSource, error) {
			counts.Called("sources")
			mcpAttachmentCheck(t, pid, project.ID)
			mcpAttachmentCheck(t, ids, []string{target.ID})
			return []store.TaskSessionSource{{ProjectID: project.ID, TaskID: target.ID, TaskVersion: target.Version, TaskStatus: target.Status}}, nil
		}}
	}
	scope.Projects = projectHTTPReader{ProjectAccessCall: func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		counts.Called("access")
		mcpAttachmentCheck(t, actor, p)
		mcpAttachmentCheck(t, id, project.ID)
		return projectHTTPAccess(p, project), nil
	}, ProjectCall: func(ctx context.Context, id string) (model.Project, error) {
		counts.Called("project")
		mcpAttachmentCheck(t, id, project.ID)
		return project, nil
	}}
	reader := &taskHTTPReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "MCP isolation Task")}
	reader.TaskListFenceFn = func(ctx context.Context, id string) (store.TaskListFence, error) {
		counts.Called("fence")
		mcpAttachmentCheck(t, id, project.ID)
		return store.TaskListFence{Count: "1", VersionSum: "1"}, nil
	}
	reader.TaskPriorityListFn = func(ctx context.Context, id string, q store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
		counts.Called("priority")
		mcpAttachmentCheck(t, id, project.ID)
		expected := store.TaskPriorityQuery{AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentAll}, Limit: 50, ExcludeTerminal: true}
		if name == "task_ready" {
			status, ready := model.TaskTodo, true
			expected = store.TaskPriorityQuery{AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentAll}, Status: &status, Ready: &ready, Limit: 5}
		}
		mcpAttachmentCheck(t, q, expected)
		summary := mcpCloneFixture(target)
		summary.Description = ""
		return store.TaskPriorityPage{Items: []store.TaskPriorityItem{{Task: summary}}}, nil
	}
	reader.TaskBodiesFn = func(ctx context.Context, pid string, ids []string) ([]model.Task, error) {
		counts.Called("task")
		mcpAttachmentCheck(t, pid, project.ID)
		mcpAttachmentCheck(t, ids, []string{target.ID})
		return []model.Task{mcpCloneFixture(target)}, nil
	}
	reader.TaskFn = func(ctx context.Context, pid, id string) (model.Task, error) {
		counts.Called("task")
		mcpAttachmentCheck(t, []string{pid, id}, []string{project.ID, target.ID})
		return mcpCloneFixture(target), nil
	}
	reader.TaskPresenceFn = func(ctx context.Context, pid, id string) (store.TaskPresence, error) {
		counts.Called("presence")
		mcpAttachmentCheck(t, []string{pid, id}, []string{project.ID, target.ID})
		return store.TaskPresence{Found: true}, nil
	}
	selection := store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, LiveOnly: true}
	reader.TaskGraphTasksFn = func(ctx context.Context, pid, id string, q store.TaskGraphSelection, n int) ([]model.GraphTask, error) {
		counts.Called("nodes")
		mcpAttachmentCheck(t, []string{pid, id}, []string{project.ID, target.ID})
		mcpAttachmentCheck(t, q, selection)
		mcpAttachmentCheck(t, n, 160)
		return []model.GraphTask{{ID: target.ID, Version: target.Version, TitlePreview: target.Title, Status: target.Status, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true, CreatedAt: target.CreatedAt, UpdatedAt: target.UpdatedAt}}, nil
	}
	scope.Tasks = reader
	scope.ObservedAtCall = func(context.Context) (time.Time, error) { counts.Called("clock"); return target.UpdatedAt, nil }
	tx.ReadSnapshotCall = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
		counts.Called("snapshot")
		return fn(scope)
	}
}

type mcpIsolationRevocationDAO struct {
	httpRejectedIdentityDAO
	session model.Principal
	tokenID string
	calls   *httpCallPlan
}

func (d *mcpIsolationRevocationDAO) LockSession(ctx context.Context, p model.Principal, now time.Time) error {
	d.calls.Called("session lock")
	mcpAttachmentCheck(d.t, p, d.session)
	if now.IsZero() || now.Location() != time.UTC {
		unexpectedHTTPCall(d.t, "revocation time")
	}
	return nil
}
func (d *mcpIsolationRevocationDAO) DeletePAT(ctx context.Context, owner, id string) error {
	d.calls.Called("PAT delete")
	mcpAttachmentCheck(d.t, []string{owner, id}, []string{d.session.UserID, d.tokenID})
	return nil
}
func mcpIsolationRevocation(t *testing.T, tx *httpTestStore, browser model.Principal, tokenID string) {
	before := tx.WriteIdentityCall
	calls := newHTTPCallPlan(t, map[string]int{"identity callback": 2, "session lock": 1, "PAT delete": 1})
	phase := 0
	tx.WriteIdentityCall = func(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
		calls.Called("identity callback")
		phase++
		if phase == 1 {
			return before(ctx, fn)
		}
		dao := &mcpIsolationRevocationDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}, session: browser, tokenID: tokenID, calls: calls}
		return mcpBotResult(fn(httpAuthenticationScope{t: t, dao: dao}))
	}
}
func mcpIsolationRevokedAuthentication(t *testing.T, tx *httpTestStore, revokedToken, otherToken string, other model.Principal) {
	revokedHash, otherHash := secret.Hash(revokedToken), secret.Hash(otherToken)
	tx.WriteIdentityCall = func(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
		dao := &mcpAuthenticationDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}}
		dao.authenticate = func(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
			dao.calls++
			if dao.calls != 1 || kind != model.PATCredential || now.IsZero() || now.Location() != time.UTC {
				unexpectedHTTPCall(t, "revoked MCP authentication")
			}
			if bytes.Equal(hash, revokedHash) {
				return model.Principal{}, model.ErrNotFound
			}
			if bytes.Equal(hash, otherHash) {
				return other, nil
			}
			unexpectedHTTPCall(t, "undeclared MCP credential")
			panic("unreachable")
		}
		err := fn(httpAuthenticationScope{t: t, dao: dao})
		if dao.calls != 1 {
			unexpectedHTTPCall(t, "MCP authentication count")
		}
		return mcpBotResult(err)
	}
}
