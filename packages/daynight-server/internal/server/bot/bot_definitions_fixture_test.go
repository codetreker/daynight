package bot_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	bothttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type botDefinitionCall struct {
	method string
	id     string
	input  any
	result any
	err    error
}

type botDefinitionAuthentication int

const (
	botDefinitionAdmitted botDefinitionAuthentication = iota
	botDefinitionAnonymous
	botDefinitionRevoked
)

type botDefinitionsFixture struct {
	t              *testing.T
	principal      model.Principal
	handler        http.Handler
	requestContext context.Context
	authentication botDefinitionAuthentication
	authCalls      int
	want           *botDefinitionCall
}

func newBotDefinitionsFixture(t *testing.T, logs io.Writer) *botDefinitionsFixture {
	t.Helper()
	f := &botDefinitionsFixture{t: t, principal: defaultHTTPPrincipal()}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		f.authCalls++
		if f.authCalls != 1 || f.authentication == botDefinitionAnonymous || ctx != f.requestContext ||
			kind != f.principal.Kind || token != httpTestToken(f.principal.Kind) {
			t.Error("unexpected Bot credential identity, context, or call count")
			return model.Principal{}, authhttp.Failure()
		}
		if f.authentication == botDefinitionRevoked {
			return model.Principal{}, authhttp.Failure()
		}
		return f.principal, nil
	}, authconfig.AuthSettings{PublicOrigin: botExpiryOrigin}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	bothttp.RegisterRoutes(mux, f, f, &authhttp.Authentication{RequestAuthentication: auth}, logger)
	f.handler = httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requestContext = r.Context()
		mux.ServeHTTP(w, r)
	}))
	return f
}

func (f *botDefinitionsFixture) invoke(ctx context.Context, p model.Principal, method, id string, input any) botDefinitionCall {
	f.t.Helper()
	want := f.want
	if want == nil || want.method != method || want.id != id || !reflect.DeepEqual(want.input, input) ||
		f.authentication != botDefinitionAdmitted || f.authCalls != 1 || ctx != f.requestContext || p != f.principal {
		f.t.Fatalf("unexpected Bot %s(%q, %#v): principal=%+v same context=%v want=%#v",
			method, id, input, p, ctx == f.requestContext, want)
	}
	f.want = nil
	return *want
}

func botDefinitionResult[T any](call botDefinitionCall) (T, error) {
	if call.err != nil {
		var zero T
		return zero, call.err
	}
	return call.result.(T), nil
}

func (f *botDefinitionsFixture) unexpected(method string) error {
	f.t.Helper()
	f.t.Errorf("unconfigured Bot operation: %s", method)
	return fmt.Errorf("unconfigured Bot operation: %s", method)
}

func (f *botDefinitionsFixture) CreateResolved(context.Context, model.Principal, botcore.CreateBot) (model.Bot, error) {
	return model.Bot{}, f.unexpected("CreateResolved")
}

func (f *botDefinitionsFixture) Defaults(context.Context, model.Principal, *string) (botcore.BotDefaults, error) {
	return botcore.BotDefaults{}, f.unexpected("Defaults")
}

func (f *botDefinitionsFixture) List(ctx context.Context, p model.Principal, page model.PageRequest) (botcore.BotPage, error) {
	return botDefinitionResult[botcore.BotPage](f.invoke(ctx, p, "List", "", page))
}

func (f *botDefinitionsFixture) ListWorker(ctx context.Context, p model.Principal, id string, page model.PageRequest) (botcore.BotPage, error) {
	return botDefinitionResult[botcore.BotPage](f.invoke(ctx, p, "ListWorker", id, page))
}

func (f *botDefinitionsFixture) Get(ctx context.Context, p model.Principal, id string) (model.Bot, error) {
	return botDefinitionResult[model.Bot](f.invoke(ctx, p, "Get", id, nil))
}

func (f *botDefinitionsFixture) DeleteBot(ctx context.Context, p model.Principal, id string, input store.DeleteBot) (model.Bot, error) {
	return botDefinitionResult[model.Bot](f.invoke(ctx, p, "DeleteBot", id, input))
}

func (f *botDefinitionsFixture) request(method, path, body string, want *botDefinitionCall) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.dispatch(method, path, body, botDefinitionAdmitted, want)
}

func (f *botDefinitionsFixture) dispatch(method, path, body string, auth botDefinitionAuthentication, want *botDefinitionCall) *httptest.ResponseRecorder {
	f.t.Helper()
	f.want, f.authentication, f.authCalls = want, auth, 0
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json; charset=UTF-8")
	r.Header.Set("X-Request-ID", "project-test")
	wantAuthCalls := 0
	if auth != botDefinitionAnonymous {
		r.Header.Set("Authorization", "Bearer "+httpTestToken(f.principal.Kind))
		wantAuthCalls = 1
	}
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if f.authCalls != wantAuthCalls || f.want != nil {
		f.t.Fatalf("%s %s: credential calls=%d want=%d pending Bot operation=%#v", method, path, f.authCalls, wantAuthCalls, f.want)
	}
	var userID string
	if auth == botDefinitionAdmitted {
		userID = f.principal.UserID
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Daynight-User-ID") != userID {
		f.t.Fatalf("unexpected private response headers: %v", w.Header())
	}
	return w
}
