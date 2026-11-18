package worker

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

const workerRouteOrigin = "http://127.0.0.1:8787"
const workerRouteSession = "dnst_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

type workerRouteCall struct {
	name   string
	args   []any
	result any
	err    error
}

type workerRouteFixture struct {
	t              *testing.T
	actor          model.Principal
	cookie         *http.Cookie
	handler        http.Handler
	requestContext context.Context
	want           *workerRouteCall
	credentialUses int
}

func newWorkerRouteFixture(t *testing.T) *workerRouteFixture {
	t.Helper()
	f := &workerRouteFixture{
		t: t,
		actor: model.Principal{
			Kind: model.SessionCredential, UserID: "10000000-0000-4000-8000-000000000001",
			CredentialID: "20000000-0000-4000-8000-000000000001",
		},
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, credential string) (model.Principal, error) {
		f.credentialUses++
		if f.credentialUses != 1 || ctx != f.requestContext || kind != model.SessionCredential || credential != workerRouteSession {
			t.Errorf("unexpected Worker route credential: calls=%d kind=%q same context=%v",
				f.credentialUses, kind, ctx == f.requestContext)
			return model.Principal{}, authhttp.Failure()
		}
		return f.actor, nil
	}, authconfig.AuthSettings{PublicOrigin: workerRouteOrigin, AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	f.cookie = &http.Cookie{Name: auth.SessionCookieName(), Value: workerRouteSession}
	operations := &capacityReportOperations{
		t: t,
		report: func(ctx context.Context, actor model.Principal, id string, input model.WorkerReport) (workerservice.WorkerReportResult, error) {
			return workerRouteResult[workerservice.WorkerReportResult](f.take(ctx, actor, "Report", id, input))
		},
		get: func(ctx context.Context, actor model.Principal, id string) (workerservice.WorkerDetailResult, error) {
			return workerRouteResult[workerservice.WorkerDetailResult](f.take(ctx, actor, "Get", id))
		},
		list: func(ctx context.Context, actor model.Principal, page model.PageRequest) (workerservice.WorkerPage, error) {
			return workerRouteResult[workerservice.WorkerPage](f.take(ctx, actor, "List", page))
		},
		configuration: func(ctx context.Context, actor model.Principal, id string) (model.WorkerConfigurationResource, error) {
			return workerRouteResult[model.WorkerConfigurationResource](f.take(ctx, actor, "Configuration", id))
		},
		put: func(ctx context.Context, actor model.Principal, id, revision string, value model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
			return workerRouteResult[model.WorkerConfigurationResource](f.take(ctx, actor, "PutConfiguration", id, revision, value))
		},
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, operations, &authhttp.Authentication{RequestAuthentication: auth}, logger)
	f.handler = httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requestContext = r.Context()
		mux.ServeHTTP(w, r)
	}))
	return f
}

func (f *workerRouteFixture) take(ctx context.Context, actor model.Principal, name string, args ...any) workerRouteCall {
	f.t.Helper()
	want := f.want
	if want == nil || name != want.name || actor != f.actor || ctx != f.requestContext ||
		f.credentialUses != 1 || !reflect.DeepEqual(args, want.args) {
		f.t.Fatalf("unexpected Worker operation %s(%#v): principal=%+v same context=%v want=%#v",
			name, args, actor, ctx == f.requestContext, want)
	}
	f.want = nil
	return *want
}

func workerRouteResult[T any](call workerRouteCall) (T, error) {
	if call.err != nil {
		var zero T
		return zero, call.err
	}
	return call.result.(T), nil
}

func (f *workerRouteFixture) request(method, path, body string, want *workerRouteCall, versions ...string) *httptest.ResponseRecorder {
	f.t.Helper()
	f.want = want
	f.credentialUses = 0
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set(workerToolPathsHeader, "2")
	r.Header.Set("X-Request-ID", "project-test")
	r.AddCookie(f.cookie)
	r.Header.Set("Origin", workerRouteOrigin)
	for _, version := range versions {
		r.Header.Add(workerConfigurationHeader, version)
	}
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if f.credentialUses != 1 || f.want != nil {
		f.t.Fatalf("%s %s: credential calls=%d pending Worker operation=%#v", method, path, f.credentialUses, f.want)
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Daynight-User-ID") != f.actor.UserID {
		f.t.Fatalf("worker private response headers differ: %v", w.Header())
	}
	return w
}
