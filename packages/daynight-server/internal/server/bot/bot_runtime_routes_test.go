package bot_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	bothttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/google/uuid"
)

func TestBotRuntimeHTTPChecksCredentialAfterUnchangedBotLockWait(t *testing.T) {
	for _, operation := range []string{"register", "report", "report_replay"} {
		for _, expired := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/expired=%t", operation, expired), func(t *testing.T) {
				principal := defaultHTTPPrincipal()
				f := newBotExpiryFixture(t, principal)
				worker, botID := uuid.NewString(), uuid.NewString()
				configuration := model.BotConfiguration{WorkerID: worker, Cwd: "/private/bot-work", Provider: "codex", Args: []string{}}
				instant := time.Date(2026, 11, 8, 1, 0, 0, 0, time.UTC)
				bot := model.Bot{ID: botID, OwnerUserID: principal.UserID, WorkerID: worker, Name: "长期助手", Version: 1, ResolvedConfiguration: configuration, StartupResult: model.BotStartupResult{State: "pending"}, CreatedAt: instant, UpdatedAt: instant}
				ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), botExpiryContextKey{}, "request"), 5*time.Second)
				defer cancel()
				base := "/api/v1/me/workers/" + worker + "/bots/" + botID
				code := "directory_missing"
				report := sessioncore.BotReport{BotVersion: 1, Result: model.BotStartupResult{State: "failed", Code: &code}}
				instructions := "Use the Daynight CLI."
				registration := sessioncore.BotRegistration{BotVersion: 1, Configuration: configuration, RoleConfiguration: model.BotRoleConfiguration{Instructions: instructions, Revision: "v1", Digest: fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}, Registration: sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}}
				sessionID, historyEpoch := uuid.NewString(), uuid.NewString()
				snapshot := func() sp.Snapshot {
					return sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: sessionID, TestExecutionID: registration.Registration.TestExecutionID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{OwnerUserID: principal.UserID, ControllerID: registration.Registration.ControllerID, ControllerInstanceID: registration.Registration.ControllerInstanceID, AgentControlMode: "web", Provider: "codex"}, SessionRevision: "1", HistoryEpoch: historyEpoch, LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: "not_required", Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}
				}
				registered := func() sessioncore.BotRegistrationResult {
					bound := botExpiryCloneBot(bot)
					bound.Version, bound.UpdatedAt = 2, instant.Add(time.Second)
					bound.SessionID = botExpiryClonePointer(&sessionID)
					bound.TestExecutionID = botExpiryClonePointer(&registration.Registration.TestExecutionID)
					bound.RoleConfiguration = botExpiryClonePointer(&registration.RoleConfiguration)
					return sessioncore.BotRegistrationResult{Bot: bound, Session: botExpiryCloneSnapshot(snapshot())}
				}
				reported := func() model.Bot {
					out := botExpiryCloneBot(bot)
					out.Version, out.UpdatedAt = 2, instant.Add(time.Second)
					out.StartupResult = model.BotStartupResult{State: "failed", Code: botExpiryClonePointer(&code)}
					return out
				}
				registerCall := func() *botExpiryCall {
					expected := registration
					expected.Configuration.Args = botExpiryCloneSlice(registration.Configuration.Args)
					return &botExpiryCall{method: "RegisterBot", worker: worker, bot: botID, input: expected, result: registered()}
				}
				wantBot := func(bound bool) api.Bot {
					definition := &api.BotDefinition{OwnerUserID: principal.UserID, Name: "长期助手", ResolvedConfiguration: api.BotConfiguration{WorkerID: worker, Cwd: "/private/bot-work", Provider: "codex", Args: []string{}}, StartupResult: api.BotResult{State: "pending"}, CreatedAt: instant, UpdatedAt: instant.Add(time.Second)}
					if bound {
						definition.RoleConfiguration = &api.BotRoleConfiguration{Instructions: instructions, Revision: "v1", Digest: fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}
						definition.SessionID = botExpiryClonePointer(&sessionID)
						definition.TestExecutionID = botExpiryClonePointer(&registration.Registration.TestExecutionID)
					} else {
						definition.StartupResult = api.BotResult{State: "failed", Code: botExpiryClonePointer(&code)}
					}
					return api.Bot{ID: botID, WorkerID: worker, Version: 2, BotDefinition: definition}
				}
				reportCall := func(in sessioncore.BotReport, err error) *botExpiryCall {
					in.Result.Code = botExpiryClonePointer(in.Result.Code)
					return &botExpiryCall{method: "ReportBot", worker: worker, bot: botID, input: in, result: reported(), err: err}
				}
				request := func(path string, body any, call *botExpiryCall) *httptest.ResponseRecorder {
					return f.dispatch(ctx, http.MethodPost, path, jsonBody(t, body), call)
				}
				path := base + "/report"
				if operation == "report_replay" {
					setup := reportCall(report, nil)
					setup.contentType = "application/json; charset=UTF-8"
					out := decodeResponse[api.Bot](t, request(path, report, setup), http.StatusOK)
					if !reflect.DeepEqual(out, wantBot(false)) {
						t.Fatal("failure setup did not return the planned version and result")
					}
					report.BotVersion = 2
				}
				var call *botExpiryCall
				var body any = report
				if operation == "register" {
					path, body = base+"/register", registration
					call = registerCall()
				} else {
					call = reportCall(report, nil)
				}
				if expired {
					call.err = &model.Fault{Code: "unauthenticated", Message: "Credential expired or was revoked."}
				}
				response := blockedBotExpiryResponse(t, ctx, cancel, call, func() *httptest.ResponseRecorder { return request(path, body, call) })
				if expired {
					assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
					return
				}
				if operation == "register" {
					type registrationResult struct {
						Bot     api.Bot     `json:"bot"`
						Session sp.Snapshot `json:"session"`
					}
					out := decodeResponse[registrationResult](t, response, http.StatusOK)
					if !reflect.DeepEqual(out.Bot, wantBot(true)) || !reflect.DeepEqual(out.Session, snapshot()) || out.Session.HistoryEpoch == "" {
						t.Fatal("valid PAT did not retain the independent binding and initial Session facts")
					}
					replayCall := registerCall()
					replayCall.contentType = "application/json; charset=UTF-8"
					replayResponse := request(path, registration, replayCall)
					replay := decodeResponse[registrationResult](t, replayResponse, http.StatusOK)
					var originalWire, replayWire struct {
						Bot json.RawMessage `json:"bot"`
					}
					if err := json.Unmarshal(response.Body.Bytes(), &originalWire); err != nil {
						t.Fatal(err)
					}
					if err := json.Unmarshal(replayResponse.Body.Bytes(), &replayWire); err != nil {
						t.Fatal(err)
					}
					if !bytes.Equal(originalWire.Bot, replayWire.Bot) || replay.Session.SessionID != out.Session.SessionID || replay.Session.TestExecutionID != out.Session.TestExecutionID {
						t.Fatal("valid registration replay changed its result")
					}
				} else {
					out := decodeResponse[api.Bot](t, response, http.StatusOK)
					if !reflect.DeepEqual(out, wantBot(false)) {
						t.Fatal("valid PAT changed preflight semantics")
					}
					report.BotVersion = 2
					replayCall := reportCall(report, nil)
					replayCall.contentType = "application/json; charset=UTF-8"
					replayResponse := request(path, report, replayCall)
					decodeResponse[api.Bot](t, replayResponse, http.StatusOK)
					if !bytes.Equal(replayResponse.Body.Bytes(), response.Body.Bytes()) {
						t.Fatal("valid failure replay changed its result")
					}
				}
			})
		}
	}
}

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
	}, authconfig.AuthSettings{PublicOrigin: botExpiryOrigin}, logger)
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
		r.Header.Set("Origin", botExpiryOrigin)
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

const botExpiryOrigin = "https://daynight.example"

func defaultHTTPPrincipal() model.Principal {
	return model.Principal{UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222", Kind: model.PATCredential}
}

func httpTestToken(kind model.CredentialKind) string {
	const value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	switch kind {
	case model.PATCredential:
		return "dnpat_" + value
	case model.SessionCredential:
		return "dnst_" + value
	default:
		panic("unsupported HTTP fixture credential kind: " + string(kind))
	}
}
