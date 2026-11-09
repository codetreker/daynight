package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
)

type databaseIdentityIntegration struct{ server *httptest.Server }

// The explicitly selected CLI subprocess check owns a complete persistent server;
// its database fixture is independent of root HTTP unit-test credentials.
func newDatabaseIdentityIntegration(t *testing.T) *databaseIdentityIntegration {
	t.Helper()
	database := testsupport.TestStore(t)
	server := httptest.NewUnstartedServer(nil)
	t.Cleanup(server.Close)
	origin := "http://" + server.Listener.Addr().String()
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	config := configuredTestConfig()
	config.PublicOrigin, config.UniAuthURL = origin, gateway.Origin
	config.UniAuthAppID, config.UniAuthAppSecret, config.UniAuthCallbackURL = gateway.AppID, gateway.AppSecret, callback
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	handler, err := newTestHandler(Dependencies{Store: database, Ready: database.Ready, Files: attachmentTestFiles(t)}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		handler.(Handler).BeginShutdown()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := handler.(Handler).Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	server.Config.Handler = httpx.RequestLogging(logger, handler)
	server.Start()
	return &databaseIdentityIntegration{server: server}
}

func (integration *databaseIdentityIntegration) login(t *testing.T, browser *http.Client, persona string) api.User {
	t.Helper()
	testauth.Login(t, browser, integration.server.URL, persona)
	_, data := identityRequest(t, browser, http.MethodGet, integration.server.URL+"/api/v1/me", "", nil, http.StatusOK)
	return identityDecode[api.User](t, data)
}
