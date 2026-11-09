package session_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
)

type sessionApplication interface {
	http.Handler
	Shutdown(context.Context) error
}
type sessionApplicationFactory func(*testing.T, *routeBackend, *routeAuthentication) sessionApplication

type routeApplication struct {
	http.Handler
	Routes         *sessionhttp.Routes
	Backend        *routeBackend
	Authentication *routeAuthentication
}

func (a *routeApplication) Shutdown(ctx context.Context) error { return a.Routes.Shutdown(ctx) }

func newRouteApplication(t *testing.T, backend *routeBackend, auth *routeAuthentication, logger *slog.Logger, ping time.Duration) *routeApplication {
	t.Helper()
	var routes *sessionhttp.Routes
	if ping == 0 {
		routes = sessionhttp.NewRoutesForTest(backend.Calls, auth.Authentication, logger)
	} else {
		routes = sessionhttp.NewRoutesWithPingIntervalForTest(backend.Calls, auth.Authentication, logger, ping)
	}
	lifetime, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	backend.mu.Lock()
	previous := backend.OnFailure
	backend.OnFailure = func(err error) {
		cancel()
		if previous != nil {
			previous(err)
		}
	}
	backend.mu.Unlock()
	mux := http.NewServeMux()
	routes.RegisterRoutes(mux)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, stopRequest := context.WithCancel(r.Context())
		stop := context.AfterFunc(lifetime, stopRequest)
		defer func() { stop(); stopRequest() }()
		mux.ServeHTTP(w, r.WithContext(ctx))
	})
	return &routeApplication{Handler: handler, Routes: routes, Backend: backend, Authentication: auth}
}
func newSessionHTTPApplication(t *testing.T, backend *routeBackend, auth *routeAuthentication) sessionApplication {
	return newRouteApplication(t, backend, auth, testLogger(), 0)
}
func newSessionPingApplication(t *testing.T, backend *routeBackend, auth *routeAuthentication) sessionApplication {
	return newRouteApplication(t, backend, auth, testLogger(), 100*time.Millisecond)
}
func testLogger() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }
