package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	bothttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
)

type botExpiryContextKey struct{}

type botExpiryCall struct {
	method           string
	contentType      string
	worker, bot      string
	input            any
	result           any
	err              error
	calls            int
	entered, release chan struct{}
}

type botExpiryFixture struct {
	t              *testing.T
	principal      model.Principal
	handler        http.Handler
	requestContext context.Context
	sourceContext  context.Context
	authCalls      int
	call           *botExpiryCall
}

func newBotExpiryFixture(t *testing.T, principal model.Principal) *botExpiryFixture {
	t.Helper()
	f := &botExpiryFixture{t: t, principal: principal}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	requestAuth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		f.authCalls++
		if f.authCalls != 1 || !f.sameContext(ctx) || kind != principal.Kind || token != httpTestToken(principal.Kind) {
			t.Errorf("unexpected Bot credential identity, context, or call count")
			return model.Principal{}, authhttp.Failure()
		}
		return principal, nil
	}, authconfig.AuthSettings{PublicOrigin: configuredTestConfig().Server.PublicOrigin}, logger)
	if err != nil {
		t.Fatal(err)
	}
	auth := &authhttp.Authentication{RequestAuthentication: requestAuth}
	mux := http.NewServeMux()
	bothttp.RegisterRoutes(mux, f, f, auth, logger)
	bothttp.RegisterRuntimeRoutes(mux, f, f, auth, sessionhttp.NewRoutes(nil, auth, logger), logger)
	f.handler = httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requestContext = r.Context()
		mux.ServeHTTP(w, r)
	}))
	return f
}

func (f *botExpiryFixture) unexpected(method string) error {
	f.t.Errorf("unconfigured or extra Bot operation: %s", method)
	return errors.New("unconfigured or extra Bot operation: " + method)
}

func (f *botExpiryFixture) sameContext(ctx context.Context) bool {
	actualDeadline, actualHasDeadline := ctx.Deadline()
	wantDeadline, wantHasDeadline := f.sourceContext.Deadline()
	return ctx == f.requestContext && ctx.Done() == f.sourceContext.Done() && actualHasDeadline == wantHasDeadline && actualDeadline.Equal(wantDeadline) && ctx.Value(botExpiryContextKey{}) == "request" && ctx.Err() == nil
}

func (f *botExpiryFixture) invoke(ctx context.Context, p model.Principal, method, worker, bot string, input any) (any, error) {
	c := f.call
	if c == nil || c.method != method || c.calls != 0 {
		return nil, f.unexpected(method)
	}
	c.calls++
	if !f.sameContext(ctx) || p != f.principal || worker != c.worker || bot != c.bot || !reflect.DeepEqual(input, c.input) {
		f.t.Errorf("%s context, principal, identity, or input differs", method)
	}
	if c.entered != nil {
		close(c.entered)
		select {
		case <-c.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return c.result, c.err
}

func (f *botExpiryFixture) RegisterBot(ctx context.Context, p model.Principal, worker, bot string, input sessioncore.BotRegistration) (sessioncore.BotRegistrationResult, error) {
	v, err := f.invoke(ctx, p, "RegisterBot", worker, bot, input)
	if err != nil {
		return sessioncore.BotRegistrationResult{}, err
	}
	return v.(sessioncore.BotRegistrationResult), nil
}
func (f *botExpiryFixture) ReportBot(ctx context.Context, p model.Principal, worker, bot string, input sessioncore.BotReport) (model.Bot, error) {
	v, err := f.invoke(ctx, p, "ReportBot", worker, bot, input)
	if err != nil {
		return model.Bot{}, err
	}
	return v.(model.Bot), nil
}
func (f *botExpiryFixture) DeleteBot(ctx context.Context, p model.Principal, bot string, input store.DeleteBot) (model.Bot, error) {
	v, err := f.invoke(ctx, p, "DeleteBot", "", bot, input)
	if err != nil {
		return model.Bot{}, err
	}
	return v.(model.Bot), nil
}
func (f *botExpiryFixture) GrantBot(context.Context, model.Principal, string, string, sessioncore.BotGrant) (sessioncore.GrantResult, error) {
	return sessioncore.GrantResult{}, f.unexpected("GrantBot")
}
func (f *botExpiryFixture) CompleteBotDeletion(context.Context, model.Principal, string, string, botservice.BotDeletionReceipt) (model.Bot, error) {
	return model.Bot{}, f.unexpected("CompleteBotDeletion")
}
func (f *botExpiryFixture) CreateResolved(context.Context, model.Principal, botcore.CreateBot) (model.Bot, error) {
	return model.Bot{}, f.unexpected("CreateResolved")
}
func (f *botExpiryFixture) Defaults(context.Context, model.Principal, *string) (botcore.BotDefaults, error) {
	return botcore.BotDefaults{}, f.unexpected("Defaults")
}
func (f *botExpiryFixture) List(context.Context, model.Principal, model.PageRequest) (botcore.BotPage, error) {
	return botcore.BotPage{}, f.unexpected("List")
}
func (f *botExpiryFixture) ListWorker(context.Context, model.Principal, string, model.PageRequest) (botcore.BotPage, error) {
	return botcore.BotPage{}, f.unexpected("ListWorker")
}
func (f *botExpiryFixture) Get(context.Context, model.Principal, string) (model.Bot, error) {
	return model.Bot{}, f.unexpected("Get")
}

func (f *botExpiryFixture) dispatch(ctx context.Context, method, path, body string, c *botExpiryCall) *httptest.ResponseRecorder {
	f.t.Helper()
	if f.call != nil {
		f.t.Fatal("Bot operation already configured")
	}
	f.call, f.authCalls, f.sourceContext = c, 0, ctx
	defer func() { f.call = nil }()
	r := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(ctx)
	contentType := c.contentType
	if contentType == "" {
		contentType = "application/json"
	}
	r.Header.Set("Content-Type", contentType)
	r.Header.Set("X-Request-ID", "project-test")
	if method == http.MethodDelete {
		r.Header.Set("Origin", configuredTestConfig().Server.PublicOrigin)
	}
	if f.principal.Kind == model.PATCredential {
		r.Header.Set("Authorization", "Bearer "+httpTestToken(f.principal.Kind))
	} else {
		r.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: httpTestToken(f.principal.Kind)})
	}
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, r)
	if c.calls != 1 || f.authCalls != 1 {
		f.t.Errorf("%s calls=%d, authentication calls=%d; want one each", c.method, c.calls, f.authCalls)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.principal.UserID {
		f.t.Errorf("Bot private headers: %v", response.Header())
	}
	return response
}

