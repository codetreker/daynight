package session_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/appsupport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
)

type sessionApplication interface {
	http.Handler
	Shutdown(context.Context) error
}

type sessionApplicationFactory func(*testing.T, *sessionHTTPFixture) sessionApplication

func preparedSessionHTTPApplication(t *testing.T, fixture *sessionHTTPFixture) sessionApplication {
	t.Helper()
	return fixture.handler.application
}

func newSessionSecureApplication(t *testing.T, fixture *sessionHTTPFixture) sessionApplication {
	t.Helper()
	handler, err := appsupport.NewHandler(configuredTestConfig(), fixture.db, fixture.db.Ready, attachmentTestFiles(t), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	stopSessionPreparation(t, fixture)
	return handler.(sessionApplication)
}

func stopSessionPreparation(t *testing.T, fixture *sessionHTTPFixture) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := fixture.handler.application.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}

type sessionPingApplication struct {
	http.Handler
	routes *sessionhttp.Routes
	engine *sessioncore.Engine
}

func (a *sessionPingApplication) Shutdown(ctx context.Context) error {
	routeErr := a.routes.Shutdown(ctx)
	return errors.Join(routeErr, a.engine.Stop(ctx))
}

func newSessionPingApplication(t *testing.T, fixture *sessionHTTPFixture) sessionApplication {
	t.Helper()
	config := fixture.handler.configuration
	client, err := service.NewIdentityClient(config)
	if err != nil {
		t.Fatal(err)
	}
	app := application.New(fixture.db, attachmentTestFiles(t), client, config.UniAuthCallbackURL, config.TaskSyncOverlap)
	auth, err := authhttp.NewAuthentication(app.Identity, configpkg.AuthSettings{PublicOrigin: config.PublicOrigin, AllowHTTPTestOrigin: config.AllowHTTPTestOrigin}, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	routes := sessionhttp.NewRoutesWithPingIntervalForTest(app.Sessions, auth, testLogger(), 100*time.Millisecond)
	mux := http.NewServeMux()
	routes.RegisterRoutes(mux)
	stopSessionPreparation(t, fixture)
	return &sessionPingApplication{Handler: mux, routes: routes, engine: app.Engine}
}

func configuredTestConfig() configpkg.Config {
	return configpkg.Config{
		DatabaseURL: "postgres://database", StorageRoot: "storage", ListenAddress: "127.0.0.1:0",
		StartupTimeout: 5 * time.Second, ShutdownTimeout: time.Second, TaskSyncOverlap: 10 * time.Second,
		PublicOrigin: "https://daynight.example", UniAuthURL: "https://auth.example",
		UniAuthAppID: "configuration-test", UniAuthAppSecret: "configuration-test",
		UniAuthCallbackURL: "https://daynight.example/api/v1/auth/callback",
	}
}

func testLogger() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }
