package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type httpBindingStore struct {
	store.Transactions
	t       *testing.T
	ctx     context.Context
	failure error
	calls   map[string]int
}

func (s *httpBindingStore) called(ctx context.Context, name string) error {
	s.t.Helper()
	if ctx != s.ctx || ctx.Err() != nil {
		s.t.Fatal("default HTTP binding changed the operation context")
	}
	s.calls[name]++
	return s.failure
}
func (s *httpBindingStore) ReadSnapshot(ctx context.Context, run func(store.SnapshotScope) error) error {
	if run == nil {
		s.t.Fatal("default sync binding omitted its snapshot operation")
	}
	return s.called(ctx, "sync")
}
func (s *httpBindingStore) ReadTaskSearch(ctx context.Context, run func(store.TaskSearchSnapshot) error) error {
	if run == nil {
		s.t.Fatal("default search binding omitted its snapshot operation")
	}
	return s.called(ctx, "search")
}
func (s *httpBindingStore) WriteIdentity(ctx context.Context, run func(store.IdentityScope) error) (store.Completion, error) {
	if run == nil {
		s.t.Fatal("default token binding omitted its admission operation")
	}
	return store.Completion{Outcome: store.TransactionNotCommitted}, s.called(ctx, "admission")
}

func (s *httpBindingStore) ReadWebhookSnapshot(ctx context.Context, run func(store.WebhookReadScope) error) error {
	if run == nil {
		s.t.Fatal("default Webhook binding omitted its snapshot operation")
	}
	return s.called(ctx, "webhook")
}

type httpBindingIdentity struct {
	application.IdentityOperations
	t         *testing.T
	ctx       context.Context
	callback  string
	token     string
	principal model.Principal
	calls     int
}

func (i *httpBindingIdentity) CallbackURL() string { return i.callback }
func (i *httpBindingIdentity) Authenticate(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
	i.t.Helper()
	if ctx != i.ctx || ctx.Err() != nil || kind != i.principal.Kind || token != i.token {
		i.t.Fatal("Webhook authentication changed context, credential kind or raw token")
	}
	i.calls++
	return i.principal, nil
}

func TestHTTPDefaultDependenciesKeepApplicationInstances(t *testing.T) {
	type instance struct {
		files      *local.Storage
		app        *service.App
		handler    *sessionApplication
		deps       httpDependencies
		store      *httpBindingStore
		readyCalls int
		identity   *httpBindingIdentity
		webhooks   http.Handler
	}
	storageRoot := t.TempDir()
	var instances []*instance
	// Cleanup precedes construction, including a failure while registering tools.
	t.Cleanup(func() {
		for _, item := range instances {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if item.handler != nil {
				item.handler.BeginShutdown()
				if err := item.handler.Shutdown(ctx); err != nil {
					t.Error(err)
				}
			}
			item.app.CancelWork()
			if err := item.app.Close(ctx); err != nil {
				t.Error(err)
			}
			cancel()
			if err := item.files.Close(); err != nil {
				t.Error(err)
			}
		}
	})
	for _, label := range []string{"first", "second"} {
		ctx := context.WithValue(t.Context(), httpBindingContextKey{}, label)
		database := &httpBindingStore{t: t, ctx: ctx, failure: errors.New(label + " application"), calls: map[string]int{}}
		config := configuredTestConfig()
		client, err := service.NewIdentityClient(config)
		if err != nil {
			t.Fatal(err)
		}
		files, err := local.New(filepath.Join(storageRoot, label))
		if err != nil {
			t.Fatal(err)
		}
		item := &instance{store: database, files: files}
		item.app = service.NewModules(config, database, func(actual context.Context) error {
			if actual.Value(httpBindingContextKey{}) != label || actual.Err() != nil {
				t.Fatal("default readiness binding changed context")
			}
			item.readyCalls++
			return database.failure
		}, files, client)
		instances = append(instances, item)
		if item.app.OAuthProfile == nil {
			t.Fatal(item.app.OAuthError)
		}
		item.identity = &httpBindingIdentity{t: t, ctx: ctx, callback: config.UniAuthCallbackURL, token: "webhook-binding-" + label, principal: defaultHTTPPrincipal()}
		authentication, err := authhttp.NewAuthentication(item.identity, configpkg.AuthSettings{PublicOrigin: config.PublicOrigin, AllowHTTPTestOrigin: config.AllowHTTPTestOrigin}, testLogger())
		if err != nil {
			t.Fatal(err)
		}
		if deps := httpDependenciesFromApp(item.app, authentication, nil, nil, nil, testLogger()); deps.Webhooks != nil {
			t.Fatal("unconfigured Application mounted Webhook routes")
		}
		item.app.Webhooks = &webhookservice.Service{DB: database}
		handler, err := New(item.app, config, testLogger())
		if err != nil {
			t.Fatal(err)
		}
		var ok bool
		item.handler, ok = handler.(*sessionApplication)
		if !ok {
			t.Fatalf("New returned %T", handler)
		}
		item.deps = httpDependenciesFromApp(item.app, authentication, item.handler.mcp, item.handler.relay, item.handler.workerReadOnly, testLogger())
		if item.deps.Webhooks == nil {
			t.Fatal("configured Application omitted Webhook routes")
		}
		mux := http.NewServeMux()
		item.deps.Webhooks.RegisterRoutes(mux)
		item.webhooks = mux
		response := httptest.NewRecorder()
		item.handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/webhook-event-types", nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatal("production New did not mount configured Webhook routes", response.Code)
		}
		d, a := item.deps, item.app
		if d.Auth != authentication || d.MCP != item.handler.mcp || d.Relay != item.handler.relay || d.WorkerReadOnly != item.handler.workerReadOnly ||
			item.handler.engine != a.Engine || item.handler.service != a.Sessions ||
			d.Registration != a.OAuthProfile.Clients || d.Authorizations != a.OAuthProfile.Authorizations || d.TokenCodes != a.OAuthProfile.Authorizations || d.TokenGrants != a.OAuthProfile.Grants || d.OAuthGrants != a.OAuthGrants ||
			d.Projects != a.Projects || d.Memberships != a.Memberships || d.Teams != a.Teams || d.Workers != a.Workers || d.Prompts != a.Prompts ||
			d.Tasks != a.Tasks || d.TaskObservations != a.TaskObservations || d.TaskInspection != a.TaskInspection || d.TaskHistory != a.TaskHistory || d.TaskSteps != a.TaskSteps || d.TaskThreads != a.TaskThreads ||
			d.Attachments != a.Attachments || d.Bots != a.Bots || d.BotDeletions != a.BotDeletions || d.BotRuntime != a.Sessions || d.Web == nil || d.Webhooks == nil {
			t.Fatal("default HTTP dependencies changed an application or protocol instance")
		}
	}
	first, second := instances[0], instances[1]
	if first.app.Engine == second.app.Engine || first.handler.mcp == second.handler.mcp || first.deps.Relay == second.deps.Relay || first.deps.WorkerReadOnly == second.deps.WorkerReadOnly || first.deps.Web == second.deps.Web || first.deps.Projects == second.deps.Projects || first.deps.Attachments == second.deps.Attachments || first.deps.Webhooks == second.deps.Webhooks {
		t.Fatal("two applications share their owned modules or protocol state")
	}
	for _, item := range []*instance{first, second, first} {
		ctx, failure := item.store.ctx, item.store.failure
		_, allowed, err := item.deps.TokenAdmission(ctx, "192.0.2.1")
		if allowed || !errors.Is(err, failure) {
			t.Fatal("token admission changed its bound application", allowed, err)
		}
		_, err = item.deps.TaskSearch(ctx, defaultHTTPPrincipal(), "33333333-3333-4333-8333-333333333333", tasksearch.Request{Query: "needle", Limit: 1})
		if !errors.Is(err, failure) {
			t.Fatal("task search changed its bound application", err)
		}
		_, err = item.deps.TaskSync(ctx, defaultHTTPPrincipal(), "33333333-3333-4333-8333-333333333333", taskservice.TaskSyncRequest{})
		if !errors.Is(err, failure) {
			t.Fatal("task sync changed its bound application", err)
		}
		if err := item.deps.Ready(ctx); !errors.Is(err, failure) {
			t.Fatal("readiness changed its bound application", err)
		}
		request := httptest.NewRequest(http.MethodGet, "/readyz", nil).WithContext(ctx)
		response := httptest.NewRecorder()
		item.handler.ServeHTTP(response, request)
		if response.Code != http.StatusServiceUnavailable {
			t.Fatal("production HTTP handler lost its actual readiness binding", response.Code)
		}
		request = httptest.NewRequest(http.MethodGet, "/api/v1/webhook-event-types", nil).WithContext(ctx)
		request.Header.Set("Authorization", "Bearer "+item.identity.token)
		response = httptest.NewRecorder()
		item.webhooks.ServeHTTP(response, request)
		if response.Code != http.StatusInternalServerError || response.Header().Get("Daynight-User-ID") != item.identity.principal.UserID {
			t.Fatal("Webhook adapter changed its bound Service or authenticated principal", response.Code, response.Header())
		}
	}
	if first.readyCalls != 4 || second.readyCalls != 2 {
		t.Fatal("readiness instances overwrite each other", first.readyCalls, second.readyCalls)
	}
	for index, item := range instances {
		want := 1
		if index == 0 {
			want = 2
		}
		if item.identity.calls != want {
			t.Fatalf("application %d authentication calls=%d, want=%d", index, item.identity.calls, want)
		}
		for _, name := range []string{"admission", "search", "sync", "webhook"} {
			if item.store.calls[name] != want {
				t.Fatalf("application %d %s calls=%d, want=%d", index, name, item.store.calls[name], want)
			}
		}
	}
}

type httpBindingContextKey struct{}
