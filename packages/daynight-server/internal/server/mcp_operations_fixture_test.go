package server

import (
	"context"
	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func newMCPOperationServer(t *testing.T, principals map[string]model.Principal, files filestorage.Storage, configure func(*service.App), outputs ...io.Writer) (*httptest.Server, *sessionApplication) {
	return newMCPOperationServerPrepared(t, principals, files, func(origin string) configpkg.Config {
		config := configuredTestConfig()
		config.PublicOrigin = origin
		config.UniAuthCallbackURL = origin + "/api/v1/auth/callback"
		config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
		return config
	}, configure, outputs...)
}
func newMCPOperationServerWithConfig(t *testing.T, principals map[string]model.Principal, files filestorage.Storage, config configpkg.Config, configure func(*service.App), outputs ...io.Writer) (*httptest.Server, *sessionApplication) {
	return newMCPOperationServerPrepared(t, principals, files, func(string) configpkg.Config { return config }, configure, outputs...)
}
func newMCPOperationServerPrepared(t *testing.T, principals map[string]model.Principal, files filestorage.Storage, configForOrigin func(string) configpkg.Config, configure func(*service.App), outputs ...io.Writer) (*httptest.Server, *sessionApplication) {
	t.Helper()
	server := httptest.NewUnstartedServer(nil)
	var app *service.App
	var handler Handler
	started := false
	// Register cleanup before construction so partial startup also releases the listener and engine.
	t.Cleanup(func() {
		bounded := func(name string, stop func(context.Context) error) bool {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := stop(ctx); err != nil {
				t.Errorf("MCP %s: %v", name, err)
				return false
			}
			return true
		}
		forceHTTP := func() {
			if started {
				if err := server.Config.Close(); err != nil {
					t.Errorf("MCP HTTP close: %v", err)
				}
			}
		}
		if handler != nil {
			handler.BeginShutdown()
		}
		if started && !bounded("HTTP shutdown", server.Config.Shutdown) {
			forceHTTP()
		}
		if handler != nil && !bounded("handler shutdown", handler.Shutdown) {
			// Close remaining connections, then continue draining with a fresh budget.
			forceHTTP()
			bounded("handler drain after close", handler.Shutdown)
		}
		if app != nil {
			app.CancelWork()
			if !bounded("application shutdown", app.Close) {
				// Close is retryable after a deadline and retains owned resources until drained.
				bounded("application drain after cancellation", app.Close)
			}
		}
		closed := make(chan struct{})
		go func() {
			server.Close()
			close(closed)
		}()
		bounded("test server close", func(ctx context.Context) error {
			select {
			case <-closed:
				return nil
			case <-ctx.Done():
				forceHTTP()
				return ctx.Err()
			}
		})
	})
	origin := "http://" + server.Listener.Addr().String()
	config := configForOrigin(origin)
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	client, err := service.NewIdentityClient(config)
	if err != nil {
		t.Fatal(err)
	}
	// No store callback is configured: any unexpected business access fails.
	app = service.NewModules(config, &httpTestStore{t: t}, nil, files, client)
	identity := &mcpOperationIdentity{mcpStepIdentity: mcpStepIdentity{t: t, callback: config.UniAuthCallbackURL}, credentials: make(map[string]mcpOperationCredential, len(principals))}
	for token, principal := range principals {
		identity.credentials[token] = mcpOperationCredential{kind: principal.Kind, principal: principal}
	}
	app.Identity = identity
	app.Projects = &operationRejectedProjects{t: t}
	app.Memberships = &operationRejectedMemberships{t: t}
	app.Teams = &operationRejectedTeams{t: t}
	app.Bots = &operationRejectedBots{t: t}
	app.BotDeletions = &operationRejectedBotDeletions{t: t}
	app.Tasks = &operationRejectedTasks{t: t}
	app.TaskObservations = &operationRejectedTaskObservations{t: t}
	app.TaskSteps = &operationRejectedTaskSteps{t: t}
	app.TaskThreads = &operationRejectedTaskThreads{t: t}
	app.Attachments = &operationRejectedAttachments{t: t}
	app.Downloads = &operationRejectedDownloads{t: t}
	app.Uploads = &operationRejectedUploads{t: t}
	app.OAuth = &operationRejectedOAuth{t: t}
	configure(app)
	app.OAuth = mcpOperationOAuth{t: t, operations: app.OAuth}
	output := io.Discard
	if len(outputs) > 1 {
		t.Fatal("MCP fixture accepts at most one log writer")
	}
	if len(outputs) == 1 {
		output = outputs[0]
	}
	logger := slog.New(slog.NewJSONHandler(output, nil))
	handler, err = New(app, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	server.Config.Handler = markMCPOperationRequests(t, httpx.RequestLogging(logger, handler))
	server.Start()
	started = true
	return server, handler.(*sessionApplication)
}

type mcpOperationCredential struct {
	kind      model.CredentialKind
	principal model.Principal
	err       error
	calls     int
}

type mcpOperationIdentity struct {
	mcpStepIdentity
	mu                 sync.Mutex
	credentials        map[string]mcpOperationCredential
	PersonalTeamIDCall func(context.Context, model.Principal) (string, error)
	UserCall           func(context.Context, model.Principal) (model.User, error)
	RevokePATCall      func(context.Context, model.Principal, string) error
}

func (i *mcpOperationIdentity) setCredential(kind model.CredentialKind, token string, principal model.Principal, err error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.credentials[token] = mcpOperationCredential{kind: kind, principal: principal, err: err}
}

func (i *mcpOperationIdentity) credentialCalls(token string) int {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.credentials[token].calls
}

func (i *mcpOperationIdentity) Authenticate(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
	i.mu.Lock()
	result, ok := i.credentials[token]
	if ok {
		result.calls++
		i.credentials[token] = result
	}
	i.mu.Unlock()
	if !ok {
		i.t.Errorf("undeclared MCP authentication kind/token: %s", kind)
		return model.Principal{}, model.ErrNotFound
	}
	if kind != result.kind {
		i.t.Errorf("MCP credential kind: got %s want %s", kind, result.kind)
		return model.Principal{}, model.ErrNotFound
	}
	if result.err != nil {
		mcpOperationAuthenticated(i.t, ctx, model.Principal{})
		return model.Principal{}, result.err
	}
	mcpOperationAuthenticated(i.t, ctx, result.principal)
	return result.principal, nil
}
func mcpOperationAuthenticated(t *testing.T, ctx context.Context, principal model.Principal) {
	t.Helper()
	marker := mcpStepRequestMarker(t, ctx)
	if marker == nil {
		return
	}
	marker.mu.Lock()
	defer marker.mu.Unlock()
	marker.authCalls++
	marker.principal = principal
}
func mcpOperationContext(t *testing.T, ctx context.Context, principal model.Principal) {
	t.Helper()
	marker := mcpStepRequestMarker(t, ctx)
	if marker == nil {
		return
	}
	marker.mu.Lock()
	defer marker.mu.Unlock()
	if marker.authCalls != 1 || marker.principal != principal {
		t.Errorf("MCP operation authentication: got %d/%+v want 1/%+v", marker.authCalls, marker.principal, principal)
	}
}
func (i *mcpOperationIdentity) PersonalTeamID(ctx context.Context, principal model.Principal) (string, error) {
	mcpOperationContext(i.t, ctx, principal)
	if i.PersonalTeamIDCall == nil {
		return "", i.reject("PersonalTeamID")
	}
	return i.PersonalTeamIDCall(ctx, principal)
}
func (i *mcpOperationIdentity) User(ctx context.Context, principal model.Principal) (model.User, error) {
	mcpOperationContext(i.t, ctx, principal)
	if i.UserCall == nil {
		return model.User{}, i.reject("User")
	}
	return i.UserCall(ctx, principal)
}
func (i *mcpOperationIdentity) RevokePAT(ctx context.Context, principal model.Principal, id string) error {
	mcpOperationContext(i.t, ctx, principal)
	if i.RevokePATCall == nil {
		return i.reject("RevokePAT")
	}
	return i.RevokePATCall(ctx, principal, id)
}

type mcpOperationOAuth struct {
	t          *testing.T
	operations application.OAuthOperations
}

func (o mcpOperationOAuth) AuthenticateAccess(ctx context.Context, token, resource string) (store.OAuthAccessIdentity, error) {
	result, err := o.operations.AuthenticateAccess(ctx, token, resource)
	mcpOperationAuthenticated(o.t, ctx, result.Principal)
	return result, err
}

func markMCPOperationRequests(t *testing.T, handler http.Handler) http.Handler {
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
}
