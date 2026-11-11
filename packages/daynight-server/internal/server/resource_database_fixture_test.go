//go:build stress || webhooktest

package server

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"testing"
	"time"

	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
)

func resourceDatabaseTestServer(t *testing.T, database *postgres.Store, files filestorage.Storage, output io.Writer) *resourceTestHandler {
	t.Helper()
	server := httptest.NewUnstartedServer(nil)
	t.Cleanup(server.Close)
	origin := "http://" + server.Listener.Addr().String()
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	config := configuredTestConfig()
	config.Server.PublicOrigin = origin
	config.UniAuth.CallbackURL = callback
	config.UniAuth.URL = gateway.Origin
	config.UniAuth.AppID = gateway.AppID
	config.UniAuth.AppSecret = gateway.AppSecret
	config.Server.AllowHTTPTestOrigin = true
	config.UniAuth.AllowLoopbackHTTP = true
	logger := slog.New(slog.NewJSONHandler(output, nil))
	handler, err := newTestHandler(Dependencies{Store: database, Ready: database.Ready, Files: files}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := handler.(*sessionApplication).Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	server.Config.Handler = httpx.RequestLogging(logger, handler)
	server.Start()
	browser := testauth.Browser(t)
	testauth.Login(t, browser, origin, "alice")
	token := testauth.CreatePAT(t, browser, origin)
	client, err := service.NewIdentityClient(config.UniAuth)
	if err != nil {
		t.Fatal(err)
	}
	principal, err := identityservice.New(database, client, callback).Authenticate(context.Background(), model.PATCredential, token)
	if err != nil {
		t.Fatal(err)
	}
	return &resourceTestHandler{Handler: server.Config.Handler, token: token, principal: principal}
}

func projectDatabaseTestHandler(t *testing.T, database *postgres.Store, output io.Writer) *resourceTestHandler {
	t.Helper()
	return resourceDatabaseTestServer(t, database, attachmentTestFiles(t), output)
}

func projectTestStore(t *testing.T) *postgres.Store { return testsupport.TestStore(t) }
