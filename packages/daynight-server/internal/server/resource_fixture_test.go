package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
)

type resourceTestHandler struct {
	http.Handler
	token     string
	principal model.Principal
}

func resourceTestServer(t *testing.T, database *store.Store, files filestorage.Storage, output io.Writer) *resourceTestHandler {
	t.Helper()
	server := httptest.NewUnstartedServer(nil)
	t.Cleanup(server.Close)
	origin := "http://" + server.Listener.Addr().String()
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	config := configuredTestConfig()
	config.PublicOrigin = origin
	config.UniAuthCallbackURL = callback
	config.UniAuthURL = gateway.Origin
	config.UniAuthAppID = gateway.AppID
	config.UniAuthAppSecret = gateway.AppSecret
	config.AllowHTTPTestOrigin = true
	config.AllowLoopbackHTTP = true
	logger := slog.New(slog.NewJSONHandler(output, nil))
	handler, err := New(Dependencies{Store: database, Files: files}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	server.Config.Handler = httpx.RequestLogging(logger, handler)
	server.Start()
	browser := testauth.Browser(t)
	testauth.Login(t, browser, origin, "alice")
	token := testauth.CreatePAT(t, browser, origin)
	client, err := config.identityClient()
	if err != nil {
		t.Fatal(err)
	}
	principal, err := identityservice.New(database, client, callback).Authenticate(context.Background(), model.PATCredential, token)
	if err != nil {
		t.Fatal(err)
	}
	return &resourceTestHandler{Handler: server.Config.Handler, token: token, principal: principal}
}

func authorizeResourceRequest(handler http.Handler, request *http.Request) {
	if resource, ok := handler.(*resourceTestHandler); ok {
		request.Header.Set("Authorization", "Bearer "+resource.token)
	}
}
