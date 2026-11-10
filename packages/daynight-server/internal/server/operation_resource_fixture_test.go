package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	oauthtoken "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/token"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	webhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webui"
	workerhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	resources "github.com/codetreker/daynight/packages/daynight-server/internal/service/webui"
)

type operationHTTPRequestKey struct{}
type operationHTTPRequest struct {
	mu                    sync.Mutex
	active                bool
	authenticated         int
	authenticationContext context.Context
	requestContext        context.Context
}

func requireOperationHTTPContext(t *testing.T, ctx context.Context) {
	t.Helper()
	invocation, ok := ctx.Value(operationHTTPRequestKey{}).(*operationHTTPRequest)
	if !ok {
		unexpectedHTTPCall(t, "operation without HTTP request context")
	}
	invocation.mu.Lock()
	active := invocation.active
	invocation.mu.Unlock()
	if !active || ctx.Err() != nil {
		unexpectedHTTPCall(t, "operation outside live HTTP request")
	}
}

func requireExactOperationHTTPContext(t *testing.T, ctx context.Context) {
	t.Helper()
	requireOperationHTTPContext(t, ctx)
	invocation := ctx.Value(operationHTTPRequestKey{}).(*operationHTTPRequest)
	invocation.mu.Lock()
	expected := invocation.requestContext
	invocation.mu.Unlock()
	if ctx != expected {
		unexpectedHTTPCall(t, "operation replaced HTTP request context")
	}
}

type operationHTTPAuthenticationIdentity struct {
	application.IdentityOperations
	t *testing.T
}

func (i operationHTTPAuthenticationIdentity) Authenticate(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
	requireOperationHTTPContext(i.t, ctx)
	invocation := ctx.Value(operationHTTPRequestKey{}).(*operationHTTPRequest)
	invocation.mu.Lock()
	invocation.authenticated++
	count := invocation.authenticated
	invocation.authenticationContext = ctx
	invocation.mu.Unlock()
	if count != 1 {
		unexpectedHTTPCall(i.t, "repeated Identity.Authenticate")
	}
	return i.IdentityOperations.Authenticate(ctx, kind, token)
}

func newOperationHTTPServer(t *testing.T, configure func(*httpDependencies), output io.Writer, principal model.Principal) *resourceTestHandler {
	t.Helper()
	resource := &resourceTestHandler{token: httpTestToken(principal.Kind), principal: principal}
	identity := newOperationHTTPIdentity(t, principal)
	identity.AuthenticateFn = func(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		requireOperationHTTPContext(t, ctx)
		if kind != resource.principal.Kind || token != httpTestToken(kind) {
			unexpectedHTTPCall(t, "Identity.Authenticate credential")
		}
		return resource.principal, nil
	}
	resource.Handler = newOperationHTTPServerWithConfig(t, identity, configure, output, principal, configuredTestConfig()).Handler
	return resource
}

func newOperationHTTPServerWithIdentity(t *testing.T, identity application.IdentityOperations, configure func(*httpDependencies), output io.Writer, principal model.Principal) *resourceTestHandler {
	t.Helper()
	return newOperationHTTPServerWithConfig(t, identity, configure, output, principal, configuredTestConfig())
}