func blockedBotExpiryResponse(t *testing.T, ctx context.Context, cancel context.CancelFunc, call *botExpiryCall, request func() *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	call.entered, call.release = make(chan struct{}), make(chan struct{})
	result, finished := make(chan *httptest.ResponseRecorder, 1), make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(call.release) }) }
	t.Cleanup(func() {
		release()
		cancel()
		select {
		case <-finished:
		case <-time.After(3 * time.Second):
			t.Error("Bot HTTP operation did not stop during cleanup")
		}
	})
	go func() { defer close(finished); result <- request() }()
	select {
	case <-call.entered:
	case <-finished:
		t.Fatal("Bot request completed before its operation")
	case <-ctx.Done():
		t.Fatal("Bot request did not reach its operation")
	}
	release()
	select {
	case response := <-result:
		return response
	case <-ctx.Done():
		t.Fatal("Bot request did not finish after its operation")
		return nil
	}
}

func botExpiryClonePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
func botExpiryCloneSlice[T any](value []T) []T {
	if value == nil {
		return nil
	}
	cloned := make([]T, len(value))
	copy(cloned, value)
	return cloned
}
func botExpiryCloneBot(value model.Bot) model.Bot {
	value.RequestedOverrides.WorkerID = botExpiryClonePointer(value.RequestedOverrides.WorkerID)
	value.RequestedOverrides.Cwd = botExpiryClonePointer(value.RequestedOverrides.Cwd)
	value.RequestedOverrides.Provider = botExpiryClonePointer(value.RequestedOverrides.Provider)
	value.RequestedOverrides.Model = botExpiryClonePointer(value.RequestedOverrides.Model)
	value.RequestedOverrides.ReasoningEffort = botExpiryClonePointer(value.RequestedOverrides.ReasoningEffort)
	value.ResolvedConfiguration.Args = botExpiryCloneSlice(value.ResolvedConfiguration.Args)
	value.ResolvedConfiguration.Model = botExpiryClonePointer(value.ResolvedConfiguration.Model)
	value.ResolvedConfiguration.ReasoningEffort = botExpiryClonePointer(value.ResolvedConfiguration.ReasoningEffort)
	value.ResolvedConfiguration.Selection = botExpiryClonePointer(value.ResolvedConfiguration.Selection)
	value.RoleConfiguration = botExpiryClonePointer(value.RoleConfiguration)
	value.SessionID = botExpiryClonePointer(value.SessionID)
	value.TestExecutionID = botExpiryClonePointer(value.TestExecutionID)
	value.StartupResult.Code = botExpiryClonePointer(value.StartupResult.Code)
	value.Deletion = botExpiryClonePointer(value.Deletion)
	if value.Deletion != nil {
		value.Deletion.WorkerCleanup.Code = botExpiryClonePointer(value.Deletion.WorkerCleanup.Code)
		value.Deletion.ServerCleanup.Code = botExpiryClonePointer(value.Deletion.ServerCleanup.Code)
	}
	return value
}
func botExpiryCloneSnapshot(value sp.Snapshot) sp.Snapshot {
	value.Identity.NativeSessionID = botExpiryClonePointer(value.Identity.NativeSessionID)
	value.TurnStartedAt = botExpiryClonePointer(value.TurnStartedAt)
	value.CurrentTurnID = botExpiryClonePointer(value.CurrentTurnID)
	value.CleanupInteractionIDs = botExpiryCloneSlice(value.CleanupInteractionIDs)
	value.Controls = botExpiryClonePointer(value.Controls)
	if value.Controls != nil {
		value.Controls.SettingsError = botExpiryClonePointer(value.Controls.SettingsError)
		value.Controls.CommandsError = botExpiryClonePointer(value.Controls.CommandsError)
		value.Controls.Settings = botExpiryCloneSlice(value.Controls.Settings)
		for i := range value.Controls.Settings {
			s := &value.Controls.Settings[i]
			s.Description = botExpiryClonePointer(s.Description)
			s.Value = botExpiryClonePointer(s.Value)
			s.Options = botExpiryCloneSlice(s.Options)
		}
		value.Controls.Commands = botExpiryCloneSlice(value.Controls.Commands)
		for i := range value.Controls.Commands {
			value.Controls.Commands[i].ArgumentHint = botExpiryClonePointer(value.Controls.Commands[i].ArgumentHint)
		}
	}
	return value
}
