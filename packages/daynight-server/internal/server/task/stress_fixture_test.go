//go:build stress

package task_test

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	storageconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	databaseconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/config"
	serverconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/appsupport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	applicationconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/application/config"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	identityconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity/config"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

func projectTestStore(t *testing.T) *postgres.Store { return testsupport.TestStore(t) }
func projectTestHandler(t *testing.T, database *postgres.Store, output io.Writer) *resourceTestHandler {
	t.Helper()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	instance := httptest.NewUnstartedServer(nil)
	t.Cleanup(instance.Close)
	origin := "http://" + instance.Listener.Addr().String()
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	config := configpkg.Config{
		Database: databaseconfig.Config{URL: "postgres://database"},
		Storage:  storageconfig.Config{Root: "storage"},
		Server:   serverconfig.Config{ListenAddress: "127.0.0.1:0", StartupTimeout: 5 * time.Second, ShutdownTimeout: time.Second, PublicOrigin: origin, AllowHTTPTestOrigin: true},
		TaskSync: applicationconfig.TaskSyncConfig{Overlap: 10 * time.Second},
		UniAuth:  identityconfig.Config{URL: gateway.Origin, AppID: gateway.AppID, AppSecret: gateway.AppSecret, CallbackURL: callback, AllowLoopbackHTTP: true},
	}
	logger := slog.New(slog.NewJSONHandler(output, nil))
	handler, err := appsupport.NewHandler(config, database, database.Ready, files, logger)
	if err != nil {
		t.Fatal(err)
	}
	application, ok := handler.(interface{ Shutdown(context.Context) error })
	if !ok {
		t.Fatal("stress application does not support shutdown")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := application.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	instance.Config.Handler = httpx.RequestLogging(logger, handler)
	instance.Start()
	browser := testauth.Browser(t)
	testauth.Login(t, browser, origin, "alice")
	token := testauth.CreatePAT(t, browser, origin)
	client, err := uniauth.New(uniauth.Config{BaseURL: gateway.Origin, AppID: gateway.AppID, AppSecret: gateway.AppSecret, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	principal, err := identityservice.New(database, client, callback).Authenticate(context.Background(), model.PATCredential, token)
	if err != nil {
		t.Fatal(err)
	}
	return &resourceTestHandler{Handler: instance.Config.Handler, token: token, principal: principal}
}

func stepsHTTPFixture(t *testing.T, logs io.Writer) (*postgres.Store, *resourceTestHandler, api.Task) {
	t.Helper()
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, logs)
	project := decodeResponse[api.Project](t, projectRequest(handler, "POST", "/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Steps", RepoURL: "https://example.com/steps", ExpectedUserID: handler.principal.UserID})), 201)
	task := decodeResponse[api.Task](t, projectRequest(handler, "POST", "/api/v1/projects/"+project.ID+"/tasks", `{"title":"Parent"}`), 201)
	return database, handler, task
}
