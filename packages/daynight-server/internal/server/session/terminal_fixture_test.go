package session_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

type terminalHTTPFixture struct {
	sessionHTTPShutdown
	h              *resourceTestHandler
	calls          *routeBackend
	authentication *routeAuthentication
	base           string
	message        v2.Message
	owner          v2.Owner
}

func terminalHTTPSetup(t *testing.T) *terminalHTTPFixture {
	t.Helper()
	calls := newRouteBackend(t)
	authentication := newRouteAuthentication(t, "https://daynight.example")
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	handler := newResourceTestHandler(t, calls, authentication, principal, io.Discard)
	app := handler.application.(*routeApplication)
	project, task, claim, worker, worktree := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	owner := v2.Owner{ProjectID: project, TaskID: task, WorkerID: worker, WorktreeID: worktree, OwnerUserID: principal.UserID, ServerOrigin: "https://daynight.example", Provider: "codex"}
	message := v2.Message{Envelope: v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, SessionID: uuid.NewString(), ClaimID: claim, ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}}
	f := &terminalHTTPFixture{h: handler, calls: calls, authentication: authentication, base: "/api/v1/projects/" + project + "/tasks/" + task + "/sessions", message: message, owner: owner}
	f.sessionHTTPShutdown.register(t, app.Shutdown)
	return f
}

func terminalRequest(handler http.Handler, method, path, body, protocol string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	if protocol != "" {
		request.Header.Set(v2.ProtocolHeader, protocol)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func (f *terminalHTTPFixture) scope(t *testing.T, ctx context.Context, p model.Principal, project, task, id string) {
	t.Helper()
	owner := f.owner
	if ctx.Err() != nil || p != f.h.principal || project != owner.ProjectID || task != owner.TaskID || id != f.message.SessionID {
		t.Errorf("terminal use-case arguments changed: %v %v %s/%s/%s", ctx.Err(), p, project, task, id)
	}
}
