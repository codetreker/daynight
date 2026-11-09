package session_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

type sessionApplication interface {
	http.Handler
	Shutdown(context.Context) error
}
type sessionApplicationFactory func(*testing.T, *routeBackend, *routeAuthentication, filestorage.Storage) sessionApplication

type routeApplication struct {
	http.Handler
	Service        *sessionservice.Service
	Engine         *sessioncore.Engine
	Routes         *sessionhttp.Routes
	Backend        *routeBackend
	Authentication *routeAuthentication
	Files          filestorage.Storage
}

func (a *routeApplication) Shutdown(ctx context.Context) error {
	return errors.Join(a.Routes.Shutdown(ctx), a.Engine.Stop(ctx))
}

func newRouteApplication(t *testing.T, backend *routeBackend, auth *routeAuthentication, files filestorage.Storage, logger *slog.Logger, ping time.Duration) *routeApplication {
	t.Helper()
	engine := sessioncore.NewEngine(files)
	service := sessionservice.New(backend, engine)
	var routes *sessionhttp.Routes
	if ping == 0 {
		routes = sessionhttp.NewRoutes(service, auth.Authentication, logger)
	} else {
		routes = sessionhttp.NewRoutesWithPingIntervalForTest(service, auth.Authentication, logger, ping)
	}
	lifetime, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	backend.mu.Lock()
	previousFailure := backend.OnFailure
	backend.OnFailure = func(err error) {
		cancel()
		if previousFailure != nil {
			previousFailure(err)
		}
	}
	backend.mu.Unlock()
	mux := http.NewServeMux()
	routes.RegisterRoutes(mux)
	return &routeApplication{Handler: withRoutePlanLifetime(backend, mux, lifetime), Service: service, Engine: engine, Routes: routes, Backend: backend, Authentication: auth, Files: files}
}

func newSessionHTTPApplication(t *testing.T, backend *routeBackend, auth *routeAuthentication, files filestorage.Storage) sessionApplication {
	return newRouteApplication(t, backend, auth, files, testLogger(), 0)
}

func newSessionPingApplication(t *testing.T, backend *routeBackend, auth *routeAuthentication, files filestorage.Storage) sessionApplication {
	return newRouteApplication(t, backend, auth, files, testLogger(), 100*time.Millisecond)
}

func withRoutePlans(backend *routeBackend, next http.Handler) http.Handler {
	return withRoutePlanLifetime(backend, next, context.Background())
}

func withRoutePlanLifetime(backend *routeBackend, next http.Handler, lifetime context.Context) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		names := []string{}
		if value := r.Header.Get(routePlanHeader); value != "" {
			names = strings.Split(value, ",")
		}
		requestContext, cancel := context.WithCancel(r.Context())
		stop := context.AfterFunc(lifetime, cancel)
		defer func() { stop(); cancel() }()
		ctx := backend.Plan(requestContext, names...)
		defer backend.Finish(ctx)
		request := r.Clone(ctx)
		request.Header.Del(routePlanHeader)
		next.ServeHTTP(w, request)
	})
}

func testLogger() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }
