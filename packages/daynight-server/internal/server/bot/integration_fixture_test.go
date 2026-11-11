package bot_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	storageconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local/config"
	databaseconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/config"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	serverconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/config"
	applicationconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/application/config"
	identityconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity/config"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/appsupport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

type resourceTestHandler struct {
	http.Handler
	token     string
	principal model.Principal
}

func projectTestStore(t *testing.T) *postgres.Store { return testsupport.TestStore(t) }
func resourceTestServer(t *testing.T, database *postgres.Store, files filestorage.Storage, output io.Writer) *resourceTestHandler {
	t.Helper()
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
func projectRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if h, ok := handler.(*resourceTestHandler); ok {
		request.Header.Set("Authorization", "Bearer "+h.token)
	}
	request.Header.Set("Content-Type", "application/json; charset=UTF-8")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
func decodeResponse[T any](t *testing.T, response *httptest.ResponseRecorder, status int) T {
	return testsupport.DecodeResponse[T](t, response, status)
}
func assertProjectError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	testsupport.AssertProjectError(t, response, status, code)
}
func jsonBody(t *testing.T, input any) string { return testsupport.JSONBody(t, input) }

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
	return resourceTestServer(t, database, files, output)
}
func authorizeResourceRequest(handler http.Handler, request *http.Request) {
	if h, ok := handler.(*resourceTestHandler); ok {
		request.Header.Set("Authorization", "Bearer "+h.token)
	}
}
func reportSnapshotHTTP(t *testing.T, handler http.Handler, id string, body map[string]any) api.WorkerReportResponse {
	t.Helper()
	response := projectRequest(handler, http.MethodPost, "/api/v1/me/workers/"+id+"/report", jsonBody(t, body))
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") == "" {
		t.Fatal("worker report lacks private response admission headers")
	}
	return decodeResponse[api.WorkerReportResponse](t, response, http.StatusOK)
}

type authHarness = testsupport.AuthHarness[*authhttp.Authentication]

func authTestHarness(t *testing.T) *authHarness {
	return testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
		return authhttp.NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	})
}

type threadFailingWriter struct {
	*httptest.ResponseRecorder
	calls int
}

func (w *threadFailingWriter) Write(data []byte) (int, error) {
	w.calls++
	return 0, errors.New("private response failure")
}