func newOperationHTTPServerWithConfig(t *testing.T, identity application.IdentityOperations, configure func(*httpDependencies), output io.Writer, principal model.Principal, c config.Config) *resourceTestHandler {
	t.Helper()
	logger := slog.New(slog.NewJSONHandler(output, nil))
	auth, err := authhttp.NewAuthentication(operationHTTPAuthenticationIdentity{IdentityOperations: identity, t: t}, config.AuthSettings{PublicOrigin: c.PublicOrigin, AllowHTTPTestOrigin: c.AllowHTTPTestOrigin}, logger)
	if err != nil {
		t.Fatal(err)
	}
	rejectedOAuth := &oauthHTTPOperations{t: t}
	deps := httpDependencies{
		Auth:         auth,
		MCP:          http.HandlerFunc(func(http.ResponseWriter, *http.Request) { unexpectedHTTPCall(t, "MCP HTTP handler") }),
		Registration: rejectedOAuth, Authorizations: rejectedOAuth, TokenCodes: rejectedOAuth, TokenGrants: rejectedOAuth, OAuthGrants: rejectedOAuth,
		TokenAdmission: func(context.Context, string) (oauthtoken.ClientPermit, bool, error) {
			unexpectedHTTPCall(t, "TokenAdmission")
			panic("unreachable")
		},
		Projects: &operationRejectedProjects{t: t}, Memberships: &operationRejectedMemberships{t: t}, Teams: &operationRejectedTeams{t: t},
		Workers: &capacityReportOperations{t: t}, Prompts: &operationRejectedPrompts{t: t},
		Tasks: &operationRejectedTasks{t: t}, TaskObservations: &operationRejectedTaskObservations{t: t}, TaskSteps: &operationRejectedTaskSteps{t: t}, TaskThreads: &operationRejectedTaskThreads{t: t},
		Attachments: &operationRejectedAttachments{t: t}, Bots: &operationRejectedBots{t: t}, BotDeletions: &operationRejectedBotDeletions{t: t}, BotRuntime: &operationRejectedBotRuntime{t: t},
		TaskInspection: &operationRejectedInspection{t: t}, TaskHistory: &operationRejectedHistory{t: t},
		TaskSearch: func(context.Context, model.Principal, string, tasksearch.Request) (tasksearch.Page, error) {
			unexpectedHTTPCall(t, "TaskSearch")
			panic("unreachable")
		},
		TaskSync: func(context.Context, model.Principal, string, taskservice.TaskSyncRequest) (model.TaskSync, error) {
			unexpectedHTTPCall(t, "TaskSync")
			panic("unreachable")
		},
		Web:   webhttp.New(resources.New()),
		Ready: func(context.Context) error { unexpectedHTTPCall(t, "Ready"); panic("unreachable") },
	}
	deps.WorkerReadOnly = workerhttp.NewReadOnlyRoutes(&operationRejectedReadOnly{t: t}, auth, logger)
	deps.Relay = sessionhttp.NewRoutesWithOperations(rejectedOperationHTTPSessions(t), auth.RequestAuthentication, logger, deps.TaskHistory)
	configure(&deps)
	handler := newHTTPHandler(deps, c, logger)
	t.Cleanup(func() {
		deps.WorkerReadOnly.BeginShutdown()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := deps.WorkerReadOnly.Shutdown(ctx); err != nil {
			t.Error(err)
		}
		if err := deps.Relay.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	observed := httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		invocation := r.Context().Value(operationHTTPRequestKey{}).(*operationHTTPRequest)
		invocation.mu.Lock()
		invocation.requestContext = r.Context()
		invocation.mu.Unlock()
		handler.ServeHTTP(w, r)
	}))
	wrapped := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		invocation := &operationHTTPRequest{active: true}
		defer func() { invocation.mu.Lock(); invocation.active = false; invocation.mu.Unlock() }()
		ctx := context.WithValue(r.Context(), operationHTTPRequestKey{}, invocation)
		// Logging and ServeMux share the request that receives the matched route pattern.
		observed.ServeHTTP(w, r.WithContext(ctx))
	})
	return &resourceTestHandler{Handler: wrapped, token: httpTestToken(principal.Kind), principal: principal}
}

type operationRejectedReadOnly struct{ t *testing.T }

func (r *operationRejectedReadOnly) Request(context.Context, model.Principal, string, ro.Request) (ro.Message, error) {
	unexpectedHTTPCall(r.t, "ReadOnly.Request")
	panic("unreachable")
}
func (r *operationRejectedReadOnly) Connect(context.Context, model.Principal, string, ro.Hello) (*ro.Connection, error) {
	unexpectedHTTPCall(r.t, "ReadOnly.Connect")
	panic("unreachable")
}
func (r *operationRejectedReadOnly) Disconnect(*ro.Connection) {
	unexpectedHTTPCall(r.t, "ReadOnly.Disconnect")
}
func (r *operationRejectedReadOnly) Deliver(context.Context, *ro.Connection, ro.Message) error {
	unexpectedHTTPCall(r.t, "ReadOnly.Deliver")
	panic("unreachable")
}
func (r *operationRejectedReadOnly) Check(context.Context, *ro.Connection) error {
	unexpectedHTTPCall(r.t, "ReadOnly.Check")
	panic("unreachable")
}
func (r *operationRejectedReadOnly) Close() {}
