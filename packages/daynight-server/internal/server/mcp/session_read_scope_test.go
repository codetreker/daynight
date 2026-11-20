package mcp

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type sessionReadScopeChecker func(context.Context, model.CredentialAuthorization, string, string, string) error

func (c sessionReadScopeChecker) CheckSessionRead(ctx context.Context, a model.CredentialAuthorization, project, task, session string) error {
	return c(ctx, a, project, task, session)
}

func TestScopedSessionReadToolsRejectAndRefreshPolicy(t *testing.T) {
	f := newSessionReadFixture(t)
	auth := testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"token": scopedTestAuthorization(t, "session:read")}}
	if err := f.entry.EnableScopedAuthentication(auth); err != nil {
		t.Fatal(err)
	}
	checks, reads := 0, 0
	checker := sessionReadScopeChecker(func(_ context.Context, a model.CredentialAuthorization, project, task, session string) error {
		checks++
		if a.Principal != auth.policies["token"].Principal || project != testProjectID || task != testTargetID || session != "" {
			t.Errorf("unexpected Session admission identity: %+v %s %s %s", a.Principal, project, task, session)
		}
		return scopeadmission.Require(a, scopepolicy.SessionRead)
	})
	mock := sessionReadMock{t: t, current: func(_ context.Context, p model.Principal, _, _ string) (sp.TaskSessionCurrent, error) {
		reads++
		if p != auth.policies["token"].Principal {
			t.Error("read changed authenticated principal")
		}
		return sp.TaskSessionCurrent{Status: "not_applicable"}, nil
	}}
	current := func(_ context.Context, _ store.SessionScope, a model.CredentialAuthorization) (model.CredentialAuthorization, error) {
		return a, nil
	}
	snapshot := func(_ context.Context, _ store.SnapshotScope, a model.CredentialAuthorization) (model.CredentialAuthorization, error) {
		return a, nil
	}
	if err := RegisterScopedSessionReadTools(f.entry, mock, mock, checker, current, snapshot); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "token")
	assertNoDiscoveredOutputSchemas(t, client, "task_session_current", "task_session_list", "task_session_show", "task_session_read", "task_session_entry")
	c := &structClient{t: t, client: client}
	c.call("task_session_current", map[string]any{"projectId": testProjectID, "taskId": testTargetID}, false)
	auth.policies["token"] = scopedTestAuthorization(t, "task:read")
	for _, name := range []string{"current", "list", "show", "read", "entry"} {
		args := sessionReadArgs()
		if name == "current" || name == "list" {
			delete(args, "sessionId")
		}
		if name == "entry" {
			args["cursor"] = "body"
		}
		v := c.call("task_session_"+name, args, true)
		if object(t, v["error"])["code"] != "insufficient_scope" || v["data"] != nil {
			t.Fatalf("%s leaked or used wrong refusal: %#v", name, v)
		}
	}
	if checks != 6 || reads != 1 {
		t.Fatalf("checks=%d reads=%d", checks, reads)
	}
}

func TestScopedSessionReadRegistrationRequiresChecker(t *testing.T) {
	f := newSessionReadFixture(t)
	mock := sessionReadMock{t: t}
	if err := RegisterScopedSessionReadTools(f.entry, mock, mock, nil, nil, nil); err == nil {
		t.Fatal("missing checker accepted")
	}
}
