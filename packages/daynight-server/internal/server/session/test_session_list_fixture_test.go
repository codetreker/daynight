package session_test

import (
	"context"
	"io"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

type listRequestContextKey struct{}

type listHTTPFixture struct {
	t             *testing.T
	handler       *resourceTestHandler
	auth          *routeAuthentication
	backend       *routeBackend
	contextMarker *struct{}
	expectedCalls int
}

func newListHTTPFixture(t *testing.T) *listHTTPFixture {
	t.Helper()
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	auth, backend := newRouteAuthentication(t, "https://daynight.example"), newRouteBackend(t)
	handler := newResourceTestHandler(t, backend, auth, principal, io.Discard)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := handler.application.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	return &listHTTPFixture{t: t, handler: handler, auth: auth, backend: backend, contextMarker: &struct{}{}}
}

func (f *listHTTPFixture) Expect(cursor string, limit int, online bool, page sessioncore.TestListPage, cause error) {
	f.t.Helper()
	f.expectedCalls++
	f.backend.ExpectCalls("ListTest", f.expectedCalls)
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.ListTest = func(ctx context.Context, principal model.Principal, actualCursor string, actualLimit int, actualOnline bool) (sessioncore.TestListPage, error) {
			if ctx.Err() != nil || ctx.Value(listRequestContextKey{}) != f.contextMarker || principal != f.handler.principal || actualCursor != cursor || actualLimit != limit || actualOnline != online {
				f.t.Errorf("list use-case arguments changed: principal=%+v cursor=%q limit=%d online=%t context=%v", principal, actualCursor, actualLimit, actualOnline, ctx.Err())
			}
			return routeCopy(page), cause
		}
	})
}

func (f *listHTTPFixture) Finish() {
	f.t.Helper()
	if got := f.backend.Called("ListTest"); got != f.expectedCalls {
		f.t.Fatalf("ListTest calls = %d, want %d", got, f.expectedCalls)
	}
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) { calls.ListTest = nil })
}

func (f *listHTTPFixture) Request(method, path string, authenticated bool) *httptest.ResponseRecorder {
	f.t.Helper()
	expected := 0
	if authenticated {
		expected = 1
	}
	f.auth.ExpectCalls(expected)
	before := f.auth.Count()
	request := httptest.NewRequest(method, path, nil)
	request = request.WithContext(context.WithValue(request.Context(), listRequestContextKey{}, f.contextMarker))
	if authenticated {
		authorizeResourceRequest(f.handler, request)
	}
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	if f.auth.Count() != before+expected {
		f.t.Fatal("list route changed its authentication call count")
	}
	return response
}
