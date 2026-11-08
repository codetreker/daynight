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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
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

type sessionApplicationFactory func(*testing.T, *postgres.Store, filestorage.Storage) sessionApplication

func newSessionHTTPApplication(t *testing.T, database *postgres.Store, files filestorage.Storage) sessionApplication {
	t.Helper()
	handler, err := appsupport.NewHandler(configuredTestConfig(), database, database.Ready, files, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	return handler.(sessionApplication)
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

func newSessionPingApplication(t *testing.T, database *postgres.Store, files filestorage.Storage) sessionApplication {
	t.Helper()
	config := configuredTestConfig()
	client, err := service.NewIdentityClient(config)
	if err != nil {
		t.Fatal(err)
	}
	app := application.New(database, files, client, config.UniAuthCallbackURL, config.TaskSyncOverlap)
	auth, err := authhttp.NewAuthentication(app.Identity, configpkg.AuthSettings{PublicOrigin: config.PublicOrigin, AllowHTTPTestOrigin: config.AllowHTTPTestOrigin}, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	routes := sessionhttp.NewRoutesWithPingIntervalForTest(app.Sessions, auth, testLogger(), 100*time.Millisecond)
	mux := http.NewServeMux()
	routes.RegisterRoutes(mux)
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
