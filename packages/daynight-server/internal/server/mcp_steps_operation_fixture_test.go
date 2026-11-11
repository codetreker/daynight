package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

// A fresh marker is attached after request logging and remains unique to the
// HTTP request, including the contexts derived by MCP's handlers.
type mcpStepMarkerKey struct{}
type mcpStepMarker struct {
	mu        sync.Mutex
	authCalls int
	principal model.Principal
}

func mcpStepRequestMarker(t *testing.T, ctx context.Context) *mcpStepMarker {
	t.Helper()
	marker, ok := ctx.Value(mcpStepMarkerKey{}).(*mcpStepMarker)
	if !ok || marker == nil {
		t.Error("MCP request context lost its marker")
		return nil
	}
	if err := ctx.Err(); err != nil {
		t.Errorf("MCP operation context is already canceled: %v", err)
	}
	return marker
}

func newMCPStepOperationServer(t *testing.T, files filestorage.Storage, principals map[string]model.Principal) (*httptest.Server, *mcpStepOperations) {
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
	config := configuredTestConfig()
	config.Server.PublicOrigin = origin
	config.UniAuth.CallbackURL = origin + "/api/v1/auth/callback"
	config.Server.AllowHTTPTestOrigin, config.UniAuth.AllowLoopbackHTTP = true, true
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	client, err := service.NewIdentityClient(config.UniAuth)
	if err != nil {
		t.Fatal(err)
	}
	// No store callback is configured: any unexpected business access fails.
	app = service.NewModules(config, &httpTestStore{t: t}, nil, files, client)
	ops := &mcpStepOperations{t: t, total: make(map[string]int)}
	identity := &mcpStepIdentity{t: t, callback: config.UniAuth.CallbackURL, principals: make(map[string]model.Principal, len(principals))}
	for token, principal := range principals {
		identity.principals[token] = principal
	}
	app.TaskSteps, app.Identity = ops, identity
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	handler, err = New(app, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	marked := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	server.Config.Handler = httpx.RequestLogging(logger, marked)
	server.Start()
	started = true
	return server, ops
}

type mcpStepIdentity struct {
	t          *testing.T
	callback   string
	principals map[string]model.Principal
}

var _ application.IdentityOperations = (*mcpStepIdentity)(nil)

func (i *mcpStepIdentity) CallbackURL() string { return i.callback }
func (i *mcpStepIdentity) Authenticate(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
	marker := mcpStepRequestMarker(i.t, ctx)
	principal, ok := i.principals[token]
	if !ok || kind != model.PATCredential || principal.Kind != model.PATCredential {
		i.t.Errorf("unexpected MCP credential kind/token")
		return model.Principal{}, errors.New("unexpected MCP credential")
	}
	if marker != nil {
		marker.mu.Lock()
		marker.authCalls++
		marker.principal = principal
		marker.mu.Unlock()
	}
	return principal, nil
}
func (i *mcpStepIdentity) reject(name string) error {
	i.t.Errorf("unexpected Identity.%s call", name)
	return errors.New("unexpected Identity." + name)
}
func (i *mcpStepIdentity) ValidateLogin(string, string) error { return i.reject("ValidateLogin") }
func (i *mcpStepIdentity) StartLogin(context.Context, string, string, string) (identitycore.LoginStart, error) {
	return identitycore.LoginStart{}, i.reject("StartLogin")
}
func (i *mcpStepIdentity) CompleteLogin(context.Context, url.Values, string) (identitycore.LoginCompletion, error) {
	return identitycore.LoginCompletion{}, i.reject("CompleteLogin")
}
func (i *mcpStepIdentity) User(context.Context, model.Principal) (model.User, error) {
	return model.User{}, i.reject("User")
}
func (i *mcpStepIdentity) Logout(context.Context, model.Principal) error { return i.reject("Logout") }
func (i *mcpStepIdentity) CreatePAT(context.Context, model.Principal, identitycore.CreatePAT) (identitycore.MintedPAT, error) {
	return identitycore.MintedPAT{}, i.reject("CreatePAT")
}
func (i *mcpStepIdentity) ListPATs(context.Context, model.Principal) ([]model.PersonalAccessToken, error) {
	return nil, i.reject("ListPATs")
}
func (i *mcpStepIdentity) RevokePAT(context.Context, model.Principal, string) error {
	return i.reject("RevokePAT")
}
func (i *mcpStepIdentity) UpdatePATExpiry(context.Context, model.Principal, string, identitycore.UpdatePATExpiry) (model.PersonalAccessToken, error) {
	return model.PersonalAccessToken{}, i.reject("UpdatePATExpiry")
}
func (i *mcpStepIdentity) Providers(context.Context) ([]string, error) {
	return nil, i.reject("Providers")
}
func (i *mcpStepIdentity) StartDevice(context.Context, string, string) (identitycore.DeviceStart, error) {
	return identitycore.DeviceStart{}, i.reject("StartDevice")
}
func (i *mcpStepIdentity) InspectDevice(context.Context, model.Principal, string) (identitycore.DeviceInspection, error) {
	return identitycore.DeviceInspection{}, i.reject("InspectDevice")
}
func (i *mcpStepIdentity) DecideDevice(context.Context, model.Principal, string, string, string) error {
	return i.reject("DecideDevice")
}
func (i *mcpStepIdentity) RedeemDevice(context.Context, string, string, string, string) (identitycore.MintedPAT, error) {
	return identitycore.MintedPAT{}, i.reject("RedeemDevice")
}
func (i *mcpStepIdentity) LogoutDevice(context.Context, model.Principal) error {
	return i.reject("LogoutDevice")
}
func (i *mcpStepIdentity) PersonalTeamID(context.Context, model.Principal) (string, error) {
	return "", i.reject("PersonalTeamID")
}

type mcpStepOperations struct {
	t       *testing.T
	mu      sync.Mutex
	current *mcpStepOperationPlan
	total   map[string]int
}

type mcpStepOperationPlan struct {
	owner        *mcpStepOperations
	actor        model.Principal
	order        []string
	next         int
	ctx          context.Context
	marker       *mcpStepMarker
	onListPage   func(context.Context, model.Principal, string, string, int64, int, *int64, bool) (task.StepsPage, error)
	onGetSummary func(context.Context, model.Principal, string, string, string) (task.StepSummary, error)
	onGet        func(context.Context, model.Principal, string, string, string) (task.StepDocument, error)
	onAdd        func(context.Context, model.Principal, string, string, task.AddTaskStep) (task.StepsWriteResult, error)
	onUpdate     func(context.Context, model.Principal, string, string, string, task.UpdateTaskStep) (task.StepsWriteResult, error)
	onSetStatus  func(context.Context, model.Principal, string, string, string, task.SetTaskStepStatus) (task.StepsWriteResult, error)
	onMove       func(context.Context, model.Principal, string, string, string, task.MoveTaskStep) (task.StepsWriteResult, error)
	onDelete     func(context.Context, model.Principal, string, string, string, task.DeleteTaskStep) (task.StepsWriteResult, error)
}

var _ application.TaskStepsOperations = (*mcpStepOperations)(nil)

func (o *mcpStepOperations) plan(actor model.Principal, order ...string) *mcpStepOperationPlan {
	p := &mcpStepOperationPlan{owner: o, actor: actor, order: append([]string(nil), order...)}
	o.mu.Lock()
	o.current = p
	o.mu.Unlock()
	return p
}
func (p *mcpStepOperationPlan) verify() {
	p.owner.t.Helper()
	p.owner.mu.Lock()
	defer p.owner.mu.Unlock()
	if p.next != len(p.order) {
		p.owner.t.Errorf("Step operation calls = %d, want %d (%v)", p.next, len(p.order), p.order)
	}
}
func (o *mcpStepOperations) counts() map[string]int {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := make(map[string]int, len(o.total))
	for k, v := range o.total {
		out[k] = v
	}
	return out
}
func (o *mcpStepOperations) invoke(ctx context.Context, actor model.Principal, name string) *mcpStepOperationPlan {
	marker := mcpStepRequestMarker(o.t, ctx)
	o.mu.Lock()
	defer o.mu.Unlock()
	o.total[name]++
	p := o.current
	if p == nil {
		o.t.Errorf("unconfigured Step.%s call", name)
		return nil
	}
	if p.next >= len(p.order) || p.order[p.next] != name {
		o.t.Errorf("unexpected Step.%s call at index %d, want %v", name, p.next, p.order)
		return nil
	}
	p.next++
	if actor != p.actor {
		o.t.Errorf("Step.%s actor = %+v, want %+v", name, actor, p.actor)
	}
	if marker != nil {
		marker.mu.Lock()
		calls, authenticated := marker.authCalls, marker.principal
		marker.mu.Unlock()
		if calls != 1 || authenticated != actor {
			o.t.Errorf("Step.%s authentication = %d/%+v, want 1/%+v", name, calls, authenticated, actor)
		}
	}
	if p.ctx == nil {
		p.ctx, p.marker = ctx, marker
	} else if p.ctx != ctx || p.marker != marker {
		o.t.Errorf("Step.%s did not retain the tool context and request marker", name)
	}
	return p
}
func (o *mcpStepOperations) missing(name string) error {
	o.t.Errorf("unconfigured Step.%s callback", name)
	return errors.New("unconfigured Step." + name)
}

func (o *mcpStepOperations) ListPage(ctx context.Context, actor model.Principal, project, taskID string, after int64, limit int, version *int64, summary bool) (task.StepsPage, error) {
	p := o.invoke(ctx, actor, "ListPage")
	if p == nil || p.onListPage == nil {
		return task.StepsPage{}, o.missing("ListPage")
	}
	return p.onListPage(ctx, actor, project, taskID, after, limit, version, summary)
}
func (o *mcpStepOperations) GetSummary(ctx context.Context, actor model.Principal, project, taskID, id string) (task.StepSummary, error) {
	p := o.invoke(ctx, actor, "GetSummary")
	if p == nil || p.onGetSummary == nil {
		return task.StepSummary{}, o.missing("GetSummary")
	}
	return p.onGetSummary(ctx, actor, project, taskID, id)
}
func (o *mcpStepOperations) List(ctx context.Context, actor model.Principal, project, taskID string) (task.StepsDocument, error) {
	o.invoke(ctx, actor, "List")
	return task.StepsDocument{}, o.missing("List")
}
func (o *mcpStepOperations) Get(ctx context.Context, actor model.Principal, project, taskID, id string) (task.StepDocument, error) {
	p := o.invoke(ctx, actor, "Get")
	if p == nil || p.onGet == nil {
		return task.StepDocument{}, o.missing("Get")
	}
	return p.onGet(ctx, actor, project, taskID, id)
}
func (o *mcpStepOperations) Add(ctx context.Context, actor model.Principal, project, taskID string, input task.AddTaskStep) (task.StepsWriteResult, error) {
	p := o.invoke(ctx, actor, "Add")
	if p == nil || p.onAdd == nil {
		return task.StepsWriteResult{}, o.missing("Add")
	}
	return p.onAdd(ctx, actor, project, taskID, input)
}
func (o *mcpStepOperations) Update(ctx context.Context, actor model.Principal, project, taskID, id string, input task.UpdateTaskStep) (task.StepsWriteResult, error) {
	p := o.invoke(ctx, actor, "Update")
	if p == nil || p.onUpdate == nil {
		return task.StepsWriteResult{}, o.missing("Update")
	}
	return p.onUpdate(ctx, actor, project, taskID, id, input)
}
func (o *mcpStepOperations) SetStatus(ctx context.Context, actor model.Principal, project, taskID, id string, input task.SetTaskStepStatus) (task.StepsWriteResult, error) {
	p := o.invoke(ctx, actor, "SetStatus")
	if p == nil || p.onSetStatus == nil {
		return task.StepsWriteResult{}, o.missing("SetStatus")
	}
	return p.onSetStatus(ctx, actor, project, taskID, id, input)
}
func (o *mcpStepOperations) Move(ctx context.Context, actor model.Principal, project, taskID, id string, input task.MoveTaskStep) (task.StepsWriteResult, error) {
	p := o.invoke(ctx, actor, "Move")
	if p == nil || p.onMove == nil {
		return task.StepsWriteResult{}, o.missing("Move")
	}
	return p.onMove(ctx, actor, project, taskID, id, input)
}
func (o *mcpStepOperations) Delete(ctx context.Context, actor model.Principal, project, taskID, id string, input task.DeleteTaskStep) (task.StepsWriteResult, error) {
	p := o.invoke(ctx, actor, "Delete")
	if p == nil || p.onDelete == nil {
		return task.StepsWriteResult{}, o.missing("Delete")
	}
	return p.onDelete(ctx, actor, project, taskID, id, input)
}
